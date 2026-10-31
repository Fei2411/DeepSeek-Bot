import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { handoffHold } from '../src/host/browser-plugins.js'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { createSession } from '../src/host/browser/session.js'
import { toolDefs as refsTools } from '../src/host/browser/refs.js'
import { toolDefs as scriptTools } from '../src/host/browser/script.js'
import { runTask, toolDefs as taskTools } from '../src/host/browser/task.js'
import { REPLY_KIND } from '../src/host/constants.js'
import { handoffReply, historyEntry, install as installParts, readReply, replyText } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

let rt
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const sent = []
  const ensured = []
  let flushError
  ctx.sessions = { flush: async () => { if (flushError !== undefined) throw flushError } }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home, browser: true })
  rt.ensureCapabilities = async sessionId => { ensured.push(sessionId) }
  rt.resolveAgent = async sessionId => ({
    session: { id: sessionId },
    followup(message) { sent.push({ sessionId, message }) },
  })
  return {
    rt, sent, ensured,
    failFlush(error) { flushError = error },
    call: async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))).json(),
    stop: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }),
  }
}

const BOT_HOLD = { by: 'bot', reason: 'login', note: 'Sign in to the shop.', callId: 'call-1' }

test('a browser handoff names the call and the Session that raised it', async () => {
  const tools = new Map()
  const holds = []
  mountBrowserPlugin({
    effect() {},
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: [
      ...refsTools.filter(tool => tool.name === 'browser_handoff'),
      ...scriptTools.filter(tool => tool.name === 'browser_exec'),
    ],
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    headless: true,
    onHold: (botId, hold) => holds.push([botId, hold]),
    openSession: async ({ onHold }) => ({
      handoff(reason, note, origin) {
        onHold({ by: 'bot', reason, note: String(note ?? ''), ...origin })
        return 'waiting'
      },
      async runScript(_source, origin) {
        onHold({ by: 'bot', reason: 'login', note: '', ...origin })
        return 'ran'
      },
      async close() {},
    }),
  })

  await tools.get('browser_handoff').execute({ reason: 'login', note: 'Sign in' }, { agent: { id: 'b2' }, callId: 'call-1' })
  await tools.get('browser_exec').execute({ script: 'handoff("login")' }, { agent: { id: 'b2' }, callId: 'call-2' })
  await tools.get('browser_handoff').execute({ reason: 'other' }, {})
  assert.deepEqual(holds, [
    ['b2', { by: 'bot', reason: 'login', note: 'Sign in', callId: 'call-1', sessionId: 'b2' }],
    ['b2', { by: 'bot', reason: 'login', note: '', callId: 'call-2', sessionId: 'b2' }],
    ['b2', { by: 'bot', reason: 'other', note: '' }],
  ])
})

test('browser_task forwards its outer call origin to a nested handoff', async () => {
  const tools = new Map()
  const holds = []
  let completions = 0
  mountBrowserPlugin({
    effect() {},
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: taskTools,
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    headless: true,
    onHold: (botId, hold) => holds.push([botId, hold]),
    completeFor: () => async () => {
      completions += 1
      if (completions === 1) {
        return { choices: [{ message: { tool_calls: [{
          id: 'inner-call',
          function: { name: 'browser_handoff', arguments: JSON.stringify({ reason: 'login', note: 'Sign in' }) },
        }] } }] }
      }
      return { choices: [{ message: { content: 'Waiting for sign-in.' } }] }
    },
    openSession: async ({ onHold }) => ({
      botId: 'b2',
      userDataDir: '/profiles/b2',
      handoff(reason, note, origin) {
        onHold({ by: 'bot', reason, note, ...origin })
        return 'waiting'
      },
      async close() {},
    }),
  })

  const result = await tools.get('browser_task').execute({ goal: 'Sign in' }, { agent: { id: 'b2' }, callId: 'outer-call' })
  assert.match(result.text, /Waiting for sign-in/)
  assert.match(result.text, /Handoffs:\nwaiting/)
  assert.deepEqual(holds, [
    ['b2', { by: 'bot', reason: 'login', note: 'Sign in', callId: 'outer-call', sessionId: 'b2' }],
  ])
})

