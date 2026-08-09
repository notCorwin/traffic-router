const APP_NAME = "Traffic Router";
const outputEl = document.querySelector("#output");
const outputStatusEl = document.querySelector("#output-status");
const summaryEl = document.querySelector("#summary");
const generatorStatusEl = document.querySelector("#generator-status");
// Safari 在 /repo（无尾斜杠）时会把相对路径解析到站点根；按页面目录拼绝对 URL
function pageDir() {
  if (typeof location === "undefined") return "/";
  let path = location.pathname;
  if (!path.endsWith("/")) {
    const last = path.split("/").pop();
    path = last.includes(".") ? path.slice(0, -last.length) : `${path}/`;
  }
  return path;
}
const assetUrl = (name) => (typeof location === "undefined" ? name : new URL(name, `${location.origin}${pageDir()}`).href);
let source = null;
const initialOutput = typeof location !== "undefined" && new URLSearchParams(location.search || "").get("output");
let outputType = initialOutput === "shadowrocket" ? "shadowrocket" : "clash";
let flushGenerator = null;
const LAN_ROUTE = "局域网直连";
const IPV4_ROUTE = "IPv4直连";
const routeDescriptions = { Apple: "Apple 服务直连", AI: "ChatGPT、Gemini、Claude、Grok、Cursor、Copilot 等 AI 服务", LINE: "LINE 服务", Netflix: "Netflix 与 Fast.com", YouTube: "YouTube 视频服务", TikTok: "TikTok 短视频服务", Google: "Google 服务", GitHub: "GitHub 与资源域名", "局域网直连": "局域网、保留地址与特殊网段", "IPv4直连": "所有 IPv4 地址固定直连" };
const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(value);
// 国外 DoH 用 IP，避免解析 DoH 域名时再被污染。
// 节点域名和直连域名使用国内 DNS，不额外依赖国内 DoH。
const defaultOverseasDns = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"];
const defaultDomesticDns = ["223.5.5.5"];
const defaultFakeIpFilter = ["*.lan", "*.local", "*.localhost", "+.internal", "+.home.arpa", "+.arpa", "time.*.com", "ntp.*.com", "+.stun.*", "stun.*", "*.msftconnecttest.com", "www.msftconnecttest.com"];
const defaultHijackDns = ["8.8.8.8:53", "8.8.4.4:53", "1.1.1.1:53", "1.0.0.1:53", "223.5.5.5:53", "119.29.29.29:53"];
const defaultAlwaysRealIp = ["*.lan", "*.local", "*.arpa", "time.*.com", "ntp.*.com", "www.msftconnecttest.com"];
const speedTests = { Cloudflare: "http://cp.cloudflare.com/generate_204", Fast: "https://fast.com", Gstatic: "http://www.gstatic.com/generate_204" };
const geoipCodes = [["CN", "中国大陆"], ["HK", "香港"], ["TW", "台湾"], ["MO", "澳门"], ["JP", "日本"], ["KR", "韩国"], ["SG", "新加坡"], ["MY", "马来西亚"], ["TH", "泰国"], ["PH", "菲律宾"], ["VN", "越南"], ["ID", "印尼"], ["US", "美国"], ["CA", "加拿大"], ["GB", "英国"], ["DE", "德国"], ["FR", "法国"], ["AU", "澳大利亚"], ["RU", "俄罗斯"], ["IN", "印度"]];
const geoipName = (code) => { const upper = String(code || "").toUpperCase(); return geoipCodes.find(([value]) => value === upper)?.[1] || `GeoIP ${upper || "??"}`; };
const geoipOptions = (selected) => {
  const upper = String(selected || "CN").toUpperCase();
  const codes = new Map(geoipCodes);
  if (upper && !codes.has(upper)) codes.set(upper, upper);
  return [...codes.entries()].map(([code, label]) => `<option value="${escapeHtml(code)}" ${code === upper ? "selected" : ""}>${escapeHtml(code)} · ${escapeHtml(label)}</option>`).join("");
};
function targetKeyFromName(name) {
  let hash = 2166136261;
  for (const char of String(name)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}
function mapTargetRefs(data, map) {
  const next = (value) => map[value] || value;
  for (const route of data.routes || []) route.target = next(route.target);
  for (const item of data.standalone_urls || []) item.target = next(item.target);
  for (const item of data.standalone_rules || []) item.target = next(item.target);
  for (const group of data.groups || []) group.fallback = next(group.fallback);
  data.final = next(data.final);
}
function syncGroupKeys(data) {
  const assignments = data.groups.map((group) => {
    const display = String(data.targets[group.target] || group.target).trim() || "未命名节点组";
    return { group, display, from: group.target };
  });
  const used = new Set(["DIRECT"]);
  for (const item of assignments) {
    let key = targetKeyFromName(item.display);
    let n = 0;
    while (used.has(key)) key = targetKeyFromName(`${item.display}\0${++n}`);
    used.add(key);
    item.to = key;
  }
  const remap = Object.fromEntries(assignments.filter((item) => item.from !== item.to).map((item) => [item.from, item.to]));
  for (const group of data.groups) delete data.targets[group.target];
  for (const item of assignments) {
    item.group.target = item.to;
    data.targets[item.to] = item.display;
  }
  if (Object.keys(remap).length) mapTargetRefs(data, remap);
  if (!data.targets.DIRECT) data.targets.DIRECT = "DIRECT";
}
function allocateGroupKey(data, display) {
  let key = targetKeyFromName(display);
  let n = 0;
  while (data.targets[key]) key = targetKeyFromName(`${display}\0${++n}`);
  return key;
}
const ruleGroupPatterns = {
  Apple: [{ name: "Apple Relay", domains: ["apple-relay.akamaized.net", "apple-relay.apple.com", "apple-relay.cloudflare.com", "apple-relay.fastly-edge.com", "apple-relay.mask.apple-dns.net"] }, { name: "Apple 服务", domains: ["apple.com", "icloud.com", "icloud-content.com", "me.com", "mzstatic.com", "cdn-apple.com"] }],
  AI: [{ name: "ChatGPT", domains: ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "api.openai.com"] }, { name: "Gemini", domains: ["gemini.google.com", "generativelanguage.googleapis.com", "ai.google.dev"] }, { name: "Claude", domains: ["claude.ai", "anthropic.com", "claudeusercontent.com"] }, { name: "Perplexity", domains: ["perplexity.ai"] }, { name: "Grok", domains: ["x.ai", "grok.com"] }, { name: "Cursor", domains: ["cursor.com", "cursor.sh"] }, { name: "Copilot", domains: ["copilot.microsoft.com"] }],
  LINE: [{ name: "LINE CDN", domains: ["line-cdn.net", "line-scdn.net"] }, { name: "LINE 服务", domains: ["line.naver.jp", "line.me", "line-apps.com"] }],
  Netflix: [{ name: "Netflix 主站", domains: ["netflix.com", "netflix.net"] }, { name: "Netflix CDN", domains: ["nflximg.net", "nflxvideo.net", "nflxso.net", "nflxext.com"] }, { name: "Fast.com", domains: ["fast.com"] }],
  YouTube: [{ name: "YouTube 短链接", domains: ["youtu.be"] }, { name: "YouTube CDN", domains: ["ytimg.com", "googlevideo.com"] }, { name: "YouTube 主站", domains: ["youtube.com", "youtube-nocookie.com"] }],
  TikTok: [{ name: "TikTok 主站", domains: ["tiktok.com", "tiktokv.com"] }, { name: "TikTok CDN", domains: ["tiktokcdn.com", "tiktokcdn-us.com", "ttlivecdn.com", "byteoversea.com"] }, { name: "Musical.ly", domains: ["musical.ly", "muscdn.com"] }],
  Google: [{ name: "Google API", domains: ["googleapis.com"] }, { name: "Google 静态资源", domains: ["gstatic.com", "ggpht.com"] }, { name: "Google 主站", domains: ["google.com", "withgoogle.com"] }, { name: "Google 广告", domains: ["googleadservices.com"] }, { name: "Google 视频", domains: ["googlevideo.com"] }, { name: "Google 用户内容", domains: ["googleusercontent.com"] }],
  GitHub: [{ name: "GitHub 主站", domains: ["github.com"] }, { name: "GitHub 用户内容", domains: ["githubusercontent.com"] }, { name: "GitHub Assets", domains: ["githubassets.com"] }],
};

