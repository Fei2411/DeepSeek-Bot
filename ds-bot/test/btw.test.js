import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { trimToolBoundary } from '../src/host/btw.js'
import { fakeContext } from './fake-ctx.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (...blocks) => ({ role: 'assistant', content: blocks })
const call = (id, name = 'read') => ({ type: 'tool-call', id, name, arguments: '{}' })
const result = (id, text = 'ok') => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] })

const team = (extra = {}) => ({
  version: 1,
  mainBotIds: ['b1'],
  whaleStored: true,
  revision: 3,
  bots: {
    b1: {
      id: 'b1', sessionId: 's-now', name: 'Chief', capabilities: [], color: 'deepseek', createdAt: 1,
      segments: [{ sessionId: 's-old', endedAt: 1 }],
    },
  },
  rooms: {
    r1: {
      id: 'r1', named: true, name: 'Launch', members: ['b1'], admin: 'b1', mode: 'everyone', notice: '',
      sessions: { b1: 'g-now' }, segments: { b1: [{ sessionId: 'g-old', endedAt: 1 }] },
    },
  },
  agents: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  views: {},
  prefs: {},
  ...extra,
})

function makeSession(id, { messages, header, seq = 4, toolHistory, events }) {
  // The anchor fold reads this log. `eventAt` is closed to new callers.
  const history = events ?? []
  const session = {
    id,
    seq,
    events: events ?? [{ seq: 1, type: 'user/message' }],
    writes: 0,
    derived: 0,
    messages,
    header,
    history: toolHistory,
    inheritedEventCount: 0,
    deriveMessages() {
      session.derived += 1
      return session.messages.map(message => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.map(block => ({ ...block })) : message.content,
      }))
    },
    toolHistory() { return session.history },
    requestHeader() { return session.header },
    snapshotEvents() { return history },
    eventAt() { throw new Error('eventAt is closed to new callers') },
    append() { session.writes += 1; session.events.push({ type: 'append' }) },
    followup() { session.writes += 1; session.events.push({ type: 'followup' }) },
  }
  return session
}

// The same register / stateOf face as ctx.sessionProjections: fold the unit
// the host registers over snapshotEvents().
function projectionRegistry(ctx) {
  const units = new Map()
  return {
    register(definition) {
      ctx.effect(() => {
        units.set(definition.key, definition)
        return () => { units.delete(definition.key) }
      }, 'sessionProjections.register()')
    },
    stateOf(session, key) {
      const definition = units.get(key)
      if (definition === undefined) return undefined
      let state = definition.init(session.header, session.inheritedEventCount)
      for (const event of session.snapshotEvents()) state = definition.apply(state, event)
      return state
    },
  }
}

