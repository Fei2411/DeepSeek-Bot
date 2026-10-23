# 浏览器插件：全团队一个后端，每个 Bot 一份 profile

- 日期：2026-10-21
- 相关：改 [浏览器、搜索、密钥和连接器](2026-10-08-browser-and-secrets.md) 里「Bot 不操作浏览器」。维护者确认：那条是等这次做的。
- 代码：`ds-bot/src/host/browser-plugins.js`、`ds-bot/src/host/browser/`、`browser-plugins/`

## 为什么

Bot 要替用户在网页上做事，只读面板不够。外面已经有很多浏览器后端：browser-use、Playwright、Stagehand、ego lite、Hermes 的 `browser_exec`、OpenCode 的 browser 工具，以及一堆 DSH 插件。DSH 官方的 browser-use 子系统一次只能挂一个 provider，浏览器属于那一个活着的 Session，换段或重开会丢掉登录。

Bot 是长期身份。登录应该跟着 Bot 走，而不是跟着某一段对话走。同时不能这个 Bot 用一套、那个 Bot 用另一套：团队只选一个后端。浏览器本身仍然分开，cookie 不在 Bot 之间串。

## 已定的行为

- 团队配置 `browserPlugin`，取值 `refs`、`script`、`task` 之一。不配就和以前一样，只有桌面里的只读 `read_browser`。三个值不会同时注册。
- 选定之后，每个 Bot 用同一套工具。Bot 自己的会话、它在每个群里的会话、以及这些会话换段之前的 id，都解析到同一个 Bot，打开同一份 profile：`bot/browser-profiles/<botId>/`。
- 不同 Bot 的目录不复制、不共享。用户要两个 Bot 登同一个站，就各自登一次。以后如果要「把这份登录复制给另一个 Bot」，做成显式动作，不自动同步。
- 群聊各用各的浏览器，也就是各用各的 Bot profile，不设一个群共用的浏览器。
- 页面正文仍然是数据，不当成用户的指令。
- 浏览、点击、输入、选择、筛选、登录表单和普通设置默认放行，不按 DSH 权限预设分级。
- 只有发帖、上传、下载、删除需要用户授权。Bot 在设置的「浏览器」页获得匹配网站和操作类型的预授权时直接执行；否则走 DSH 审批卡片，审批只允许本次操作。预授权可设过期时间。
- 删除无论有没有预授权，都先返回核对快照；Bot 必须在检查目标后用 `browser_click` 的 `confirm: true` 再点同一个元素，且页面 URL 和标签都必须匹配，才进入正常授权流程。
- 付款、购买、转账等操作永远不由 Bot 执行；付款详情也不由 Bot 输入。Bot 调用 `browser_handoff`（或脚本里的 `handoff`），由用户完成。登录或验证码也可交给用户；交接后点击、输入、打开页面都会停住，直到 `browser_resume`。不另设域名名单，也不拦截内网地址。
- 上传只允许使用 Bot 的工作目录或 `browser-downloads/<botId>/` 中的文件，链接目标在校验前解析。
- 已授权的发帖、上传、下载、删除若结果未知，会按来源记录，要求先用快照核实；页面仍未观察前，不允许重复同来源的操作。下载文件保存到 Bot 独立的 `browser-downloads/<botId>/` 目录。
- 三个插件：
  - `refs`：打开、快照、按编号点击和填写、截图。每一步留在会话里，可以核对。快照会读进开放的 Shadow DOM 和同源 iframe。
  - `script`：一次提交一段 JavaScript，帮手已经在作用域里。这是 Hermes `browser_exec` 和 ego heredoc 的形状。
  - `task`：一个目标进去，插件自己用 `refs` 的工具跑完，交回答案和步骤。
- 截图作为图片块交给模型。后面的模型按多模态来用，不把 Flash 当成纯文本。
- 桌面里那个用户自己看的面板还在，它不是这三个插件驱动的 Chromium。两边的 cookie 不自动对齐。

## 不做什么

- 不在 Bot 之间同步 cookie。
- 不把 Chrome DevTools MCP 做成可选后端。它留在调研里，不进这三个插件。
- 不在这台没有 ego lite 的环境里假装测过 ego。
- 默认不打开任何一个插件，所以现有的只读行为不变。选定之前不合进 `dev`。

## 已知限制

- 插件驱动的是 Playwright 的 Chromium profile，不是桌面面板里的 Electron webview。用户暂时不能在面板里看着 Bot 点。
- 单独把 `browser-plugins/*` 装进一个没有 DS Bot 的 DSH profile 时，profile 按 Session id 分开，换段会像官方 browser-use 一样丢掉登录。跟 Bot 走的那份目录只有 DS Bot 挂载时才有。
- `task` 在插件内部再调一次模型，步骤在工具结果里，不在 Bot 自己的逐步工具调用里。
- 这次实测用的是自建多步页面，加上 WebVoyager 里两条 arXiv 任务，不是整套 600 多条。

## 变更

- 2026-10-21：维护者定下全团队一个后端、每 Bot 一份 profile、cookie 不同步。三个插件和实测在同一分支，默认关闭。
- 2026-10-22：实测模型是 OpenDesign 上的 `deepseek-v4.1-flash`（`https://amr-link.open-design.ai/v1`），密钥用 `OPENDESIGN_API_KEY`。
- 2026-10-23：维护者定下权限规则：默认放行；发帖、上传、下载、删除按预授权或审批；删除强制多核对一轮；付款一律交给用户；预授权可设时限，在设置的浏览器页管理。
