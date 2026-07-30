# WebMirror

WebMirror is a Cloudflare Workers based mirror gateway for Chinese Wikipedia and common Wikimedia static resources. It is designed to help users in mainland China reach public knowledge resources for reading, learning, citation checking, and academic research.

The project focuses on open knowledge access. It does not modify article content, does not provide account services, and should be deployed responsibly with respect for Wikimedia's community norms, copyright rules, and terms of use.

## Features

- Mirrors `zh.wikipedia.org` as the default upstream site.
- Proxies common Wikimedia resource domains through fixed path prefixes.
- Rewrites HTML, CSS, JavaScript, JSON, and redirect links so browsing stays under the mirror domain.
- Handles static asset caching with Cloudflare edge cache and browser cache headers.
- Removes upstream security headers that are bound to the original domains and would otherwise block mirrored rendering.
- Includes conservative cookie rewriting for session compatibility.

## Route Mapping

| Mirror path | Upstream |
| --- | --- |
| `/` | `https://zh.wikipedia.org/` |
| `/upload_wikimedia/` | `https://upload.wikimedia.org/` |
| `/static_wikipedia/` | `https://static.wikipedia.org/` |
| `/bits_wikimedia/` | `https://bits.wikimedia.org/` |
| `/maps_wikimedia/` | `https://maps.wikimedia.org/` |
| `/login_wikimedia/` | `https://login.wikimedia.org/` |
| `/meta_wikimedia/` | `https://meta.wikimedia.org/` |
| `/commons_wikimedia/` | `https://commons.wikimedia.org/` |
| `/www_wikipedia/` | `https://www.wikipedia.org/` |
| `/api_rest/` | `https://api.wikimedia.org/` |

## Login Notes

WebMirror includes best-effort login compatibility:

- `login.wikimedia.org` is proxied through `/login_wikimedia/`.
- Redirects are rewritten back to the mirror domain.
- `Set-Cookie` headers are adjusted so cookies can be stored under the mirror domain.
- Dynamic and login-related responses are marked `private, no-store`.

This does not guarantee full Wikimedia login support. Wikimedia uses unified login, CSRF tokens, central authentication cookies, and strict browser security behavior across multiple domains. For account-sensitive actions such as editing, uploading, account recovery, or password changes, use the official Wikimedia domains directly whenever possible.

## Deployment

Install dependencies:

```bash
npm install
```

Deploy with Wrangler:

```bash
npm run deploy
```

For quick testing:

```bash
npm run dev
```

Before public use, bind the Worker to a custom HTTPS domain in Cloudflare. A stable domain improves cookie behavior and avoids unnecessary origin changes.

## Configuration

The Worker does not require environment variables. Edit `src/worker.js` if you want to add or remove upstream domains.

Keep route prefixes fixed and explicit. Do not turn this into an arbitrary open proxy.

## Responsible Use

This project is intended for positive, research-oriented access to public educational content. Please use it to support reading, study, teaching, citation verification, and public-interest knowledge preservation.

Do not use WebMirror to impersonate Wikimedia, mislead users, harvest credentials, bypass account restrictions, or mass-scrape content in ways that burden upstream services.

## License

MIT
