const PRIMARY_HOST = 'www.google.com';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 240;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const EDGE_TTL = {
  asset: 7 * 24 * 60 * 60,
  search: 30
};

const BROWSER_TTL = {
  asset: 24 * 60 * 60,
  search: 0
};

const ROUTES = [
  { prefix: '/gstatic', host: 'www.gstatic.com', cache: 'asset' },
  { prefix: '/ssl_gstatic', host: 'ssl.gstatic.com', cache: 'asset' },
  { prefix: '/fonts_gstatic', host: 'fonts.gstatic.com', cache: 'asset' },
  { prefix: '/fonts_googleapis', host: 'fonts.googleapis.com', cache: 'asset' },
  { prefix: '/encrypted_tbn0', host: 'encrypted-tbn0.gstatic.com', cache: 'asset' },
  { prefix: '/encrypted_tbn1', host: 'encrypted-tbn1.gstatic.com', cache: 'asset' },
  { prefix: '/encrypted_tbn2', host: 'encrypted-tbn2.gstatic.com', cache: 'asset' },
  { prefix: '/encrypted_tbn3', host: 'encrypted-tbn3.gstatic.com', cache: 'asset' },
  { prefix: '/googleusercontent', host: 'lh3.googleusercontent.com', cache: 'asset' },
  { prefix: '/consent_google', host: 'consent.google.com', cache: 'private' },
  { prefix: '/ogs_google', host: 'ogs.google.com', cache: 'private' },
  { prefix: '', host: PRIMARY_HOST, cache: 'page' }
];

const HOST_TO_PREFIX = new Map(ROUTES.map((route) => [route.host, route.prefix]));
HOST_TO_PREFIX.set('google.com', '');

const TEXT_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/x-javascript',
  'application/manifest+json'
];

