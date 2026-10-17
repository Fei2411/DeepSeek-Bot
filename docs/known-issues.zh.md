# 已知问题

[English](known-issues.md) | 中文

## 还没发出的消息里，「@名字」显示成文件

**在哪里：** 你自己的消息还在等待时：刚按下发送的一瞬间，或者 Bot 正忙、消息在排队的时候。

**会看到什么：** DeepSeek Harness 会把这条消息里的「@」部分画成文件引用，带一个文件图标。下面这些情况还会把名字切错：

| 你输入的 | 等待时显示 |
| --- | --- |
| `@新 Bot 看一下`（名字里有空格） | 文件「新」，后面是「Bot 看一下」 |
| `@Anvil你看下`（名字后面没空格） | 文件「Anvil你看下」 |
| `@Anvil，帮我查`（名字后面直接跟标点） | 文件「Anvil，帮我查」 |

**不受影响的：** 谁来回答。DS Bot 用自己的规则读「@名字」，被点名的 Bot 照样会被叫到。消息发出以后，会正常显示 Bot 的头像和名字。

**小技巧：** 名字后面加一个空格（`@Anvil 你看下`）。这样只要名字里没有空格，等待时也会显示成 Bot。

**原因：** 这些等待中的行由 DeepSeek Harness 自己画，它读「@」时一直读到下一个空格。插件目前改不了它们的显示。

## DS Bot 没有加载：「disabling profile plugin row "bot"」

**在哪里：** DSH Web（或 Desktop）能启动，但没有 DS Bot。日志里有这一行：

```text
dsh: disabling profile plugin row "bot": its declared peer dependencies cannot be validated: Cannot read properties of undefined (reading 'startsWith')
```

换装别的 DS Bot 版本也没用。

**原因：** DeepSeek Harness 加载插件前，会检查 profile 里的每一行插件配置。这条信息表示有一行的 id 是 `bot`，却没有包名。DS Bot 自己加的那一行带有包名 `ds-bot`，所以没有包名的那一行多半来自 profile 文件夹里的文件，比如 `cordis.patch.yml` 里一条已经对不上 DS Bot 那一行的 `- id: bot` 覆盖配置。我们没能复现这个问题，所以还不知道这样的一行是怎么留下来的。

**怎么处理：** profile 文件夹是 `~/.dsh/profiles/web/`（Windows：`C:\Users\<用户名>\.dsh\profiles\web\`）；设置了 `DSH_HOME` 时，是其中的 `profiles/web/`。Desktop 用 `profiles/desktop/`。

1. 退出 DSH。
2. 打开 profile 文件夹里的 `cordis.patch.yml`，找 `id: bot` 但没有 `name: ds-bot` 的一行，删掉这一行。改之前先备份这个文件。
3. 确认同一文件夹的 `package.json` 在 `dependencies` 里有 `ds-bot`。没有的话，重新添加 DS Bot：`npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ds-bot`。
4. 重新启动 DSH。

想知道这一行来自哪里，可以运行 `npx @deepseek-ai/dsh@0.2.1-rc.2 --profile web --dump-config`。它会列出每一行插件配置，以及提供它的文件。如果要报告这个问题，只复制 `id: bot` 的那几行和文件名，不要带上 key 或你不想公开的路径。

删掉整个 profile 文件夹也能解决，但会一并删掉这个 profile 的其他插件和设置（比如模型）。Bot 团队数据在 `~/.dsh/bot/`，两种做法都不会影响它。

## 关掉「web-search-auto」后，所有会话的网页搜索都失败

**在哪里：** 在侧栏的插件页关掉 `web-search-auto` 这一行，或者在 profile 的 `cordis.patch.yml` 里给它写 `disabled: true` 之后，所有会话都受影响，Bot 聊天和普通 Agent 聊天都一样。每次调用 `web_search` 都返回：

```text
Error: configured web provider "auto" is not registered
```

错误码是 `WEB_PROVIDER_CONFIGURED_MISSING`。

**原因：** 不管 `web-search-auto` 这一行开没开，DS Bot 的 `cordis.patch.yml` 都会把 `web` 行的 `searchProvider` 设成 `auto`；而它指定的 provider 不存在时，DeepSeek Harness 不会换用别的 provider。

**怎么处理：** profile 文件夹和上一条里的一样。

1. 退出 DSH。
2. 打开 profile 文件夹里的 `cordis.patch.yml`。在关掉 `web-search-auto` 的那一行旁边，加一条 `web` 行，指定另一个搜索 provider。这一条会替换 `web` 行的整个 config，所以 `fetchProvider` 也要写上：

   ```yaml
   - id: web-search-auto
     name: ds-bot/web-search
     disabled: true
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: deepseek-official
       fetchProvider: http
   ```

3. 重新启动 DSH。

想确认结果，可以运行 `npx @deepseek-ai/dsh@0.2.1-rc.2 --profile web --dump-config`，看 `web` 那一行。另外，有的插件会在 DSH 运行时设置搜索 provider，时间在 profile patch 之后。以后关掉这类插件时，也要再检查一下这个设置。

另见插件 README 的 [Web search](../ds-bot/README.md#web-search) 一节和 issue [#128](https://github.com/Fei2411/DeepSeek-Bot/issues/128)。
