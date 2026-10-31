# 启动页文案：层、键和一张表

- 日期：2026-10-29
- 相关：[启动窗口](2026-10-26-start-window.md)（第 3、4、5、6、7、11 节）、[Windows 上手流程](2026-10-26-windows-onboarding.md)（第 3、4、8 节、用词）、[UI 标准](../design/ui-standard.md) 第 11 节
- 代码：`app/src/start/text.mjs`（唯一的表）、`app/src/start/start.html`、`app/src/start/start.js`、`app/src/first-run.mjs`、`app/src/updates.mjs`、`app/src/main.mjs`、`app/test/start-page.test.mjs`

## 为什么

启动页的字是在两份设计稿里一句一句定下来的，代码里却散在三张表里：页面的 `text.mjs`（118 个键），主进程的 `first-run.mjs`（30 个）和 `updates.mjs`（11 个），后两张用函数拼句子，没有测试盯着。键名按来历起，不按它在页面上是哪一行字：鲸鱼那一行既有 `voice.*` 也有 `title.*`，提示行里有一个 `slow.45.later`，按钮一半是光杆键（`retry`）一半挂在卡片下（`card.recommend.use`），卡片正文散在 `card.*`、`import.*`、`newer.*`、`update.*` 和光杆键里。于是同一句话写了两遍（「换个位置…」「DeepSeek Bot 没有权限在 … 里写文件。」），同一个意思有两三种写法（「不复制 / 先不复制」「不带团队开始 / 先不带团队开始」），标点看情况（鲸鱼的话里只有「团队界面没有加载出来。」带句号，提示行里只有「比平时慢，请再等一会儿。」带句号），用词也走了样（「聊天记录」对「对话」，「群」对「群聊」，英文里 chats 和 conversations 混用）。审一遍 2026-10-29 的表，没有一个键是死的，问题全在结构上。

这份稿只做一件事：**按字在页面上的位置分层，每一层一条写法规则，一个键一句话，一张表，一组测试。** 已定的句子一个字都不改，除非它违反自己那一层的规则；改了的逐条记在「改动的已定设计」里。

## 已定的行为

### 1. 一张表

- 壳里用户看得到的字都在 `app/src/start/text.mjs` 的 `TEXT` 里：启动页的，和挂在启动窗口或主窗口上的系统对话框的（选文件夹、搬数据、导入、更新）。`first-run.mjs` 和 `updates.mjs` 不再有自己的表。
- 中文是源，英文逐键对照；两边键集相同、占位符相同（已有的测试）。
- 占位符 `{name}`；路径、大小、名字、版本都从快照或参数填，表里不写。英文的单复数写在占位符里：`{bots|Bot|Bots}` 填成「1 Bot」「6 Bots」（`t()` 按值是不是 1 选）。中文不用。
- 查字只有一个函数 `t(lang, key, vars)`。语言由 `langOf(locale)` 定（`zh*` → `zh`，其余 `en`），页面从快照拿，主进程用 `app.getLocale()`。
- 产品名不是文案：对话框标题 `DeepSeek Bot`、`DSH Desktop`、`DSH Web` 是常量，不进表、不翻译。
- 表以外不再有用户看得到的中文或英文；主进程里给 Bot 或开发者看的英文错误串（浏览器、cookie 导入、IPC 拒绝）不算文案，不进表。

### 2. 层：键的第一段

键写成 `<层>.<事>[.<部分>]`。第一段只能是下面十个，说的是这行字在页面的哪里，不是它为什么存在。每层一条写法规则（中文；英文照第 4 节）。

