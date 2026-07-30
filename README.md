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
- 移除原站绑定域名的 CSP、HSTS、X-Frame-Options 等响应头，避免镜像页面加载失败。
- 对 Cookie 做保守改写，尽量改善会话兼容性。

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
├── optimized-worker.js  # 兼容入口，导出 src/worker.js
├── wrangler.toml        # Cloudflare Workers 配置
├── package.json         # 项目脚本和依赖
├── README.md            # 中文说明文档
└── LICENSE              # MIT License
```

## 配置说明

默认不需要环境变量。需要增加或移除上游域名时，编辑 `src/worker.js` 里的 `ROUTES` 和 `HOST_TO_PREFIX` 相关配置即可。

建议保持路由前缀固定、明确，不要改造成任意 URL 都可代理的开放代理。

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
