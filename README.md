# Traffic Router

Traffic Router 是一个无需后端和构建工具的静态分流策略管理页面。内置 AI、Google、流媒体、Apple、局域网直连等分流策略，以及东南亚/美国自动测速节点组；在页面里维护策略后即可生成 `Mihomo` 脚本与 `Shadowrocket` 配置。

`rules-source.json` 是页面加载时使用的通用示例。个人网段、内网 DNS 等本地改动请放在已被 gitignore 的 `rules-source.local.json`，不要提交进仓库。

## 本地预览

默认规则通过 `fetch` 加载，用 `file://` 直接打开会被浏览器拦截，需要静态服务器：

```bash
python3 -m http.server 8000
```

然后打开 <http://localhost:8000>。用手机通过局域网 IP 访问时页面仍可用，但浏览器只在 HTTPS/localhost 下提供剪贴板 API，“复制”会退回为全选并提示手动复制。

## 自检

改完 `app.js` 或 `rules-source.json` 后跑一次（零依赖）：

```bash
node check.mjs
```

它会校验出厂规则源、IPv6 网段生成 `IP-CIDR6`、订阅自带规则排在 `MATCH` 之前、停用的策略组不进输出、关键词不误伤无关域名、私有地址不指向代理，以及节点组改名后引用同步。

## GitHub Pages

在仓库 Settings → Pages 中选择部署分支的根目录（`/ (root)`）。提交 `index.html`、`app.js`、`style.css` 和 `rules-source.json` 后，GitHub Pages 会直接提供页面。Pages 对静态资源默认缓存约 10 分钟，改动上线后稍等即可，不需要手动加版本号。

## DNS 策略

`rules-source.json` 不写完整 DNS。生成时用内置默认值展开，页面上也只暴露两份列表：

- **国外 DoH（经代理查询）**：Mihomo 的 `nameserver`，Shadowrocket 的 `proxy-dns-server`。默认 `1.1.1.1` + `8.8.8.8` 的 IP 形式 DoH。不要拿它解析节点域名——在国内往往要先翻墙才能访问这些 DoH。
- **国内 DNS（System）**：Mihomo 的 `proxy-server-nameserver` / `direct-nameserver` 和 Shadowrocket 的 `dns-server` / `fallback-dns-server` 默认使用 `system`；Shadowrocket 同时用 `dns-direct-system = true` 解析直连域名。

其余项（fake-ip 过滤、`hijack-dns`、bootstrap nameserver 等）固定用代码里的防污染默认值，不必写进规则源。
