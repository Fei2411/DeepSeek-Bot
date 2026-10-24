import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dockCards, tailCards, withBtwRows,
} from '../src/client/btw-model.js'
import { matchSideEnter } from '../src/client/side-model.js'
import { createSource } from '../src/client/sources.js'

// DSH sends the line on when matchEnter returns undefined. A claim or a throw
// must leave session.prompt alone.
function sessionFor(id) {
  return { id, sent: [], prompt(line) { this.sent.push(line) } }
}

async function enter(roster, session, line, envelope = { attachments: 0 }, signal) {
  const outcome = await matchSideEnter(roster, session.id, line, envelope, signal)
  if (outcome === undefined) session.prompt(line)
  return outcome
}

const botRoster = { ready: true, byId: { s: { id: 'bot', sessionId: 's' } }, roomsById: {} }
const groupRoster = { ready: true, byId: {}, roomsById: { g: { id: 'g' } } }
const otherRoster = { ready: true, byId: {}, roomsById: {} }

async function refused(roster, session, line, envelope) {
  await assert.rejects(enter(roster, session, line, envelope))
  assert.deepEqual(session.sent, [])
}

test('a group, an attachment, and an empty /side claim-and-refuse', async () => {
  const group = sessionFor('g')
  await assert.rejects(enter(groupRoster, group, '/side what happened'), /private chat/)
  await assert.rejects(enter(groupRoster, group, '/side', { attachments: 2 }), /private chat/)
  assert.deepEqual(group.sent, [])

  const bot = sessionFor('s')
  await assert.rejects(enter(botRoster, bot, '/side what happened', { attachments: 1 }), /attachments/)
  await assert.rejects(enter(botRoster, bot, '/side'), /Write a question/)
  await assert.rejects(enter(botRoster, bot, '/side   '), /Write a question/)
  assert.deepEqual(bot.sent, [])
  assert.deepEqual(await enter(botRoster, bot, '/side what happened'), { claim: true })
  assert.deepEqual(bot.sent, [])
})

test('a /side typed before the roster is ready never reaches session.prompt', async () => {
  const roster = createSource({ ready: false, byId: {}, roomsById: {} })
  const session = sessionFor('s')
  let settled = false
  const pending = enter(roster, session, '/side what happened').then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(session.sent, [])
  roster.set(botRoster)
  assert.deepEqual(await pending, { claim: true })
  assert.deepEqual(session.sent, [])
})

test('a delayed roster that is a group still refuses, and abort does not send', async () => {
  const roster = createSource({ ready: false, byId: {}, roomsById: {} })
  const session = sessionFor('g')
  const pending = enter(roster, session, '/side')
  await Promise.resolve()
  assert.deepEqual(session.sent, [])
  roster.set(groupRoster)
  await assert.rejects(pending, /private chat/)
  assert.deepEqual(session.sent, [])

  const waiting = createSource({ ready: false, byId: {}, roomsById: {} })
  const bot = sessionFor('s')
  const controller = new AbortController()
  const aborted = enter(waiting, bot, '/side what happened', { attachments: 0 }, controller.signal)
  controller.abort(new Error('stopped'))
  await assert.rejects(aborted, /stopped/)
  assert.deepEqual(bot.sent, [])
})

test('a roster snapshot that is not ready refuses instead of sending', async () => {
  await refused({ ready: false, byId: {}, roomsById: {} }, sessionFor('s'), '/side what happened')
})

test('a positively identified non-Bot session lets /side through, and a non-command does not wait', async () => {
  const session = sessionFor('plain')
  assert.equal(await enter(otherRoster, session, '/side what happened'), undefined)
  assert.deepEqual(session.sent, ['/side what happened'])

  const roster = createSource({ ready: false, byId: {}, roomsById: {} })
  assert.equal(await matchSideEnter(roster, 's', '/sidequestion', { attachments: 0 }), undefined)
  assert.equal(await matchSideEnter(roster, 's', '/btw question', { attachments: 0 }), undefined)
  assert.equal(await matchSideEnter(roster, 's', 'hello', { attachments: 0 }), undefined)
})

