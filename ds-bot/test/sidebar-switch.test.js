import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The sidebar and its style sheets import the browser's React; bundle them with a minimal
// stand-in, as the tool-cell tests do: components run as plain functions. Navigation
// fixtures retain refs across commits and run their layout effects after each render.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS } from './src/client/styles.js'\nexport { SIDEBAR_CSS, TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let renderRefs
let refIndex = 0
let layoutEffects
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect: effect => layoutEffects?.push(effect), useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => renderRefs ? renderRefs[refIndex++] ??= { current } : { current }, useId: () => 'id',
}
const module = { exports: {} }
const viewport = { innerWidth: 1280 }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: viewport,
})
const { SHELL_CSS, SIDEBAR_CSS, TeamSidebar } = module.exports

function navigationSidebar(wide, { leftDrawer = false } = {}) {
  const calls = []
  const refs = []
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Team', members: [], createdAt: 2 }
  const agent = { id: 'agent', sessions: ['session'], createdAt: 3 }
  const roster = { bots: [bot], rooms: [room], agents: [agent], byId: { writer: bot }, ready: true }
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession'].map(name => [name, id => { calls.push([name, id]); return id }]))
  actions.toggleSidebar = () => { calls.push(['toggleSidebar']) }
  actions.setLeftDrawer = (on) => { calls.push(['setLeftDrawer', on]) }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (['BotRow', 'RoomRow', 'AgentRow'].includes(node.type?.name)) rows.push(node)
    walk(node.props?.children)
  }
  const render = (nextWide = wide) => {
    wide = nextWide
    renderRefs = refs
    refIndex = 0
    layoutEffects = []
    const tree = TeamSidebar({
      wide, actions,
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {}, leftDrawer }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    })
    renderRefs = undefined
    const effects = layoutEffects
    layoutEffects = undefined
    effects.forEach(effect => effect())
    rows.length = 0
    walk(tree)
  }
  render()
  return { calls, rows, actions, render }
}

for (const width of [390, 1023, 1024, 1280]) {
  for (const wide of [false, true]) {
    test(`sidebar navigation at ${width}px with ${wide ? 'expanded content' : 'our own column'} just navigates`, () => {
      viewport.innerWidth = width
      const initial = navigationSidebar(wide)
      assert.equal(initial.rows.length, 3)
      for (const [index, row] of initial.rows.entries()) {
        const names = row.type.name === 'AgentRow' ? ['openAgent', 'openAgentSession', 'newAgentSession'] : ['openSession']
        for (const name of names) {
          const { rows, calls } = navigationSidebar(wide)
          assert.equal(rows[index].props.actions[name]('selected'), 'selected')
          assert.deepEqual(calls, [[name, 'selected']])
        }
      }
    })
  }
}

test('a row picked from the floating drawer closes it', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(false, { leftDrawer: true })
  side.rows[0].props.actions.openSession('picked')
  assert.deepEqual(side.calls, [['openSession', 'picked'], ['setLeftDrawer', false]])
})

test('a row picked outside the drawer leaves it alone', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(false)
  side.rows[0].props.actions.openSession('picked')
  assert.deepEqual(side.calls, [['openSession', 'picked']])
})

// A Bot working in its own chat previews what it is doing, the way a group row does
// for members at work; an idle Bot keeps the last message preview.
test('a running Bot\'s sidebar row shows what it is doing', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map([['writer', { running: true }]])),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({ writer: 'working' }),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  assert.equal(rows.length, 1)
  // BotRow renders as a function component: run it, then flatten Shimmer and the
  // other function children to read the preview line's text.
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 1)
  // The row already says Writer, so the preview is the doing phrase alone.
  assert.match(textOf(previews[0]), /^.+…$/)
  assert.doesNotMatch(textOf(previews[0]), /^Writer ·/)
})

test('an idle Bot\'s sidebar row keeps the message preview', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({}),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 0)
})