test('only a handoff raised in the Bot\'s own chat keeps its call and drops the Session', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()

  const raised = { by: 'bot', reason: 'login', note: 'Sign in', callId: 'call-1' }
  assert.deepEqual(handoffHold(rt, 'b2', { ...raised, sessionId: 'b2' }), raised)
  // A group turn runs in another Session: no card there, so no call to answer.
  assert.deepEqual(handoffHold(rt, 'b2', { ...raised, sessionId: 'room-session' }), { by: 'bot', reason: 'login', note: 'Sign in' })
  // Another Bot's chat is no more its own.
  assert.deepEqual(handoffHold(rt, 'b2', { ...raised, sessionId: 'm1' }), { by: 'bot', reason: 'login', note: 'Sign in' })
  assert.deepEqual(handoffHold(rt, 'b2', { by: 'bot', reason: 'login', note: 'Sign in', sessionId: 'b2' }), { by: 'bot', reason: 'login', note: 'Sign in' })
  assert.deepEqual(handoffHold(rt, 'b2', { by: 'bot', reason: 'other', note: '' }), { by: 'bot', reason: 'other', note: '' })
})

test('a handoff outside the Bot\'s own chat gives resume-first guidance, and browser_task returns it', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()
  const makeSession = () => createSession({
    context: { pages: () => [], on() {} },
    page: null,
    botId: 'b2',
    userDataDir: '/profiles/b2',
    cookieFile: '/profiles/b2/cookies.json',
    downloadDir: '/downloads',
    actionTimeout: 1000,
    getHold: () => rt.browserChannel.holdOf('b2'),
    onHold: hold => rt.browserChannel.setHold('b2', hold && handoffHold(rt, 'b2', hold)),
  })

  const own = makeSession().handoff('login', 'Sign in', { callId: 'call-1', sessionId: 'b2' })
  assert.match(own, /Call browser_resume when they have finished/)
  assert.doesNotMatch(own, /no handoff card/)

  rt.browserChannel.setHold('b2', null)
  const group = makeSession().handoff('login', 'Sign in', { callId: 'call-2', sessionId: 'room-session' })
  assert.match(group, /no handoff card in this conversation/)
  assert.match(group, /Tell the user here what you need them to do/)
  assert.match(group, /call browser_resume, then browser_snapshot/)
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { by: 'bot', reason: 'login', note: 'Sign in' })

  rt.browserChannel.setHold('b2', null)
  let completions = 0
  const task = await runTask({
    session: makeSession(),
    goal: 'Sign in',
    origin: { callId: 'call-3', sessionId: 'room-session' },
    complete: async () => {
      completions += 1
      if (completions === 1) {
        return { choices: [{ message: { tool_calls: [{
          id: 'inner-call',
          function: { name: 'browser_handoff', arguments: JSON.stringify({ reason: 'login', note: 'Sign in' }) },
        }] } }] }
      }
      return { choices: [{ message: { content: 'Nested answer' } }] }
    },
  })
  assert.match(task.text, /Nested answer/)
  assert.ok(task.text.includes(`Handoffs:\n${group}`))
})

test('the channel keeps a handoff\'s call on its hold', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  rt.browserChannel.setHold('b2', { ...BOT_HOLD, callId: 'c'.repeat(300) })
  assert.equal(rt.browserChannel.holdOf('b2').callId, 'c'.repeat(200))
  rt.browserChannel.setHold('b2', { by: 'bot', reason: 'other', note: '' })
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { by: 'bot', reason: 'other', note: '' })
})

