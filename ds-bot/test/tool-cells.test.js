import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The tool cells and the card docks, bundled once and rendered with a minimal React:
// components run as plain functions, effects are collected and run on demand.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ToolCell, TriggerCell, callTree, stackReplies } from './src/client/cells.js'",
      "export { QuestionDock } from './src/client/questions.js'",
      "export { SecretDock } from './src/client/secret-card.js'",
      "export { countCards } from './src/client/sources.js'",
      "export { ViewMenuList, WidgetView } from './src/client/widget-cell.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const sets = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createElement: h, Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, value => sets.push(value)],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'card-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const timers = new Set()
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false }, TextEncoder,
  setTimeout: (fn) => { const timer = { fn }; timers.add(timer); return timer },
  clearTimeout: timer => timers.delete(timer),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ToolCell, TriggerCell, callTree, stackReplies, QuestionDock, SecretDock, countCards, ViewMenuList, WidgetView } = module.exports

// Runs the effects collected since the last render; returns the cleanups.
const mount = () => {
  const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function')
  effects = []
  return () => { for (const cleanup of cleanups) cleanup() }
}
const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props.children, match)
}
const count = (haystack, needle) => haystack.split(needle).length - 1

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const chief = { id: 'chief', name: 'Chief', color: 'green' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief' }
const team = (over = {}) => ({
  bots: [writer, chief], byId: { writer, chief }, rooms: [room], roomsById: { room }, exchangeTurns: {},
  questions: {}, secretRequests: {}, secrets: [], ...over,
})
const question = (callId, over = {}) => ({ id: 'question', callId, question: 'Which draft?', options: [{ label: 'Short' }], allowCustom: true, ...over })
const request = (callId, over = {}) => ({ id: 'request', callId, sessionId: chief.id, name: 'DEMO_TOKEN', purpose: 'Test card', status: 'pending', kind: 'fill', ...over })

const text$ = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const call = (name, callId, { args = {}, content = '', subCalls = [], running = false, isError = false, error } = {}) => (running
  ? { phase: 'start', name, callId, argsRaw: JSON.stringify(args), subCalls, turn: 0 }
  : { kind: 'tool-result', name, callId, call: { name, argsRaw: JSON.stringify(args) }, content: text$(content), isError, ...(error === undefined ? {} : { error }), subCalls })
const program = (subCalls, over = {}) => call('run_code', 'program', { subCalls, ...over })

test('a member\'s messages in a row stack under its name, and an event line starts a new block', () => {
  const replies = [
    { botId: 'writer', text: 'a', time: 10, duration: 1000 }, { botId: 'writer', text: 'b', time: 20, duration: 2000 },
    { kind: 'working', botId: 'writer', time: 30 },
    { botId: 'writer', text: 'c', time: 40, duration: 4000 }, { botId: 'chief', text: 'd', time: 50, duration: 5000 },
    { botId: 'writer', text: 'e', time: 60, duration: 6000 },
  ]
  assert.deepEqual(JSON.parse(JSON.stringify(stackReplies(replies).map(item => [item.index, item.texts]))), [[0, ['a', 'b']], [2, []], [3, ['c']], [4, ['d']], [5, ['e']]])
  // A stacked block carries its last message's time and how long that turn ran.
  const [stacked, event, single] = stackReplies(replies)
  assert.deepEqual([stacked.time, stacked.duration], [20, 2000])
  assert.deepEqual([event.time, event.duration], [30, undefined])
  assert.deepEqual([single.time, single.duration], [40, 4000])
})

// A time in the machine's own zone, some days back, so the test does not depend on the zone.
const at = (daysAgo, hour, minute) => {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).getTime()
}
const clockOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const findAll = (node, match) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) { entry.forEach(visit); return }
    if (!entry || typeof entry !== 'object') return
    if (match(entry)) found.push(entry)
    visit(entry.props?.children)
  }
  visit(node)
  return found
}

test('a group reply shows its time, and how long its turn ran', () => {
  const today = at(0, 14, 5)
  const yesterday = at(1, 9, 3)
  const replies = [
    { botId: 'writer', text: 'Draft is up.', time: today, duration: 68_000 },
    { botId: 'chief', text: 'Looks good.', time: yesterday, duration: 2_000 },
  ]
  const out = show(call('group_relay', 'direct', { content: { replies } }), { sessionId: 'room' })
  const times = findAll(out, node => node.props?.className === 'bt-group-time')
  const tooks = findAll(out, node => node.props?.className === 'bt-group-took')
  assert.deepEqual(times.map(text), [clockOf(today), `Yesterday ${clockOf(yesterday)}`])
  assert.deepEqual(times.map(node => node.props.title), [`Today ${clockOf(today)}`, `Yesterday ${clockOf(yesterday)}`])
  assert.deepEqual(tooks.map(text), ['1m 8s', '2s'])
  assert.deepEqual(tooks.map(node => node.props.title), ['Ran for 1m 8s', 'Ran for 2s'])
})

// A user text sent while a relay runs joins the round's replies with its time.
test('a user message inside a group relay shows its time', () => {
  const today = at(0, 14, 5)
  const replies = [
    { kind: 'user', text: 'hold on', time: today },
    { botId: 'writer', text: 'Draft is up.', time: at(0, 14, 6), duration: 1000 },
  ]
  const out = show(call('group_relay', 'direct', { content: { replies } }), { sessionId: 'room' })
  const times = findAll(out, node => node.props?.className === 'bt-utime')
  assert.deepEqual(times.map(text), [clockOf(today)])
  assert.deepEqual(times.map(node => node.props.title), [`Today ${clockOf(today)}`])
})

