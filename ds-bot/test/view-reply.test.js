import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { normalizeView, VIEW_BYTE_LIMIT, viewBytes } from 'deep-view/core'
import { fakeContext } from './fake-ctx.js'

let rt

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: {
      id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer-now', createdAt: 2,
      segments: [{ sessionId: 'writer-old', endedAt: 1 }],
    },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['writer'], mode: 'admin', admin: 'writer', named: true, sessions: { writer: 'writer-group' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const METER = { type: 'metric', label: '进度', value: '70%' }

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-views-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const sent = []
  let flushError
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup(message) { sent.push({ sessionId, message }) } } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => { if (flushError !== undefined) throw flushError } },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  // show_view lives in the agent scope; a Bot agent appearing registers it.
  await ctx.emitAsync('agent/created', { agent: ctx.scopeAgent('writer-now') })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const show = async (sessionId, args, callId = 'call-1') => {
    let concluded = false
    const text = await rt.teamTools.find(d => d.name === 'show_view').execute(args, {
      agent: { id: sessionId }, callId, concludeTurn() { concluded = true },
    })
    return { text, concluded }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const team = async () => (await call('state', {})).value
  return {
    ctx, emit, show, call, team, sent,
    failFlush(error) { flushError = error },
    stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) },
  }
}

const text = value => [{ type: 'text', text: value }]