| 层 | 在哪里 | 谁在说 | 规则 |
|---|---|---|---|
| `voice.*` | 鲸鱼下面那一行 | 鲸鱼，第一人称、口语 | 一行，不折行，最多 16 字；不加句号，可以问号；可以用口语的动词（「搬过来」） |
| `say.*` | 卡片的第一行（15/20、600） | 鲸鱼 | 最多 12 字；不加句号 |
| `hint.*` | 提示行 | 应用，中性 | 只写接下来要知道的一件事，最多 22 字；不加句号 |
| `card.*` | 卡片正文 | 应用 | 整句，以 。？ 结尾；说出了什么事，怎么办交给按钮；路径放 `code`；`card.<卡>.<部分>`，几张卡共用的放 `card.update.*` |
| `reason.*` | 卡片正文里复用的原因 | 应用 | 整句的以 。 结尾（`reason.place.*` 位置不能用的七个原因、`reason.start.*` 启动失败的五个）；嵌进句子的片段不带标点（`reason.copy.*` 复制失败的三个） |
| `btn.*` | 按钮 | 用户的动作 | 最多 10 字，动词或动作短语开头；打开系统选择框或离开这张卡的以 … 结尾；不加句号；链接样式的小按钮可以是名词短语（「其他位置…」「详细」） |
| `note.*` | 卡片脚注 | 应用 | 一句，以 。 结尾，说以后在哪里改 |
| `foot.*` | 底注行 | 应用 | 不加句号（「社区开源项目，不是 DeepSeek 官方产品」、位置行） |
| `status.*` | 只给读屏和计数 | 应用 | 不加句号：隐藏列表「启动进度」、三个阶段名、四个状态词、朗读句、「已用 N 秒」 |
| `dialog.*` | 系统对话框的正文和标题 | 应用 | 正文整句以 。？ 结尾，可以两段（`\n\n`）；选择框标题不加句号；按钮用 `btn.*` |

- 同一句话只有一个键；两层里都要的同一句，各自一键（提示行的「C 盘只剩 1.2 GB」和卡片里的「C 盘只剩 1.2 GB。」是两层两键）。
- 同一个意思只有一种写法：「先不复制」（不复制团队，继续）和「先不带团队开始」（放弃复制、带空白团队启动）是两个意思，各一种写法；对话框里原来的「不复制」「不带团队开始」改成这两句。
- 一个东西一个名字（上手流程「用词」）：对话（不是聊天记录）、群聊（不是群）、API Key（不是密钥）、附件、总工作区、数据文件夹、位置（设置项，英文 Location，单数）。鲸鱼的话可以口语（「正在搬过来」），按钮和正文用正式名（「复制过来」「停止复制」）。
- 不写过程词：马上、稍后、下个版本（UI 标准第 11 节；测试扫全表）。「待会儿要接一个模型」说的是用户的下一步，不是引擎的承诺，留着。

### 3. 键的对照

旧键 → 新键，中文照旧的不写，改了的写出来。

鲸鱼的话 `voice.*`：`voice.hello / helloName / helloBack / data / found / engine / slow10 / slow45 / team / ready / watchdog` 不动；`title.later` → `voice.opening`，`title.moving` → `voice.moving`，`title.failed` → `voice.failed`，`title.viewFailed` → `voice.viewFailed`「团队界面没有加载出来」（去句号）。

卡片第一行 `say.*`：`say.space / permission / rejected / picked / missing / import / importSpace / inUse / newer` 不动；`copying.title` → `say.copying`「正在搬过来」。

提示行 `hint.*`：`hint.model / preview / reinstall / space` 不动；`slow.45.later` → `hint.slowLater`「比平时慢，请再等一会儿」（去句号）。

卡片正文 `card.*`：

| 旧 | 新 | 中文 |
|---|---|---|
| `card.recommend.ask` | `card.recommend.ask` | 放到 {rec} 盘（剩 {recFree}）？ |
| `card.reason.space`、`card.reason.permission` | 见 `reason.place.*` | |
| `card.rejected.*` | 见 `reason.place.*` | 卡片直接用 `reason.place.{reason}` |
| `card.missing` | `card.missing.lead` | |
| `card.missing.retryMissed` | `card.missing.retryMissed` | |
| `card.picked` | `card.picked.lead` | 会放在 {path}。（加句号） |
| `import.lead / extra / found / scope / model` | `card.import.lead / extra / found / scope / model` | |
| `import.opt.regen / skipWork` | `card.import.optRegen / optSkipWork` | 勾选框的标签 |
| `import.space` | `card.importSpace.lead` | |
| `copying.step1 / 2 / 3` | `card.copying.step1 / 2 / 3` | |
| `eta.minutes`、`eta.lt1` | `card.copying.eta`、`card.copying.etaSoon` | |
| `stop.confirm` | `card.copying.stopConfirm` | |
| `inUse` | `card.inUse.lead` | |
| `newer.updating`、`newer.unreadable` | `card.newerUpdating.lead`、`card.newer.lead` | |
| `importFailed` | `card.importFailed.lead` | |
| `failed.reason.*` | 见 `reason.start.*` | 卡片直接用 `reason.start.{reason}` |
| `update.available / downloading / installing / failed / slow` | `card.update.available / downloading / installing / failed / slow` | |