const PRIVATE_PATH_PATTERNS = [
  /^\/accounts/i,
  /^\/signin/i,
  /^\/ServiceLogin/i,
  /^\/settings/i,
  /^\/preferences/i,
  /^\/history/i,
  /^\/save/i
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

    if (isLocalHomeRequest(request, clientUrl)) {
      return localSearchHome();
    }

    const outboundRedirect = directOutboundRedirect(clientUrl);
    if (outboundRedirect) {
      return outboundRedirect;
    }

    if (clientUrl.pathname.startsWith('/sorry')) {
      return googleBlockedResponse();
    }

    const rateLimitResponse = checkRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const route = matchRoute(clientUrl.pathname);
    const upstreamUrl = toUpstreamUrl(clientUrl, route);
    normalizeSearchUrl(upstreamUrl);

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
      return textResponse(`GoogleMirror upstream error: ${error.message}`, 502);
    }

    const response = await toClientResponse(upstreamResponse, {
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

function normalizeSearchUrl(url) {
  if (url.hostname !== PRIMARY_HOST) {
    return;
  }

  if (!url.searchParams.has('hl')) {
    url.searchParams.set('hl', 'zh-CN');
  }

  if (isSearchUrl(url)) {
    url.searchParams.set('pws', '0');
    url.searchParams.set('igu', '1');
  }

  url.searchParams.delete('gbv');
}

function isLocalHomeRequest(request, url) {
  return request.method.toUpperCase() === 'GET'
    && (url.pathname === '/' || url.pathname === '/webhp')
    && !url.searchParams.has('q');
}

function localSearchHome() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <title>Google Search Mirror</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8fafc;
      color: #111827;
    }
    main {
      width: min(720px, calc(100vw - 32px));
      text-align: center;
    }
    h1 {
      margin: 0 0 28px;
      font-size: clamp(32px, 8vw, 72px);
      font-weight: 700;
      letter-spacing: 0;
    }
    form {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    input {
      flex: 1;
      height: 46px;
      border: 1px solid #d1d5db;
      border-radius: 24px;
      padding: 0 18px;
      font-size: 16px;
      outline: none;
      background: white;
      color: #111827;
    }
    button {
      height: 46px;
      border: 0;
      border-radius: 24px;
      padding: 0 20px;
      font-size: 15px;
      cursor: pointer;
      background: #2563eb;
      color: white;
    }
    p {
      margin: 18px 0 0;
      color: #6b7280;
      font-size: 13px;
      line-height: 1.6;
    }
    @media (max-width: 560px) {
      form { flex-direction: column; }
      input, button { width: 100%; box-sizing: border-box; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Google</h1>
    <form action="/search" method="get" autocomplete="off">
      <input name="q" type="search" autofocus required placeholder="Search keywords">
      <button type="submit">Search</button>
    </form>
    <p>Anonymous search only. Login, account, history, and preferences are not supported.</p>
  </main>
</body>
</html>`;

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300'
  });

  setRobotsHeaders(headers);
  headers.set('X-GoogleMirror-Cache', 'LOCAL');
  return new Response(html, { status: 200, headers });
}

function directOutboundRedirect(url) {
  if (url.pathname !== '/url') {
    return null;
  }

  const target = url.searchParams.get('q') || url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return null;
  }

  const headers = new Headers({
    location: target,
    'cache-control': 'private, no-store'
  });

  setRobotsHeaders(headers);
  return new Response(null, { status: 302, headers });
}

function googleBlockedResponse() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <title>Google Traffic Challenge</title>
  <style>
    body { margin: 0; padding: 32px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.7; color: #111827; background: #f8fafc; }
    main { max-width: 720px; margin: 12vh auto 0; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 10px 0; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>Google returned a traffic challenge</h1>
    <p>This usually means Google flagged the Cloudflare Worker egress IP as datacenter traffic.</p>
    <p>The mirror now avoids loading the Google home page and reduces extra resource requests, but a pure Cloudflare Worker cannot control the upstream egress IP and cannot guarantee bypassing Google's traffic checks.</p>
    <p><a href="/">Back to search</a></p>
  </main>
</body>
</html>`;

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store'
  });

  setRobotsHeaders(headers);
  headers.set('X-GoogleMirror-Cache', 'BLOCKED');
  return new Response(html, { status: 429, headers });
}

function isGoogleSorryLocation(location) {
  try {
    const url = new URL(location, `https://${PRIMARY_HOST}`);
    return url.pathname.startsWith('/sorry');
  } catch {
    return location.includes('/sorry/');
  }
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
  if (isGoogleSorryBody(body)) {
    return googleBlockedResponse();
  }

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

  if (context.cachePolicy.kind !== 'private') {
    headers.delete('set-cookie');
  } else {
    rewriteSetCookie(headers);
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

  if (isGoogleSorryLocation(location)) {
    return googleBlockedResponse();
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

  if (isSearchUrl(upstreamUrl)) {
    return {
      kind: 'search',
      edgeTtl: EDGE_TTL.search,
      browserTtl: BROWSER_TTL.search,
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
  if (url.hostname === 'accounts.google.com') {
    return true;
  }

  if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return true;
  }

  return url.searchParams.has('authuser')
    || url.searchParams.has('token')
    || url.searchParams.has('continue');
}

function isSearchUrl(url) {
  return url.hostname === PRIMARY_HOST
    && ['/search', '/m/search'].includes(url.pathname)
    && url.searchParams.has('q');
}

function isGoogleSorryBody(body) {
  return body.includes('/sorry/')
    || body.includes('Our systems have detected unusual traffic')
    || body.includes('unusual traffic');
}

function isCacheableAsset(url) {
  if (isPrivateUrl(url)) {
    return false;
  }

  return /\.(avif|bmp|css|gif|ico|jpeg|jpg|js|mjs|png|svg|ttf|webp|woff|woff2)$/i.test(url.pathname);
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
  keyUrl.searchParams.set('__googlemirror_lang', acceptLanguage.slice(0, 32));

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

function rewriteSetCookie(headers) {
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

  output = output.replace(/\bwww\.google\.com\b/g, proxyHost);
  output = output.replace(/\bgoogle\.com\b/g, proxyHost);

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
  headers.set('X-GoogleMirror-Cache', cacheState);
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