// A group paused at its relay limit shows the wait, with a Continue button while
// the room still parks calls — which calls room-continue with the group's id.
test('a paused group shows the wait, and Continue releases it while calls are parked', () => {
  const replies = [{ kind: 'paused', names: ['Writer', 'Coder'], count: 6, time: at(0, 14, 5) }]
  const relay = call('group_relay', 'direct', { content: { replies } })

  // Nothing parked on the room: the line stands alone, with no button.
  const plain = show(relay, { sessionId: 'room' })
  const events = findAll(plain, node => node.props?.className === 'bt-event').map(text)
  assert.deepEqual(events, ['Paused after 6 Bot relays. Waiting: Writer and Coder'])
  assert.equal(find(plain, node => node.type === 'button' && text(node) === 'Continue'), undefined)

  const parked = { ...room, paused: [{ id: 'writer', name: 'Writer' }] }
  const clicked = []
  const live = show(relay, {
    sessionId: 'room',
    roster: team({ rooms: [parked], roomsById: { room: parked } }),
    actions: { continueRoom: id => clicked.push(id) },
  })
  const button = find(live, node => node.type === 'button' && text(node) === 'Continue')
  assert.ok(button, 'the Continue button is drawn while the room parks calls')
  button.props.onClick()
  assert.deepEqual(clicked, ['room'])
})

// The trigger of a post in a group chat carries the event's time, not the post's.
test('a group post drawn from its trigger shows the time it came in', () => {
  const time = at(0, 16, 42)
  const node = {
    key: 'trigger', kind: 'turn-trigger', location: { turn: { turn: 1 } },
    data: { seq: 7, time, content: text$('Draft is up.'), source: { kind: 'bot', role: 'post', senderSessionId: 'writer', senderName: 'Writer' } },
  }
  const out = expand(TriggerCell({
    node, sessionId: 'room', actions: {},
    useRoster: select => select(team()), useSessions: select => select({ byId: {} }),
    useTurnClock: select => select({}), useUi: select => select({ visits: {}, reactions: {} }),
  }))
  const stamps = findAll(out, entry => entry.props?.className === 'bt-group-time')
  assert.equal(stamps.length, 1)
  assert.equal(text(stamps[0]), clockOf(time))
  effects = []
})

const props = (root, { sessionId = chief.id, roster = team(), actions = {}, turn = 1, held = {} } = {}) => ({
  node: { key: 'node', data: { root }, location: { turn: { turn } } }, sessionId,
  useRoster: select => select(roster), useUi: select => select({ reactions: {}, visits: {} }), actions,
  useHeldCards: select => select(held),
})
const show = (root, options) => {
  const out = expand(ToolCell(props(root, options)))
  effects = []
  return out
}
const shown = (root, options) => text(show(root, options))

// One finished call of every kind ToolCell draws, and what it shows.
const BRANCHES = [
  ['message_bot', { args: { to: 'Writer' } }, /Messaged.*Writer/],
  ['stop_bot', { args: { bot: 'Writer' } }, /Stopped.*Writer/],
  ['create_bot', { args: { name: 'Writer' } }, /Created.*Writer/],
  ['update_bot', { args: { name: 'Writer' } }, /Updated.*Writer/],
  ['group_relay', { content: { replies: [{ botId: 'writer', text: 'Relay reply.' }] } }, /Writer.*Relay reply\./],
  ['create_group', { content: 'Created group "Ops" with Writer.' }, /Created group.*Ops/],
  ['update_group', { content: 'Updated "Ops".' }, /Updated group.*Ops/],
  ['delete_group', { content: 'Deleted "Ops".' }, /Deleted group/],
  ['post_to_group', { content: 'Posted in "Ops".' }, /Posted in.*Ops/],
  ['ask_user', {}, /Which draft\?.*Short/],
  ['request_secret', { args: { name: 'DEMO_TOKEN' } }, /Chief needs a key.*DEMO_TOKEN/],
  ['ask_user_question', { args: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] }, content: { answers: [{ selected: ['Yes'] }] } }, /Ship it\?.*Yes/],
  ['read_group_chat', { args: { group: 'Ops' } }, /Read.*Ops/],
  ['remember', { args: { scope: 'Chief' }, content: 'Saved to Chief memory.' }, /Memory updated/],
  ['forget', { args: { scope: 'Chief' }, content: 'Removed from Chief memory.' }, /Memory updated/],
]
const rosterFor = callId => team({ questions: { chief: question(callId) }, secretRequests: { chief: [request(callId)] } })

test('every call ToolCell draws shows the same nested in a PTC program as on its own', () => {
  assert.equal(BRANCHES.length, 15)
  for (const [name, options, expected] of BRANCHES) {
    const native = shown(call(name, 'direct', options), { roster: rosterFor('direct') })
    assert.match(native, expected, `${name} on its own`)
    const nested = shown(program([call(name, 'program:ptc:1', options)]), { roster: rosterFor('program:ptc:1') })
    assert.equal(nested, native, `${name} under run_code`)
    const deep = shown(program([call('run_code', 'program:ptc:1', { subCalls: [call(name, 'program:ptc:1:ptc:1', options)] })]), { roster: rosterFor('program:ptc:1:ptc:1') })
    assert.equal(deep, native, `${name} two programs deep`)
  }
})

