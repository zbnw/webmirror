# WebMirror

WebMirror 是一个基于 Cloudflare Workers 的网页镜像项目，当前主要用于镜像中文维基百科以及常见 Wikimedia 静态资源。项目目标是帮助中国大陆用户更稳定地访问公开知识内容，用于阅读、学习、资料查证、引用核验和学术研究。

WebMirror 关注的是公共知识的可达性。它不会修改百科正文内容，不提供独立账号系统，也不应该被用于冒充 Wikimedia 官方站点、诱导用户输入敏感信息或进行高强度抓取。

## 项目定位

- 面向中文用户，降低访问公开知识资源的技术门槛。
- 服务学习、教学、科研、资料检索和公共知识保存。
- 使用 Cloudflare Workers 做轻量级反向代理，不需要自建服务器。
- 使用固定域名映射，避免把服务变成任意开放代理。

## 主要功能

- 默认镜像 `zh.wikipedia.org`。
- 代理常见 Wikimedia 图片、样式、脚本、地图、元维基、共享资源等域名。
- 自动改写 HTML、CSS、JavaScript、JSON 和重定向中的链接，使浏览过程保持在镜像域名下。
- 对图片、字体、样式、脚本等静态资源启用缓存，提高重复访问速度。
- 使用 Cloudflare Cache API 缓存匿名访问结果，减少 Worker CPU 消耗和上游回源。
- 移除原站绑定域名的 CSP、HSTS、X-Frame-Options 等响应头，避免镜像页面加载失败。
- 对 Cookie 做保守改写，尽量改善会话兼容性。
- 内置轻量限流，降低异常访问对 Worker 和上游站点的压力。
- 默认拒绝搜索引擎收录，避免镜像页进入搜索索引。

## 路由映射

| 镜像路径 | 上游地址 |
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

## 性能与缓存策略

WebMirror 以“匿名阅读访问更快、登录和动态操作不缓存”为原则：

| 内容类型 | Cloudflare 边缘缓存 | 浏览器缓存 | 说明 |
| --- | ---: | ---: | --- |
| 图片、字体、静态文件 | 30 天 | 7 天 | 适合长期缓存，显著减少回源 |
| MediaWiki `load.php` 样式/脚本模块 | 7 天 | 1 天 | 维基页面大量依赖该接口，缓存后首屏更快 |
| 匿名词条页面 | 5 分钟 | 60 秒 | 缓存改写后的 HTML，降低 Worker CPU 和回源请求 |
| 登录、编辑、带 Cookie 请求 | 不缓存 | 不缓存 | 避免会话污染和账号风险 |
| POST/PUT/PATCH/DELETE 请求 | 不缓存 | 不缓存 | 保持动态操作实时转发 |

代码会给响应添加 `X-WebMirror-Cache` 头，便于排查缓存状态：

```txt
HIT     命中 Worker Cache API
MISS    可缓存但本次未命中
BYPASS  登录态、动态请求或不适合缓存
```

## 限流与保护

默认限流为每个 IP 每分钟 360 个请求。这个阈值对少量用户阅读使用比较宽松，可以覆盖页面首次加载时的大量图片、样式和脚本请求，同时能拦住明显异常的高频访问。

限流是 Worker 内存级的轻量保护，不依赖数据库或 KV。它适合个人、小范围使用场景；如果未来公开给大量用户访问，建议再接入 Cloudflare WAF、Turnstile、Rate Limiting Rules 或 KV/Durable Objects 做更严格的全局限流。

## 搜索引擎收录

项目默认拒绝搜索引擎收录：

- `/robots.txt` 返回 `Disallow: /`。
- 所有响应都会附带 `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex`。

这样可以避免镜像页面被搜索引擎索引，减少不必要流量，也降低与原站内容重复带来的问题。

## 关于登录

代码中包含“尽力而为”的登录兼容处理：

- `login.wikimedia.org` 会通过 `/login_wikimedia/` 转发。
- 上游重定向会被改写回当前镜像域名。
- `Set-Cookie` 会移除原始 `Domain`，让浏览器可以把 Cookie 写入镜像域名。
- 登录、动态页面和会话相关响应会设置为 `private, no-store`，避免缓存污染。

但这不等于完整支持 Wikimedia 登录。Wikimedia 使用统一登录、跨域 Cookie、CSRF Token 和多域名认证流程，镜像站很难保证编辑、上传、账号恢复、密码修改等操作稳定可靠。涉及账号安全的操作，建议直接访问 Wikimedia 官方域名完成。

## 部署方式

安装依赖：

```bash
npm install
```

本地调试：

```bash
npm run dev
```

部署到 Cloudflare Workers：

```bash
npm run deploy
```

部署后建议绑定自定义 HTTPS 域名。稳定域名有助于 Cookie、缓存和浏览器安全策略保持一致。

## 文件结构

```txt
webmirror/
├── src/worker.js        # Cloudflare Worker 主代码
├── src/google-worker.js # Google 搜索镜像 Worker，只保证搜索可用
├── optimized-worker.js  # 兼容入口，导出 src/worker.js
├── google-worker.js     # Google 搜索镜像兼容入口
├── wrangler.toml        # Cloudflare Workers 配置
├── package.json         # 项目脚本和依赖
├── README.md            # 中文说明文档
└── LICENSE              # MIT License
```

## Google 搜索镜像

项目额外提供 `src/google-worker.js`，用于镜像 Google 搜索页面。这个文件是独立 Worker，不影响中文维基镜像。

Google 搜索镜像只以“搜索引擎可用”为目标：

- 默认代理 `www.google.com`。
- 代理常见 Google 静态资源域名，例如 `www.gstatic.com`、`ssl.gstatic.com`、`fonts.gstatic.com`、`fonts.googleapis.com`。
- 不处理 Google 登录、账号、历史记录、偏好设置等路径。
- 搜索结果短缓存 30 秒，首页短缓存 60 秒，静态资源缓存 7 天。
- 每 IP 每分钟 240 请求限流。
- 默认返回 `/robots.txt` 禁止收录，并给所有响应添加 `X-Robots-Tag`。

如果只想部署 Google 搜索镜像，可以把 `wrangler.toml` 的入口改成：

```toml
main = "src/google-worker.js"
```

## 配置说明

默认不需要环境变量。需要增加或移除上游域名时，编辑 `src/worker.js` 里的 `ROUTES` 和 `HOST_TO_PREFIX` 相关配置即可。

建议保持路由前缀固定、明确，不要改造成任意 URL 都可代理的开放代理。

如需调整性能参数，可修改 `src/worker.js` 顶部常量：

```js
RATE_LIMIT_MAX_REQUESTS
EDGE_TTL
BROWSER_TTL
```

Google 搜索镜像对应参数在 `src/google-worker.js` 顶部。

## 正向使用

WebMirror 的初衷是帮助更多人平等、稳定地接触公开知识。欢迎将它用于：

- 学术研究和文献核验；
- 课堂教学和知识普及；
- 个人学习和资料检索；
- 公共知识的备份、整理和引用检查。

请不要将本项目用于钓鱼、冒充官方服务、收集账号凭据、绕过账号限制，或进行会给上游服务造成压力的大规模抓取。

## GitHub About 建议

仓库简介可以填写：

```txt
基于 Cloudflare Workers 的中文维基百科镜像网关，帮助大陆用户访问公开知识资源，用于学习、资料查证和学术研究。
```

推荐 Topics：

```txt
cloudflare-workers, wikipedia, wikimedia, mirror, proxy, knowledge-access, research, chinese
```

## 许可证

MIT
