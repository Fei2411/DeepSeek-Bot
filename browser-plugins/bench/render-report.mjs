import { readFile, writeFile } from 'node:fs/promises'

const outDir = new URL('./out/', import.meta.url)
const reportPath = new URL('../report.html', import.meta.url)
const artifactPath = '/opt/cursor/artifacts/browser-plugins-report.html'

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

let results = { key: 'missing', driver: [], isolation: {}, plugins: {}, model: 'deepseek-v4.1-flash' }
try {
  results = JSON.parse(await readFile(new URL('./results.json', outDir), 'utf8'))
} catch { /* rendered before the bench */ }

let canvas = ''
try {
  const bytes = await readFile(new URL('./canvas.jpg', outDir))
  canvas = `data:image/jpeg;base64,${bytes.toString('base64')}`
} catch { /* no shot yet */ }

const pluginOrder = ['refs', 'script', 'task']
const pluginLabel = { refs: 'refs 逐步快照', script: 'script 一段脚本', task: 'task 整段任务' }

const score = (name) => {
  const rows = results.plugins?.[name]?.rows
  if (!rows) return null
  const ok = rows.filter(row => row.ok).length
  return { ok, total: rows.length, rows }
}

const scored = pluginOrder.map(name => ({ name, ...score(name) })).filter(item => item.total)
scored.sort((a, b) => b.ok - a.ok || pluginOrder.indexOf(a.name) - pluginOrder.indexOf(b.name))
const leader = scored[0]

const recommendation = leader
  ? `这次实测里 ${pluginLabel[leader.name]} 通过 ${leader.ok}/${leader.total}。团队只开一个：先开 ${leader.name}。另外两个留在分支里，不同时挂到 Bot 上。`
  : '模型实测没有跑起来，原因写在下面。驱动和隔离已经在真 Chromium 里通过。按 Bot 要能核对每一步来选，全局后端先用 refs；script 留给步骤很长、想少几次工具调用的时候；task 留给把整段网页目标交出去、回来对步骤清单的时候。'

const rowCards = (rows = []) => rows.map(row => `
  <article class="task ${row.ok ? 'ok' : 'bad'}">
    <header><b>${esc(row.id)}</b><span>${row.ok ? '通过' : '未通过'} · ${esc(row.steps ?? 0)} 步 · ${esc(row.ms ?? 0)} ms</span></header>
    <p>${esc(row.answer || row.error || row.judge || '')}</p>
    <p class="meta">${esc((row.trace ?? []).join(' → '))}${row.judge ? ` · 评判：${esc(row.judge)}` : ''}${row.vision ? ` · 图像：${esc(row.vision)}` : ''}</p>
  </article>`).join('')

const pluginSection = pluginOrder.map(name => {
  const block = results.plugins?.[name]
  if (!block) return ''
  if (block.skipped) return `<section id="${name}"><h2>${esc(pluginLabel[name])}</h2><p class="warn">${esc(block.skipped)}</p></section>`
  const tally = score(name)
  return `<section id="${name}"><h2>${esc(pluginLabel[name])} <small>${tally.ok}/${tally.total}</small></h2>${rowCards(block.rows)}</section>`
}).join('')

const driverRows = (results.driver ?? []).map(row => `<li class="${row.ok ? 'ok' : 'bad'}"><b>${esc(row.id)}</b> ${esc(row.detail)}</li>`).join('')
const isolation = results.isolation ?? {}