test('a program draws every known sub-call in dispatch order and each call once', () => {
  const relay = call('group_relay', 'program:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Group reply.' }] } })
  const message = call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })
  const secret = call('request_secret', 'program:ptc:3', { args: { name: 'DEMO_TOKEN' } })
  const root = program([message, call('run_code', 'program:ptc:4', { subCalls: [relay, secret, message] }), relay, call('bash', 'program:ptc:5')])
  assert.deepEqual(JSON.parse(JSON.stringify(callTree(root).map(entry => entry.callId))), ['program', 'program:ptc:1', 'program:ptc:4', 'program:ptc:2', 'program:ptc:3', 'program:ptc:5'])
  const out = shown(root, { roster: team({ secretRequests: { chief: [request('program:ptc:3')] } }) })
  assert.match(out, /Messaged.*Writer.*Group reply\..*Chief needs a key/)
  assert.equal(count(out, 'Messaged'), 1)
  assert.equal(count(out, 'Group reply.'), 1)
  assert.equal(count(out, 'needs a key'), 1)
})

test('nested group relays keep their own replies in order, each once', () => {
  const first = call('group_relay', 'program:ptc:1:ptc:1', { content: { replies: [{ botId: 'writer', text: 'First reply.' }] } })
  const second = call('group_relay', 'program:ptc:1:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Second reply.' }] } })
  const out = shown(program([call('run_code', 'program:ptc:1', { subCalls: [first, second] }), first]), { sessionId: 'room' })
  assert.match(out, /First reply\..*Second reply\./)
  assert.equal(count(out, 'First reply.'), 1)
})

test('cards and replies still show when the program\'s own call head left the loaded history', () => {
  const roster = team({ questions: { chief: question('program:ptc:3') }, secretRequests: { chief: [request('program:ptc:1')] } })
  const relay = call('group_relay', 'program:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Group reply.' }] } })
  const root = { ...program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } }), relay, call('ask_user', 'program:ptc:3')]), name: '', call: null }
  assert.match(shown(root, { roster }), /Chief needs a key.*Group reply\..*Which draft\?/)
})

test('each sub-call shows its own state, not its program\'s', () => {
  const created = call('create_bot', 'program:ptc:1', { args: { name: 'Writer' } })
  assert.match(shown(program([created], { running: true })), /Created.*Writer/)
  assert.equal(shown(program([{ ...call('create_bot', 'program:ptc:1', { args: { name: 'Writer' }, running: true }) }])), '')
  const failed = call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, isError: true })
  assert.match(shown(program([failed])), /Couldn't message Writer/)
  assert.match(shown(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })], { isError: true })), /^Messaged/)
  const refused = call('post_to_group', 'program:ptc:1', { content: 'No group is called "Nope".', isError: true })
  const posted = call('post_to_group', 'program:ptc:2', { content: 'Posted in "Ops".' })
  assert.match(shown(program([refused, posted])), /Couldn't post in the group.*Posted in.*Ops/)
})

test('a program with no known sub-call draws nothing, as before', () => {
  assert.equal(ToolCell(props(program([]))), null)
  assert.equal(ToolCell(props(program([call('bash', 'program:ptc:1'), call('read_file', 'program:ptc:2')]))), null)
  assert.equal(ToolCell(props(call('bash', 'direct'))), null)
  effects = []
})

test('a hidden Bot-to-Bot turn draws none of its sub-calls', () => {
  const roster = team({ exchangeTurns: { chief: [1] }, secretRequests: { chief: [request('program:ptc:1')] } })
  const root = program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } }), call('message_bot', 'program:ptc:2', { args: { to: 'Writer' } })])
  assert.equal(shown(root, { roster }), '')
  assert.match(shown(root, { roster, turn: 2 }), /Chief needs a key.*Messaged/)
})

// The line a memory write that changed nothing draws.
const memoryLine = (root, options) => find(show(root, options), node => node.props?.className === 'bt-event bt-event-error')
// The buttons a line draws.
const lineButtons = node => findAll(node, entry => entry.type === 'button')
// A write that failed, with the kind of failure the host named.
const failedWrite = (name, args, code, message) => call(name, `${name}:1`, {
  args, content: `Error: ${message}`, isError: true, error: { name: 'MemoryWriteError', code },
})