// The ask path is gone; saved cards stay where they were, read-only. `btw`
// seeds card files: { botId: { partId: [cards] } }.
async function setup({ state = team(), messages, seq = 4, events, foreignLock = false, btw = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-btw-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  for (const [botId, parts] of Object.entries(btw)) {
    for (const [partId, list] of Object.entries(parts)) {
      mkdirSync(join(home, 'btw', botId), { recursive: true })
      writeFileSync(join(home, 'btw', botId, `${partId}.json`), JSON.stringify(list))
    }
  }
  if (foreignLock) writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const header = {
    config: { provider: 'deepseek', model: 'aside-model', reasoningEffort: 'high', maxTokens: 8000, temperature: 0.2, stop: ['END'] },
    tools: [{ name: 'read' }, { name: 'pwsh' }],
  }
  const toolHistory = [{ name: 'read' }]
  const session = makeSession('s-now', { messages: messages ?? [user('Look at the file')], header, seq, toolHistory, events })
  const sessions = new Map([[session.id, session]])
  const requests = []
  const services = {}
  const ctx = fakeContext({ services })
  services.sessionProjections = projectionRegistry(ctx)
  ctx.llm = {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
    async* stream(options) {
      requests.push(options)
      yield { type: 'text-delta', index: 0, text: 'Because of the snapshot.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.sessionController = {
    resolveAgent: async (sessionId) => {
      const found = sessions.get(sessionId)
      if (found === undefined) throw new Error(`no session ${sessionId}`)
      return { agent: { id: sessionId, session: found } }
    },
    list: async () => ({ items: [] }),
    projections: async () => null,
    page: async () => ({ records: [], hasMore: false }),
    selectModel: async () => {},
    prompt: async () => {},
  }
  ctx.sessions = { flush: async () => {}, messageProjections: [] }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  let notices = 0
  const saved = rt.stateSaved
  rt.stateSaved = () => { notices += 1; saved?.() }
  await rt.load()
  const callEndpoint = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stopRuntime = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, ctx, rt, session, sessions, header, toolHistory, requests, call: callEndpoint, notices: () => notices, stop: stopRuntime }
}

const cardsOf = rt => rt.btwView?.().b1 ?? []
const cardsFile = (home, botId = 'b1', partId = 's-now') => JSON.parse(readFileSync(join(home, 'btw', botId, `${partId}.json`), 'utf8'))

test('a snapshot drops an unfinished tool batch and keeps a finished one', () => {
  const pending = [user('Look'), assistant({ type: 'text', text: 'Reading.' }, call('c1'))]
  assert.deepEqual(trimToolBoundary(pending), [pending[0]])
  const partial = [user('Look'), assistant(call('a'), call('b')), result('a', 'half')]
  assert.deepEqual(trimToolBoundary(partial), [partial[0]])
  const balanced = [user('Look'), assistant(call('a'), call('b')), result('a'), result('b')]
  assert.equal(trimToolBoundary(balanced), balanced)
  const plain = [user('Look'), assistant({ type: 'text', text: 'Done.' })]
  assert.equal(trimToolBoundary(plain), plain)
  const followed = [user('Look'), assistant(call('c1')), user('And now?')]
  assert.equal(trimToolBoundary(followed), followed)
  assert.deepEqual(trimToolBoundary([]), [])
})

test('a saved card rides the current part\'s view, whole and read-only', async (t) => {
  const question = `${'q'.repeat(2000)}END-OF-QUESTION`
  const answer = `${'a'.repeat(2000)}END-OF-ANSWER`
  const env = await setup({
    btw: {
      b1: {
        's-now': [
          { id: 'first', botId: 'b1', partId: 's-now', atSeq: 3, anchorSeq: null, turn: null, question, answer, status: 'done', createdAt: 10, finishedAt: 11 },
          { id: 'second', botId: 'b1', partId: 's-now', atSeq: 2, anchorSeq: null, turn: null, question: 'Earlier?', answer: 'Yes.', status: 'done', createdAt: 9, finishedAt: 10 },
        ],
      },
    },
  })
  t.after(() => env.stop())
  const cards = cardsOf(env.rt)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].id, 'first')
  assert.equal(cards[0].question, question)
  assert.equal(cards[0].answer, answer)
  const file = cardsFile(env.home)
  assert.equal(file.length, 2)
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal('btwCards' in saved, false)
  const view = await env.call('state', {})
  assert.equal(view.ok, true, view.error?.message)
  assert.equal(view.value.btwCards.b1.length, 2)
  assert.equal(view.value.btwCards.b1[0].id, 'first')
  // Read-only: no model call, no Session write, no state revision.
  assert.equal(env.requests.length, 0)
  assert.equal(env.session.writes, 0)
  assert.equal(saved.revision, 3)
})

test('a restart marks an aside that was still answering as failed', async (t) => {
  const env = await setup({
    btw: {
      b1: {
        's-now': [
          { id: 'live', botId: 'b1', partId: 's-now', atSeq: 2, question: 'Still going?', answer: '', status: 'answering', createdAt: 10 },
          { id: 'old', botId: 'b1', partId: 's-now', atSeq: 1, question: 'Earlier?', answer: 'Yes.', status: 'done', createdAt: 9, finishedAt: 11 },
        ],
      },
    },
  })
  t.after(() => env.stop())
  const [live, old] = cardsOf(env.rt)
  assert.equal(live.status, 'failed')
  assert.equal(live.error, 'DS Bot restarted before this answer finished.')
  assert.equal(typeof live.finishedAt, 'number')
  assert.equal(live.question, 'Still going?')
  assert.equal(old.status, 'done')
  assert.equal(old.answer, 'Yes.')
  assert.equal(old.finishedAt, 11)
  const file = cardsFile(env.home)
  assert.equal(file[0].status, 'failed')
  assert.equal(file[0].error, 'DS Bot restarted before this answer finished.')
  assert.equal(file[1].status, 'done')
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal('btwCards' in saved, false)
  assert.equal(saved.revision, 3)
})