const marker = (type) => type === "clash"
  ? `// Generated by ${APP_NAME}; edit rules-source.json instead.`
  : `# Generated by ${APP_NAME}; edit rules-source.json instead.`;

function routeDomains(data, route) { return [...(route.domain_sets || []).flatMap((name) => data.rule_sets[name] || []), ...(route.domains || [])]; }

const ruleKinds = ["域名", "关键词", "IP/CIDR", "GeoIP"];

function routeRuleEntries(data, route) {
  return [
    ...routeDomains(data, route).map((value) => ({ kind: "域名", value })),
    ...(route.keywords || []).map((value) => ({ kind: "关键词", value })),
    ...(route.cidrs || []).map((value) => ({ kind: "IP/CIDR", value })),
    ...(route.geoips || []).map((value) => ({ kind: "GeoIP", value })),
  ];
}

function ruleRow(kind, value, label) {
  const options = ruleKinds.map((item) => `<option ${item === kind ? "selected" : ""}>${item}</option>`).join("");
  return `<div class="drawer-item drawer-item-plain"><select name="rule-kind" aria-label="规则类型">${options}</select><input name="rule-value" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></div>`;
}

function ruleGroupName(route, entry) {
  if (entry.kind !== "域名") return entry.kind;
  const value = entry.value.toLowerCase();
  const group = (ruleGroupPatterns[route.name] || []).find(({ domains }) => domains.some((domain) => value === domain || value.endsWith(`.${domain}`)));
  return group?.name || "其他规则";
}

function normalizeStandaloneValue(value) {
  const text = String(value || "").trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return `${text}/32`;
  if (!text.includes("/") && /^[0-9a-f:]*:[0-9a-f:]*$/i.test(text)) return `${text}/128`;
  return text;
}
function expandStandaloneUrl(item) {
  const value = normalizeStandaloneValue(item.domain);
  if (validCidr(value)) return { name: item.name, target: item.target, cidrs: [value] };
  return { name: item.name, target: item.target, domains: [value] };
}
const cidrRule = (value, target) => `IP-CIDR${value.includes(":") ? "6" : ""},${value},${target},no-resolve`;

function expandedRoutes(data) {
  const routes = data.routes.filter((route) => (route.name === LAN_ROUTE || route.name === IPV4_ROUTE) || route.enabled !== false).map((route) => ({ ...route, enabled: undefined, domain_sets: undefined, domains: routeDomains(data, route) }));
  return [
    ...routes.filter((route) => route.name !== IPV4_ROUTE),
    ...(data.standalone_urls || []).map(expandStandaloneUrl),
    ...(data.standalone_rules || []),
    ...routes.filter((route) => route.name === IPV4_ROUTE),
  ];
}

function rules(data, finalType) {
  return [...expandedRoutes(data).flatMap((route) => {
    const target = data.targets[route.target];
    return [
      ...(route.geoips || []).map((value) => [`GEOIP,${value},${target}`, route.name]),
      ...(route.domains || []).map((value) => [`DOMAIN-SUFFIX,${value},${target}`, route.name]),
      ...(route.keywords || []).map((value) => [`DOMAIN-KEYWORD,${value},${target}`, route.name]),
      ...(route.cidrs || []).map((value) => [cidrRule(value, target), route.name]),
    ];
  }), [`${finalType},${data.targets[data.final]}`, null]];
}

function renderClash(data) {
  const groups = data.groups.map((group) => ({
    target: group.target, pattern: group.pattern, flags: group.flags || "",
    url: group.url, interval: group.interval, tolerance: group.tolerance, fallback: group.fallback,
  }));
  return `${marker("clash")}\n\nconst TARGETS = Object.freeze(${JSON.stringify(data.targets, null, 2)});\nconst GROUP_CONFIGS = ${JSON.stringify(groups, null, 2)};\nconst ROUTES = ${JSON.stringify(expandedRoutes(data), null, 2)};\nconst FINAL_TARGET = ${JSON.stringify(data.final)};\nconst DNS_CONFIG = ${JSON.stringify(data.mihomo_dns, null, 2)};\n\nfunction compileRoute(route) {\n  const target = TARGETS[route.target];\n  return [\n    ...(route.geoips || []).map((value) => \`GEOIP,\${value},\${target}\`),\n    ...(route.domains || []).map((value) => \`DOMAIN-SUFFIX,\${value},\${target}\`),\n    ...(route.keywords || []).map((value) => \`DOMAIN-KEYWORD,\${value},\${target}\`),\n    ...(route.cidrs || []).map((value) => \`IP-CIDR\${value.includes(":") ? "6" : ""},\${value},\${target},no-resolve\`),\n  ];\n}\n\nfunction buildProxyGroups(proxies) {\n  return GROUP_CONFIGS.map((group) => {\n    const match = new RegExp(group.pattern, group.flags);\n    const matchedProxies = proxies.filter((proxy) => match.test(proxy.name)).map((proxy) => proxy.name);\n    return { name: TARGETS[group.target], type: "url-test", url: group.url, interval: group.interval, tolerance: group.tolerance, proxies: matchedProxies.length ? matchedProxies : [TARGETS[group.fallback]] };\n  });\n}\n\nfunction main(config) {\n  config["proxy-groups"] ||= [];\n  config["proxy-groups"].unshift(...buildProxyGroups(config.proxies || []));\n  config.dns = DNS_CONFIG;\n  config.rules = [...ROUTES.flatMap(compileRoute), ...(config.rules || []), \`MATCH,\${TARGETS[FINAL_TARGET]}\`];\n  return config;\n}\n`;
}

