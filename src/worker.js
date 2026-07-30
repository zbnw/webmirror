const PRIMARY_HOST = 'zh.wikipedia.org';
const MOBILE_HOST = 'zh.m.wikipedia.org';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 360;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const EDGE_TTL = {
  asset: 30 * 24 * 60 * 60,
  module: 7 * 24 * 60 * 60,
  article: 5 * 60
};

const BROWSER_TTL = {
  asset: 7 * 24 * 60 * 60,
  module: 24 * 60 * 60,
  article: 60
};

const ROUTES = [
  { prefix: '/upload_wikimedia', host: 'upload.wikimedia.org', cache: 'asset' },
  { prefix: '/static_wikipedia', host: 'static.wikipedia.org', cache: 'asset' },
  { prefix: '/bits_wikimedia', host: 'bits.wikimedia.org', cache: 'asset' },
  { prefix: '/maps_wikimedia', host: 'maps.wikimedia.org', cache: 'asset' },
  { prefix: '/login_wikimedia', host: 'login.wikimedia.org', cache: 'private' },
  { prefix: '/meta_wikimedia', host: 'meta.wikimedia.org', cache: 'private' },
  { prefix: '/commons_wikimedia', host: 'commons.wikimedia.org', cache: 'private' },
  { prefix: '/www_wikipedia', host: 'www.wikipedia.org', cache: 'private' },
  { prefix: '/api_rest', host: 'api.wikimedia.org', cache: 'private' },
  { prefix: '', host: PRIMARY_HOST, cache: 'private' }
];

const HOST_TO_PREFIX = new Map(ROUTES.map((route) => [route.host, route.prefix]));
HOST_TO_PREFIX.set(MOBILE_HOST, '');

const TEXT_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/manifest+json',
  'application/vnd.php.serialized'
];

const LOGIN_PATH_HINTS = [
  '/w/index.php?title=Special:UserLogin',
  '/wiki/Special:UserLogin',
  '/wiki/Special:CreateAccount',
  '/wiki/Special:CentralLogin',
  '/wiki/Special:UserLogout'
];

const PRIVATE_PATH_PATTERNS = [
  /^\/wiki\/Special:/i,
  /^\/wiki\/User:/i,
  /^\/wiki\/User_talk:/i,
  /^\/wiki\/Talk:/i
];

const rateLimitBuckets = new Map();
let lastRateLimitSweep = 0;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    const clientUrl = new URL(request.url);

    if (clientUrl.pathname === '/robots.txt') {
      return robotsTxt();
    }

    const rateLimitResponse = checkRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const route = matchRoute(clientUrl.pathname);
    const upstreamUrl = toUpstreamUrl(clientUrl, route);
    const proxyOrigin = `${clientUrl.protocol}//${clientUrl.host}`;
    const cachePolicy = getCachePolicy(request, upstreamUrl, route);
    const cacheKey = cachePolicy.edgeTtl > 0 ? toCacheKey(request, clientUrl) : null;

    if (cacheKey) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        return withStandardHeaders(cached, 'HIT');
      }
    }

    const upstreamRequest = toUpstreamRequest(request, upstreamUrl, route.host, cachePolicy);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), upstreamRequest);
    } catch (error) {
      return textResponse(`WebMirror upstream error: ${error.message}`, 502);
    }

    const response = await toClientResponse(upstreamResponse, {
      route,
      upstreamUrl,
      proxyOrigin,
      proxyHost: clientUrl.host,
      cachePolicy
    });

    if (cacheKey && isResponseCacheable(response)) {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }

    return withStandardHeaders(response, cacheKey ? 'MISS' : 'BYPASS');
  }
};

function matchRoute(pathname) {
  return ROUTES.find((route) => {
    return route.prefix === '' || pathname === route.prefix || pathname.startsWith(`${route.prefix}/`);
  }) || ROUTES[ROUTES.length - 1];
}

function toUpstreamUrl(clientUrl, route) {
  const upstreamUrl = new URL(clientUrl.toString());
  upstreamUrl.protocol = 'https:';
  upstreamUrl.hostname = route.host;

  if (route.prefix) {
    upstreamUrl.pathname = upstreamUrl.pathname.slice(route.prefix.length) || '/';
  }

  return upstreamUrl;
}

function toUpstreamRequest(request, upstreamUrl, upstreamHost, cachePolicy) {
  const headers = new Headers(request.headers);
  const method = request.method.toUpperCase();

  headers.set('Host', upstreamHost);
  headers.set('Referer', `https://${PRIMARY_HOST}/`);
  headers.set('User-Agent', headers.get('User-Agent') || 'Mozilla/5.0');

  if (headers.has('Origin')) {
    headers.set('Origin', `https://${upstreamHost}`);
  }

  headers.delete('Accept-Encoding');
  headers.delete('CF-Connecting-IP');
  headers.delete('CF-IPCountry');
  headers.delete('CF-Ray');
  headers.delete('X-Forwarded-For');
  headers.delete('X-Forwarded-Proto');

  const init = {
    method,
    headers,
    redirect: 'manual'
  };

  if (!['GET', 'HEAD'].includes(method)) {
    init.body = request.body;
  }

  if (['GET', 'HEAD'].includes(method)) {
    init.cf = {
      cacheEverything: cachePolicy.edgeTtl > 0,
      cacheTtlByStatus: {
        '200-299': cachePolicy.edgeTtl,
        '300-399': Math.min(cachePolicy.edgeTtl, 60),
        '404': Math.min(cachePolicy.edgeTtl, 300),
        '500-599': 0
      }
    };
  }

  return init;
}