test('show_view registers an interactive card, refuses a group and a display-only wait, and leaves a display-only card unregistered', async (t) => {
  const { emit, show, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })

  const group = await show('writer-group', { title: 'Pick', view: CHOICES })
  assert.equal(group.text, 'View cards only work in your own chat. In a group, ask in your message instead.')
  assert.equal(group.concluded, false)
  const stranger = await show('outsider', { title: 'Pick', view: CHOICES })
  assert.match(stranger.text, /^Only Bots on the team can use show_view\. Use ask_user_question if it is available in this session, or ask the user in your reply\.$/)
  assert.equal(stranger.concluded, false)

  const waiting = await show('writer-now', { title: 'Meter', view: METER, await_reply: true })
  assert.equal(waiting.text, 'This view has nothing to submit; call show_view with await_reply: false.')
  assert.equal(waiting.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // An interactive card cannot be told not to wait: refused, nothing stored.
  const skipped = await show('writer-now', { title: 'Pick', view: CHOICES, await_reply: false })
  assert.equal(skipped.text, 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.')
  assert.equal(skipped.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // `__proto__` is no id: the answer object would lose the value to its prototype.
  const protoCall = await show('writer-now', { title: 'Pick', view: { ...CHOICES, id: '__proto__' } })
  assert.equal(protoCall.text, 'view.id: "__proto__" cannot be an id')
  const protoField = await show('writer-now', { title: 'Ask', view: { type: 'form', id: 'ask', fields: [{ id: '__proto__', label: 'Name' }] } })
  assert.equal(protoField.text, 'view.fields[0].id: "__proto__" cannot be an id')
  assert.equal((await team()).views['writer-now'], undefined)

  const shown = await show('writer-now', { title: 'Meter', view: METER })
  assert.equal(shown.text, 'The view is on screen.')
  assert.equal(shown.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // A question card and a view card in the same chat do not replace each other.
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  const asked = await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal(asked.text, 'The view is on screen; the user\'s answer arrives as their next message.')
  assert.equal(asked.concluded, true)
  const open = await team()
  assert.equal(open.questions['writer-now'].question, 'Which name?')
  assert.equal(open.views['writer-now'].title, 'Pick')
  assert.equal(open.views['writer-now'].callId, 'call-1')
  assert.equal(typeof open.views['writer-now'].id, 'string')
  assert.equal(typeof open.views['writer-now'].askedAt, 'number')
  assert.deepEqual(open.views['writer-now'].view, CHOICES)

  // A hidden Bot-to-Bot turn keeps the card but not the call.
  emit('writer-now', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('writer-now', 'turn/start', { turn: 2 })
  emit('writer-now', 'user/message', { content: text('[Message from Chief]\nAsk them'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  const hidden = await show('writer-now', { title: 'Pick', view: CHOICES }, 'call-hidden')
  assert.equal(hidden.concluded, true)
  assert.equal((await team()).views['writer-now'].callId, undefined)
  assert.equal((await team()).views['writer-now'].title, 'Pick')

  const body = JSON.stringify(METER)
  const room = VIEW_BYTE_LIMIT - viewBytes('', METER)
  const exact = await show('writer-now', { title: 'x'.repeat(room), view: METER, await_reply: false })
  assert.equal(exact.text, 'The view is on screen.')
  const over = await show('writer-now', { title: `${'x'.repeat(room)}y`, view: METER })
  assert.equal(over.text, `The view is ${viewBytes(`${'x'.repeat(room)}y`, METER)} bytes; the limit is ${VIEW_BYTE_LIMIT}.`)
  assert.equal(over.concluded, false)
  assert.equal((await team()).views['writer-now'].title, 'Pick')
  assert.ok(body.length > 0)
})

test('view-reply claims the card, refuses a stale or invalid answer, and restores the card when queueing fails', async (t) => {
  const { show, call, team, sent, failFlush, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Keep me', options: [{ label: 'Yes' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES }, 'call-view')
  const pending = (await team()).views['writer-now']

  const stale = await call('view-reply', { sessionId: 'writer-now', viewId: 'gone', action: 'pick', values: { selected: ['A'] } })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'bot/stale')
  assert.equal(stale.error.message, 'This view is no longer open')
  assert.equal((await team()).views['writer-now'].id, pending.id)

  const invalid = await call('view-reply', { sessionId: 'writer-now', viewId: pending.id, action: 'pick', values: { selected: [] } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'bot/invalid')
  assert.match(invalid.error.message, /select at least one option/)
  assert.equal((await team()).views['writer-now'].id, pending.id)
  assert.equal(sent.length, 0)

  failFlush(new Error('flush failed'))
  const failed = await call('view-reply', { sessionId: 'writer', viewId: pending.id, action: 'pick', values: { selected: ['B', 'A'] } })
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /flush failed/)
  assert.equal(sent.length, 1)
  assert.equal((await team()).views['writer-now'].id, pending.id)
  sent.length = 0

  failFlush(undefined)
  // A Bot id, and an earlier part, both mean the current part.
  const answered = await call('view-reply', { sessionId: 'writer-old', viewId: pending.id, action: 'pick', values: { selected: ['B', 'nope'] } })
  assert.equal(answered.ok, true)
  assert.equal((await team()).views['writer-now'], undefined)
  // The question card is a different store; answering the view does not claim it.
  assert.equal((await team()).questions['writer-now'].question, 'Keep me')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'writer-now')
  const message = sent[0].message
  assert.equal(message.source.kind, 'user-question-reply')
  assert.equal(message.source.callId, 'call-view')
  assert.equal(message.source.outcome, 'answered')
  const payload = JSON.parse(message.content[0].text)
  assert.equal(payload.kind, 'answer_to_pending_view')
  assert.equal(payload.tool, 'show_view')
  assert.deepEqual(payload.answers, [{ id: pending.id, action: 'pick', values: { selected: ['B'] } }])
  assert.equal(payload.views[0].title, 'Pick')
  assert.deepEqual(payload.views[0].view, CHOICES)

  const again = await call('view-reply', { sessionId: 'writer-now', viewId: pending.id, action: 'pick', values: { selected: ['A'] } })
  assert.equal(again.error.message, 'This view is no longer open')
})

test('dismiss-view drops the open view and leaves a question card alone', async (t) => {
  const { show, call, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Keep me', options: [{ label: 'Yes' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal((await call('dismiss-view', { sessionId: 'writer-now' })).ok, true)
  const open = await team()
  assert.equal(open.views['writer-now'], undefined)
  assert.equal(open.questions['writer-now'].question, 'Keep me')
  assert.equal((await call('dismiss-view', { sessionId: 'writer-now' })).ok, true)
})

test('a user message drops the open question and the open view together', async (t) => {
  const { emit, show, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal((await team()).questions['writer-now'].question, 'Which name?')
  assert.equal((await team()).views['writer-now'].title, 'Pick')
  emit('writer-now', 'user/message', { content: text('never mind'), source: { kind: 'user' } })
  const open = await team()
  assert.equal(open.questions['writer-now'], undefined)
  assert.equal(open.views['writer-now'], undefined)
})

test('show_view measures the bytes the model sent, before unwrapping the provider encoding', async (t) => {
  const { show, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  // Nested { item: ... } wrappers all disappear in normalization: measured after
  // unwrapping this card would pass with a fraction of the bytes it was sent with.
  let children = [{ type: 'text', text: 'x' }]
  while (viewBytes('', { type: 'stack', children }) <= VIEW_BYTE_LIMIT) children = { item: children }
  const wrapped = { type: 'stack', children }
  assert.ok(viewBytes('Meter', normalizeView(wrapped)) < VIEW_BYTE_LIMIT)
  const over = await show('writer-now', { title: 'Meter', view: wrapped, await_reply: false })
  assert.equal(over.text, `The view is ${viewBytes('Meter', wrapped)} bytes; the limit is ${VIEW_BYTE_LIMIT}.`)
  assert.equal(over.concluded, false)
})