function renderShadowrocket(data) {
  const dns = data.shadowrocket_dns;
  const lines = [marker("shadowrocket"), "# Traffic Router：Mihomo 在零匹配时回退到 fallback；Shadowrocket 使用静态策略组。", "", "[General]",
    `ipv6 = ${dns.ipv6}`, `prefer-ipv6 = ${dns.prefer_ipv6}`, `private-ip-answer = ${dns.private_ip_answer}`,
    `dns-direct-system = ${dns.dns_direct_system}`, `dns-direct-fallback-proxy = ${dns.dns_direct_fallback_proxy}`,
    `hijack-dns = ${dns.hijack_dns.join(",")}`, `dns-server = ${dns.servers.join(",")}`,
    `fallback-dns-server = ${dns.fallback_servers.join(",")}`, `proxy-dns-server = ${dns.proxy_servers.join(",")}`,
    `always-real-ip = ${dns.always_real_ip.join(",")}`, "", "[Proxy Group]"];
  for (const group of data.groups) lines.push(`${data.targets[group.target]} = url-test,url=${group.url},interval=${group.interval},tolerance=${group.tolerance},policy-regex-filter=${group.flags === "i" ? "(?i)" : ""}${group.pattern}`);
  lines.push("", "[Rule]");
  let previous = null;
  for (const [rule, name] of rules(data, "FINAL")) { if (name && name !== previous) { lines.push("", `# ${name}`); previous = name; } lines.push(rule); }
  lines.push("", "[Host]");
  for (const mapping of dns.host_servers) for (const pattern of mapping.patterns) lines.push(`${pattern} = server:${mapping.server}`);
  return `${lines.join("\n")}\n`;
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function validCidr(value) {
  const [address, prefix, ...rest] = String(value).split("/");
  if (!address || rest.length || !/^\d+$/.test(prefix)) return false;
  const bits = address.includes(":") ? 128 : 32;
  if (Number(prefix) > bits) return false;
  if (bits === 128) { try { return new URL(`http://[${address}]`).hostname !== ""; } catch { return false; } }
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

function resolveDnsLists(data) {
  if (data.dns?.overseas?.length || data.dns?.domestic?.length) {
    return {
      overseas: data.dns.overseas?.length ? data.dns.overseas : defaultOverseasDns,
      domestic: data.dns.domestic?.length ? data.dns.domestic : defaultDomesticDns,
    };
  }
  return {
    overseas: data.mihomo_dns?.nameserver?.length ? data.mihomo_dns.nameserver : defaultOverseasDns,
    domestic: data.mihomo_dns?.["direct-nameserver"]?.length ? data.mihomo_dns["direct-nameserver"] : defaultDomesticDns,
  };
}

// 规则源只保留海外 DoH / 国内 DNS 两份列表；其余用防污染默认值展开给两个客户端
function ensureDns(data) {
  const { overseas, domestic } = resolveDnsLists(data);
  data.dns = { overseas: [...overseas], domestic: [...domestic] };
  data.mihomo_dns = {
    enable: true,
    "cache-algorithm": "arc",
    "prefer-h3": false,
    "use-hosts": true,
    "use-system-hosts": true,
    "respect-rules": false,
    ipv6: false,
    "default-nameserver": [...data.dns.domestic],
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": [...defaultFakeIpFilter],
    nameserver: data.dns.overseas,
    fallback: [],
    "proxy-server-nameserver": data.dns.domestic,
    "direct-nameserver": data.dns.domestic,
    "direct-nameserver-follow-policy": false,
    "fallback-filter": { geoip: false, "geoip-code": "CN", geosite: [], ipcidr: [], domain: [] },
  };
  data.shadowrocket_dns = {
    ipv6: false,
    prefer_ipv6: false,
    private_ip_answer: true,
    dns_direct_system: false,
    dns_direct_fallback_proxy: true,
    hijack_dns: [...defaultHijackDns],
    // dns-server 使用国内 DNS 解析节点与直连域名；proxy-dns-server 走代理后再查，可用国外 DoH
    servers: data.dns.domestic,
    fallback_servers: data.dns.domestic,
    proxy_servers: data.dns.overseas,
    always_real_ip: [...defaultAlwaysRealIp],
    host_servers: [],
  };
}

function validate(data) {
  if (!data || data.version !== 1 || !data.targets || !data.rule_sets || !Array.isArray(data.groups) || !Array.isArray(data.routes) || !data.final) throw new Error("必须包含 version、targets、rule_sets、groups、routes 和 final 字段");
  ensureDns(data);
  for (const [name, values] of Object.entries(data.rule_sets)) if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) throw new Error(`规则集「${name}」配置无效`);
  for (const group of data.groups) {
    if (!data.targets[group.target] || !data.targets[group.fallback]) throw new Error(`节点组「${group.target || "未命名"}」引用了未知策略`);
    if (typeof group.pattern !== "string" || !group.pattern) throw new Error(`节点组「${group.target}」缺少节点名称正则`);
    if (!['', 'i'].includes(group.flags || "")) throw new Error(`节点组「${group.target}」正则标志无效`);
    try { new RegExp(group.pattern, group.flags || ""); } catch (error) { throw new Error(`节点组「${group.target}」正则错误：${error.message}`); }
    if (typeof group.url !== "string" || !/^https?:\/\//.test(group.url)) throw new Error(`节点组「${group.target}」测速地址无效`);
    if (!Number.isInteger(group.interval) || group.interval < 0 || !Number.isInteger(group.tolerance) || group.tolerance < 0) throw new Error(`节点组「${group.target}」测速参数无效`);
  }
  for (const route of data.routes) {
    if (!data.targets[route.target]) throw new Error(`规则「${route.name || "未命名"}」引用了未知策略`);
    for (const setName of route.domain_sets || []) if (!Array.isArray(data.rule_sets[setName])) throw new Error(`规则「${route.name || "未命名"}」引用了未知规则集`);
    for (const field of ["domains", "keywords", "cidrs", "geoips"]) if (route[field] && (!Array.isArray(route[field]) || route[field].some((value) => typeof value !== "string" || !value))) throw new Error(`规则「${route.name || "未命名"}」的 ${field} 配置无效`);
    for (const cidr of route.cidrs || []) if (!validCidr(cidr)) throw new Error(`CIDR 无效：${cidr}`);
    if (route.domain_targets || route._domainTargets) throw new Error(`规则「${route.name || "未命名"}」使用了已移除的逐域名目标，请把这些域名改成独立网址`);
  }
  for (const item of data.standalone_urls || []) {
    const value = normalizeStandaloneValue(item.domain);
    if (!item.name || !value || !(domainPattern.test(value) || validCidr(value))) throw new Error(`独立网址无效：${item.domain || "空值"}`);
    if (!data.targets[item.target]) throw new Error(`独立网址「${item.name}」引用了未知策略`);
  }
  for (const item of data.standalone_rules || []) {
    if (!item.name || !data.targets[item.target] || !item.geoips?.length) throw new Error(`GeoIP 规则「${item.name || "未命名"}」配置无效`);
    for (const geoip of item.geoips) if (!/^[A-Z]{2}$/i.test(geoip)) throw new Error(`GeoIP 无效：${geoip}`);
  }
  if (!data.targets[data.final]) throw new Error("final 引用了未知策略");
  const mihomoDns = data.mihomo_dns;
  if (!mihomoDns || typeof mihomoDns !== "object") throw new Error("缺少 mihomo_dns 配置");
  if (mihomoDns.enable !== true || !["arc", "lru"].includes(mihomoDns["cache-algorithm"]) || !["fake-ip", "redir-host"].includes(mihomoDns["enhanced-mode"])) throw new Error("mihomo_dns 基础配置无效");
  for (const field of ["default-nameserver", "fake-ip-filter", "nameserver", "proxy-server-nameserver", "direct-nameserver"]) if (!Array.isArray(mihomoDns[field]) || !mihomoDns[field].length || mihomoDns[field].some((value) => typeof value !== "string" || !value || /[,\r\n]/.test(value))) throw new Error(`mihomo_dns.${field} 配置无效`);
  if (!Array.isArray(mihomoDns.fallback) || mihomoDns.fallback.some((value) => typeof value !== "string" || !value || /[,\r\n]/.test(value))) throw new Error("mihomo_dns.fallback 配置无效");
  const fallbackFilter = mihomoDns["fallback-filter"];
  if (!fallbackFilter || typeof fallbackFilter.geoip !== "boolean" || !Array.isArray(fallbackFilter.geosite) || !Array.isArray(fallbackFilter.ipcidr) || !Array.isArray(fallbackFilter.domain)) throw new Error("mihomo_dns.fallback-filter 配置无效");
  const dns = data.shadowrocket_dns;
  if (!dns || typeof dns !== "object") throw new Error("缺少 shadowrocket_dns 配置");
  for (const field of ["ipv6", "prefer_ipv6", "private_ip_answer", "dns_direct_system", "dns_direct_fallback_proxy"]) if (typeof dns[field] !== "boolean") throw new Error(`shadowrocket_dns.${field} 必须是布尔值`);
  for (const field of ["servers", "fallback_servers", "proxy_servers", "always_real_ip", "hijack_dns"]) if (!Array.isArray(dns[field]) || !dns[field].length || dns[field].some((value) => typeof value !== "string" || !value || /[,\r\n]/.test(value))) throw new Error(`shadowrocket_dns.${field} 配置无效`);
  if (!Array.isArray(dns.host_servers)) throw new Error("shadowrocket_dns.host_servers 配置无效");
}

function clearValidationErrors() {
  document.querySelectorAll("[data-validation-error]").forEach((error) => error.remove());
  document.querySelectorAll("[data-validation-field]").forEach((field) => {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
    delete field.dataset.validationField;
  });
}

function focusValidationField(message) {
  const selectors = message.includes("独立网址") ? ["[data-standalone-name]", "[data-standalone-domain]"]
    : message.includes("GeoIP") ? ["[data-geoip-code]", "[data-rule-target]"]
      : message.includes("节点组") || message.includes("正则") || message.includes("测速") ? ["[data-display]", "[data-field=pattern]", "[data-field=url]", "#group-interval"]
        : message.includes("DNS") || message.includes("mihomo_dns") ? ["#overseas-dns-servers", "#domestic-dns-servers"]
          : ["[data-target-route]", "[data-standalone-domain]", "#group-interval"];
  const field = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
  if (!field) return generatorStatusEl.focus({ preventScroll: true });
  const error = document.createElement("span");
  const id = `validation-error-${Date.now()}`;
  error.id = id;
  error.className = "field-error";
  error.dataset.validationError = "true";
  error.textContent = message;
  field.insertAdjacentElement("afterend", error);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", id);
  field.dataset.validationField = "true";
  field.focus({ preventScroll: true });
}

function render() {
  clearValidationErrors();
  try {
    if (!source) throw new Error("规则源尚未加载");
    validate(source);
    outputEl.value = outputType === "clash" ? renderClash(source) : renderShadowrocket(source);
    const count = rules(source, "MATCH").length;
    const enabled = source.routes.filter((route) => (route.name === LAN_ROUTE || route.name === IPV4_ROUTE) || route.enabled !== false).length;
    summaryEl.textContent = `${formatNumber(count)} 条规则 · ${formatNumber(enabled)} 个策略组 · ${formatNumber((source.standalone_urls || []).length)} 个独立网址 · ${formatNumber((source.standalone_rules || []).length)} 个 GeoIP · 浏览器本地生成`;
    generatorStatusEl.textContent = "规则源校验通过"; generatorStatusEl.className = "generator-status";
    outputStatusEl.textContent = "";
    return true;
  } catch (error) {
    generatorStatusEl.textContent = error.message;
    generatorStatusEl.className = "generator-status error";
    summaryEl.textContent = "规则源无效";
    outputEl.value = "";
    focusValidationField(error.message);
    return false;
  }
}

async function loadDefault() {
  const url = assetUrl("rules-source.json");
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`);
    source = await response.json();
    validate(source);
    setupGenerator(source);
    generatorStatusEl.textContent = "规则源已加载，可开始编辑";
    generatorStatusEl.className = "generator-status";
    summaryEl.textContent = "规则源已加载 · 可开始编辑";
  } catch (error) {
    generatorStatusEl.textContent = `无法加载 rules-source.json：${error.message}`;
    generatorStatusEl.className = "generator-status error";
    summaryEl.textContent = "规则源加载失败";
  }
}

function setupGenerator(data) {
  if (!data.standalone_urls) data.standalone_urls = [];
  data.standalone_rules = (data.standalone_rules || []).flatMap((item) => {
    if (item.geoips?.length) return item.geoips.map((code) => ({ name: geoipName(code), target: item.target, geoips: [String(code).toUpperCase()] }));
    const values = [...(item.domains || []), ...(item.cidrs || [])];
    data.standalone_urls.push(...values.map((value) => ({ name: item.name || value, domain: value, target: item.target })));
    return [];
  });
  let editingRoute = null;
  let drawerTrigger = null;
  const drawer = document.querySelector("#domain-drawer");
  const backdrop = document.querySelector("#drawer-backdrop");
  const isLanRoute = (route) => route.name === LAN_ROUTE;
  const isIpv4Route = (route) => route.name === IPV4_ROUTE;
  const isFixedDirectRoute = (route) => isLanRoute(route) || isIpv4Route(route);
  data.routes.forEach((route) => { if (isFixedDirectRoute(route)) route.enabled = true; });
  const generatorForm = document.querySelector("#generator");
  const pageSections = [generatorForm, document.querySelector("#results"), document.querySelector("footer")].filter(Boolean);
  const setPageInert = (inert) => pageSections.forEach((section) => { section.inert = inert; });
  const confirmRemoval = (label) => typeof window === "undefined" || window.confirm(`确认删除${label}？`);
  const emptyState = (message) => `<p class="empty-state" role="status">${message}</p>`;
  let dirty = false;
  const markDirty = () => { dirty = true; };
  generatorForm.addEventListener("input", markDirty);
  generatorForm.addEventListener("change", markDirty);
  drawer.addEventListener("input", markDirty);
  drawer.addEventListener("change", markDirty);
  generatorForm.addEventListener("click", (event) => { if (event.target.closest("#add-route, #add-standalone, #add-geoip, #add-group")) markDirty(); });
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const renderRoutes = () => {
    const enabledBox = (route, index, badge = "") => `<label class="route-toggle"><input type="checkbox" name="route-enabled-${index}" aria-label="启用 ${escapeHtml(route.name)}" data-route="${index}" ${route.enabled !== false ? "checked" : ""}><strong>${escapeHtml(route.name)}</strong>${badge}</label>`;
    const tableToggle = (route, index) => `<label class="route-table-toggle"><input type="checkbox" name="route-enabled-${index}" aria-label="启用 ${escapeHtml(route.name)}" data-route="${index}" ${route.enabled !== false ? "checked" : ""}><span class="visually-hidden">启用 ${escapeHtml(route.name)}</span></label>`;
    const targetSelect = (selected, label, attribute, index) => `<select name="route-target-${index}" ${attribute}="${index}" aria-label="${escapeHtml(label)}">${Object.entries(data.targets).map(([key, name]) => `<option value="${escapeHtml(key)}" ${selected === key ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select>`;
    const actions = (route, index, editLabel) => `<div class="route-actions"><button type="button" class="edit-domains" data-edit-route="${index}" aria-controls="domain-drawer" aria-haspopup="dialog" aria-expanded="false">${editLabel}</button><button type="button" class="remove-route" data-remove-route="${index}" aria-label="删除分流策略组 ${escapeHtml(route.name)}">删除</button></div>`;
    const renderRoute = (route, index) => {
      const count = routeRuleEntries(data, route).length;
      return `<tr class="route-row"><td class="route-enabled-cell">${tableToggle(route, index)}</td><td class="route-name-cell"><strong>${escapeHtml(route.name)}</strong><p class="route-description">${routeDescriptions[route.name] || "自定义分流规则"}</p></td><td class="route-target-cell">${targetSelect(route.target, `${route.name} 导向节点组`, "data-target-route", index)}</td><td class="route-rule-cell"><span class="route-count">${formatNumber(count)} 条匹配规则</span></td><td class="route-action-cell">${actions(route, index, "编辑规则列表…")}</td></tr>`;
    };
    const renderBaseRoute = (route, index) => {
      const entries = routeRuleEntries(data, route);
      const list = entries.length
        ? `<ul class="base-rule-list">${entries.map(({ kind, value }) => `<li><code>${escapeHtml(value)}</code><small>${escapeHtml(kind)}</small></li>`).join("")}</ul>`
        : `<p class="base-rule-empty">暂无地址</p>`;
      const label = `<div class="base-route-label"><strong>${escapeHtml(route.name)}</strong><span class="base-route-badge">固定直连</span></div>`;
      return `<div class="route-option base-route">${label}<em>${routeDescriptions[route.name] || "局域网、保留地址与特殊网段"} · ${formatNumber(entries.length)} 条地址</em>${list}${actions(route, index, "编辑地址列表…")}</div>`;
    };
    const routes = data.routes.map((route, index) => ({ route, index }));
    const baseRoutes = routes.filter(({ route }) => isLanRoute(route));
    const ipv4Routes = routes.filter(({ route }) => isIpv4Route(route));
    const customRoutes = routes.filter(({ route }) => !isLanRoute(route) && !isIpv4Route(route));
    const routeTable = `<div class="route-table-wrap"><table class="route-table"><caption class="visually-hidden">服务分流策略列表</caption><thead><tr><th scope="col">启用</th><th scope="col">分流策略</th><th scope="col">目标节点组</th><th scope="col">匹配规则</th><th scope="col">操作</th></tr></thead><tbody>${customRoutes.map(({ route, index }) => renderRoute(route, index)).join("")}</tbody></table></div>`;
    document.querySelector("#route-options").innerHTML = customRoutes.length ? routeTable : emptyState("暂无分流策略组；可用下方按钮增加一个。 ");
    document.querySelector("#base-rule-options").innerHTML = baseRoutes.map(({ route, index }) => renderBaseRoute(route, index)).join("");
    document.querySelector("#base-rule-section").classList.toggle("hidden", !baseRoutes.length);
    document.querySelector("#ipv4-rule-options").innerHTML = ipv4Routes.map(({ route, index }) => renderBaseRoute(route, index)).join("");
    document.querySelector("#ipv4-rule-section").classList.toggle("hidden", !ipv4Routes.length);
    document.querySelectorAll("[data-route]").forEach((input) => input.onchange = () => { data.routes[input.dataset.route].enabled = input.checked; });
    document.querySelectorAll("[data-target-route]").forEach((select) => select.onchange = () => { data.routes[select.dataset.targetRoute].target = select.value; });
    document.querySelectorAll("[data-remove-route]").forEach((button) => button.onclick = () => {
      const route = data.routes[Number(button.dataset.removeRoute)];
      if (!route || !confirmRemoval(`「${route.name}」分流策略组`)) return;
      markDirty();
      data.routes.splice(Number(button.dataset.removeRoute), 1);
      editingRoute = null;
      renderRoutes();
    });
    document.querySelectorAll("[data-edit-route]").forEach((button) => button.onclick = () => {
      editingRoute = Number(button.dataset.editRoute);
      drawerTrigger = button;
      const route = data.routes[editingRoute];
      const fixedDirect = isFixedDirectRoute(route);
      let previousGroup = null;
      const renderEntry = (entry, index) => {
        const group = ruleGroupName(route, entry);
        const heading = group === previousGroup ? "" : `<h3 class="drawer-group">${escapeHtml(group)}</h3>`;
        previousGroup = group;
        return heading + ruleRow(entry.kind, entry.value, `${route.name} ${entry.kind} ${index + 1}`);
      };
      document.querySelector("#drawer-title").textContent = fixedDirect ? `${route.name} · 地址列表` : `${route.name} · 规则列表`;
      document.querySelector("#domain-drawer > p").textContent = fixedDirect ? "始终直连；只需维护地址列表。" : "分流方向由策略组统一决定，这里只维护匹配列表。";
      const entries = routeRuleEntries(data, route);
      document.querySelector("#drawer-items").innerHTML = entries.length ? entries.map(renderEntry).join("") : emptyState("暂无规则；可用下方按钮增加一行。 ");
      button.setAttribute("aria-expanded", "true");
      setPageInert(true);
      backdrop.classList.remove("hidden");
      drawer.classList.remove("hidden");
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      document.querySelector("#close-drawer").focus();
    });
  };
  renderRoutes();
  const renderStandalone = () => {
    const items = data.standalone_urls || [];
    const targetOptions = (selected) => Object.entries(data.targets).map(([key, name]) => `<option value="${escapeHtml(key)}" ${selected === key ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    const renderStandaloneRow = (item, index) => `<tr class="standalone-table-row"><td class="standalone-name-cell"><input name="standalone-name-${index}" aria-label="独立网址名称" data-standalone-name="${index}" value="${escapeHtml(item.name)}" placeholder="名称…" autocomplete="off"></td><td class="standalone-domain-cell"><input name="standalone-domain-${index}" aria-label="域名或 IP/CIDR" data-standalone-domain="${index}" value="${escapeHtml(item.domain)}" placeholder="例如 example.com 或 1.2.3.4/32…" inputmode="url" autocomplete="off" spellcheck="false"></td><td class="standalone-target-cell"><select name="standalone-target-${index}" aria-label="目标节点组" data-standalone-target="${index}">${targetOptions(item.target)}</select></td><td class="standalone-action-cell"><button type="button" data-remove-standalone="${index}" aria-label="删除独立网址 ${escapeHtml(item.name || "未命名")}">删除</button></td></tr>`;
    const standaloneTable = `<div class="standalone-table-wrap"><table class="standalone-table"><caption class="visually-hidden">独立网址列表</caption><thead><tr><th scope="col">名称</th><th scope="col">域名或 IP/CIDR</th><th scope="col">目标节点组</th><th scope="col">操作</th></tr></thead><tbody>${items.map(renderStandaloneRow).join("")}</tbody></table></div>`;
    document.querySelector("#standalone-options").innerHTML = items.length ? standaloneTable : emptyState("暂无独立网址；可用下方按钮增加一条。 ");
    document.querySelectorAll("[data-standalone-name]").forEach((input) => input.oninput = () => { data.standalone_urls[input.dataset.standaloneName].name = input.value; });
    document.querySelectorAll("[data-standalone-domain]").forEach((input) => input.oninput = () => { data.standalone_urls[input.dataset.standaloneDomain].domain = input.value.trim(); });
    document.querySelectorAll("[data-standalone-target]").forEach((select) => select.onchange = () => { data.standalone_urls[select.dataset.standaloneTarget].target = select.value; });
    document.querySelectorAll("[data-remove-standalone]").forEach((button) => button.onclick = () => {
      const index = Number(button.dataset.removeStandalone);
      const item = data.standalone_urls[index];
      if (!item || !confirmRemoval(`「${item.name || "未命名"}」独立网址`)) return;
      markDirty();
      data.standalone_urls.splice(index, 1);
      renderStandalone();
    });
  };
  renderStandalone();
  document.querySelector("#add-standalone").onclick = () => { data.standalone_urls.push({ name: "新条目", domain: "example.com", target: "DIRECT" }); renderStandalone(); };
  const renderGeoipRules = () => {
    const items = data.standalone_rules || [];
    document.querySelector("#geoip-options").innerHTML = items.length ? items.map((item, index) => {
      const code = item.geoips?.[0] || "CN";
      return `<div class="geoip-row"><label><span>国家 / 地区</span><select name="geoip-code-${index}" aria-label="国家代码" data-geoip-code="${index}">${geoipOptions(code)}</select></label><label><span>目标节点组</span><select name="geoip-target-${index}" aria-label="GeoIP 目标节点组" data-rule-target="${index}">${Object.entries(data.targets).map(([key, name]) => `<option value="${escapeHtml(key)}" ${item.target === key ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label><button type="button" data-remove-rule="${index}" aria-label="删除 GeoIP ${escapeHtml(geoipName(code))}">删除</button></div>`;
    }).join("") : emptyState("暂无 GeoIP 分流；可用下方按钮增加一条。 ");
  };
  const renderRuleLists = () => {
    renderGeoipRules();
    document.querySelectorAll("[data-geoip-code]").forEach((select) => select.onchange = () => {
      const item = data.standalone_rules[select.dataset.geoipCode];
      const code = select.value.toUpperCase();
      item.geoips = [code];
      item.name = geoipName(code);
    });
    document.querySelectorAll("[data-rule-target]").forEach((select) => select.onchange = () => { data.standalone_rules[select.dataset.ruleTarget].target = select.value; });
    document.querySelectorAll("[data-remove-rule]").forEach((button) => button.onclick = () => {
      const index = Number(button.dataset.removeRule);
      const item = data.standalone_rules[index];
      if (!item || !confirmRemoval(`「${item.name || geoipName(item.geoips?.[0])}」GeoIP 规则`)) return;
      markDirty();
      data.standalone_rules.splice(index, 1);
      renderRuleLists();
    });
  };
  renderRuleLists();
  document.querySelector("#add-geoip").onclick = () => { data.standalone_rules.push({ name: geoipName("CN"), target: "DIRECT", geoips: ["CN"] }); renderRuleLists(); };
  document.querySelector("#add-route").onclick = () => { data.routes.push({ name: `新策略 ${data.routes.length + 1}`, target: "DIRECT", domains: [], keywords: [] }); renderRoutes(); };
  const closeDrawer = () => {
    backdrop.classList.add("hidden");
    drawer.classList.add("hidden");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    setPageInert(false);
    drawerTrigger?.setAttribute("aria-expanded", "false");
    drawerTrigger?.focus();
  };
  document.querySelector("#add-drawer-item").onclick = () => {
    markDirty();
    const items = document.querySelector("#drawer-items");
    items.querySelector(".empty-state")?.remove();
    items.insertAdjacentHTML("beforeend", ruleRow("域名", "", "新规则"));
    items.lastElementChild.querySelector("input").focus();
  };
  document.querySelector("#save-domains").onclick = () => {
    if (editingRoute === null) return;
    const route = data.routes[editingRoute];
    const entries = [...document.querySelectorAll("#drawer-items .drawer-item")]
      .map((row) => ({ kind: row.querySelector("select").value, value: row.querySelector("input").value.trim() }))
      .filter((entry) => entry.value);
    if (entries.length < routeRuleEntries(data, route).length && !confirmRemoval("已清空的规则")) return;
    markDirty();
    const pick = (kind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.value);
    route.domain_sets = [];
    route.domains = pick("域名");
    route.keywords = pick("关键词");
    route.cidrs = pick("IP/CIDR");
    route.geoips = pick("GeoIP");
    if (isFixedDirectRoute(route)) route.target = "DIRECT";
    closeDrawer();
    renderRoutes();
  };
  document.querySelector("#close-drawer").onclick = closeDrawer;
  backdrop.onclick = closeDrawer;
  drawer.onkeydown = (event) => {
    if (event.key === "Escape") return closeDrawer();
    if (event.key !== "Tab") return;
    const focusable = [...drawer.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])")].filter((element) => !element.disabled && !element.closest(".hidden"));
    if (!focusable.length) return;
    const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
    if (document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
  };
  document.querySelector("#group-interval").value = data.groups[0]?.interval ?? 30;
  document.querySelector("#group-tolerance").value = data.groups[0]?.tolerance ?? 10;
  const groupOptions = document.querySelector("#group-options");
  const dnsOptions = document.querySelector("#dns-options");
  const dnsLines = (area) => area.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const applyDns = (overseas, domestic) => {
    data.dns = {
      overseas: overseas.length ? overseas : defaultOverseasDns,
      domestic: domestic.length ? domestic : defaultDomesticDns,
    };
    ensureDns(data);
  };
  const renderDns = () => {
    ensureDns(data);
    dnsOptions.innerHTML = `<div class="dns-card dns-card-simple"><h3>DNS 分工</h3>
      <p class="section-help">节点域名和直连域名使用国内 DNS；代理流量侧再用国外 DoH 防污染。其余选项用内置默认值。</p>
      <label><span>国外 DoH（经代理查询）</span><textarea id="overseas-dns-servers" name="overseas-dns-servers" spellcheck="false" autocomplete="off">${escapeHtml(data.dns.overseas.join("\n"))}</textarea><small>每行一个；Mihomo nameserver / Shadowrocket proxy-dns-server。用 IP 形式 DoH。</small></label>
      <label><span>国内 DNS</span><textarea id="domestic-dns-servers" name="domestic-dns-servers" spellcheck="false" autocomplete="off">${escapeHtml(data.dns.domestic.join("\n"))}</textarea><small>默认使用 223.5.5.5；解析代理节点域名，以及直连站点。</small></label>
    </div>`;
    const overseasArea = document.querySelector("#overseas-dns-servers");
    const domesticArea = document.querySelector("#domestic-dns-servers");
    const sync = () => applyDns(dnsLines(overseasArea), dnsLines(domesticArea));
    overseasArea.oninput = sync;
    domesticArea.oninput = sync;
  };
  const renderGroups = () => {
    groupOptions.innerHTML = data.groups.length ? data.groups.map((group, index) => `<div class="group-row" data-group="${index}">
      <label><span>显示名称</span><input name="group-display-${index}" data-display="${index}" value="${escapeHtml(data.targets[group.target] || group.target)}" autocomplete="off"><small>客户端显示的节点组名称</small></label>
      <label><span>节点名称正则</span><input name="group-pattern-${index}" data-field="pattern" value="${escapeHtml(group.pattern)}" placeholder="例如 新加坡|SG…" autocomplete="off" spellcheck="false"><small>匹配节点名称后加入此组</small></label>
      <label><span>测速服务</span><select name="group-url-${index}" data-field="url">${Object.entries(speedTests).map(([name, url]) => `<option value="${url}" ${group.url === url ? "selected" : ""}>${name}</option>`).join("")}</select><small>用于判断节点连通性和延迟</small></label>
      <button type="button" data-remove-group="${index}" aria-label="删除节点组 ${escapeHtml(data.targets[group.target] || group.target)}">删除</button></div>`).join("") : emptyState("暂无节点组；可用下方按钮增加一个。 ");
    groupOptions.querySelectorAll("[data-display]").forEach((input) => {
      input.oninput = () => { data.targets[data.groups[input.dataset.display].target] = input.value; renderRoutes(); renderStandalone(); renderRuleLists(); };
      input.onchange = () => {
        const group = data.groups[input.dataset.display];
        data.targets[group.target] = input.value.trim() || "未命名节点组";
        syncGroupKeys(data);
        renderGroups();
        renderRoutes();
        renderStandalone();
        renderRuleLists();
      };
    });
    groupOptions.querySelectorAll("[data-remove-group]").forEach((button) => button.onclick = () => {
      const index = Number(button.dataset.removeGroup);
      const removed = data.groups[index];
      if (!removed || !confirmRemoval(`「${data.targets[removed.target] || removed.target}」节点组`)) return;
      markDirty();
      data.groups.splice(index, 1);
      delete data.targets[removed.target];
      data.routes.forEach((route) => { if (route.target === removed.target) route.target = "DIRECT"; });
      data.standalone_urls?.forEach((item) => { if (item.target === removed.target) item.target = "DIRECT"; });
      data.standalone_rules?.forEach((item) => { if (item.target === removed.target) item.target = "DIRECT"; });
      data.groups.forEach((group) => { if (group.fallback === removed.target) group.fallback = "DIRECT"; });
      if (data.final === removed.target) data.final = "DIRECT";
      renderGroups();
      renderRoutes();
      renderStandalone();
      renderRuleLists();
    });
  };
  syncGroupKeys(data);
  renderGroups();
  // syncGroupKeys 会改写 target key；必须重绘引用它们的下拉框，否则生成时会把旧 key 写回规则源
  renderRoutes();
  renderStandalone();
  renderRuleLists();
  renderDns();
  document.querySelector("#add-group").onclick = () => {
    const display = `新节点组 ${data.groups.length + 1}`;
    const target = allocateGroupKey(data, display);
    data.targets[target] = display;
    data.groups.push({ target, pattern: "(节点|Node)", flags: "i", url: speedTests.Gstatic, interval: 30, tolerance: 10, fallback: "DIRECT" });
    renderGroups();
    renderRoutes();
    renderStandalone();
    renderRuleLists();
  };
  flushGenerator = () => {
    groupOptions.querySelectorAll(".group-row").forEach((row) => {
      const group = data.groups[Number(row.dataset.group)];
      row.querySelectorAll("[data-field]").forEach((input) => { group[input.dataset.field] = input.value.trim(); });
      const display = row.querySelector("[data-display]");
      if (display) data.targets[group.target] = display.value.trim() || "未命名节点组";
      group.interval = Number(document.querySelector("#group-interval").value);
      group.tolerance = Number(document.querySelector("#group-tolerance").value);
      if (!group.flags) group.flags = "i";
      if (!group.fallback) group.fallback = "DIRECT";
    });
    data.routes.forEach((route, index) => { const target = document.querySelector(`[data-target-route="${index}"]`); if (target) route.target = target.value; });
    data.standalone_urls.forEach((item) => { item.name = String(item.name || "").trim(); item.domain = normalizeStandaloneValue(item.domain); });
    const overseasArea = document.querySelector("#overseas-dns-servers");
    const domesticArea = document.querySelector("#domestic-dns-servers");
    if (overseasArea && domesticArea) applyDns(dnsLines(overseasArea), dnsLines(domesticArea));
    else ensureDns(data);
    syncGroupKeys(data);
    source = data;
  };
  const generate = () => {
    flushGenerator();
    renderGroups();
    renderRoutes();
    renderStandalone();
    renderRuleLists();
    const valid = render();
    const results = document.querySelector("#results");
    results.classList.toggle("hidden", !valid);
    if (!valid) return;
    const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth";
    results.scrollIntoView({ behavior, block: "start" });
    document.querySelector("#results-title").focus({ preventScroll: true });
  };
  generatorForm.addEventListener("submit", (event) => { event.preventDefault(); generate(); });
  generatorForm.querySelectorAll("textarea").forEach((area) => area.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (generatorForm.requestSubmit) generatorForm.requestSubmit(); else generate();
    }
  }));
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character])); }

