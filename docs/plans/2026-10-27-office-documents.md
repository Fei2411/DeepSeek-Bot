# Office 文档

- 日期：2026-10-27
- 相关：Issue #613；[桌面应用](2026-10-16-desktop-app.md)、[Bot 运行配置](2026-10-10-bot-runtime.md)

## 为什么

Bot 要能直接处理 .docx/.pptx/.xlsx：打开看结构、检查包健康、定点改内容，用户不装任何东西。DSH 自带一套 Office 技能（python-docx 写文档、LibreOffice Kit 渲染/重算/PDF），缺的是「包级」的那把刀：稳定 id 的结构读取、关系和内容类型检查、跨 run 的定点编辑、修订接受/拒绝、页面对象的盒模型和拼图巡检。

## 桌面应用打包了什么

按 DSH Desktop 的做法，桌面应用随包带一份 payload（`npm run runtime` 从锁定清单下载、SHA-256 校验）：

- CPython + 文档库（python-docx、python-pptx、openpyxl、lxml、Pillow、pandas 等）
- 独立的 Node
- LibreOffice Kit 的 CLI 和原生引擎
- DSH 的七个 Office 技能素材

安装体积多约 245 MB（841 → 1086 MB），下载约 91 MB。无 payload 时 app 照常启动，只是技能缺席——同一份 `office.patch.yml` 在两个插件可用时才生成。

## ds-bot 自己的命令行（`office.js`）

打进 npm 包的单文件 CLI，依赖 Node 内建加打包进去的 XML 解析库，所有运行面通用（桌面应用、DSH Desktop、DSH Web）。退出码：0 成功、1 仍有 finding、2 用法或失败；`--json` 时输出 `{"ok":true,"data":…}` / `{"ok":false,"error":{…}}`（finding 在 `data.findings` 里，ok 仍为 true）。编辑默认另存（`-o`），`--in-place` 才原地写。

- `unpack`/`pack`：把包解成可读 XML（`pack` 还原排版空白并跑 `check --against`）
- `check [--against] [--fix]`：只查会让 Office 拒开或弹修复的问题——XML 良构、内容类型完整、内部关系可达、r:id 引用存在、pptx 形状/幻灯片 id、docx docPr/paraId、`xml:space`、批注 id 一致。`--against` 只看新引入的问题；`--fix` 修安全的几类
- `docx read [--changes]`：正文块按 `p1…`/`t1…` 编号，页眉页脚、脚注尾注、批注及其锚点；修订默认按接受显示，`--changes` 用 `{+插入 (作者)+}` 这类内联标记
- `docx fields`：简单/复杂域的指令与当前结果
- `docx edit --ops`：原子批量 ops——跨 run `replace`（保留起始 run 格式、不进删除文本、正则带 `$1`）、`set_cell`、`set_field`、`insert`、`delete`、`comment`、`accept_changes`/`reject_changes`
- `pptx inventory`：页面尺寸、主题字体、每页每个形状（id/名/类/占位符/英寸盒——含组的坐标变换和布局/母版占位符继承）/逐段文本与 run 字体字号/图片媒体
- `pptx layout [--autofit]`：文本框相交、跑出页面的 finding；`--autofit` 写 `a:normAutofit`；盒内溢出要渲染才能看到
- `pptx slides --order`：按现位置重排，重复位置=复制（slide+rels+备注页+图表+内嵌工作簿），略过的=删除，再跑 clean
- `pptx clean [--dry-run]`：不在 sldIdLst 的页、不可达部件、悬空关系/Override、无引用媒体（docx/xlsx 通用）
- `xlsx inventory` / `xlsx read --sheet [--range]`：工作表状态/维度/单元格与公式计数/合并/表/图、定义名、错误单元格与其公式、无缓存值提示；网格化读出缓存值、公式、ISO 日期
- `sheet`：渲染页拼成标页码的 contact sheet（纯 JS PNG 编解码）

## 两个技能

由 ds-bot 插件注册（provider `ds-bot-office`，仅在宿主挂了 `skills` 服务时生效——cordis 的子 fiber 让它在没技能服务的环境静默缺席，不挡插件启动）：

- `office`（rank 550）：沿用 DSH 的路由 skill 正文，加一条把「结构读取、包检查、定点编辑」指给 `office-tools` 的行，并写明目录里没有的技能在本环境不可用。rank 取 550 是因为同层低值优先——DSH 自带的 office 是 bundled rank 600，用户/项目技能 100–500 仍然压过我们。
- `office-tools`（rank 600）：原创 SKILL.md——命令怎么选、Word/PowerPoint/Excel 各一条工作流、XML 只走 `unpack` + 真解析器 + `pack --against`、收尾标准、新 deck 的排版规则。加载时按环境追加 `{"officeTools":{"node","cli"}}`：node 依次取 `DS_BOT_OFFICE_NODE`（桌面应用 payload）、纯 Node 宿主的 `process.execPath`，否则要求 `load_workspace_dependencies` 的 node，再不行就说明命令不可用；cli 是 `ds-bot/office.js` 的绝对路径，在 asar 里映射到 `app.asar.unpacked`。

DSH 的六个格式/操作技能（office-docx/pptx/xlsx、office-render、office-recalculate、office-export-pdf）原样保留，只有小路由被替换。

## 各运行面的运行时

- 桌面应用：全部可用——payload 的 Python/Node/LibreOffice、DSH 的 Office 技能、`office.js` 全部命令（host 注入 `DS_BOT_OFFICE_NODE`；应用不打 asar，office.js 是普通文件，#679）
- DSH Desktop：DSH 自带的 Python 和渲染器照常，外加我们的 `office.js` 命令（纯 Node 宿主用宿主解释器；否则技能文本指示调 `load_workspace_dependencies` 取 node）
- DSH Web：只有 `office.js` 命令——没有随包的 Python（建新文件受限），没有渲染器（除非用户自己装 DSH 提供的 Office sidecar）

## 不做的

- 不做模板/母题生成；排版规则写成技能文本
- 不做 XSD 校验——`check` 只覆盖「Office 拒开/弹修复」这一档
- `accept_changes`/`reject_changes` 不处理嵌套在字段指令里的修订，也不处理 `w:numberingChange` 的内容回滚（编号变更只去标记不还原编号）

## 升 DSH 版本时

换锁文件版本：从对应 DSH tag 取 `scripts/primary-runtime/lock.json` 覆盖 `app/scripts/primary-runtime.lock.json`，跑 `npm run runtime` 重建 payload，`npm run check-packed` 复验。同时对照新版 `assets/office/SKILL.md` 复核我们的 office 路由。