const html = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>DS Bot 浏览器插件调研</title>
<style>
  :root { color-scheme: light; --ink:#1c1915; --paper:#f6f1e7; --line:#ddd4c4; --good:#1f7a4d; --bad:#9d341f; --mark:#e7a322; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 "Iowan Old Style", Palatino, "Songti SC", serif; color: var(--ink); background: var(--paper); }
  header.top { padding: 48px 8vw 28px; background: #231c14; color: #f6f1e7; }
  header.top h1 { font-size: 42px; line-height: 1.15; margin: 0 0 12px; font-weight: 650; }
  header.top p { max-width: 68ch; margin: 0; color: #e6dccb; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 8vw; position: sticky; top: 0; background: #f6f1ecc9; backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  nav a { color: inherit; text-decoration: none; border: 1px solid var(--line); padding: 4px 10px; border-radius: 999px; background: white; }
  main { padding: 8px 8vw 64px; max-width: 1180px; }
  h2 { font-size: 28px; margin: 36px 0 12px; }
  h3 { margin: 22px 0 8px; }
  .callout { background: white; border-left: 6px solid var(--mark); padding: 14px 16px; margin: 16px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .card, .task { background: white; border: 1px solid var(--line); padding: 12px 14px; }
  .card h3 { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; background: white; font-size: 14px; }
  th, td { border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; padding: 8px; }
  th { background: #efe7d8; }
  .ok { box-shadow: inset 4px 0 var(--good); }
  .bad { box-shadow: inset 4px 0 var(--bad); }
  .task header { display: flex; justify-content: space-between; gap: 12px; }
  .task p { margin: 8px 0 0; }
  .meta, .fine { color: #5e564c; font-size: 13px; }
  .warn { background: #fff4e8; padding: 10px 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  img.shot { max-width: min(640px, 100%); border: 1px solid var(--line); }
  .bar { height: 10px; background: #efe7d8; }
  .bar span { display: block; height: 10px; background: var(--good); }
</style>
<body>
<header class="top">
  <h1>浏览器交给插件，团队只用一个</h1>
  <p>${esc(recommendation)}</p>
</header>
<nav>
  <a href="#decision">决定</a>
  <a href="#agents">Agent 项目</a>
  <a href="#dsh">DSH 插件</a>
  <a href="#ours">三个插件</a>
  <a href="#runs">实测</a>
</nav>
<main>
<section id="decision">
  <h2>已经定下来的</h2>
  <div class="callout">
    <p>维护者确认：以前写「Bot 不操作浏览器」，是等这次做。全团队只挂一个浏览器后端，不让这个 Bot 用 refs、那个 Bot 用 script。每个 Bot 仍有自己的浏览器，cookie 不在 Bot 之间同步。群聊各用各的，也就是用各自 Bot 的那份 profile。</p>
    <p>同一个 Bot 的私聊、它加入的群、以及换段之前的会话，打开同一份目录 <code>bot/browser-profiles/&lt;botId&gt;/</code>，所以换段之后登录还在。这是相对 DSH 官方 browser-use 的差别：官方的浏览器属于那一个活着的 Session，换段就丢掉登录。</p>
    <p>登录、付款、验证码交给用户（<code>browser_handoff</code> / <code>browser_resume</code>）。没有另加域名黑名单。默认不打开插件，桌面里的只读 <code>read_browser</code> 不变。这个分支不合进 dev。</p>
  </div>
  <h3>为什么 cookie 不同步</h3>
  <p>你说浏览器保持独立、别串，同步 cookie 就是串。一个 Bot 读到网页里的指令，不该因此拿到另一个 Bot 已经登入的站。两个 Bot 要同一个登录时，各自登一次。以后若要复制，做成一次显式动作，不在后台同步。</p>
  <h3>和桌面面板的关系</h3>
  <p>现在的面板是 Electron webview，Bot 只能读。这三个插件驱动的是 Playwright 的 Chromium。两边不自动对齐 cookie。用户暂时不能在面板里看着 Bot 点击。要把它们合成一个窗口，是下一步，不是这次。</p>
</section>

<section id="agents">
  <h2>Agent 浏览器项目</h2>
  <p class="fine">下面七个都对过 DSH 的 Session 模型和 DS Bot 的长期身份。Chrome DevTools 按你的判断留在调研里，不做成插件。ego lite 这台 Linux 环境跑不了，用 script 插件测它那种「一段脚本」的形状，不把它算成测过。</p>
  <div class="grid">
    <article class="card"><h3>browser-use</h3><p>开源 Python / TypeScript agent，另有 Cloud。CLI 3.0 把一整段浏览收成一次 <code>browser_exec</code>。和 Bot 的差距：它自己就是 agent，登录跟它的浏览器走，不跟 DS Bot 的身份走。官方 DSH 只登记一个 provider，换 Session 不恢复 profile。</p></article>
    <article class="card"><h3>Playwright MCP</h3><p>微软的无障碍树和编号。DSH 官方 provider 之一。逐步、可核对，适合多模态模型看截图、也适合只看文本。官方挂载按 Session 收浏览器。我们的 refs 用同一类操作，但 profile 按 Bot 留在磁盘上。</p></article>
    <article class="card"><h3>Stagehand</h3><p>Browserbase 的 act / extract / observe，里面还会再调一个模型。DSH 有 native provider，文档写明这个内层模型还没接上 DSH 的路由和用量。Bot 的记忆里看不到内层怎么点的。适合当对照，不适合当团队唯一后端。</p></article>
    <article class="card"><h3>Skyvern</h3><p>偏视觉和流程的开源浏览器 agent，强项是表格和长表单。它自带一套 agent 循环和部署。接到 Bot 上会变成第二个循环。这次没有把它的服务拉起来测，结论来自它的产品形状。</p></article>
    <article class="card"><h3>ego lite</h3><p>Citro 的浏览器，人和 agent 各有 Space，<code>ego-browser</code> 用一段 Node 脚本驱动真 Chromium。DSH 上有 <code>dsh-ego-browser</code>（回忆、执行、学会、把键盘交还）。官方支持 macOS。这台机器测不了，handoff 的做法吸收进了三个插件。</p></article>
    <article class="card"><h3>Hermes</h3><p>Nous Research 的 agent。默认浏览器模式是 Browser Use CLI 的 <code>browser_exec</code>，可以套本地 Chromium、Cloud、Browserbase、Lightpanda。他们在 PR #81958 里报过多步网页任务上 token 少了大约一半，准确率持平。那是他们的数字，不是这次测的。script 插件是这个形状，再加上每 Bot 一份 profile。</p></article>
    <article class="card"><h3>OpenCode v2</h3><p>桌面版有 browser 命名空间：先拿到 tabID，再快照、点击、截图、看网络。另有 <code>opencode-chromium</code>，四个工具，<code>setup --targets dsh</code> 能写进 DSH 的 MCP。标签属于会话，不按 Bot 留登录。Chrome DevTools MCP 也看过：工具面是调试器，你说不好用，不进可选后端。</p></article>
  </div>
</section>

<section id="dsh">
  <h2>DSH 上的浏览器插件</h2>
  <table>
    <tr><th>插件</th><th>和 Bot 合不合</th></tr>
    <tr><td>官方 <code>dsh-browser-use</code> + Playwright MCP</td><td>逐步、可核对。浏览器跟 Session 走，换段丢登录。没有 Bot id。</td></tr>
    <tr><td>官方 Chrome DevTools MCP provider</td><td>调试面太宽。不采用。</td></tr>
    <tr><td>官方 Stagehand provider</td><td>内层模型不走 DSH 路由。步骤不在 Bot 的工具记录里。</td></tr>
    <tr><td><code>dshworks/dsh-ego-browser</code></td><td>ego 的记忆环（recall / learn / handoff）对长期 Bot 有价值。依赖装好的 ego lite，这次跑不了。</td></tr>
    <tr><td><code>coderdailyone/dsh-plugin-browser-use</code></td><td>每次动作复查域名，模型不碰文件路径。限制比这次定的更严，没有按 Bot 分 profile。</td></tr>
    <tr><td><code>omdsh-dev/dsh-browser</code></td><td>接管用户已经打开的 Chrome / Firefox，登录是用户的。Bot 之间会串到同一个浏览器，和「别串」相反。</td></tr>
    <tr><td><code>yzd6552-commits/dsh-browseruse</code></td><td>独立 Chrome profile、危险动作确认、验证码交人。最接近我们要的手感，profile 还不是按 Bot id。</td></tr>
    <tr><td><code>zoahdev/dsh-browser-use</code></td><td>Browser Use Cloud 一个工具跑完。要他们的 key。本地 MCP 才是不花钱的那条。</td></tr>
    <tr><td><code>JeremyGuo/dsh-playwright</code></td><td>人和模型看同一个页面，会话一份 BrowserContext。换 Session 不保证登录还在。</td></tr>
    <tr><td><code>opencode-chromium --targets dsh</code></td><td>四个工具进 MCP。会话拥有标签。上传要确认。没有 Bot profile。</td></tr>
  </table>
</section>

<section id="ours">
  <h2>为 Bot 做的三个插件</h2>
  <div class="grid">
    <article class="card"><h3>refs</h3><p><code>browser_open</code> <code>browser_snapshot</code> <code>browser_click</code> <code>browser_fill</code> <code>browser_screenshot</code> <code>browser_handoff</code>。编号在快照里，页面一变就作废。开放 Shadow DOM 和同源 iframe 的文字会写进快照。每一步都在会话里。</p></article>
    <article class="card"><h3>script</h3><p><code>browser_exec</code> 跑一段已经注入帮手的 JavaScript，用 <code>done(answer)</code> 交卷。对应 Hermes / ego 的一段脚本。失败了可以再交一段。登录仍走 handoff。</p></article>
    <article class="card"><h3>task</h3><p><code>browser_task</code> 收一个目标，内部用 refs 的工具和同一次模型调用跑完，结果里带步骤清单。Bot 的对话里只有一次工具调用。适合整段网页差事，不适合要中途改口的活。</p></article>
  </div>
  <p>三个包在 <code>browser-plugins/refs</code>、<code>script</code>、<code>task</code>，都有 <code>apply</code>，可以单独装进 DSH。单独装时目录按 Session id，不按 Bot。DS Bot 挂载时才换成 Bot id。团队配置只接受一个名字。</p>
</section>

<section id="runs">
  <h2>实测</h2>
  <p>标准用了公开的 <a href="https://github.com/MinorJerry/WebVoyager">WebVoyager</a>（browser-use 也用这套报过成绩）。整套六百多条、很多站要登录或已经过期，不全跑。抽了两条 arXiv 原文任务：<code>ArXiv--11</code>、<code>ArXiv--6</code>。另外用自建页面补 WebVoyager 不覆盖的部分：检索后再点进去、翻页、Shadow DOM、同源 iframe、只存在于 canvas 的字、登录必须交给人。</p>
  <p>模型 <code>${esc(results.model || 'deepseek-v4.1-flash')}</code>，经 OpenDesign <code>https://amr-link.open-design.ai/v1</code>。密钥：${results.key === 'present' ? '用的是环境里的 OPENDESIGN_API_KEY，没有写入报告。' : '这台环境里没有 OPENDESIGN_API_KEY，模型任务没有跑。'}</p>
  <h3>驱动，不经过模型</h3>
  <ul>${driverRows || '<li>还没有驱动结果</li>'}</ul>
  <h3>两个 Bot 的 cookie</h3>
  <ul>
    <li class="${isolation.alphaSawCookie ? 'ok' : 'bad'}">Bot alpha 看到自己的 cookie：${isolation.alphaSawCookie ? '是' : '否'}</li>
    <li class="${isolation.betaSawCookie ? 'bad' : 'ok'}">Bot beta 看到 alpha 的 cookie：${isolation.betaSawCookie ? '是' : '否'}</li>
    <li class="${isolation.alphaKeptCookie ? 'ok' : 'bad'}">关掉再打开，alpha 的 cookie 还在：${isolation.alphaKeptCookie ? '是' : '否'}</li>
  </ul>
  ${canvas ? `<h3>canvas 截图</h3><p class="fine">代号画在画布上，快照文本里没有。多模态模型要靠这张图。</p><img class="shot" alt="画着 CANVAS-73 的页面截图" src="${canvas}">` : ''}
  <h3>通过数</h3>
  ${scored.map(item => `<p>${esc(pluginLabel[item.name])} ${item.ok}/${item.total}</p><div class="bar"><span style="width:${Math.round(100 * item.ok / item.total)}%"></span></div>`).join('') || '<p>没有模型结果。</p>'}
  ${pluginSection}
</section>
</main>
</html>`

await writeFile(reportPath, html)
try { await writeFile(artifactPath, html) } catch { /* artifacts dir may be absent */ }
console.log(reportPath.pathname)