const outputTabs = document.querySelectorAll(".tab");
const updateUrlState = (change) => {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const params = new URLSearchParams(location.search || "");
  change(params);
  const query = params.toString();
  const next = `${location.pathname}${query ? `?${query}` : ""}${location.hash || ""}`;
  const current = `${location.pathname}${location.search || ""}${location.hash || ""}`;
  if (next !== current) history.pushState(null, "", next);
};
const setOutputTab = (tab, updateUrl = true) => {
  outputTabs.forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.setAttribute("tabindex", active ? "0" : "-1");
  });
  outputType = tab.dataset.output;
  document.querySelector("#output-panel").setAttribute("aria-labelledby", tab.id);
  document.title = `${tab.textContent} · ${APP_NAME}`;
  if (updateUrl) updateUrlState((params) => { if (outputType === "clash") params.delete("output"); else params.set("output", outputType); });
  render();
};
outputTabs.forEach((tab) => {
  const active = tab.dataset.output === outputType;
  tab.classList.toggle("active", active);
  tab.setAttribute("aria-selected", String(active));
  tab.setAttribute("tabindex", active ? "0" : "-1");
  if (active) {
    document.querySelector("#output-panel").setAttribute("aria-labelledby", tab.id);
    document.title = `${tab.textContent} · ${APP_NAME}`;
  }
  tab.onclick = () => setOutputTab(tab);
  tab.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll(".tab")];
    const current = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    setOutputTab(tabs[next]);
  };
});
const urlDetails = document.querySelectorAll("details[id]");
const detailDefaults = new Map();
urlDetails.forEach((detail) => detailDefaults.set(detail.id, detail.open ? "open" : "closed"));
const applyDetailsFromUrl = (params) => urlDetails.forEach((detail) => {
  const state = params.get(detail.id) || detailDefaults.get(detail.id);
  detail.open = state === "open";
});
applyDetailsFromUrl(new URLSearchParams(typeof location !== "undefined" ? location.search || "" : ""));
urlDetails.forEach((detail) => {
  const defaultState = detailDefaults.get(detail.id);
  detail.addEventListener("toggle", () => {
    const nextState = detail.open ? "open" : "closed";
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search || "" : "");
    if ((params.get(detail.id) || defaultState) === nextState) return;
    updateUrlState((next) => next.set(detail.id, nextState));
  });
});
if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search || "");
  applyDetailsFromUrl(params);
  const selected = params.get("output") || "clash";
  outputTabs.forEach((tab) => { if (tab.dataset.output === selected) setOutputTab(tab, false); });
});
const copyButton = document.querySelector("#copy-button");
copyButton.onclick = async () => {
  if (!outputEl.value) return;
  copyButton.classList.add("is-loading");
  copyButton.disabled = true;
  copyButton.setAttribute("aria-busy", "true");
  // 非 HTTPS（例如手机用局域网 IP 访问）下没有 navigator.clipboard，退回手动复制
  try { await navigator.clipboard.writeText(outputEl.value); outputStatusEl.textContent = "已复制"; }
  catch { outputEl.select(); outputStatusEl.textContent = "已全选，请手动复制（自动复制需要 HTTPS）"; }
  finally { copyButton.classList.remove("is-loading"); copyButton.disabled = false; copyButton.removeAttribute("aria-busy"); }
};
document.querySelector("#download-button").onclick = () => { if (!outputEl.value) return; const ext = outputType === "clash" ? "js" : "conf"; const blob = new Blob([outputEl.value], { type: "text/plain;charset=utf-8" }); const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `traffic-router.${ext}` }); link.click(); URL.revokeObjectURL(link.href); };
loadDefault();