test('a memory write that failed says so, and opens the memory it meant to change', () => {
  const opened = []
  const actions = { openMemory: id => opened.push(id) }
  const line = memoryLine(failedWrite('remember', { scope: 'Writer' }, 'memory/refused', 'Only Main Bots and group admins write the team memory.'), { actions })
  assert.match(text(line), /Couldn't save to memory/)
  // The reason is ours, in our words: what the host said stays in the tool record.
  assert.match(text(line), /The memory refused this change/)
  assert.doesNotMatch(text(line), /team memory/)
  assert.equal(line.props.role, 'status')
  assert.equal(line.props.title, 'memory/refused')
  // The way into the panel opens the scope the call named.
  lineButtons(line)[0].props.onClick()
  assert.deepEqual(opened, ['writer'])
})

test('a removal that failed says it could not remove the entry, and why', () => {
  const line = memoryLine(failedWrite('forget', {}, 'memory/no-match', 'No entry in your memory matches "tea".'), {})
  assert.match(text(line), /Couldn't remove from memory/)
  assert.match(text(line), /No saved entry matched/)
  // The entry the call named is not repeated in the notice.
  assert.doesNotMatch(text(line), /tea/)
})

test('the reason follows the kind of failure, not the words of the host', () => {
  const reason = (code, message = 'Error: Something went wrong.') => text(memoryLine(failedWrite('remember', {}, code, message), {}))
  assert.match(reason('memory/empty'), /Write something to save/)
  assert.match(reason('memory/no-match'), /No saved entry matched/)
  assert.match(reason('memory/refused'), /The memory refused this change/)
  assert.match(reason('memory/denied'), /The memory refused this change/)
  assert.match(reason('memory/failed'), /The memory could not be changed/)
  // A failure this interface does not know still says what happened, in short.
  assert.match(reason('memory/bot-gone'), /The memory could not be changed/)
})

test('a write with nothing in it says what is missing', () => {
  const line = memoryLine(failedWrite('remember', {}, 'memory/empty', 'Write the entry to save.'), {})
  assert.match(text(line), /Couldn't save to memory · Write something to save/)
})

test('a memory write for a Bot that is gone says so, with no button to nowhere', () => {
  const opened = []
  const line = memoryLine(failedWrite('remember', { scope: 'Ghost' }, 'memory/refused', 'No Bot named Ghost.'), { actions: { openMemory: id => opened.push(id) } })
  assert.match(text(line), /Couldn't save to memory/)
  assert.equal(lineButtons(line).length, 0)
  assert.deepEqual(opened, [])
})

test('a group write opens the memory of the group, and outside a group it has no button', () => {
  const opened = []
  const actions = { openMemory: id => opened.push(id) }
  const failed = failedWrite('remember', { scope: 'group' }, 'memory/refused', 'Only the members of a group chat write its memory.')
  const inGroup = memoryLine(failed, { sessionId: 'room', actions })
  assert.match(text(inGroup), /Couldn't save to memory/)
  lineButtons(inGroup)[0].props.onClick()
  assert.deepEqual(opened, ['room'])
  // Outside a group chat there is no group memory to open.
  const outside = memoryLine(failed, { actions })
  assert.equal(lineButtons(outside).length, 0)
})

test('a memory result that is no saved entry says the memory did not change', () => {
  const line = memoryLine(call('remember', 'remember:1', { content: 'Only Main Bots and group admins write the team memory.' }), {})
  assert.match(text(line), /Memory not changed/)
  assert.doesNotMatch(text(line), /team memory/)
})

test('an entry that was already saved keeps the quiet line, not a failure and not a change', () => {
  const opened = []
  const out = show(call('remember', 'remember:1', { content: 'Already in your memory (MEMORY.md): "Likes tea". Nothing changed.' }), { actions: { openMemory: id => opened.push(id) } })
  assert.equal(find(out, node => node.props?.className === 'bt-event bt-event-error'), undefined)
  assert.match(text(out), /Already saved/)
  assert.doesNotMatch(text(out), /Memory updated/)
  lineButtons(out)[0].props.onClick()
  assert.deepEqual(opened, ['chief'])
})

test('a save that came later does not say the earlier one recovered', () => {
  const failed = failedWrite('remember', {}, 'memory/refused', 'Only Main Bots and group admins write the team memory.')
  const saved = call('remember', 'remember:2', { content: 'Saved to your memory, in MEMORY.md (MEMORY.md: 20 of 4000 characters).' })
  const out = shown(program([failed, saved]))
  // The failure stands, with its own reason; the later save only says its own.
  assert.equal(count(out, "Couldn't save to memory"), 1)
  assert.equal(count(out, 'Only Main Bots and group admins write the team memory'), 0)
  assert.match(out, /Memory updated/)
})

test('a message line opens the exchange of the chat\'s Bot, from any part', () => {
  const opened = []
  const out = show(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })]), { actions: { openExchange: (...ids) => opened.push(ids) } })
  find(out, node => node.type === 'button').props.onClick()
  const current = { ...chief, sessionId: 'chief-2', parts: ['chief', 'chief-2'] }
  const roster = team({ bots: [writer, current], byId: { writer, chief: current, 'chief-2': current } })
  const later = show(call('message_bot', 'direct', { args: { to: 'Writer' } }), { sessionId: 'chief-2', roster, actions: { openExchange: (...ids) => opened.push(ids) } })
  find(later, node => node.type === 'button').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['chief', 'writer'], ['chief', 'writer']])
})

// The activity row reads one note per chat node.
const notes = (root, options = {}) => {
  const log = []
  ToolCell(props(root, { ...options, actions: { noteLive: (sessionId, id, entry) => log.push({ sessionId, id, entry }) } }))
  const unmount = mount()
  unmount()
  return JSON.parse(JSON.stringify(log))
}

test('the live note follows the running sub-call of a program', () => {
  const asking = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })], { running: true }))
  assert.deepEqual(asking, [
    { sessionId: 'chief', id: 'tool:program', entry: { label: 'Asking Writer', state: 'sending' } },
    { sessionId: 'chief', id: 'tool:program', entry: null },
  ])
  const relaying = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } }), call('group_relay', 'program:ptc:2', { running: true })], { running: true }))
  assert.equal(relaying[0].entry.relay, true)
  const shell = notes(program([call('bash', 'program:ptc:1', { running: true })], { running: true }))
  assert.equal(shell[0].entry.label, 'Running shell commands')
  const between = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })], { running: true }))
  assert.equal(between[0].entry.label, null)
  assert.deepEqual(notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })])), [])
  const roster = team({ exchangeTurns: { chief: [1] } })
  assert.deepEqual(notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })], { running: true }), { roster }), [])
  assert.equal(notes(call('message_bot', 'direct', { args: { to: 'Writer' }, running: true }))[0].entry.label, 'Asking Writer')
})

// A minimal cards store, as index.js keeps it.
const cardStore = () => {
  const store = { state: {} }
  store.noteCards = (sessionId, ids, delta) => { store.state = countCards(store.state, sessionId, ids, delta) }
  return store
}
const draw = (root, store, options = {}) => {
  effects = []
  ToolCell(props(root, { ...options, actions: { noteCards: store.noteCards } }))
  const unmount = mount()
  return { out: show(root, options), unmount }
}

