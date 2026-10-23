# Bot 浏览器插件

团队只选一个后端，每个 Bot 一份 Chromium profile。不配时，桌面里的 `read_browser` 保持只读。

| 目录 | 插件 | Bot 怎么用 |
|---|---|---|
| `refs/` | `ds-bot-browser-refs` | 快照、按编号点击和填写、截图 |
| `script/` | `ds-bot-browser-script` | 一次提交一段脚本 |
| `task/` | `ds-bot-browser-task` | 一个目标，交回答案和步骤 |

DS Bot 里设置 `browserPlugin` 为 `refs`、`script` 或 `task`。三个不会一起挂上。profile 在 `bot/browser-profiles/<botId>/`，群会话用同一个 Bot 的那一份。Bot 之间不复制 cookie。

登录、付款、验证码调用 `browser_handoff`，用户做完再 `browser_resume`。

```sh
npm install
npx playwright install chromium
npm test
node bench/run.mjs
node bench/render-report.mjs
```

模型走 OpenDesign `https://amr-link.open-design.ai/v1`，模型 id 是 `deepseek-v4.1-flash`。密钥用环境变量 `OPENDESIGN_API_KEY`。不要写进仓库。

设计说明在 `docs/plans/2026-10-21-browser-plugins.md`。
