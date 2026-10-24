# 移动端客户端 API

- 日期：2026-10-24
- 相关：dsh-go（Android 上的 DSH 客户端）的 Bot 页；[桌面应用](2026-10-16-desktop-app.md)「界面」、[群聊](2026-10-07-group-chat.md)

## 为什么

网页版和桌面应用的界面都是 DSH 网页前端加 `ds-bot` 插件：群聊的历史靠插件在浏览器里拆 `group_relay` 的结果，进行中的一轮靠每秒轮询 `room-progress`，别的状态靠轮询 `state`。手机不一样：

1. **自己画界面。** 手机客户端（dsh-go）用原生控件画 Bot、群聊和详情，不跑 DSH 网页前端，也不跑插件的界面代码。群聊怎么从会话里拆出发言人，这条规则只能有一份，放在服务端。
2. **会断线、会被挂到后台。** SSE 连接在后台会被系统掐断，回来时要知道错过了什么：哪个 Bot 说了话、群里谁交了活、哪张卡在等人。
3. **两边各自升级。** 手机上的 App、手机里装的 `ds-bot`、NAS 上 Docker 里的 `ds-bot` 版本不会一致，需要一个握手说清楚彼此会什么。
4. **流量和体积。** Bot 的头像照片是 data URL，每次 `state` 都带全部照片，手机远程连接时太重。

取舍：

- **两条传输，同一套回答。** 本机和 SSH 隧道仍走 `POST api/bot` 和 `GET api/bot/feed`，DSH 的会话 cookie 鉴权，和桌面应用的窗口一样。远程中继（ds-harness-remote）只转发 DSH 的 Remote 方法、不转发 Fetch 路由，所以同样的调用和直播也注册成 Remote 方法 `dsBot/call` 和 `dsBot/feed`。两条路走同一个处理函数、同一份事件。
- **显示用的条目，不是原始事件。** 群聊和 Bot 私聊都给「谁、说了什么、什么时候」的条目，客户端不需要懂 DSH 的会话事件和 DS Bot 的内部来源标记。
- **提醒放内存。** 提醒只是「回来时补上」的索引，不是记录本身；真正的内容还在会话和 `state.json` 里。所以不落盘，重启后从头计数（`boot` 变了），客户端重新读一遍团队即可。

## 已定的行为

### 版本和握手

- `hello`：`{ client?: { name, version, platform }, api?: [1] }` → `{ api, apiMin, apiMax, plugin: { name, version }, capabilities, boot, seq, revision, readOnly, memory, feed }`。
  - `api` 是双方都会的最高版本；客户端不传时是服务端当前版本；没有交集时是 `null`，客户端提示更新。
  - `capabilities` 列出服务端会的东西（`room-chat`、`notices`、`avatar`、`memory-edit`、`usage-summary` 等）。
  - `boot` 每次 DSH 启动都换；`seq` 是最新一条提醒的序号。
- 版本规则：
  - 只加东西（新接口、新字段、新的条目或提醒种类、新的 feed 事件）不升 `api`，写进 `capabilities`。客户端跳过不认识的字段、种类和事件。
  - 旧客户端会读错的改动才升 `api`；服务端在 `apiMin..apiMax` 之间都照常回答。
- 没有 `hello` 的旧 `ds-bot` 回 `bot/not-found`，客户端据此判断版本太旧。

### 团队和头像

- `state` 照旧。加 `avatars: 'ref'` 时，每张照片换成 `avatar.imageRef`（照片内容的 SHA-256 前 16 位），其他不变。
- `avatar`：`{ botId }` → `{ botId, ref, image }`，没有照片时 `ref` 和 `image` 都是 `null`。客户端按 `ref` 缓存，`ref` 变了再取。
- 角色形象（`avatar.shape`）和默认颜色照旧由客户端按 Bot id 算（`characters.js` 的 `defaultColor`）。

### 私聊

- `chat`、`send`、feed 的 `message` 和 `stream` 照旧（见 `feed.js`）。

### 群聊

- `room-chat`：`{ roomId, cursor? }` → `{ roomId, items, cursor, running, speaking }`，从新到旧分页，每页最多 60 条消息，页内从旧到新。
- 条目：
  - `{ id, kind: 'user', text, images?, time }`：用户的消息，包括一轮进行中插进来的。
  - `{ id, kind: 'bot', botId, name, color?, text, time, duration?, whole?, live? }`：成员的发言，或 Bot 从群外发进来的帖子。`whole: { length, file }` 表示帖子太长、转成了文件，用 `file-text` 读全文。
  - `{ id, kind: 'event', event, botId?, name?, text?, code?, time }`：一轮里的事件，`event` 是 `working`、`approval`、`done`、`stopped`、`failed`、`missed`、`lookup`、`resumed`、`cut`，或定时任务的 `schedule`。