test('a cell tells the docks which card calls it draws, until it unmounts', () => {
  const store = cardStore()
  const root = program([call('ask_user', 'program:ptc:1'), call('request_secret', 'program:ptc:2'), call('message_bot', 'program:ptc:3')])
  ToolCell(props(root, { actions: { noteCards: store.noteCards } }))
  const unmount = mount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: { 'program:ptc:1': 1, 'program:ptc:2': 1 } })
  ToolCell(props(root, { actions: { noteCards: store.noteCards } }))
  const second = mount()
  assert.equal(store.state.chief['program:ptc:1'], 2)
  second()
  unmount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: {} })
  ToolCell(props(root, { actions: { noteCards: store.noteCards }, roster: team({ exchangeTurns: { chief: [1] } }) }))
  mount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: {} })
})

const dockProps = (store, roster, { sessionId = chief.id, openState = 'open', actions = {}, held = {} } = {}) => ({
  sessionId, actions,
  useRoster: select => select(roster),
  useCards: select => select(store.state),
  useHeldCards: select => select(held),
  useSession: select => select({ openState }),
})
const docks = (store, roster, options) => {
  const out = text(expand([QuestionDock(dockProps(store, roster, options)), SecretDock(dockProps(store, roster, options))]))
  effects = []
  return out
}

test('a secret request refused on a read-only window says so in one line', () => {
  const refused = 'No card can be shown now. The Bot team in /somewhere is open in another dsh (Web or Desktop, pid 4 on host-a). This window shows the team but cannot change it; close the other one and reload.'
  const root = program([call('request_secret', 'program:ro', { args: { name: 'DEMO_TOKEN' }, content: refused })])
  assert.match(shown(root), /Chief could not ask for a key: this window can only view the team/)
  // Other refusals stay silent: they are written for the model.
  const wrong = 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.'
  assert.equal(shown(program([call('request_secret', 'program:grp', { args: { name: 'DEMO_TOKEN' }, content: wrong })])), '')
})

test('a card whose call is not drawn waits in the dock; a drawn one shows only at its call', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('program:ptc:1') }, secretRequests: { chief: [request('program:ptc:2')] } })
  const root = program([call('ask_user', 'program:ptc:1'), call('request_secret', 'program:ptc:2', { args: { name: 'DEMO_TOKEN' } })])
  assert.match(docks(store, roster), /Which draft\?.*Chief needs a key/)
  const { out, unmount } = draw(root, store, { roster })
  const inline = text(out)
  assert.equal(docks(store, roster), '')
  assert.equal(count(inline, 'Which draft?'), 1)
  assert.equal(count(inline, 'needs a key'), 1)
  unmount()
  assert.match(docks(store, roster), /Which draft\?.*Chief needs a key/)
})

test('the docks keep pending cards through history loading until their calls actually mount', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('program:ptc:1') }, secretRequests: { chief: [request('program:ptc:2')] } })
  for (const openState of ['cold', 'loading', 'open', 'error']) {
    const waiting = docks(store, roster, { openState })
    assert.equal(count(waiting, 'Which draft?'), 1, openState)
    assert.equal(count(waiting, 'needs a key'), 1, openState)
  }
  const root = program([call('ask_user', 'program:ptc:1'), call('request_secret', 'program:ptc:2', { args: { name: 'DEMO_TOKEN' } })])
  const { out, unmount } = draw(root, store, { roster })
  assert.equal(docks(store, roster, { openState: 'loading' }), '')
  assert.equal(count(text(out), 'Which draft?'), 1)
  assert.equal(count(text(out), 'needs a key'), 1)
  unmount()
  assert.match(docks(store, roster, { openState: 'loading' }), /Which draft\?.*Chief needs a key/)
  const free = team({ questions: { chief: question(undefined) }, secretRequests: { chief: [request(undefined)] } })
  assert.match(docks(store, free, { openState: 'loading' }), /Which draft\?.*Chief needs a key/)
})

test('an edited dock card stays there when its history call mounts, with no inline copy', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('q-call') }, secretRequests: { chief: [request('s-call')] } })
  const root = program([call('ask_user', 'q-call'), call('request_secret', 's-call')])
  const held = { chief: { '["question","question"]': 1, '["secret","request"]': 1 } }
  const { unmount } = draw(root, store, { roster })
  assert.equal(shown(root, { roster, held }), '')
  assert.match(docks(store, roster, { held, openState: 'loading' }), /Which draft\?.*Chief needs a key/)
  unmount()
  assert.match(docks(store, roster, { held, openState: 'loading' }), /Which draft\?.*Chief needs a key/)
})

test('dock ownership is isolated by session, request id and card kind, not the call id', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('same-call', { id: 'same-id' }) }, secretRequests: { chief: [request('same-call', { id: 'same-id' })] } })
  const root = program([call('ask_user', 'same-call'), call('request_secret', 'secret-call')])
  // Duplicate call ids are coalesced by callTree, so check each kind separately.
  const questionCall = call('ask_user', 'same-call')
  const secretCall = call('request_secret', 'same-call')
  const { unmount } = draw(root, store, { roster })
  for (const held of [
    { writer: { '["question","same-id"]': 1, '["secret","same-id"]': 1 } },
    { chief: { '["question","old-id"]': 1, '["secret","old-id"]': 1 } },
  ]) {
    assert.match(shown(questionCall, { roster, held }), /Which draft\?/)
    assert.match(shown(secretCall, { roster, held }), /needs a key/)
    assert.equal(docks(store, roster, { held }), '')
  }
  const held = { chief: { '["question","same-id"]': 1 } }
  assert.equal(shown(questionCall, { roster, held }), '')
  assert.match(shown(secretCall, { roster, held }), /needs a key/)
  assert.match(docks(store, roster, { held }), /Which draft\?/)
  assert.doesNotMatch(docks(store, roster, { held }), /needs a key/)
  unmount()
})