const closed = { turn: 1, start: { seq: 10 }, end: { seq: 20 }, status: 'closed' }
const open = { turn: 2, start: { seq: 30 }, status: 'open' }

function placed(cards, turns) {
  const dock = dockCards(cards, { turns }).map(card => card.id)
  const tails = []
  for (const turn of turns.values()) {
    for (const card of tailCards(cards, turn, turns)) tails.push(`${turn.turn}:${card.id}`)
  }
  const ids = [...dock, ...tails.map(item => item.slice(item.indexOf(':') + 1))]
  assert.equal(new Set(ids).size, ids.length, 'a card is on the dock or one tail')
  return { dock, tails }
}

test('a card moves from the dock to exactly one turn tail', () => {
  const idle = new Map([[1, closed]])
  const changed = { id: 'model', atSeq: 21 }
  assert.deepEqual(placed([changed], idle), { dock: [], tails: ['1:model'] })

  const live = new Map([[1, closed], [2, open]])
  const mid = { id: 'mid', atSeq: 35 }
  assert.deepEqual(placed([mid], live), { dock: ['mid'], tails: [] })

  const asked = { id: 'asked', atSeq: 15 }
  assert.deepEqual(placed([asked], live), { dock: [], tails: ['1:asked'] })

  // atSeq 21 would belong to the closed turn. anchorSeq is the open turn's start.
  const named = { id: 'named', atSeq: 21, anchorSeq: 30 }
  assert.deepEqual(placed([named], live), { dock: ['named'], tails: [] })
  const done = { turn: 2, start: { seq: 30 }, end: { seq: 40 }, status: 'closed' }
  assert.deepEqual(placed([named, changed], new Map([[1, closed], [2, done]])), {
    dock: [],
    tails: ['1:model', '2:named'],
  })

  assert.deepEqual(placed([{ id: 'none', atSeq: null }], live).dock, ['none'])
})

test('anchorSeq uses the closed turn range and does not fall through to atSeq', () => {
  // Host shape: turn/start 1, messages, turn/end 4, model/selection 5.
  const closedTurn = new Map([[1, { turn: 1, start: { seq: 1 }, end: { seq: 4 }, status: 'closed' }]])
  assert.deepEqual(placed([{ id: 'logged', atSeq: 5, anchorSeq: 1 }], closedTurn), { dock: [], tails: ['1:logged'] })

  // The same anchor while that turn is still open stays on the dock.
  const running = new Map([[1, { turn: 1, start: { seq: 1 }, status: 'open' }]])
  assert.deepEqual(placed([{ id: 'midhost', atSeq: 4, anchorSeq: 1 }], running), { dock: ['midhost'], tails: [] })

  // 50 matches neither closed range. atSeq 15 would have, and must not.
  const finished = new Map([
    [1, closed],
    [2, { turn: 2, start: { seq: 30 }, end: { seq: 40 }, status: 'closed' }],
  ])
  assert.deepEqual(placed([{ id: 'stray', atSeq: 15, anchorSeq: 50 }], finished), { dock: ['stray'], tails: [] })
  assert.deepEqual(placed([{ id: 'legacy', atSeq: 15, anchorSeq: null }], finished), { dock: [], tails: ['1:legacy'] })
})

const shape = rows => rows.map(row => (row.kind === 'btw' ? `btw:${row.card.id}` : row.kind === 'divider' ? 'divider' : `${row.kind}:${row.text}`))