async function toClientResponse(response, context) {
  const headers = cleanResponseHeaders(response.headers, context);
  const redirectResponse = rewriteRedirect(response, headers, context);

  if (redirectResponse) {
    return redirectResponse;
  }

  const contentType = headers.get('content-type') || '';
  const shouldRewrite = TEXT_CONTENT_TYPES.some((type) => contentType.includes(type));

  if (!shouldRewrite) {
    setCacheHeaders(headers, context.cachePolicy);
    setCorsHeaders(headers);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  let body = await response.text();
  body = rewriteText(body, context.proxyOrigin, context.proxyHost);

  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  setCacheHeaders(headers, context.cachePolicy);
  setCorsHeaders(headers);

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cleanResponseHeaders(sourceHeaders, context) {
  const headers = new Headers(sourceHeaders);

  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.delete('clear-site-data');
  headers.delete('strict-transport-security');
  headers.delete('x-content-security-policy');
  headers.delete('x-frame-options');
  headers.delete('x-webkit-csp');
  headers.delete('report-to');
  headers.delete('nel');

  if (context.cachePolicy.kind === 'private') {
    rewriteSetCookie(headers, context.proxyHost);
  } else {
    headers.delete('set-cookie');
  }

  return headers;
}

function rewriteRedirect(response, headers, context) {
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return null;
  }

  const location = headers.get('location');
  if (!location) {
    return null;
  }

  headers.set('location', rewriteUrl(location, context.proxyOrigin));
  headers.delete('content-length');
  setCacheHeaders(headers, context.cachePolicy);
  setCorsHeaders(headers);

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function getCachePolicy(request, upstreamUrl, route) {
  if (!isReadOnlyAnonymousRequest(request) || isPrivateUrl(upstreamUrl)) {
    return privateCachePolicy();
  }

  if (route.cache === 'asset' && isCacheableAsset(upstreamUrl)) {
    return {
      kind: 'asset',
      edgeTtl: EDGE_TTL.asset,
      browserTtl: BROWSER_TTL.asset,
      immutable: true
    };
  }

  if (isMediaWikiStaticModule(upstreamUrl)) {
    return {
      kind: 'module',
      edgeTtl: EDGE_TTL.module,
      browserTtl: BROWSER_TTL.module,
      immutable: false
    };
  }

  if (isAnonymousArticlePage(upstreamUrl)) {
    return {
      kind: 'article',
      edgeTtl: EDGE_TTL.article,
      browserTtl: BROWSER_TTL.article,
      immutable: false
    };
  }

  return privateCachePolicy();
}

function privateCachePolicy() {
  return {
    kind: 'private',
    edgeTtl: 0,
    browserTtl: 0,
    immutable: false
  };
}

function isReadOnlyAnonymousRequest(request) {
  const method = request.method.toUpperCase();

  return ['GET', 'HEAD'].includes(method)
    && !request.headers.has('Cookie')
    && !request.headers.has('Authorization');
}

function isPrivateUrl(url) {
  const pathname = url.pathname;
  const pathAndSearch = `${url.pathname}${url.search}`;
  const action = url.searchParams.get('action');

  if (LOGIN_PATH_HINTS.some((path) => pathAndSearch.includes(path))) {
    return true;
  }

  if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return true;
  }

  if (['edit', 'submit', 'history', 'delete', 'protect', 'unprotect', 'rollback', 'watch', 'unwatch'].includes(action || '')) {
    return true;
  }

  if (url.searchParams.has('veaction') || url.searchParams.has('token')) {
    return true;
  }

  return false;
}

function isMediaWikiStaticModule(url) {
  return url.hostname === PRIMARY_HOST
    && url.pathname === '/w/load.php'
    && (url.searchParams.has('modules') || url.searchParams.has('only') || url.searchParams.has('skin'));
}

function isAnonymousArticlePage(url) {
  if (url.hostname !== PRIMARY_HOST) {
    return false;
  }

  if (url.pathname === '/' || url.pathname.startsWith('/wiki/')) {
    return !isPrivateUrl(url);
  }

  if (url.pathname === '/w/index.php') {
    const title = url.searchParams.get('title') || '';
    const action = url.searchParams.get('action') || 'view';
    return title !== '' && action === 'view' && !isPrivateUrl(url);
  }

  return false;
}

function isCacheableAsset(url) {
  const pathname = url.pathname.toLowerCase();

  if (isPrivateUrl(url)) {
    return false;
  }

  return /\.(avif|bmp|css|gif|ico|jpeg|jpg|js|mjs|png|svg|ttf|webp|woff|woff2)$/i.test(pathname);
}

function isResponseCacheable(response) {
  return response.status >= 200
    && response.status < 300
    && !response.headers.has('set-cookie');
}

function toCacheKey(request, clientUrl) {
  const keyUrl = new URL(clientUrl.toString());
  keyUrl.hash = '';

  const sortedSearch = new URLSearchParams(keyUrl.search);
  sortedSearch.sort();
  keyUrl.search = sortedSearch.toString();

  const acceptLanguage = request.headers.get('Accept-Language') || '';
  const variant = acceptLanguage.toLowerCase().includes('zh-tw') ? 'zh-tw' : 'zh-cn';
  keyUrl.searchParams.set('__webmirror_variant', variant);

  return new Request(keyUrl.toString(), { method: 'GET' });
}

function setCacheHeaders(headers, cachePolicy) {
  if (cachePolicy.edgeTtl <= 0) {
    headers.set('Cache-Control', 'private, no-store');
    return;
  }

  const directives = [`public`, `max-age=${cachePolicy.browserTtl}`, `s-maxage=${cachePolicy.edgeTtl}`];

  if (cachePolicy.immutable) {
    directives.push('immutable');
  }

  headers.set('Cache-Control', directives.join(', '));
}

function rewriteSetCookie(headers, proxyHost) {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : splitSetCookie(headers.get('set-cookie'));

  if (!cookies.length) {
    return;
  }

  headers.delete('set-cookie');

  for (const cookie of cookies) {
    headers.append('set-cookie', rewriteCookie(cookie));
  }

  headers.set('x-webmirror-cookie-host', proxyHost);
}

function splitSetCookie(header) {
  if (!header) {
    return [];
  }

  return header.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function rewriteCookie(cookie) {
  let rewritten = cookie
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*SameSite=None/gi, '; SameSite=Lax');

  if (!/;\s*Path=/i.test(rewritten)) {
    rewritten += '; Path=/';
  }

  if (!/;\s*Secure/i.test(rewritten)) {
    rewritten += '; Secure';
  }

  return rewritten;
}

function rewriteText(text, proxyOrigin, proxyHost) {
  let output = text;

  output = output.replace(/https?:\\?\/\\?\/([^\/"'()<>\s\\]+)([^"'()<>\s\\]*)/gi, (match, host, path = '') => {
    return rewriteAbsoluteUrl(match, host, path, proxyOrigin);
  });

  output = output.replace(/\/\/([^\/"'()<>\s\\]+)([^"'()<>\s\\]*)/gi, (match, host, path = '') => {
    return rewriteProtocolRelativeUrl(match, host, path, proxyHost);
  });

  output = output.replace(/\bzh\.m\.wikipedia\.org\b/g, proxyHost);
  output = output.replace(/\bzh\.wikipedia\.org\b/g, proxyHost);

  return output;
}

function rewriteAbsoluteUrl(original, host, path, proxyOrigin) {
  const prefix = HOST_TO_PREFIX.get(host.toLowerCase());

  if (prefix === undefined) {
    return original;
  }

  return `${proxyOrigin}${prefix}${path}`;
}

function rewriteProtocolRelativeUrl(original, host, path, proxyHost) {
  const prefix = HOST_TO_PREFIX.get(host.toLowerCase());

  if (prefix === undefined) {
    return original;
  }

  return `//${proxyHost}${prefix}${path}`;
}

function rewriteUrl(location, proxyOrigin) {
  try {
    const absolute = new URL(location, `https://${PRIMARY_HOST}`);
    const prefix = HOST_TO_PREFIX.get(absolute.hostname.toLowerCase());

    if (prefix === undefined) {
      return location;
    }

    return `${proxyOrigin}${prefix}${absolute.pathname}${absolute.search}${absolute.hash}`;
  } catch {
    if (location.startsWith('/')) {
      return `${proxyOrigin}${location}`;
    }

    return location;
  }
}

function checkRateLimit(request) {
  const now = Date.now();
  const ip = getClientIp(request);

  if (now - lastRateLimitSweep > RATE_LIMIT_SWEEP_INTERVAL_MS) {
    sweepRateLimitBuckets(now);
  }

  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { windowStart: now, count: 1 });
    return null;
  }

  bucket.count += 1;

  if (bucket.count <= RATE_LIMIT_MAX_REQUESTS) {
    return null;
  }

  const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000);
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': String(retryAfter)
  });

  setRobotsHeaders(headers);
  return new Response('Too many requests. Please slow down.', { status: 429, headers });
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
}

function sweepRateLimitBuckets(now) {
  lastRateLimitSweep = now;

  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitBuckets.delete(ip);
    }
  }
}

function withStandardHeaders(response, cacheState) {
  const headers = new Headers(response.headers);
  headers.set('X-WebMirror-Cache', cacheState);
  setRobotsHeaders(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
}

function setRobotsHeaders(headers) {
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
}

function corsPreflight() {
  const headers = new Headers();
  setCorsHeaders(headers);
  setRobotsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function robotsTxt() {
  return new Response('User-agent: *\nDisallow: /\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex'
    }
  });
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex'
    }
  });
}