test('completed requests leave the dock and can show settled history even during ownership cleanup', () => {
  const store = cardStore()
  const held = { chief: { '["question","question"]': 1, '["secret","request"]': 1 } }
  const roster = team({ secretRequests: { chief: [request('s-call', { status: 'canceled' })] } })
  const root = program([call('ask_user', 'q-call'), call('request_secret', 's-call')])
  assert.equal(docks(store, roster, { held }), '')
  assert.match(shown(root, { roster, held }), /Chief asked for DEMO_TOKEN.*Canceled/)
})

test('a question can be answered and a secret request canceled before history arrives', async () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('question-call') }, secretRequests: { chief: [request('secret-call')] } })
  const answers = []
  const canceled = []
  const actions = { answerQuestion: async (...args) => answers.push(args), secretCancel: async id => canceled.push(id) }
  const asking = expand(QuestionDock(dockProps(store, roster, { openState: 'cold', actions })))
  find(asking, node => node.type === 'button' && node.props.className === 'bt-q-opt').props.onClick()
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [['chief', 'question', { selected: ['Short'], custom: '' }]])
  const secret = expand(SecretDock(dockProps(store, roster, { openState: 'loading', actions })))
  await find(secret, node => node.props['aria-label'] === 'Cancel the request').props.onClick()
  assert.deepEqual(canceled, ['request'])
  effects = []
  assert.equal(docks(store, team(), { openState: 'loading' }), '')
})

test('a card from an earlier part waits in the dock even when a call here has the same id', () => {
  const store = cardStore()
  const current = { ...chief, sessionId: 'chief-2', parts: ['chief', 'chief-2'] }
  const roster = team({ bots: [writer, current], byId: { writer, chief: current, 'chief-2': current }, secretRequests: { chief: [request('call-1', { sessionId: 'chief' })] } })
  const { out, unmount } = draw(call('request_secret', 'call-1', { args: { name: 'DEMO_TOKEN' } }), store, { roster, sessionId: 'chief-2' })
  assert.doesNotMatch(text(out), /needs a key/)
  assert.match(docks(store, roster, { sessionId: 'chief-2' }), /Chief needs a key/)
  unmount()
})

test('a secret in a hidden turn shows in the dock instead of nowhere', () => {
  const store = cardStore()
  const roster = team({ exchangeTurns: { chief: [1] }, secretRequests: { chief: [request('program:ptc:1')] } })
  const { out, unmount } = draw(program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } })]), store, { roster })
  assert.equal(text(out), '')
  assert.match(docks(store, roster), /Chief needs a key/)
  unmount()
})

// #38: a PTC group round's replies vanished once the round ended.
test('a PTC group relay shows its replies from the sub-call, live and after reload', async () => {
  const replies = [{ botId: 'writer', text: 'Hello from Writer.' }, { botId: 'chief', text: 'Hello from Chief.' }]
  const finished = program([call('group_relay', 'call-1-1:ptc:1', { content: { replies } })])
  const reloaded = shown(finished, { sessionId: 'room' })
  assert.match(reloaded, /Writer.*Hello from Writer\..*Chief.*Admin.*Hello from Chief\./)
  const headless = { ...finished, name: '', call: null }
  assert.equal(shown(headless, { sessionId: 'room' }), reloaded)

  const progress = [{ callId: 'other', replies: [{ botId: 'chief', text: 'Not this round.' }] }, { callId: 'call-1-1:ptc:1', replies: replies.slice(0, 1), speaking: 'chief' }]
  const asked = []
  const actions = { roomProgress: async (id) => { asked.push(id); return progress } }
  const running = program([call('group_relay', 'call-1-1:ptc:1', { running: true })], { running: true })
  const relay = find(ToolCell(props(running, { sessionId: 'room', actions })), node => node.type?.name === 'GroupReplies')
  effects = []
  sets.length = 0
  relay.type(relay.props)
  const stop = mount()
  await new Promise(resolve => setImmediate(resolve))
  stop()
  timers.clear()
  assert.deepEqual(asked, ['room'])
  assert.deepEqual(JSON.parse(JSON.stringify(sets)), [{ replies: replies.slice(0, 1), speaking: 'chief' }])
})

// #105: the secret and question cards of a PTC program showed nowhere.
test('PTC secret and question cards show at their sub-calls and act on their own requests', async () => {
  const roster = team({ questions: { chief: question('call-1-2:ptc:1') }, secretRequests: { chief: [request('call-2-1:ptc:1')] } })
  const answers = []
  const canceled = []
  const actions = { answerQuestion: async (...args) => answers.push(args), secretCancel: async id => canceled.push(id) }
  const asking = show(program([call('ask_user', 'call-1-2:ptc:1')]), { roster, actions })
  assert.match(text(asking), /Which draft\?/)
  find(asking, node => node.type === 'button' && node.props.className === 'bt-q-opt').props.onClick()
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [['chief', 'question', { selected: ['Short'], custom: '' }]])

  const secret = show(program([call('request_secret', 'call-2-1:ptc:1', { args: { name: 'DEMO_TOKEN' }, running: true })], { running: true }), { roster, actions })
  assert.match(text(secret), /Chief needs a key/)
  await find(secret, node => node.props['aria-label'] === 'Cancel the request').props.onClick()
  assert.deepEqual(canceled, ['request'])

  const settled = team({ secretRequests: { chief: [request('call-2-1:ptc:1', { status: 'canceled' })] } })
  const after = shown(program([call('request_secret', 'call-2-1:ptc:1', { args: { name: 'DEMO_TOKEN' } })]), { roster: settled })
  assert.match(after, /Chief asked for DEMO_TOKEN.*Canceled/)
  assert.doesNotMatch(after, /Paste or type the key/)
  assert.doesNotMatch(shown(program([call('ask_user', 'call-0-1:ptc:1')]), { roster }), /Which draft\?/)
  assert.equal(shown(program([call('ask_user', 'call-1-2:ptc:1')]), { roster: team() }), '')
})