test('an earlier part anchors a card to the turn, steering included', () => {
  const items = [
    { kind: 'user', text: 'start', seq: 10, turn: 1 },
    { kind: 'bot', text: 'working', seq: 12, turn: 1 },
    { kind: 'user', text: 'steer', seq: 14, turn: 1 },
    { kind: 'bot', text: 'done', seq: 16, turn: 1 },
    { kind: 'user', text: 'next', seq: 20, turn: 2 },
    { kind: 'bot', text: 'ok', seq: 22, turn: 2 },
  ]
  const cards = [
    { id: 'after', atSeq: 18 },
    { id: 'mid', atSeq: 15, turn: 1 },
  ]
  assert.deepEqual(shape(withBtwRows(items, cards)), [
    'user:start', 'bot:working', 'user:steer', 'bot:done', 'btw:after', 'btw:mid',
    'user:next', 'bot:ok',
  ])
  assert.equal(withBtwRows(items, cards).some(row => row.kind === 'btw' && row.time !== undefined), false)
})

test('an earlier page shows a card once, and an empty part keeps a trailing block', () => {
  const older = [
    { kind: 'user', text: 'old', seq: 10, turn: 1 },
    { kind: 'bot', text: 'then', seq: 12, turn: 1 },
  ]
  const newer = [
    { kind: 'user', text: 'new', seq: 20, turn: 2 },
    { kind: 'bot', text: 'now', seq: 22, turn: 2 },
  ]
  const cards = [
    { id: 'new-card', atSeq: 21, turn: 2 },
    { id: 'old-card', atSeq: 11, turn: 1 },
  ]
  assert.deepEqual(shape(withBtwRows(newer, cards)), [
    'user:new', 'bot:now', 'btw:new-card', 'btw:old-card',
  ])
  assert.deepEqual(shape(withBtwRows(newer, [{ id: 'below', atSeq: 11 }])), ['user:new', 'bot:now'])
  assert.deepEqual(shape(withBtwRows([...older, ...newer], cards)), [
    'user:old', 'bot:then', 'btw:old-card', 'user:new', 'bot:now', 'btw:new-card',
  ])
  assert.deepEqual(shape(withBtwRows(newer, [{ id: 'hidden', atSeq: 21, turn: 9 }])), [
    'user:new', 'bot:now', 'btw:hidden',
  ])
  assert.deepEqual(shape(withBtwRows([], [{ id: 'lost', atSeq: 4, turn: 1 }])), ['btw:lost'])
  assert.deepEqual(shape(withBtwRows([{ kind: 'divider', time: 1 }], [{ id: 'lost', atSeq: 4, turn: 1 }])), ['divider', 'btw:lost'])
})

test('one turn projected across two pages places its card once after the last row', () => {
  // displayItems omits turn/start and stamps seq/turn. A later page seeds its
  // turn from the latest turn/start at or before its first event, so turn 1
  // continues. EarlierParts prepends that older page before withBtwRows.
  // anchorSeq 5 is the turn/start. atSeq 23 is a later log-only event.
  const older = [
    { kind: 'user', text: 'progress', seq: 6, turn: 1, time: 1 },
    { kind: 'bot', text: 'working', seq: 8, turn: 1, time: 2 },
  ]
  const newer = [
    { kind: 'user', text: 'steer', seq: 10, turn: 1, time: 3 },
    { kind: 'bot', text: 'done', seq: 12, turn: 1, time: 4 },
    { kind: 'user', text: 'next', seq: 20, turn: 2, time: 5 },
    { kind: 'bot', text: 'ok', seq: 22, turn: 2, time: 6 },
  ]
  const card = { id: 'aside', anchorSeq: 5, atSeq: 23 }
  const merged = withBtwRows([...older, ...newer], [card])
  assert.deepEqual(shape(merged), [
    'user:progress', 'bot:working', 'user:steer', 'bot:done', 'btw:aside',
    'user:next', 'bot:ok',
  ])
  assert.equal(merged.filter(row => row.kind === 'btw').length, 1)
})

