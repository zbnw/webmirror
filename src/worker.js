const PRIMARY_HOST = 'zh.wikipedia.org';
const MOBILE_HOST = 'zh.m.wikipedia.org';

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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    const clientUrl = new URL(request.url);
    const route = matchRoute(clientUrl.pathname);
    const upstreamUrl = toUpstreamUrl(clientUrl, route);
    const proxyOrigin = `${clientUrl.protocol}//${clientUrl.host}`;

    const upstreamRequest = toUpstreamRequest(request, upstreamUrl, route.host);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), upstreamRequest);
    } catch (error) {
      return textResponse(`WebMirror upstream error: ${error.message}`, 502);
    }

    return toClientResponse(upstreamResponse, {
      route,
      upstreamUrl,
      proxyOrigin,
      proxyHost: clientUrl.host
    });
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

function toUpstreamRequest(request, upstreamUrl, upstreamHost) {
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
      cacheEverything: isCacheableAsset(upstreamUrl),
      cacheTtlByStatus: {
        '200-299': isCacheableAsset(upstreamUrl) ? 2592000 : 0,
        '300-399': 60,
        '404': 300,
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
    setCacheHeaders(headers, context);
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
  setCacheHeaders(headers, context);
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

  rewriteSetCookie(headers, context.proxyHost);
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
  setCorsHeaders(headers);

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

function setCacheHeaders(headers, context) {
  if (context.route.cache === 'asset' && isCacheableAsset(context.upstreamUrl)) {
    headers.set('Cache-Control', 'public, max-age=604800, immutable');
    return;
  }

  headers.set('Cache-Control', 'private, no-store');
}

function isCacheableAsset(url) {
  const pathname = url.pathname.toLowerCase();

  if (LOGIN_PATH_HINTS.some((path) => `${url.pathname}${url.search}`.includes(path))) {
    return false;
  }

  return /\.(avif|bmp|css|gif|ico|jpeg|jpg|js|mjs|png|svg|ttf|webp|woff|woff2)$/i.test(pathname);
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
}

function corsPreflight() {
  const headers = new Headers();
  setCorsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