// The rail shows avatars only, and a group's name can be 60 characters long: a row whose
// name is not on screen in full shows it on hover.
test('a sidebar row shows its name on hover when the name is hidden or cut', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Launch plan for the spring release', members: ['writer'], createdAt: 2 }
  const roster = { bots: [bot], rooms: [room], agents: [], byId: { writer: bot }, roomsById: { room }, ready: true, exchangeTurns: {} }
  const rowsOf = (pref) => {
    const rows = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!node || typeof node !== 'object') return
      if (['BotRow', 'RoomRow'].includes(node.type?.name)) rows.push(node)
      walk(node.props?.children)
    }
    walk(TeamSidebar({
      useSidebarPref: pick => pick(pref),
      actions: Object.fromEntries(['openSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
      useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: () => null,
      useActivity: pick => pick({}), useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
    }))
    return Object.fromEntries(rows.map(row => [row.type.name, row.type(row.props)]))
  }
  const rail = rowsOf('rail')
  assert.equal(rail.BotRow.props.title, 'Writer')
  assert.equal(rail.RoomRow.props.title, 'Launch plan for the spring release')
  const wide = rowsOf('open')
  assert.equal(wide.RoomRow.props.title, undefined)
  // jsdom lays nothing out, so the name's widths are set by hand.
  const { document } = new JSDOM('<button title="stale"><span class="bt-row-title">Launch plan for the spring release</span></button>').window
  const button = document.querySelector('button')
  const name = button.firstChild
  Object.defineProperty(name, 'clientWidth', { value: 120 })
  Object.defineProperty(name, 'scrollWidth', { value: 120, configurable: true })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.hasAttribute('title'), false)
  Object.defineProperty(name, 'scrollWidth', { value: 260 })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.title, 'Launch plan for the spring release')
  assert.equal(wide.BotRow.props.onMouseEnter, wide.RoomRow.props.onMouseEnter)
})

test('preparing sidebar navigation leaves actions elsewhere unchanged', () => {
  viewport.innerWidth = 390
  const { actions, calls } = navigationSidebar(true)
  assert.deepEqual(calls, [])
  actions.openSession('from-another-surface')
  assert.deepEqual(calls, [['openSession', 'from-another-surface']])
})

function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  for (let at = 0; ;) {
    const open = text.indexOf('{', at)
    if (open === -1) return rules
    let end = open + 1
    for (let depth = 1; depth > 0; end += 1) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0
    const selector = text.slice(at, open).trim()
    if (!selector.startsWith('@')) rules.push({ selector, body: text.slice(open + 1, end - 1).replace(/\s+/g, '') })
    at = end
  }
}
const SHELL_PARTS = /_logoRow|_brand|_toggle|_newSession|_footArea|_collapsed|_topStrip|bt-side-collapse|bt-title-toggle/
const rules = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)].filter(rule => SHELL_PARTS.test(rule.selector))
const hiding = rules.filter(rule => /display:none/.test(rule.body))
const showing = rules.filter(rule => /display:inline-flex/.test(rule.body))

// The shell sidebar's own markup (dsh-client-ui-sidebar SidebarRoot), reduced to what the
// team view reshapes: the switch is in the logo row, except in a macOS desktop window,
// where it sits in the strip by the window buttons.
function shell({ platform, collapsed }) {
  const darwin = platform === 'mac'
  const toggle = '<button class="x_iconButton x_toggle" aria-label="Toggle sidebar"></button>'
  const html = `<!doctype html><html${platform === 'windows' ? ' data-windows-titlebar' : ''}${darwin ? ' data-platform="darwin"' : ''}><body>
    <div${collapsed ? ' data-sidebar-collapsed="true"' : ''}>
      <div class="x_root${collapsed ? ' x_collapsed' : ''}">
        ${darwin ? `<div class="x_topStrip">${toggle}</div>` : ''}
        <div class="x_logoRow">${collapsed ? '' : '<button class="x_brand x_wide"></button>'}${darwin ? '' : toggle}</div>
      <button class="bt-title-toggle"></button>
        <div class="x_newSession"></div>
        <div class="team">${collapsed ? '' : '<div class="bt-side-top"><button class="bt-round bt-side-collapse"></button></div>'}</div>
        <div class="x_footArea"><span class="bt-foot-account"></span></div>
      </div>
    </div></body></html>`
  const { document } = new JSDOM(html).window
  const hidden = (node) => {
    for (let at = node; at && at.nodeType === 1; at = at.parentElement) {
      if (hiding.some(rule => at.matches(rule.selector)) && !showing.some(rule => at.matches(rule.selector))) return true
    }
    return false
  }
  const switches = [...document.querySelectorAll('.x_toggle, .bt-side-collapse, .bt-title-toggle')].filter(node => !hidden(node))
  return { document, hidden, switches }
}