test('a second host does not fail an aside the writer is still answering', async (t) => {
  const env = await setup({
    foreignLock: true,
    btw: {
      b1: {
        's-now': [
          { id: 'live', botId: 'b1', partId: 's-now', atSeq: 2, question: 'Still going?', answer: '', status: 'answering', createdAt: 10 },
          { id: 'old', botId: 'b1', partId: 's-now', atSeq: 1, question: 'Earlier?', answer: 'Yes.', status: 'done', createdAt: 9, finishedAt: 11 },
        ],
      },
    },
  })
  t.after(() => env.stop())
  assert.equal(typeof env.rt.readOnly(), 'string')
  const [live, old] = cardsOf(env.rt)
  assert.equal(live.status, 'answering')
  assert.equal(live.error, undefined)
  assert.equal(live.finishedAt, undefined)
  assert.equal(old.status, 'done')
  assert.equal(old.answer, 'Yes.')
  const file = cardsFile(env.home)
  assert.equal(file[0].status, 'answering')
  assert.equal(file[1].status, 'done')
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal('btwCards' in saved, false)
  assert.equal(saved.revision, 3)
  assert.equal(env.rt.state.revision, 3)
  assert.equal(env.notices(), 0)
})

test('deleting a Bot removes its card files', async (t) => {
  const state = team()
  state.bots.b2 = { id: 'b2', sessionId: 's-b2', name: 'Side', capabilities: [], color: 'deepseek', createdAt: 2 }
  const env = await setup({
    state,
    btw: {
      b2: {
        's-b2': [{ id: 'gone', botId: 'b2', partId: 's-b2', atSeq: 1, question: 'Old?', answer: 'Yes.', status: 'done', createdAt: 5, finishedAt: 6 }],
      },
    },
  })
  t.after(() => env.stop())
  assert.equal(existsSync(join(env.home, 'btw', 'b2')), true)
  await env.rt.deleteBot('b2')
  assert.equal(env.rt.botOf('b2'), undefined)
  assert.equal(env.rt.btwView().b2, undefined)
  assert.equal(existsSync(join(env.home, 'btw', 'b2')), false)
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal(saved.bots.b2, undefined)
  assert.equal('btwCards' in saved, false)
  assert.equal(saved.bots.b1.id, 'b1')
})

test('the team view carries only the current part\'s cards', async (t) => {
  const env = await setup({
    btw: {
      b1: {
        's-now': [{ id: 'here', botId: 'b1', partId: 's-now', atSeq: 2, question: 'In the new part?', answer: 'New.', status: 'done', createdAt: 7, finishedAt: 8 }],
        's-old': [{ id: 'gone', botId: 'b1', partId: 's-old', atSeq: 1, question: 'From the old part?', answer: 'Old.', status: 'done', createdAt: 5, finishedAt: 6 }],
      },
    },
  })
  t.after(() => env.stop())
  const cards = cardsOf(env.rt)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].partId, 's-now')
  const view = await env.call('state', {})
  assert.equal(view.ok, true, view.error?.message)
  assert.equal(view.value.btwCards.b1.length, 1)
  assert.equal(view.value.btwCards.b1[0].partId, 's-now')
  assert.equal(view.value.btwCards.b1.some(card => card.id === 'gone'), false)
})

test('an earlier part page carries that part\'s cards, read from its file', async (t) => {
  const old = [
    { id: 'there', botId: 'b1', partId: 's-old', atSeq: 1, question: 'From the old part?', answer: 'Old.', status: 'done', createdAt: 5, finishedAt: 6 },
    { id: 'left', botId: 'b1', partId: 's-old', atSeq: 2, question: 'Never done?', answer: '', status: 'answering', createdAt: 7 },
  ]
  const env = await setup({ btw: { b1: { 's-old': old } } })
  t.after(() => env.stop())
  env.sessions.set('s-old', makeSession('s-old', { messages: [user('Old work')], header: env.header, seq: 2, toolHistory: [] }))
  const view = await env.call('state', {})
  assert.equal(view.value.btwCards.b1, undefined)
  const page = await env.call('earlier', { sessionId: 's-now' })
  assert.equal(page.ok, true, page.error?.message)
  assert.equal(page.value.btw.length, 2)
  assert.equal(page.value.btw[0].id, 'there')
  // The owning host's lazy read still records the restart this file kept.
  assert.equal(page.value.btw[1].status, 'failed')
  assert.equal(page.value.btw[1].error, 'DS Bot restarted before this answer finished.')
  const file = cardsFile(env.home, 'b1', 's-old')
  assert.equal(file[1].status, 'failed')
})
