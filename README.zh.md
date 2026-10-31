<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.2_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

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

DS Bot 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的 bot 插件，插件将 dsh 改造为 bot 形式。你可以与自己创建的 bot 交流、工作。

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.zh.png)

## 安装

**桌面应用（Windows、macOS、Linux）**

桌面应用自带 dsh，不用先装 dsh。在 [Releases](https://github.com/Fei2411/DS-Bot/releases) 里下载：

- Windows（x64）：`DeepSeek-Bot-<版本>-win-x64.exe`。运行它即可安装，只装给当前用户，不要管理员权限。如果提示“Windows 已保护你的电脑”，点 **更多信息** → **仍要运行**。其他提示和拦截，打开本页开头的 **浏览器或 Windows 提示、拦下了安装包？**。
- macOS：Apple 芯片下载 `DeepSeek-Bot-<版本>-mac-arm64.zip`，Intel 下载 `DeepSeek-Bot-<版本>-mac-x64.zip`。Safari 会自动解压；把 **DeepSeek Bot** 拖进 **应用程序**，再打开。如果提示无法检查这个 App，打开 **系统设置** → **隐私与安全性**，点 **仍要打开**。
- Linux（x64）：`DeepSeek-Bot-<版本>-linux-x86_64.AppImage` 通用于所有发行版——加上可执行权限后打开即可。它通过 FUSE 2 挂载，可能需要先安装（Ubuntu 24.04+ 用 `sudo apt install libfuse2t64`，Fedora 用 `sudo dnf install fuse-libs`，Arch 用 `sudo pacman -S fuse2`）。Ubuntu 24.04 及以后版本会限制 AppImage 需要的沙箱，AppImage 可能因此拒绝启动；Debian/Ubuntu 上的 `DeepSeek-Bot-<版本>-linux-amd64.deb` 没有这个问题，还会加菜单项。

第一次打开时，App 把数据和 Bot 的文件放在你的用户文件夹里，启动窗口上写着放在哪，点一下就能换；并可以从你的 dsh 复制 Bot 团队（只读取你的 dsh，不改它）。在 App 的设置里配好模型就能用。Windows 版和 Linux 的 AppImage 会自动更新；macOS 版和 Linux 的 deb 有新版本时会提示你下载。

下载不了、装不上或打不开时，[报告安装问题](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml)，不需要诊断信息。

**从源码启动桌面应用（Windows）**

安装 Node.js 22.19 或以上版本及 npm 后，在仓库目录用 PowerShell 运行 `.\start.ps1`。脚本自动准备并启动当前源码，Bot、聊天记录和模型配置持久保存在 `.ds-bot-local/`，重启后继续使用。见[源码启动说明](app/README.md#run-from-source-windows)。

**作为 dsh 插件**

先装好 dsh，并在 dsh 里配好至少一个模型。ds bot 直接使用 dsh 里的模型。

**dsh Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `ds-bot`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**。如果提示“下次启动生效”，完全退出 dsh 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/Fei2411/DS-Bot/releases) 里下载的 `ds-bot-<版本>.tgz` 的完整路径，或者 `github:Fei2411/DS-Bot#v<版本>&path:/ds-bot`（需要装 Git）。

DS Bot 0.2.1 及更早的版本在 DSH Desktop 0.2.1-rc.2 及以后的版本里不能自己更新：在插件页移除 `ds-bot`，再添加 `ds-bot`。Bot、聊天和记忆都会保留。

**dsh Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.1-rc.4 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.1-rc.4 web
```

**Docker（NAS、Linux 服务器）**

[`docker/`](docker/) 目录构建一个带 dsh Web 和 DS Bot 的镜像，适合 NAS 或其他常开的机器。CI 已配置为向 GHCR 发布 linux/amd64 预构建镜像。容器就是 bot 的沙箱：bot 对挂进容器的目录有完全权限，其他的碰不到。见 [`docker/README.md`](docker/README.md)（英文）。

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

### 网页搜索

DS Bot 会把 `auto` 搜索 provider 选为整个 profile 的后端。禁用 `web-search-auto` 时，也要为该 profile 选择另一个已注册的搜索 provider。详见[网页搜索说明](ds-bot/README.md#web-search)和[恢复步骤](docs/known-issues.zh.md#关掉-web-search-auto-后所有会话的网页搜索都失败)。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 ds bot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

ds bot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。ds bot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你：输入 @，从列表里选 bot 就行。想让 bot 参考另一段对话，点输入框的 + → 引用对话。

任何 bot 都可以用 @ 把活派给另一个 bot。接活的 bot 自己去做，群聊照常进行。它干活时会在群里同步进度，群聊、侧边栏和它自己的聊天里也能看到它在做什么。做完后，它把结果发到群里，由派活的 bot 接着回应。要停下它的工作，打开群聊详情。

群聊有自己的记忆。你在群里交代的事留在群里：群成员在这个群里会用到，你的其他对话和群外的 bot 都看不到。你可以在群聊详情里管理它。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 能力

设置 → **能力** 是团队共享的 MCP 服务、技能和能力包列表。在 Bot 设置中启用能力后，从该 Bot 下一条消息开始生效，也适用于它参与的群聊。Bot 添加的本地 MCP 命令需要你先批准才能运行。有其他 Bot 在用的能力，只有你或主 Bot 能修改、删除。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.zh.png)

### Office 文件

Bot 可以处理 Office 文档：创建和编辑 .docx、.pptx、.xlsx；按稳定 id 读文档结构；检查会让 Office 拒开的包缺陷；定点编辑（批注、修订、域、表格单元格）；幻灯片重排与复制；列出工作簿错误；渲染成图片并按拼图检查。桌面应用已全部带上；在 DSH Desktop 里用 DSH 自己的 Office 运行时加 DS Bot 的命令；在 DSH Web 里检查、校验、编辑类命令可用，从头建文件和渲染页面需要桌面应用或 DSH Desktop。

## 数据

所有数据都在你自己的电脑上，在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载插件不会删除这些数据。

## 开发

插件源码在 [`ds-bot/`](ds-bot/)。配置项和内部结构见 [`ds-bot/README.md`](ds-bot/README.md)，开发、测试和协作方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：ds bot 建在 dsh 的插件系统上。每个 bot 都在 dsh 会话里工作，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。ds bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 ds bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

ds bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