test('browser-takeover keeps the handoff it takes over, and starts a plain takeover otherwise', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  await rt.load()

  rt.browserChannel.setHold('b2', BOT_HOLD)
  assert.equal((await call('browser-takeover', { botId: 'b2' })).value, true)
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { by: 'user', reason: 'login', note: 'Sign in to the shop.', callId: 'call-1' })

  rt.browserChannel.setHold('b2', { by: 'bot', reason: 'other', note: '' })
  await call('browser-takeover', { botId: 'b2' })
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })

  rt.browserChannel.setHold('b2', null)
  await call('browser-takeover', { botId: 'b2' })
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })

  const unknown = await call('browser-takeover', { botId: 'nobody' })
  assert.equal(unknown.error.code, 'bot/not-found')
})

test('browser-give-back tells the Bot how the handoff went and clears the hold', async (t) => {
  const { rt, call, sent, ensured, stop } = start()
  t.after(stop)
  await rt.load()

  rt.browserChannel.setHold('b2', BOT_HOLD)
  const done = await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'done' })
  assert.equal(done.value, true)
  assert.equal(rt.browserChannel.holdOf('b2'), null)
  assert.deepEqual(ensured, ['b2'])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'b2')
  assert.deepEqual(sent[0].message.source, { kind: REPLY_KIND, callId: 'call-1', outcome: 'answered' })
  const payload = JSON.parse(sent[0].message.content[0].text)
  assert.equal(payload.kind, 'answer_to_pending_handoff')
  assert.equal(payload.tool, 'browser_handoff')
  assert.equal(payload.callId, 'call-1')
  assert.equal(payload.reason, 'login')
  assert.equal(payload.note, 'Sign in to the shop.')
  assert.equal(payload.outcome, 'done')
  assert.match(payload.message, /finished this step/)

  // The user may take over first; the card then answers the same call.
  rt.browserChannel.setHold('b2', BOT_HOLD)
  await call('browser-takeover', { botId: 'b2' })
  assert.equal((await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'skip' })).value, true)
  assert.equal(sent.length, 2)
  const skipped = JSON.parse(sent[1].message.content[0].text)
  assert.equal(skipped.outcome, 'skipped')
  assert.match(skipped.message, /Do not retry it/)
})

test('browser-give-back answers an open handoff once, and a plain hold without a word', async (t) => {
  const { rt, call, sent, stop } = start()
  t.after(stop)
  await rt.load()

  // The panel's Give back has no call: nothing to tell the Bot.
  rt.browserChannel.setHold('b2', { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })
  assert.equal((await call('browser-give-back', { botId: 'b2' })).value, true)
  assert.equal(rt.browserChannel.holdOf('b2'), null)
  assert.equal(sent.length, 0)

  rt.browserChannel.setHold('b2', BOT_HOLD)
  assert.equal((await call('browser-give-back', { botId: 'b2', callId: 'call-1' })).value, true)
  const returned = JSON.parse(sent[0].message.content[0].text)
  assert.equal(returned.outcome, 'returned')
  assert.match(returned.message, /gave the browser back/)
  assert.match(returned.message, /Do not assume this step is finished/)
  assert.match(returned.message, /browser_snapshot/)

  // A second answer finds nothing held.
  const again = await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'done' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'bot/forbidden')
  assert.equal(sent.length, 1)
})

test('browser-give-back refuses a stale call, an unknown outcome, and an unknown Bot, and keeps the hold', async (t) => {
  const { rt, call, sent, stop } = start()
  t.after(stop)
  await rt.load()

  rt.browserChannel.setHold('b2', { ...BOT_HOLD, callId: 'call-2' })
  const stale = await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'done' })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'bot/stale')
  const invalid = await call('browser-give-back', { botId: 'b2', callId: 'call-2', outcome: 'maybe' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'bot/invalid')
  assert.equal((await call('browser-give-back', { botId: 'nobody' })).error.code, 'bot/not-found')
  assert.deepEqual(rt.browserChannel.holdOf('b2'), { ...BOT_HOLD, callId: 'call-2' })
  assert.equal(sent.length, 0)
})