// The switch is always ours. Under a Windows title bar it is the title-band
// button and the shell's own is hidden (left to the shell, it would expand the
// shell's sidebar before we pull it back, a flash); elsewhere it is the column's
// top-row button, or the floating one while the column is hidden.
for (const collapsed of [false, true]) {
  test(`${collapsed ? 'a collapsed' : 'an open'} shell sidebar under a Windows title bar shows only our switch`, () => {
    const { switches } = shell({ platform: 'windows', collapsed })
    assert.deepEqual(switches.map(node => node.className), ['bt-title-toggle'])
  })
}

test('off a Windows title bar the column\'s top row and the floating switch are never hidden by style', () => {
  for (const platform of ['web', 'mac']) {
    const { document, hidden } = shell({ platform, collapsed: false })
    assert.equal(hidden(document.querySelector('.bt-side-collapse')), false, platform)
    assert.equal(hidden(document.querySelector('.bt-title-toggle')), false, platform)
  }
})

test('what the team view replaces in the shell sidebar stays out of sight', () => {
  for (const platform of ['web', 'windows', 'mac']) {
    for (const collapsed of [false, true]) {
      const { document, hidden } = shell({ platform, collapsed })
      assert.equal(hidden(document.querySelector('.x_newSession')), true)
      const brand = document.querySelector('.x_brand')
      if (brand) assert.equal(hidden(brand), true)
    }
  }
})

// The shell's collapsed sidebar keeps no track in the Bot view, so a hidden
// column leaves nothing behind; the shell's right column keeps its own geometry.
test('the shell\'s collapsed sidebar keeps no track while its right column is closed', () => {
  const frame = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)].find(rule => rule.selector.includes('[data-sidebar-collapsed][data-rightbar-collapsed]'))
  assert.match(frame?.body ?? '', /grid-template-columns:0px/)
})

test('the column\'s top row hides it, on the rail too, and its edge is a drag grip', () => {
  viewport.innerWidth = 1280
  const calls = []
  const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
  const props = pref => ({
    wide: false,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSidebarPref: pick => pick(pref),
    actions: { toggleLeftHidden: () => calls.push('toggle'), toggleSidebar: () => {} },
  })
  const find = (node, match) => {
    if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    return match(node) ? node : find(node.props?.children, match)
  }
  const collapse = node => node.type === 'button' && node.props['aria-label'] === 'Collapse sidebar'
  for (const pref of ['open', 'rail']) {
    const tree = TeamSidebar(props(pref))
    const button = find(tree, collapse)
    assert.ok(button?.props.className.split(' ').includes('bt-side-collapse'), pref)
    button.props.onClick()
    const column = find(tree, node => node.type?.name === 'LeftColumn')
    assert.equal(column.props.mode, pref)
    assert.equal(typeof column.props.onGrip, 'function')
  }
  assert.deepEqual(calls, ['toggle', 'toggle'])
  // Hidden, there is no column at all; the floating switch brings it back.
  const hidden = TeamSidebar(props('hidden'))
  assert.equal(find(hidden, node => node.type?.name === 'LeftColumn'), undefined)
  const toggle = find(hidden, node => node.type?.name === 'TitleToggle')
  assert.equal(toggle.props.hidden, true)
})

