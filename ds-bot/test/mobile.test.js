import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { API_VERSION, CAPABILITIES, roomItems } from '../src/host/mobile.js'
import { fakeContext } from './fake-ctx.js'

// A team with no model: Sessions are made in memory, a group round runs on answers
// played back through the session/event listeners, and `history` holds the events
// each Session's page reads, oldest first.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mobile-'))
  const ctx = fakeContext()
  const sent = []
  const history = {}
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) inboxes.set(sessionId, { nextTurn: [], nextStep: [], remove: () => false })
    return inboxes.get(sessionId)
  }
  let sessions = 0
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId]?.at(-1)?.seq ?? 0) + 1 }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async request => sent.push({ sessionId: request.sessionId, prompt: request }),
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
        const events = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records: events.map(event => ({ event })), hasMore: events.length < all.length }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const relay = (roomId, callId) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal: new AbortController().signal })
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, emit, relay, answer, sent, history, routes, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function waitFor(check) {
  for (let at = 0; at < 200; at += 1) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await settle()
  }
  throw new Error('the condition did not hold within 4 s')
}
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message?.source.role === 'room'))

function reader(response) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

async function team(call) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'Launch', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  return { chief, writer, room }
}

const user = (seq, text, time = seq) => ({ seq, time, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const relayCall = (seq, callId) => ({ seq, time: seq, type: 'tool/call', data: { callId, name: 'group_relay', arguments: '{}' } })
const relayResult = (seq, callId, replies) => ({ seq, time: seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ replies, passed: [] }) }] } } })

test('hello names the API version both sides speak, the capabilities and the notice cursor', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const hello = (await call('hello', { client: { name: 'dsh-go', version: '1.0.0' }, api: [1] })).value
  assert.equal(hello.api, API_VERSION)
  assert.equal(hello.apiMin, 1)
  assert.equal(hello.plugin.name, 'ds-bot')
  assert.match(hello.plugin.version, /^\d+\.\d+\.\d+/)
  assert.deepEqual(hello.capabilities, CAPABILITIES)
  assert.equal(typeof hello.boot, 'string')
  assert.equal(hello.seq, 0)
  assert.equal(hello.readOnly, null)
  assert.equal(hello.feed, 'api/bot/feed')
  // A client that speaks only a later version learns the range and that nothing matches.
  const later = (await call('hello', { api: [7] })).value
  assert.equal(later.api, null)
  assert.equal(later.apiMax, API_VERSION)
  // A client that names no version gets the current one.
  assert.equal((await call('hello', {})).value.api, API_VERSION)
})

test('roomItems turns a group Session into speaker-attributed items, oldest first', () => {
  const events = [
    user(1, 'Plan the launch'),
    relayCall(2, 'r1'),
    relayResult(3, 'r1', [
      { botId: 'm1', name: 'Chief', color: 'deepseek', text: '@Writer draft it', time: 10, duration: 1200 },
      { kind: 'user', text: 'and keep it short', time: 11 },
      { kind: 'working', botId: 'b2', name: 'Writer', time: 12 },
      { kind: 'failed', botId: 'b3', name: 'Coder', code: 'HTTP', text: '429', time: 13 },
      { kind: 'unknown-later', botId: 'b3', name: 'Coder', time: 14 },
    ]),
    // A Bot's post from outside the group shows as its message; one a running round
    // logged, or a late event, shows inside a round instead.
    { seq: 4, time: 20, type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'b2', senderName: 'Writer' }, content: [{ type: 'text', text: '[Group post from Writer]\nDraft is ready' }] } },
    { seq: 5, time: 21, type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'b2', senderName: 'Writer', logged: 7 }, content: [{ type: 'text', text: '[Group post from Writer]\nlogged' }] } },
    { seq: 6, time: 22, type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'b2', senderName: 'Writer', done: true }, content: [{ type: 'text', text: 'done' }] } },
    { seq: 7, time: 23, type: 'user/message', data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminder_prompt_json: "Daily standup"' }] } },
    relayCall(8, 'r2'),
  ]
  const { items, open } = roomItems(events)
  assert.deepEqual(items, [
    { id: '1', kind: 'user', text: 'Plan the launch', time: 1 },
    { id: 'r1:0', kind: 'bot', botId: 'm1', name: 'Chief', color: 'deepseek', text: '@Writer draft it', time: 10, duration: 1200 },
    { id: 'r1:1', kind: 'user', text: 'and keep it short', time: 11 },
    { id: 'r1:2', kind: 'event', event: 'working', botId: 'b2', name: 'Writer', time: 12 },
    { id: 'r1:3', kind: 'event', event: 'failed', botId: 'b3', name: 'Coder', text: '429', code: 'HTTP', time: 13 },
    { id: '4', kind: 'bot', botId: 'b2', name: 'Writer', text: 'Draft is ready', time: 20 },
    { id: '7', kind: 'event', event: 'schedule', text: 'Daily standup', time: 23 },
  ])
  assert.deepEqual(open, [{ callId: 'r2', at: 7 }])
})

