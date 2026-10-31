<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v0.2_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

**[Download DeepSeek Bot for Windows 10/11 (64-bit) / 下载 Windows 10/11（64 位）版](https://github.com/Fei2411/DS-Bot/releases/latest)**, about 212 MB / 约 212 MB. A community project, not an official DeepSeek product. / 社区开源项目，不是 DeepSeek 官方产品。

On that page, download `DeepSeek-Bot-<version>-win-x64.exe`. Double-click it to install; DeepSeek Bot opens when it is done. No administrator rights, no Node or DSH needed. You need a DeepSeek account (you can sign up with a phone number on the spot) or a DeepSeek API key. DeepSeek bills by usage: see [its prices](https://api-docs.deepseek.com/quick_start/pricing). For macOS, Linux or the DSH plugin, see [Install](README.md#install).

在这个页面下载 `DeepSeek-Bot-<版本>-win-x64.exe`，双击就会安装，装好自动打开。不用管理员权限，不用另装 Node 或 DSH。需要一个 DeepSeek 账号（可以当场用手机号注册）或 DeepSeek API Key。DeepSeek 按用量收费，见[价格页](https://api-docs.deepseek.com/quick_start/pricing)。macOS、Linux 和 DSH 插件见[安装](README.zh.md#安装)。

<details>
<summary><b>The browser or Windows warns you, or blocks the installer? / 浏览器或 Windows 提示、拦下了安装包？</b></summary>

The installer is not signed yet, so Windows does not know its publisher.

- Edge says the file is not commonly downloaded: **···** → **Keep** → **Show more** → **Keep anyway**.
- "Windows protected your PC": **More info** → **Run anyway**.
- "Smart App Control blocked …", with no **Run anyway**: there is no safe way around this for an unsigned installer. Use [DSH Desktop with the DS Bot plugin](README.md#install) instead. Do not turn Smart App Control off.
- An antivirus blocks it: check the file first. In Command Prompt, run `certutil -hashfile <file> SHA256` and compare the result with the file's line in `SHA256SUMS.txt` on the release page. If they match, choose to trust the file in the antivirus.
- The installer says it could not uninstall the old version: close DeepSeek Bot and run the installer again. If your antivirus stopped the installer, check and trust it as above first.

Still stuck? [Report an install problem](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml).

安装包还没有签名，所以 Windows 认不出发布者。

- Edge 提示「不常下载」：「···」→「保留」→「显示更多」→「仍然保留」。
- 「Windows 已保护你的电脑」：「更多信息」→「仍要运行」。
- 「智能应用控制已阻止…」，而且没有「仍要运行」：未签名的安装包没有安全的绕过办法，请改用 [DSH Desktop 加 DS Bot 插件](README.zh.md#安装)。不要关掉智能应用控制。
- 杀毒软件拦截：先核对文件。在命令提示符里运行 `certutil -hashfile <文件> SHA256`，和 Release 页上 `SHA256SUMS.txt` 里这个文件的那一行比较，一致后再在杀毒软件里选「信任」。
- 安装时提示卸载旧版失败：先关掉 DeepSeek Bot，再运行一次安装包。杀毒软件拦了安装包时，先按上面的方法核对，选「信任」。

还是装不上？[报告安装问题](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml)。
</details>

**DeepSeek Bot**: the desktop app / 桌面应用 · **DS Bot**: the project and the plugin / 项目和插件 · **DeepSeek Harness (DSH)**: what they are built on / 它们的底层

DS Bot is a bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns DSH into bots. You create your own bots, then talk and work with them.

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Install

**Desktop app (Windows, macOS, Linux)**

The desktop app brings its own DSH, so you don't need to install DSH first. Download it from [Releases](https://github.com/Fei2411/DS-Bot/releases):

- Windows (x64): `DeepSeek-Bot-<version>-win-x64.exe`. Run it; it installs for your user only, without administrator rights. If Windows shows "Windows protected your PC", select **More info** → **Run anyway**. For other warnings and blocks, open **The browser or Windows warns you, or blocks the installer?** at the top of this page.
- macOS: `DeepSeek-Bot-<version>-mac-arm64.zip` for an Apple chip, `DeepSeek-Bot-<version>-mac-x64.zip` for Intel. Safari unzips it by itself; drag **DeepSeek Bot** into **Applications** and open it. When macOS says it cannot check the app, open **System Settings** → **Privacy & Security** and select **Open Anyway**.
- Linux (x64): `DeepSeek-Bot-<version>-linux-x86_64.AppImage` runs on every distribution — make it executable and open it. It mounts through FUSE 2, which you may need to install first (`sudo apt install libfuse2t64` on Ubuntu 24.04+, `sudo dnf install fuse-libs` on Fedora, `sudo pacman -S fuse2` on Arch). On Ubuntu 24.04 and later an AppImage can refuse to start (Ubuntu restricts the sandbox it needs); the `DeepSeek-Bot-<version>-linux-amd64.deb` on Debian/Ubuntu does not have this problem and adds a menu entry.

At the first start the app keeps its data and the Bots' files in your home folder; the start window says where and lets you change it in one click. It offers to copy a Bot team from your DSH (it only reads your DSH). Set up a model in its settings. The Windows app and the Linux AppImage update themselves; the macOS app and the Linux deb tell you when a new version is ready to download.

If the app does not download, install or start, [report an install problem](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml); it needs no diagnostics.

**Desktop app from source (Windows)**

With Node.js 22.19 or later and npm installed, run `.\start.ps1` in PowerShell from this checkout. It prepares and launches the current source, keeping your Bots, chats and model settings in `.ds-bot-local/` between runs. See [source startup](app/README.md#run-from-source-windows).

**As a plugin in DSH**

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

**DSH Desktop (Windows, macOS)**

1. In the sidebar, select **Plugins** → **Add plugin**.
2. In **Package name or address**, enter `ds-bot`. In mainland China, set **Registry** to **Mainland China mirror**.
3. Select **Install**, then **Enable now**. If DSH says the change takes effect at the next start, quit DSH completely and open it again.

If npm is not reachable, in step 2 you can also enter the full path of `ds-bot-<version>.tgz` downloaded from [Releases](https://github.com/Fei2411/DS-Bot/releases), or `github:Fei2411/DS-Bot#v<version>&path:/ds-bot` (needs Git).

DS Bot 0.2.1 and earlier cannot update themselves in DSH Desktop 0.2.1-rc.2 or later: on the Plugins page, remove `ds-bot` and add `ds-bot` again. The Bots, chats and memory stay.

**DSH Web (Windows, macOS, Linux)**

Needs Node.js `22.19` or later, and pnpm.

```sh
npx @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.1-rc.4 web
```

**Docker (NAS, Linux server)**

The [`docker/`](docker/) directory builds an image with DSH Web and DS Bot, for a NAS or any always-on machine. CI is configured to publish a prebuilt linux/amd64 image to GHCR. The container is the Bots' sandbox: they get full access to what you mount into it, and nothing else. See [`docker/README.md`](docker/README.md).

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

### Web search

DS Bot selects its `auto` search provider for the whole profile. If you disable `web-search-auto`, also select another registered search provider in that profile. See [Web search](ds-bot/README.md#web-search) and the [recovery steps](docs/known-issues.md#web-search-fails-everywhere-after-turning-off-web-search-auto).

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

DS Bot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So DS Bot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly: type @ and pick the bot from the list. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to another bot with @. That bot does the work on its own, and the group goes on. While it works, it keeps the group posted, and the group, the sidebar and its own chat show what it is doing. When it is done, it posts the result in the group, and the bot that asked for the work answers. To stop the work, open the group's details.

A group chat has its own memory. What you tell the group stays in the group: its members use it there, and your other chats and the bots outside the group do not see it. You can manage it in the group's details.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Capabilities

Settings → **Capabilities** is a shared library of MCP servers, skills and packs. Add a capability to a Bot in its settings; it is available from that Bot's next message in its own chat and group chats. A local MCP command that a Bot adds needs your approval before it can run. While other Bots use a capability, only you or a Main Bot can change or delete it.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

### Office files

Bots work with Office documents. They can create and edit .docx, .pptx and .xlsx, read a document's structure with stable ids, check a package for the defects Office would refuse, make targeted edits (comments, tracked changes, fields, table cells), reorder or duplicate slides, list workbook errors, and review rendered pages on a contact sheet. The desktop app includes everything needed; in DSH Desktop Bots use DSH's Office runtime plus DS Bot's commands; in DSH Web the inspect, check and edit commands work, while creating files from scratch and rendering pages need the desktop app or DSH Desktop.

## Data

All data stays on your own computer, in `bot/` and `sessions/` in the DSH home folder (`~/.dsh` by default). Uninstalling the plugin does not delete this data.

## Development

The plugin source is in [`ds-bot/`](ds-bot/). For options and internals, see [`ds-bot/README.md`](ds-bot/README.md). For development, tests and how the team works, see [CONTRIBUTING.md](CONTRIBUTING.md). For changes between versions, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): DS Bot is built on the DSH plugin system. Every bot works in DSH sessions and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. DS Bot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
- Everyone who tries DS Bot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

DS Bot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.