test('browser-give-back restores the hold when the Bot cannot be told', async (t) => {
  const { rt, call, sent, failFlush, stop } = start()
  t.after(stop)
  await rt.load()

  rt.browserChannel.setHold('b2', BOT_HOLD)
  failFlush(new Error('flush failed'))
  const failed = await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'done' })
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /flush failed/)
  assert.deepEqual(rt.browserChannel.holdOf('b2'), BOT_HOLD)

  failFlush(undefined)
  sent.length = 0
  assert.equal((await call('browser-give-back', { botId: 'b2', callId: 'call-1', outcome: 'done' })).value, true)
  assert.equal(rt.browserChannel.holdOf('b2'), null)
  assert.equal(sent.length, 1)
})

test('a handoff answer carries its reason, so it reads on its own', () => {
  const reply = handoffReply(BOT_HOLD, 'done')
  assert.deepEqual(reply.source, { kind: REPLY_KIND, callId: 'call-1', outcome: 'answered' })
  assert.deepEqual(readReply(reply.text), {
    handoff: { callId: 'call-1', reason: 'login', note: 'Sign in to the shop.', outcome: 'done' },
  })
  assert.equal(replyText(reply.text), '[Browser handoff] login — Sign in to the shop.\nAnswer: done')

  const plain = handoffReply({ reason: 'captcha', callId: 'call-3' }, 'skip')
  assert.equal(JSON.parse(plain.text).note, undefined)
  assert.deepEqual(readReply(plain.text).handoff, { callId: 'call-3', reason: 'captcha', note: '', outcome: 'skipped' })
  assert.equal(replyText(plain.text), '[Browser handoff] captcha\nAnswer: skipped')

  // The panel sends no outcome: that only returns control, without claiming completion.
  const returned = handoffReply(BOT_HOLD, undefined)
  assert.equal(JSON.parse(returned.text).outcome, 'returned')
  assert.match(JSON.parse(returned.text).message, /Do not assume this step is finished/)
  assert.equal(JSON.parse(handoffReply(BOT_HOLD, 'returned').text).outcome, 'returned')
  assert.deepEqual(readReply(returned.text).handoff, { callId: 'call-1', reason: 'login', note: 'Sign in to the shop.', outcome: 'returned' })
  assert.equal(replyText(returned.text), '[Browser handoff] login — Sign in to the shop.\nAnswer: returned')
  assert.equal(readReply(JSON.stringify({ kind: 'answer_to_pending_handoff', reason: 'login' })), undefined)
  assert.equal(readReply(JSON.stringify({ kind: 'answer_to_pending_handoff', callId: 'call-1' })), undefined)

  const event = { type: 'user/message', data: { source: reply.source, content: [{ type: 'text', text: reply.text }] } }
  assert.deepEqual(historyEntry(event, false), {
    answer: false, who: 'user', text: '[Browser handoff] login — Sign in to the shop.\nAnswer: done', keepAnswers: true,
  })
})

test('a handoff answer is an answer in the history pages, with its outcome', () => {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2' }
  const rt = {
    ctx: { on() {}, effect() {}, get() {} },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map(),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
  }
  installParts(rt)
  const reply = handoffReply(BOT_HOLD, 'skip')
  const items = rt.displayItems('b2', [
    { type: 'user/message', seq: 4, time: 9, data: { content: [{ type: 'text', text: reply.text }], source: reply.source } },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'answer')
  assert.equal(items[0].text, '[Browser handoff] login — Sign in to the shop.\nAnswer: skipped')
  assert.deepEqual(items[0].handoff, { callId: 'call-1', reason: 'login', note: 'Sign in to the shop.', outcome: 'skipped' })
  assert.equal(items[0].time, 9)
})