// #133: a DSH goal round showed its raw <goal_round> prompt as an event line.
test('a goal round draws nothing, while another unknown trigger keeps its event line', () => {
  const trigger = source => expand(TriggerCell({
    node: { key: 'node', data: { source, turn: 2, content: text$('<goal_round>Keep going</goal_round>') }, location: { turn: { turn: 2 } } },
    sessionId: 'room',
    useRoster: select => select(team()),
    useSessions: select => select({ byId: {} }),
    useTurnClock: select => select({}),
    useUi: select => select({ visits: {} }),
    actions: {},
  }))
  assert.equal(trigger({ kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 }), null)
  assert.match(text(trigger({ kind: 'webhook' })), /<goal_round>Keep going/)
})

// #212: the chat hands a trigger its event (seq, content, source) but no turn, so every post
// in a group chat shared one reaction entry: a reaction on one showed on all of them.
test('a reaction on a group post stays on that post, also after it draws again', () => {
  const ui = { visits: {}, reactions: {} }
  const actions = {
    toggleReaction: (key, index, emoji) => {
      const entry = { ...ui.reactions[key] }
      const list = entry[index] ?? []
      entry[index] = list.includes(emoji) ? list.filter(item => item !== emoji) : [...list, emoji]
      if (entry[index].length === 0) delete entry[index]
      ui.reactions = { ...ui.reactions, [key]: entry }
    },
  }
  // The trigger node the chat builds for a user/message from a Bot.
  const post = (seq, turn, from, words) => ({
    key: `turn-trigger:${seq}`, kind: 'turn-trigger', anchorSeq: seq, location: { turn: { turn } },
    data: { kind: 'context', seq, time: 1, content: text$(words), source: { kind: 'bot', role: 'post', senderSessionId: from, senderName: from }, producer: {}, form: null },
  })
  const draw = node => TriggerCell({
    node, sessionId: 'room', actions,
    useRoster: select => select(team()), useSessions: select => select({ byId: {} }),
    useTurnClock: select => select({}), useUi: select => select(ui),
  })
  // The handler a bubble's reaction menu calls, read before the menu draws.
  const reactOf = (node) => {
    if (Array.isArray(node)) return node.map(reactOf).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    if (typeof node.props?.react === 'function') return node.props.react
    if (typeof node.type === 'function') return reactOf(node.type(node.props))
    return reactOf(node.props?.children)
  }
  const chips = node => count(JSON.stringify(expand(node)), '"aria-label":"Remove reaction')
  const first = post(41, 3, 'writer', 'Draft is up')
  const sameTurn = post(44, 3, 'chief', 'Looks good')
  const later = post(57, 5, 'writer', 'Second draft')

  reactOf(draw(first))('👍')
  assert.deepEqual([chips(draw(first)), chips(draw(sameTurn)), chips(draw(later))], [1, 0, 0])
  // A fresh node for the same event, as after a reload, finds the reaction again.
  assert.equal(chips(draw(post(41, 3, 'writer', 'Draft is up'))), 1)
  reactOf(draw(later))('❤️')
  reactOf(draw(first))('👍')
  assert.deepEqual([chips(draw(first)), chips(draw(sameTurn)), chips(draw(later))], [0, 0, 1])
})

test('a show_view call the host refused draws nothing; a display-only card draws with the trimmed title', () => {
  const cell = (title, view, extra = {}) => show(call('show_view', 'view-call', { args: { title, view, ...extra } }), { roster: team({ views: {} }) })
  const gone = (node) => {
    assert.ok(find(node, each => each.props?.className === 'bt-q-gone') !== undefined, 'the call leaves the hidden mark')
    assert.equal(text(node), '')
  }
  // Refusals the host returned as text reach the cell as a done call; the shared
  // check hides them so the model's retry stays the only card.
  gone(cell('Card', { type: 'nope' }))
  gone(cell('x'.repeat(8192), { type: 'text', text: 'hi' }))
  gone(cell('Pick', { type: 'options', id: 'o', options: [{ label: 'A' }] }))
  gone(cell('Meter', { type: 'metric', label: 'Done', value: '3' }, { await_reply: true }))
  const card = cell('  Status  ', { type: 'metric', label: 'Done', value: '3' })
  const title = find(card, node => node.props?.className === 'bt-view-title')
  assert.ok(title !== undefined)
  assert.equal(text(title), 'Status')
  // A view needs no title: it then draws without a heading.
  const bare = cell('  ', { type: 'text', text: 'hi' })
  assert.equal(find(bare, node => node.props?.className === 'bt-view-title'), undefined)
  assert.ok(find(bare, node => typeof node.props?.className === 'string' && node.props.className.includes('bt-view-bare')) !== undefined)
})

test('a display-only call still draws when the args come through the value accessor', () => {
  // DSH's PartialArguments reads strings through text() — value() returns
  // undefined for them — so the title has to go through the string accessor.
  const data = { title: 'Status', view: { type: 'metric', label: 'Done', value: '3' } }
  const callNode = {
    kind: 'tool-result', name: 'show_view', callId: 'view-call', isError: false,
    args: { text: key => (typeof data[key] === 'string' ? data[key] : undefined), value: key => (typeof data[key] === 'string' ? undefined : data[key]) },
    call: { name: 'show_view', argsRaw: JSON.stringify(data) }, content: text$('The view is on screen.'), subCalls: [],
  }
  const node = show(callNode, { roster: team({ views: {} }) })
  const title = find(node, item => item.props?.className === 'bt-view-title')
  assert.ok(title !== undefined, 'the card draws')
  assert.equal(text(title), 'Status')
})