// #622: with only the Main Bot, the open sidebar was blank below the Main Bot's card.
test('an open sidebar with only the Main Bot shows open water, which moves only when the team is lively', () => {
  const main = { id: 'chief', name: 'Chief', createdAt: 1 }
  const room = { id: 'room', name: 'Ops', members: ['chief'], createdAt: 2 }
  const agent = { id: 'agent', sessions: [], createdAt: 3 }
  viewport.innerWidth = 1280
  const render = (pref, more = {}) => {
    const roster = { bots: [main], rooms: [], agents: [], byId: { chief: main }, mainBotId: 'chief', ready: true, exchangeTurns: {}, ...more }
    return TeamSidebar({
      actions: {},
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
      useSidebarPref: pick => pick(pref),
    })
  }
  const find = (node, match) => {
    if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    return match(node) ? node : find(node.props?.children, match)
  }
  const water = node => node.type?.name === 'OpenWater'
  const shown = find(render('open'), water)
  assert.ok(shown)
  const hint = shown.type()
  assert.equal(find(hint, node => node.type === 'p').props.children.join(''), 'Your Bots will swim here')
  assert.equal(find(hint, node => node.type === 'svg').props['aria-hidden'], true)
  assert.equal(find(render('rail'), water), undefined)
  assert.equal(find(render('open', { rooms: [room] }), water), undefined)
  assert.equal(find(render('open', { agents: [agent] }), water), undefined)
  assert.equal(find(render('open', { bots: [main, { id: 'writer', name: 'Writer', createdAt: 4 }] }), water), undefined)
  // While the Main Bot is still being set up, the list shows that instead.
  assert.equal(find(render('open', { bots: [], byId: {}, mainBotId: undefined, ready: false }), water), undefined)
  // Still by default: only the Lively level drifts the wave, and reduced motion stops it.
  const drifts = SIDEBAR_CSS.split('}').filter(rule => rule.includes('animation:bt-swim-drift'))
  assert.equal(drifts.length, 2)
  for (const rule of drifts) assert.match(rule.trim(), /^body\[data-bt-motion=lively\] \.bt-swim-(front|back)\{/)
  assert.match(SIDEBAR_CSS, /@media \(prefers-reduced-motion:reduce\)\{\.bt-swim,\.bt-swim-wave path\{animation:none!important\}\}/)
})

test('the logo row takes no room in an open sidebar under a Windows title bar', () => {
  const { document } = shell({ platform: 'windows', collapsed: false })
  const row = document.querySelector('.x_logoRow')
  const flat = rules.filter(rule => row.matches(rule.selector) && /height:0!important/.test(rule.body))
  assert.equal(flat.length, 1)
  assert.equal(shell({ platform: 'windows', collapsed: true }).document.querySelector('.x_logoRow').matches(flat[0].selector), false)
})

// The shell hides the footer of a collapsed sidebar under a Windows title bar, whose width
// is zero; a forced display put the account button off the screen.
test('the team view lays out the shell footer but never decides whether it shows', () => {
  const { document } = shell({ platform: 'windows', collapsed: true })
  const foot = document.querySelector('.x_footArea')
  const deciding = rules.filter(rule => foot.matches(rule.selector) && /(^|;)display:/.test(rule.body))
  assert.deepEqual(deciding.map(rule => rule.selector), [])
})

// 公开#164: the footer's grid gives other plugins' entries rows of their own; it holds
// wherever the shell shows the footer, and stays out of the one place it hides it.
test('the shell footer is a grid wherever the shell shows it', () => {
  for (const platform of ['web', 'windows', 'mac']) {
    for (const collapsed of [false, true]) {
      const foot = shell({ platform, collapsed }).document.querySelector('.x_footArea')
      const grid = rules.some(rule => foot.matches(rule.selector) && /(^|;)display:grid/.test(rule.body))
      assert.equal(grid, !(platform === 'windows' && collapsed), `${platform} ${collapsed ? 'collapsed' : 'open'}`)
    }
  }
})

// #452: the footer lost its Connect plugins button; the account menu and the
// entries other plugins add keep the places they had.
test('the Bot footer lays out the account, another plugin\'s entry and the settings trigger', () => {
  const html = `<!doctype html><html><body><div class="x_root"><div class="x_footArea">
    <div class="x_footerActions">
      <div><span class="bt-foot-account"></span></div>
      <div><span class="x_other-plugin"></span></div>
    </div>
    <div class="x_settingsArea"><button class="x_trigger"><span class="x_label">Settings</span></button></div>
  </div></div></body></html>`
  const { document } = new JSDOM(html).window
  // The last rule that places a node is the one that counts, as in the cascade.
  const columnOf = node => {
    const placed = rules.filter(rule => node.matches(rule.selector) && /grid-column:/.test(rule.body))
    assert.ok(placed.length > 0, `no grid placement for ${node.className}`)
    return placed[placed.length - 1].body.match(/grid-column:([^;]+)/)[1]
  }
  // The account menu keeps the left of the row.
  assert.equal(columnOf(document.querySelector('.bt-foot-account')), '1')
  // Another plugin's entry takes a row of its own, above the Bot row.
  assert.equal(columnOf(document.querySelector('.x_other-plugin')), '1/-1')
  // The settings trigger keeps the right of the row.
  assert.equal(columnOf(document.querySelector('.x_settingsArea')), '3')
})

// #452: the Connect plugins button left the footer; what DS Bot puts there is
// the account menu and the way back from Agent mode.
test('the Bot footer holds the account and the return button only', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const ids = [...source.matchAll(/shadow\('sidebar\.footer\.action',\s*\{[^}]*?id:\s*['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual(ids.sort(), ['bot-account', 'bot-return'])
})