原因 `reason.*`：

| 新 | 中文 | 来自 |
|---|---|---|
| `reason.place.space` | {drive} 盘只剩 {free}。 | `card.reason.space` |
| `reason.place.permission` | DeepSeek Bot 没有权限在 {path} 里写文件。 | `card.reason.permission` 和 `card.rejected.permission` 合一 |
| `reason.place.onedrive` | {path} 在 OneDrive 里，同步会打断正在写入的对话。 | `card.rejected.onedrive`（聊天记录 → 对话） |
| `reason.place.foreign / dsh / program / nested` | 照旧 | `card.rejected.*` |
| `reason.start.permission / space / files / engine / other` | 照旧，带句号 | `failed.reason.*` |
| `reason.copy.inUse / permission / full` | 照旧，片段 | `importFailed.*` |

按钮 `btn.*`：

| 旧 | 新 | 中文 |
|---|---|---|
| `retry`、`wait`、`openLogs`、`freshStart` | `btn.retry`、`btn.wait`、`btn.openLogs`、`btn.freshStart` | |
| `card.recommend.use`、`card.recommend.keep` | `btn.useRec`、`btn.keepDrive` | 放到 {rec} 盘、仍然放在 {drive} 盘 |
| `card.recommend.other` | `btn.otherPlace` | 其他位置…（链接样式） |
| `pickOther` | `btn.pickPlace` | 选择其他位置… |
| `place.change`、`changePlace` | `btn.changePlace` | 换个位置…（合一；英文 Change the location…） |
| `card.missing.relocate` | `btn.relocate` | 重新找到它… |
| `card.picked.use`、`card.picked.repick` | `btn.continue`、`btn.repick` | 继续、重新选…（加 …：它打开系统选择框） |
| `import.copy`、`import.skip` | `btn.copy`、`btn.skipCopy` | 复制过来、先不复制 |
| `import.more`、`import.change` | `btn.more`、`btn.changeModel` | 详细、更换 |
| `stop`、`keepCopying` | `btn.stopCopy`、`btn.keepCopying` | 停止复制、继续复制 |
| `startWithout` | `btn.startWithout` | 先不带团队开始 |
| `copyDetails`、`copied`、`details` | `btn.copyDetails`、`btn.copied`、`btn.details` | |
| `update.install`、`manualDownload`、`reload` | `btn.install`、`btn.manualDownload`、`btn.reload` | |
| 对话框的 `move`、`cancel`、`quit`、`restart`、`download` | `btn.move`、`btn.cancel`、`btn.quit`、`btn.restart`、`btn.download` | 移动并重启、取消、退出、立即重启、下载 |
| 对话框的 `copy`、`skip`、`startEmpty` | 并入 `btn.copy`、`btn.skipCopy`、`btn.startWithout` | 复制过来、先不复制、先不带团队开始 |
| 更新框的 `later` | `btn.notNowRestart`、`btn.notNowDownload` | 先不重启、先不下载（「稍后」是过程词） |
| 写死的 `'OK'` | `btn.ok` | 确定 |

脚注 `note.*`：`card.footnote` → `note.changeLater`「以后可以在 设置 → 通用 → 位置 里改。」；`import.footnote` → `note.copyLater`「也可以在 设置 → 通用 → 位置 里复制。」；`newer.footnote` → `note.copyAgain`「以后可以在 设置 → 通用 → 位置 里复制。」（和 `note.changeLater` 同一个句式）。

底注 `foot.*`：`footer` → `foot.community`；`place.drive / driveOnly / path / pathOnly` → `foot.place.drive / driveOnly / path / pathOnly`。

状态 `status.*`：`track.label` → `status.track`；`phase.*` → `status.phase.*`；`state.*` → `status.state.*`；`sr.*` → `status.sr.*`；`elapsed` → `status.elapsed`。

对话框 `dialog.*`（原来在 `first-run.mjs` 和 `updates.mjs`）：