test('a view works its formulas out, draws a chart, and keeps html in a sandboxed frame', () => {
  const cell = view => show(call('show_view', 'view-call', { args: { view } }), { roster: team({ views: {} }) })
  const classed = (node, name) => find(node, item => typeof item.props?.className === 'string' && item.props.className.split(' ').includes(name))
  const calculator = {
    type: 'stack', let: { cost: 'req * 2' },
    children: [
      { type: 'slider', id: 'req', label: 'Requests', min: 0, max: 100, value: 30 },
      { type: 'metric', label: 'Cost', value: { '=': "'¥' + cost" }, tone: { '=': "cost > 50 ? 'bad' : 'good'" } },
    ],
  }
  const live = cell(calculator)
  assert.equal(text(classed(live, 'bt-widget-metric-value')), '¥60')
  assert.equal(classed(live, 'bt-widget-metric').props['data-tone'], 'bad')
  assert.ok(classed(live, 'bt-q') !== undefined, 'a view with inputs wears a light frame')
  assert.equal(find(live, item => item.type === 'input' && item.props.type === 'range').props.value, 30)

  const chart = cell({ type: 'chart', kind: 'bar', categories: ['A', 'B'], series: [{ values: [3, 5] }], unit: 'ms' })
  assert.ok(classed(chart, 'bt-view-bare') !== undefined, 'a view that only shows has no frame')
  assert.ok(find(chart, item => item.type === 'svg') !== undefined)
  const figure = find(chart, item => item.type === 'figure')
  assert.equal(figure.props['data-kind'], 'bar')
  // The ⋯ menu sits in the card's head, not on the chart's axes (#476).
  const head = classed(chart, 'bt-view-head')
  assert.ok(find(head, item => typeof item.props?.className === 'string' && item.props.className.includes('bt-view-more')) !== undefined, 'the card head has the menu button')
  assert.equal(find(figure, item => typeof item.props?.className === 'string' && (item.props.className.includes('bt-chart-more') || item.props.className.includes('bt-chart-tools'))), undefined, 'the chart itself has no menu')
  // A view without a chart has no ⋯ button.
  const metric = cell({ type: 'metric', label: 'Done', value: '3' })
  assert.equal(find(metric, item => typeof item.props?.className === 'string' && item.props.className.includes('bt-view-more')), undefined)
  for (const kind of ['hbar', 'line', 'area', 'donut']) {
    assert.ok(find(cell({ type: 'chart', kind, categories: ['A', 'B'], series: [{ values: [3, 5] }] }), item => item.type === 'svg') !== undefined, kind)
  }

  // The ⋯ menu groups per chart when the view holds more than one (#476).
  const handle = (label, asTable = false) => ({ label, asTable, toggleTable: () => {}, copy: () => {}, save: () => {} })
  const menuItems = node => findAll(node, item => item.props?.role === 'menuitem').map(text)
  const single = expand(ViewMenuList({ charts: [handle('Revenue')], pick: run => run }))
  assert.equal(findAll(single, item => item.props?.className === 'bt-view-menu-label').length, 0, 'one chart needs no group label')
  assert.deepEqual(menuItems(single), ['View as table', 'Copy data', 'Download image'])
  const pair = expand(ViewMenuList({ charts: [handle('Revenue'), handle(null, true), handle('Costs')], pick: run => run }))
  const labels = findAll(pair, item => item.props?.className === 'bt-view-menu-label').map(text)
  assert.deepEqual(labels, ['Revenue', 'Chart 2', 'Costs'], 'each group is named after its chart')
  assert.equal(findAll(pair, item => item.props?.className === 'bt-menu-sep').length, 2, 'groups are separated')
  assert.deepEqual(menuItems(pair), [
    'View as table', 'Copy data', 'Download image',
    'View as chart', 'Copy data', 'Download image',
    'View as table', 'Copy data', 'Download image',
  ], 'each chart keeps its three actions and its table state')
  // A table switch must not re-register the chart: the groups keep mount order,
  // so the toggled chart stays first and its item reads back as the table (#476).
  const ordered = []
  expand(WidgetView({
    view: {
      type: 'stack',
      children: [
        { type: 'chart', kind: 'bar', categories: ['A'], series: [{ values: [1] }], caption: 'One' },
        { type: 'chart', kind: 'bar', categories: ['A'], series: [{ values: [2] }], caption: 'Two' },
        { type: 'chart', kind: 'bar', categories: ['A'], series: [{ values: [3] }] },
      ],
    },
    registerChart: (key, handle) => { ordered.push(handle); return () => { ordered.splice(ordered.indexOf(handle), 1) } },
  }))
  mount()
  assert.equal(ordered.length, 3)
  ordered[0].toggleTable()
  const orderedMenu = expand(ViewMenuList({ charts: ordered, pick: run => run }))
  assert.deepEqual(findAll(orderedMenu, item => item.props?.className === 'bt-view-menu-label').map(text), ['One', 'Two', 'Chart 3'], 'the toggled chart keeps its group position')
  assert.deepEqual(menuItems(orderedMenu).slice(0, 3), ['View as chart', 'Copy data', 'Download image'], 'the first group shows the table state')

  const frame = find(cell({ type: 'html', html: '<b>hi</b>', summary: 'A greeting' }), item => item.type === 'iframe')
  assert.equal(frame.props.sandbox, 'allow-scripts')
  assert.match(frame.props.srcDoc, /Content-Security-Policy" content="default-src 'none'/)
  assert.ok(frame.props.srcDoc.indexOf('Content-Security-Policy') < frame.props.srcDoc.indexOf('<b>hi</b>'), 'the policy comes before the markup')
  assert.equal(frame.props.title, 'A greeting')
})