test('a card whose turn is not loaded stays in the trailing block', () => {
  // anchorSeq 0 is turn 1's turn/start. atSeq 6 is a later log-only event.
  // Turn 1's rows are on the older page. The loaded page starts at turn 2.
  const card = { id: 'aside', turn: 1, anchorSeq: 0, atSeq: 6 }
  const turn2 = [
    { kind: 'user', text: 'next', seq: 8, turn: 2, time: 8 },
    { kind: 'bot', text: 'ok', seq: 10, turn: 2, time: 10 },
  ]
  assert.deepEqual(shape(withBtwRows(turn2, [card])), [
    'user:next', 'bot:ok', 'btw:aside',
  ])
  // A later visible turn makes "after turn 2" a different slot from the trailing block.
  const loaded = [
    ...turn2,
    { kind: 'user', text: 'later', seq: 12, turn: 3, time: 12 },
    { kind: 'bot', text: 'more', seq: 14, turn: 3, time: 14 },
  ]
  assert.deepEqual(shape(withBtwRows(loaded, [card])), [
    'user:next', 'bot:ok', 'user:later', 'bot:more', 'btw:aside',
  ])
  const older = [
    { kind: 'user', text: 'progress', seq: 1, turn: 1, time: 1 },
    { kind: 'bot', text: 'working', seq: 3, turn: 1, time: 3 },
  ]
  const merged = withBtwRows([...older, ...turn2], [card])
  assert.deepEqual(shape(merged), [
    'user:progress', 'bot:working', 'btw:aside',
    'user:next', 'bot:ok',
  ])
  assert.equal(merged.filter(row => row.kind === 'btw').length, 1)

  const loose = { id: 'loose', turn: null, anchorSeq: 0, atSeq: 6 }
  assert.deepEqual(shape(withBtwRows(loaded, [loose])), [
    'user:next', 'bot:ok', 'btw:loose', 'user:later', 'bot:more',
  ])
  const named = { id: 'named', atTurn: 1, anchorSeq: 0, atSeq: 6 }
  assert.deepEqual(shape(withBtwRows(loaded, [named])), [
    'user:next', 'bot:ok', 'user:later', 'bot:more', 'btw:named',
  ])
  const gone = { id: 'gone', turn: 9, anchorSeq: 0, atSeq: 6 }
  assert.deepEqual(shape(withBtwRows([...older, ...loaded], [gone])), [
    'user:progress', 'bot:working', 'user:next', 'bot:ok', 'user:later', 'bot:more', 'btw:gone',
  ])
})

// BtwDock, bundled and rendered with a minimal React stand-in: the dock is the
// composer slot for cards whose turn is still open or matches nothing closed.
// Old cards are read-only, so the dock shows no Cancel.
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const btwBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/btw.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const btwModule = { exports: {} }
runInNewContext(btwBundle.outputFiles[0].text, {
  module: btwModule, exports: btwModule.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1280 },
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: init => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {}, useRef: () => ({ current: null }),
        useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
        useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { BtwDock } = btwModule.exports

const findIn = (node, match, out = []) => {
  if (Array.isArray(node)) node.forEach(child => findIn(child, match, out))
  else if (node !== null && typeof node === 'object') {
    if (match(node)) out.push(node)
    for (const child of node.children ?? []) findIn(child, match, out)
  }
  return out
}

test('an open-turn card renders in the dock without a Cancel button', () => {
  const card = { id: 'c1', partId: 's', status: 'done', question: 'q?', answer: 'a.', atSeq: null, createdAt: 1, finishedAt: 2 }
  const roster = { ready: true, btwCards: { bot: [card] }, byId: { s: { id: 'bot', sessionId: 's' } }, roomsById: {} }
  const actions = { turnFacts: () => ({ turns: new Map(), openTurn: { seq: 1 } }), watchTurns: () => () => {} }
  const tree = BtwDock({ sessionId: 's', useRoster: select => select(roster), actions })
  assert.equal(findIn(tree, node => node.props?.className === 'bt-btw-dock').length, 1)
  // The card component sits in the tree as a vnode; render it to see the card.
  const [cardNode] = findIn(tree, node => typeof node.type === 'function' && node.props?.card?.id === 'c1')
  const view = cardNode.type(cardNode.props)
  assert.equal(view.props.className, 'bt-btw bt-btw-compact')
  assert.equal(findIn(view, node => node.props?.className === 'bt-btw-cancel').length, 0)
})