| 新 | 中文 |
|---|---|
| `dialog.pickRoot` | 选择 DeepSeek Bot 放数据的位置 |
| `dialog.pickMove` | 选择 DeepSeek Bot 数据的新文件夹 |
| `dialog.move.inDsh` | 请选择 DeepSeek Harness 数据（{home}）以外的文件夹。 |
| `dialog.move.inProgram / drive / nested / workspace / notEmpty` | 照旧 |
| `dialog.move.confirm`、`dialog.move.detail` | 把 DeepSeek Bot 的数据移到 {to} 吗？ / DeepSeek Bot 会把数据复制过去，然后重新启动。{from} 会原样保留，确认一切正常后可以自己删掉。 |
| `dialog.move.inUse`、`dialog.move.failed` | 照旧（`{message}`） |
| `dialog.import.found` | DeepSeek Harness 里有 {bots} 个 Bot 和 {groups} 个群聊。要复制到 DeepSeek Bot 吗？（原来 0 个群聊时不写群；现在和导入卡一样总写） |
| `dialog.import.foundDetail` | 会复制 Bot、群聊、记忆、对话、附件、模型设置和 API Key。{home} 里的内容不会改变，复制以后两边各用各的。（群 → 群聊，密钥 → API Key，文件 → 附件，和 `card.import.scope` 一致） |
| `dialog.import.inUse` | DeepSeek Harness 正在使用这个团队。请先关掉它，再重试。 |
| `dialog.import.newer` | 有 {n} 段对话是更新版本的 DeepSeek Harness 写的，这个版本的 DeepSeek Bot 读不了。请先更新 DeepSeek Bot，再打开它来复制团队。 |
| `dialog.import.whichModels` | DeepSeek Bot 用哪一份模型设置？ |
| `dialog.import.failed` | 团队没有复制完：{message}\n\nDeepSeek Bot 会用一个新团队开始。DeepSeek Harness 里的团队没有变化。（没有复制成功 → 没有复制完，和 `card.importFailed.lead` 一致） |
| `dialog.update.ready`、`dialog.update.readyDetail` | DeepSeek Bot {version} 已经下载好。 / 现在重启就能更新；不重启的话，下次退出时安装。（英文改成 has finished downloading，原来说的是 ready to install） |
| `dialog.update.available`、`dialog.update.availableDetail` | 照旧 |
| `dialog.update.onFailure`、`dialog.update.onFailurePage` | 照旧 |

### 4. 英文

- 逐键对照中文的意思，不另写一套：位置行写全「Data on drive {drive}, {free} free」（原来只有「Drive C, 412 GB free」）。
- 句首大写；`voice / say / hint / btn / foot / status` 不加句号；`card / reason（整句）/ note / dialog` 以句号或问号结尾；… 和中文同步。
- 名词：chats（不用 conversations）、group chats、attachments、API Key、Settings → General → Location（单数）、team workspace、data folder、local engine。
- 单复数用 `{n|one|many}`：`hint.reinstall`「Your {bots|Bot|Bots} and {groups|group chat|group chats} are still here」、`card.import.lead`、`card.import.found`、`dialog.import.found`、`dialog.import.newer`。
- 「先不复制」是 Don't copy yet，「先不带团队开始」是 Start without the team，「先不重启」Not now（重启框）、「先不下载」Not now（下载框）。

### 5. 测试

`app/test/start-page.test.mjs` 扫 `text.mjs` 全表、`start.html`、`start.js`、`whale.js`，以及 `main.mjs`、`first-run.mjs`、`updates.mjs`：

- 已有的：中英键集和占位符相同；中文里没有白名单外的英文；没有 马上 / 稍后 / 下个版本；页面用到的键都在表里。
- 新加的：
  - 每个键的第一段是十层之一。
  - `voice / say / hint / btn / foot / status` 的中文不以 。 结尾，英文不以 . 结尾；`card / note / dialog` 的整句以 。？ 结尾（`reason.copy.*`、`card.update.slow`「下载太慢？」、选择框标题、`card.copying.step*`、`card.copying.eta*`、`card.import.model`、`card.import.opt*`、进度行 `card.update.downloading` 除外，测试里列明）。
  - 字数上限（去掉占位符后）：`voice` 16、`say` 12、`hint` 22、`btn` 10。
  - `start.html` 里 `data-act="pick"` 的按钮，键的中文以 … 结尾。
  - 主进程三个文件里 `tx('…')` 用到的键都在表里；`first-run.mjs` 和 `updates.mjs` 里没有自己的字符串表。
  - `t()` 的单复数：`{bots|Bot|Bots}` 在 1 和 6 上各填对。