- 一轮进行中时，最新一页在这轮的位置放上目前为止的发言（`live: true`），`running` 为真，`speaking` 是正在说话的成员。这轮结束后，同一条发言的 `id` 不变（`<callId>:<序号>`），客户端可以直接替换。
- 发消息照旧用 `send`（`sessionId` 是群的 id）；停下成员的活照旧用 `stop-member-work`；群里成员的审批照旧用 `approval-answer`。

### 提醒

- 种类：
  - `message`：Bot 在自己的私聊里说了话（Bot 之间的隐藏回合和换段时的固定回复不算）。
  - `group`：成员在群里发言。
  - `done`：成员做完了派给它的活。
  - `question`、`view`：Bot 的私聊里有提问卡、视图卡在等用户。
  - `approval`：Bot 在等用户批准（在群里时带群）。
- 每条：`{ seq, kind, botId, name, roomId?, title?, sessionId?, text, time }`。`name` 是 Bot 现在的名字，`title` 是群名，`text` 最多 300 字、压成一行。
- `notices`：`{ boot?, since? }` → `{ boot, seq, reset, notices }`。`boot` 不一致（重启过）或者 `since` 之后的提醒已经被挤掉时，`reset` 为真，客户端重读团队。内存里最多留 200 条。
- 提醒只说「有事」，不记已读。已读和通知怎么弹由客户端决定。

### 直播（feed）

- `hello` 多带 `api`、`boot`、`seq`，重连后客户端先用 `notices` 补上。
- 新事件 `notice`：一条提醒，内容同上。
- 新事件 `room`：`{ roomId }`，群里有了新的一行、一轮开始或结束，150 毫秒内的合并成一条。客户端重新读这个群的第一页。

### 记忆

- `memory-add`：`{ botId | roomId, scope?, topic?, text }`，`memory-edit`：`{ botId | roomId, scope?, topic?, text, next }`。用户自己写的条目，不经模型；检查和工具一样（长度、像密钥的内容拒绝，`bot/invalid`）。都返回和 `memory-view` 一样的结果。删除照旧用 `memory-forget`。

### 用量

- `usage-summary`：`{ botId, timeZone? }` → `{ botId, day, week, month, models, scanning }`。`day`、`week`、`month` 是最近 24 小时、7 天、30 天的 `{ input, cacheRead, cacheWrite, output, calls }`；`models` 是最近 30 天按模型分的同样数字。

### Remote 方法

- `dsBot/call {endpoint, payload}`：等同于 `POST api/bot` 的一次调用，回答同样是 `{ ok, value }` 或 `{ ok: false, error }`。
- `dsBot/feed {}`：流，每项 `{ event, data }`，事件和 HTTP 直播一样，第一项是 `hello`。读得太慢（积压 512 项）的读者被结束，重新打开后从 `hello` 补上。
- 只在有 Typert Gateway 的 DSH（Web、Desktop）里挂载。插件是纯 JS，没有 Typert 生成器，所以由 Gateway 按 `@Remote` 标记服务这两个方法（它的源码模式）：参数是简单的名字，值只能是 JSON。
- `hello` 多带 `rpc: { call, feed }`，`capabilities` 里有 `rpc`。

### 只读的 DSH

- `hello`、`notices`、`avatar`、`room-chat`、`usage-summary` 在只读的 DSH 上也回答；`memory-add`、`memory-edit` 和其他改动一样拒绝（`bot/read-only`）。

## 不做什么

- 不把已读状态存在服务端：每台设备各看各的。
- 不推送到手机系统（FCM 之类）：客户端连着时才收得到，后台靠客户端自己的保活。
- 不给群聊单独算用量：成员在群里的用量记在成员自己名下。
- 不改网页版和桌面应用用的接口和事件。

## 已知限制

- 远程中继（ds-harness-remote）只转发它白名单里的 Remote 方法：它的白名单加上 `dsBot/call`、`dsBot/feed` 之后，通过中继连上的 DSH 才能用这套接口。SSH 隧道、局域网直连和本机不受影响。
- Remote 方法走 Gateway 的源码模式，参数和回答不按生成的类型校验，只检查是 JSON。
- 旧群（PTC 预设下建的）一轮跑在 `run_code` 里，`room-chat` 认不出这种轮次的发言。
- 提醒不落盘：DSH 重启前没送到的提醒就丢了，客户端只能重读团队。

## 变更