test('a group round logs notices a returning client reads back, and the feed says the group changed', async (t) => {
  const { call, emit, relay, answer, sent, history, routes, stop } = start()
  t.after(stop)
  const { chief, writer, room } = await team(call)
  const { boot } = (await call('hello', {})).value
  const abort = new AbortController()
  t.after(() => abort.abort())
  const next = reader(await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal })))
  const hello = await next()
  assert.equal(hello.event, 'hello')
  assert.equal(hello.data.api, API_VERSION)
  assert.equal(hello.data.boot, boot)

  sent.length = 0
  history[room.id] = [user(1, 'Start'), relayCall(2, 'call-1')]
  await emit(room.id, history[room.id][0])
  const running = relay(room.id, 'call-1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const second = await turnFor(sent, first)

  // While the round runs, the newest page carries what was said, live, where the call sits.
  const live = (await call('room-chat', { roomId: room.id })).value
  assert.deepEqual(live.items.map(item => [item.id, item.kind, item.name ?? null, item.live ?? false]), [['1', 'user', null, false], ['call-1:0', 'bot', 'Chief', true]])
  assert.equal(live.running, true)
  assert.equal(live.speaking, writer.id)

  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  const result = await running
  history[room.id].push(relayResult(3, 'call-1', JSON.parse(result).replies))
  const done = (await call('room-chat', { roomId: room.id })).value
  assert.deepEqual(done.items.map(item => [item.id, item.text]), [['1', 'Start'], ['call-1:0', 'Chief here.'], ['call-1:1', 'Writer here.']])
  assert.equal(done.running, false)
  assert.equal(done.cursor, null)

  // Each member's message is a notice, in order, named after the group.
  const caught = (await call('notices', { boot, since: 0 })).value
  assert.equal(caught.reset, false)
  const groupNotices = caught.notices.filter(notice => notice.kind === 'group')
  assert.deepEqual(groupNotices.map(notice => [notice.botId, notice.roomId, notice.title, notice.text]), [[chief, room.id, 'Launch', 'Chief here.'], [writer.id, room.id, 'Launch', 'Writer here.']])
  const latest = caught.seq
  assert.deepEqual((await call('notices', { boot, since: latest })).value.notices, [])
  // A client from before a restart starts over.
  const other = (await call('notices', { boot: 'another-boot', since: latest })).value
  assert.equal(other.reset, true)
  assert.equal(other.notices.length, caught.notices.length)

  // The feed carried the same notices and said the group changed.
  const seen = []
  for (let at = 0; at < 40 && !(seen.some(event => event.event === 'room') && seen.filter(event => event.event === 'notice' && event.data.kind === 'group').length === 2); at += 1) seen.push(await next())
  assert.ok(seen.some(event => event.event === 'room' && event.data.roomId === room.id))
  assert.deepEqual(seen.filter(event => event.event === 'notice' && event.data.kind === 'group').map(event => event.data.text), ['Chief here.', 'Writer here.'])
})

test('a Bot\'s own chat message and its question card are notices; a hidden Bot-to-Bot turn is not', async (t) => {
  const { call, emit, ctx, rt, stop } = start()
  t.after(stop)
  const { writer } = await team(call)
  const { boot, seq } = (await call('hello', {})).value
  const chat = rt.chatOf(writer.id)
  await emit(chat, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: `Report:\n\n${'x'.repeat(400)}` }] } } })
  rt.state.exchangeTurns[chat] = [4]
  await emit(chat, { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'to another Bot' }] } } })
  await ctx.registeredTools.get('ask_user').execute({ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }, { agent: { id: chat }, callId: 'q1' })
  const { notices } = (await call('notices', { boot, since: seq })).value
  assert.deepEqual(notices.map(notice => [notice.kind, notice.botId, notice.name, notice.sessionId]), [['message', writer.id, 'Writer', chat], ['question', writer.id, 'Writer', chat]])
  assert.equal(notices[0].text.startsWith('Report: xxx'), true)
  assert.equal(notices[0].text.length, 301)
  assert.equal(notices[1].text, 'Ship it?')
})