## 改动的已定设计

| 原来 | 现在 | 原因 |
|---|---|---|
| 启动窗口稿第 7 节、上手流程第 3 节：鲸鱼的话「团队界面没有加载出来。」 | 「团队界面没有加载出来」 | 鲸鱼那一行不加句号，和「DeepSeek Bot 没能启动」一致 |
| 启动窗口稿第 5 节、上手流程第 8 节：45 秒「比平时慢，请再等一会儿。」 | 「比平时慢，请再等一会儿」 | 提示行不加句号 |
| 启动窗口稿第 6 节、上手流程第 3 节：「会放在 `D:\DeepSeek Bot`」〔继续〕〔重新选〕 | 「会放在 `D:\DeepSeek Bot`。」〔继续〕〔重新选…〕 | 卡片正文以句号结尾；打开系统选择框的按钮以 … 结尾（被拒绝的卡上的〔重新选…〕一样） |
| 启动窗口稿第 6 节：「…在 OneDrive 里，同步会打断正在写入的聊天记录。」 | 「…正在写入的对话。」 | 一个东西一个名字 |
| 上手流程第 4 节：更新版本那张卡的脚注「可以在 设置 → 通用 → 位置 里再复制。」 | 「以后可以在 设置 → 通用 → 位置 里复制。」 | 和「以后可以在 … 里改。」同一个句式 |
| `first-run.mjs`：导入对话框〔复制〕〔不复制〕〔不带团队开始〕 | 〔复制过来〕〔先不复制〕〔先不带团队开始〕 | 和导入卡同一种写法；对话框只到导入卡落地（M5）为止 |
| `first-run.mjs`：「DeepSeek Harness 里有一个 Bot 团队：6 个 Bot、2 个群。」「会复制 Bot、群、记忆、对话、文件、密钥和模型设置。」 | 「DeepSeek Harness 里有 6 个 Bot 和 2 个群聊。要复制到 DeepSeek Bot 吗？」「会复制 Bot、群聊、记忆、对话、附件、模型设置和 API Key。…」 | 群聊、附件、API Key 是定下的名字 |
| 桌面应用稿 安装和更新、`updates.mjs`：更新框的〔稍后〕 | 〔先不重启〕〔先不下载〕 | 稍后是过程词，UI 标准第 11 节 |
| `main.mjs`：搬数据被拒绝的框只有英文的〔OK〕 | 〔确定〕/〔OK〕按语言 | 表以外不再有用户看得到的字 |

## 不做什么

- 不改任何一句的意思；上面没列的句子一个字不动。
- 不把插件里（团队界面、设置、Main Bot 聊天里的卡）的文案搬进这张表：那些在 `i18n.js`，源语言是英文（UI 标准第 11 节）。上手流程第 4、8 节里属于设置和聊天的句子不在这里。
- 不给启动页加新的句子。上手流程第 3 节定了〔重新找到它…〕选到没有数据的文件夹时写「这里没有 DeepSeek Bot 的数据。」，`.deepseek-bot` 标记还没落地，这句等那一步一起加（`card.missing.noData`）。
- 不改 `dialog.move.detail` 说的「{from} 会原样保留」：它说的是今天代码的行为；上手流程第 8 节「搬是搬，旧位置不留副本」落地时一起改。
- 不改 `dialog.update.availableDetail` 里「应用程序」文件夹的说法（macOS 的话也给了 Linux deb）：属于更新流程，另记。

## 已知限制

- 字数上限按中文字符数算，去掉占位符后，一串连着的英文字母或数字（DeepSeek、GB）算一个字；英文不限长度：英文是否折行由样式决定，一行放不下时先改句子。
- 单复数只有英文 1 和多两种形，够启动页用；别的语言不在范围里。
- 测试里的「以 … 结尾」只查 `data-act="pick"` 的按钮；对话框里打开选择框的按钮（没有）不在内。

## 变更

- 2026-10-29 首稿：十层、一张表、键的对照、测试；对应 `text.mjs` 重排、`first-run.mjs` 和 `updates.mjs` 的表并入、`start.html` 和 `start.js` 改键。依据：2026-10-29 对三张表的审读（30 个对话框键和 11 个更新键都在用，没有死键；页面表和两份设计稿逐句对照只有 `failed.reason.*` 的句号一处不同；风格问题 30 条，全部复核过）。