test('state can send photos by reference, and avatar sends each one', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const image = `data:image/png;base64,${Buffer.from('a tiny photo').toString('base64')}`
  const bot = (await call('create-bot', { name: 'Painter', avatar: { image } })).value
  const whole = (await call('state', {})).value.bots.find(entry => entry.id === bot.id)
  assert.equal(whole.avatar.image, image)
  const slim = (await call('state', { avatars: 'ref' })).value.bots.find(entry => entry.id === bot.id)
  assert.equal(slim.avatar.image, undefined)
  assert.match(slim.avatar.imageRef, /^[0-9a-f]{16}$/)
  assert.deepEqual((await call('avatar', { botId: bot.id })).value, { botId: bot.id, ref: slim.avatar.imageRef, image })
  const chief = (await call('state', {})).value.mainBotId
  assert.deepEqual((await call('avatar', { botId: chief })).value, { botId: chief, ref: null, image: null })
  assert.equal((await call('avatar', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('the user adds and edits memory entries directly, with the same checks as the tools', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const added = (await call('memory-add', { botId: writer.id, text: 'Prefers short drafts' })).value
  assert.deepEqual(added.entries.map(entry => [entry.scope, entry.text, entry.by]), [['own', 'Prefers short drafts', 'user']])
  const edited = (await call('memory-edit', { botId: writer.id, scope: 'own', text: 'Prefers short drafts', next: 'Prefers drafts under one page' })).value
  assert.deepEqual(edited.entries.map(entry => entry.text), ['Prefers drafts under one page'])
  const refused = await call('memory-edit', { botId: writer.id, scope: 'own', text: 'Prefers drafts under one page', next: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/invalid')
  assert.equal((await call('memory-edit', { botId: writer.id, scope: 'own', text: 'not there', next: 'x' })).ok, false)
  const group = (await call('memory-add', { roomId: room.id, text: 'Launch is on Friday' })).value
  assert.deepEqual(group.entries.map(entry => [entry.scope, entry.text]), [['group', 'Launch is on Friday']])
  const forgot = (await call('memory-forget', { botId: writer.id, scope: 'own', text: 'Prefers drafts under one page' })).value
  assert.deepEqual(forgot.entries, [])
})

test('usage-summary adds up a Bot\'s tokens for the last day, week and month, and by model', async (t) => {
  const { call, rt, stop } = start()
  t.after(stop)
  const { writer } = await team(call)
  const hour = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(time).reduce((parts, { type, value }) => ({ ...parts, [type]: value }), {})
  const key = (time) => {
    const part = hour(time)
    return `${part.year}-${part.month}-${part.day} ${part.hour}`
  }
  const now = Date.now()
  rt.usageView = async () => ({
    owners: [{ key: writer.id, kind: 'bot', id: writer.id, name: 'Writer' }, { key: 'other', kind: 'other' }],
    models: [{ key: 'deepseek/v4', name: 'V4' }, { key: 'deepseek/v4-flash', name: 'V4 Flash' }],
    kinds: ['chat'],
    rows: [
      [key(now - 40 * 86_400_000), 0, 0, 0, 1000, 0, 0, 1000, 1],
      [key(now - 3 * 86_400_000), 0, 1, 0, 200, 50, 10, 20, 2],
      [key(now - 3_600_000), 0, 0, 0, 100, 0, 0, 10, 1],
      [key(now), 1, 0, 0, 7, 0, 0, 7, 1],
    ],
    now: key(now),
    scanning: false,
  })
  const summary = (await call('usage-summary', { botId: writer.id, timeZone: 'UTC' })).value
  assert.deepEqual(summary.day, { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, calls: 1 })
  assert.deepEqual(summary.week, { input: 300, cacheRead: 50, cacheWrite: 10, output: 30, calls: 3 })
  assert.deepEqual(summary.month, summary.week)
  assert.deepEqual(summary.models.map(model => [model.key, model.input]), [['deepseek/v4', 100], ['deepseek/v4-flash', 200]])
  assert.equal((await call('usage-summary', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('a member\'s approval in a group is a notice that names the group', async (t) => {
  const { call, ctx, rt, stop } = start()
  t.after(stop)
  const { writer, room } = await team(call)
  const sessionId = `g-${randomUUID()}`
  rt.state.rooms[room.id].sessions = { [writer.id]: sessionId }
  rt.groupOwners.set(sessionId, { botId: writer.id, roomId: room.id })
  const { boot, seq } = (await call('hello', {})).value
  const [approve] = ctx.listeners.get('approval/request')
  const controller = new AbortController()
  const answer = approve({ agent: { id: sessionId }, toolName: 'bash', reason: 'run tests', signal: controller.signal }, () => 'allowed-once')
  const { notices } = (await call('notices', { boot, since: seq })).value
  assert.deepEqual(notices.map(notice => [notice.kind, notice.botId, notice.roomId, notice.title, notice.text]), [['approval', writer.id, room.id, 'Launch', 'bash']])
  controller.abort()
  assert.equal(await answer, 'cancelled')
})

test('the Remote feed gets the same events as the HTTP feed, hello first', async (t) => {
  const { call, emit, rt, stop } = start()
  t.after(stop)
  const { writer } = await team(call)
  const seen = []
  const unsubscribe = rt.subscribeFeed((event, data) => seen.push([event, data]))
  t.after(unsubscribe)
  assert.equal(seen[0][0], 'hello')
  assert.equal(seen[0][1].api, API_VERSION)
  await emit(rt.chatOf(writer.id), { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Draft done' }] } } })
  await call('set-prefs', { motion: 'lively' })
  await waitFor(() => seen.some(([event]) => event === 'revision'))
  assert.ok(seen.some(([event, data]) => event === 'notice' && data.text === 'Draft done'))
  assert.ok(seen.some(([event, data]) => event === 'message' && data.item.text === 'Draft done'))
  const hello = (await call('hello', {})).value
  assert.deepEqual(hello.rpc, { call: 'dsBot/call', feed: 'dsBot/feed' })
  assert.ok(hello.capabilities.includes('rpc'))
})
