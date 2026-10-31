import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { foldCalls } from '../src/host/usage.js'
import { fakeContext } from './fake-ctx.js'

const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } }, reason: 'change' } })
const message = (turn, step, usage, time = 0) => ({ type: 'assistant/message', time, data: { turn, step, message: { role: 'assistant', content: [] }, stream: [], usage } })
const streamed = (type, turn, step, usage, time = 0) => ({ type, time, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] } })
const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens })
const tokens = row => [row.model, row.input, row.cacheRead, row.output]

test('each billed attempt is one row, on the model its request named', () => {
  const { rows, state } = foldCalls([
    header('deepseek', 'v4-flash'),
    // A failed attempt, then its retry: two billed attempts in one step.
    streamed('assistant/attempt', 1, 0, usage(10, 0)),
    { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
    message(1, 0, usage(20, 3, 5)),
    // A later sample of the same attempt replaces the earlier one.
    streamed('assistant/message', 1, 1, usage(30, 1)),
    message(1, 1, usage(30, 4, 2)),
    header('deepseek', 'v4-pro'),
    streamed('assistant/message', 2, 0, usage(7, 7)),
    // No usage reported: nothing billed to count.
    message(2, 1, undefined),
  ])
  assert.deepEqual(rows.map(tokens), [['v4-flash', 10, 0, 0], ['v4-flash', 20, 5, 3], ['v4-flash', 30, 2, 4], ['v4-pro', 7, 0, 7]])
  assert.deepEqual(state, { provider: 'deepseek', model: 'v4-pro', retry: { turn: 1, step: 0, count: 1 } })
})

test('a fold goes on from where the last read stopped', () => {
  const first = foldCalls([header('p', 'm'), streamed('assistant/attempt', 3, 2, usage(1, 0)), { type: 'llm/retry-started', data: { turn: 3, step: 2 } }])
  const { rows } = foldCalls([message(3, 2, usage(2, 2))], first.state)
  assert.deepEqual(rows.map(row => [row.key, ...tokens(row)]), [['3:2:1', 'm', 2, 0, 2]])
})

test('a fork does not count the calls it inherited from its parent', () => {
  const { rows, reset } = foldCalls([header('p', 'm'), message(1, 0, usage(100, 100)), { type: 'session/end-seed', data: { inherited: true } }, message(2, 0, usage(1, 1))])
  assert.equal(reset, true)
  assert.deepEqual(rows.map(tokens), [['m', 1, 0, 1]])
})

const HOUR = 3_600_000
const LONG_AGO = 1_000

function start(home, { listedExtra, logsExtra, subagentsExtra } = {}) {
  const fresh = home === undefined
  home ??= mkdtempSync(join(tmpdir(), 'ds-bot-usage-'))
  if (fresh) writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: {
      b1: { id: 'b1', sessionId: 's-b1', segments: [{ sessionId: 'b1', endedAt: LONG_AGO }], name: 'Chief', instructions: '', createdAt: 1 },
      b2: { id: 'b2', sessionId: 'b2', name: 'Writer', instructions: '', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: '研发群', named: true, members: ['b1', 'b2'], admin: 'b1', mode: 'everyone', notice: '', sessions: { b1: 's-g1' }, log: [], createdAt: 3 } },
    agents: { a1: { id: 'a1', name: 'DSH Agent', sessions: ['s-a1'], createdAt: 4 } },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    whaleStored: true,
  }))
  const logs = {
    'b1': [header('deepseek', 'v4-flash'), message(1, 0, usage(100, 10, 50), 0)],
    's-b1': [header('deepseek', 'v4-flash'), message(1, 0, usage(200, 20), HOUR)],
    's-g1': [header('deepseek', 'v4-pro'), message(1, 0, usage(300, 30), HOUR)],
    's-sub': [header('deepseek', 'v4-flash'), message(1, 0, usage(5, 5), HOUR)],
    's-x': [header('kimi', 'k3'), message(1, 0, usage(40, 4), 2 * HOUR)],
    's-a1': [header('deepseek', 'v4-flash'), message(1, 0, usage(70, 7), HOUR)],
    ...logsExtra,
  }
  for (const log of Object.values(logs)) log.forEach((event, seq) => { event.seq = seq })
  // Child Session → the parent its header names, as DSH checks a page address.
  const subagents = { 's-sub': 's-b1', ...subagentsExtra }
  const pages = []
  const warnings = []
  const ctx = fakeContext()
  ctx.logger.warn = (template, ...args) => warnings.push([template, ...args])
  ctx.sessionController = {
    list: async () => ({ items: [
      { sessionId: 's-x', projections: { kind: 'cached', asOfSeq: 1, values: {} } },
      { sessionId: 's-sub', parentSessionId: 's-b1', origin: 'subagent', projections: { kind: 'cached', asOfSeq: 1, values: {} } },
      { sessionId: 's-empty', blank: true },
      ...(listedExtra ?? []),
    ] }),
    projections: async ({ sessionId }) => (logs[sessionId] ? { asOfSeq: logs[sessionId].length - 1, values: {} } : null),
    page: async ({ address, throughSeq, beforeSeq }) => {
      const sessionId = address.kind === 'session' ? address.sessionId : address.childSessionId
      if (address.kind === 'session' && sessionId in subagents) throw new Error('subagent Sessions require their durable parent address')
      if (address.kind === 'subagent' && subagents[sessionId] !== address.parentSessionId) throw new Error('subagent does not belong to the supplied parent')
      if (logs[sessionId] === undefined) throw new Error(`no log for ${sessionId}`)
      pages.push(sessionId)
      const events = logs[sessionId].filter(event => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq))
      return { records: events.map(event => ({ event })), hasMore: false }
    },
  }
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const meter = ctx.listeners.get('llm/stream').at(-1)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, ctx, home, meter, pages, stop, warnings }
}

// Total tokens per owner name and use.
const totals = (view) => {
  const sums = {}
  for (const [, owner, , kind, input, cacheRead, cacheWrite, output] of view.rows) {
    const name = view.owners[owner].name ?? view.owners[owner].key
    const key = `${name}/${view.kinds[kind]}`
    sums[key] = (sums[key] ?? 0) + input + cacheRead + cacheWrite + output
  }
  return sums
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('the usage view counts every Session under its owner, by hour in the asked time zone', async (t) => {
  const { call, meter, pages, stop } = start()
  t.after(stop)
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  // Chief: both parts of its own chat and its subagent; its group Session counts as group use.
  // The DSH Agent's Sessions count beside the Bots, not with the other sessions.
  assert.deepEqual(totals(view), { 'Chief/chat': 160 + 220 + 10, 'Chief/group': 330, 'DSH Agent/chat': 77, 'other/chat': 44 })
  assert.deepEqual(view.rows.map(row => row[0]), ['1970-01-01 08', '1970-01-01 09', '1970-01-01 09', '1970-01-01 09', '1970-01-01 10'])
  assert.deepEqual(view.models.map(model => model.key).sort(), ['deepseek/v4-flash', 'deepseek/v4-pro', 'kimi/k3'])
  assert.equal(view.scanning, false)
  assert.ok(!pages.includes('s-empty'))

  // A Session's own requests are in its log, so the meter lets them through untouched.
  const passed = (async function* () { yield { type: 'usage', usage: usage(1, 1) } })()
  assert.equal(meter({ sessionId: 's-b1', messages: [] }, () => passed), passed)
  // A checkpoint is outside every log: the meter counts it, once.
  const chunk = { type: 'usage', usage: usage(1000, 100) }
  const chunks = await drain(meter({ sessionId: 's-b1', purpose: 'compaction', provider: 'deepseek', model: 'v4-flash', messages: [] }, async function* () { yield chunk }))
  assert.deepEqual(chunks, [chunk])
  await drain(meter({ sessionId: 's-b1', purpose: 'compaction', provider: 'deepseek', model: 'v4-flash', messages: [] }, async function* () { yield chunk }))
  const again = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(again)['Chief/compaction'], 1100)
})

test('a call made in a group chat stays group use after the room is gone', async (t) => {
  const first = start()
  const { home } = first
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const before = (await first.call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(before)['Chief/group'], 330)
  await first.ctx.dispose()

  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  state.rooms = {}
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  const second = start(home)
  const after = (await second.call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(after)['Chief/group'], 330)
  await second.ctx.dispose()
})

test('a plain chat journals its owner before the first scan, so a deleted Bot keeps its name', async (t) => {
  const first = start()
  const { home } = first
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  // Writer talks once, Usage is never opened: the meter lets the request
  // through, but the Session's owner lands in the ledger on its own.
  const passed = (async function* () { yield { type: 'text', text: 'hi' } })()
  assert.equal(first.meter({ sessionId: 'b2', messages: [] }, () => passed), passed)
  // The ledger opens behind the meter; give it a moment before the shutdown.
  await new Promise(resolve => setTimeout(resolve, 300))
  await first.ctx.dispose()

  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  delete state.bots.b2
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  // Writer's old Session is still listed (archived, not deleted), so the scan
  // reads its log and the journaled owner attributes it to the deleted Bot.
  const second = start(home, {
    listedExtra: [{ sessionId: 'b2', projections: { kind: 'cached', asOfSeq: 1, values: {} } }],
    logsExtra: { b2: [header('deepseek', 'v4-flash'), message(1, 0, usage(50, 5), HOUR)] },
  })
  const view = (await second.call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['Writer/chat'], 55)
  await second.ctx.dispose()
})

test('a subagent Session is read through its parent, even a parent that is gone; one that cannot be read warns once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10 * HOUR })
  const { call, pages, stop, warnings } = start(undefined, {
    listedExtra: [
      { sessionId: 's-orphan', parentSessionId: 's-gone', origin: 'subagent', projections: { kind: 'cached', asOfSeq: 1, values: {} } },
      { sessionId: 's-lost', origin: 'subagent', projections: { kind: 'cached', asOfSeq: 1, values: {} } },
      { sessionId: 's-broken', projections: { kind: 'sequenced', asOfSeq: 1, values: {} } },
      { sessionId: 's-broken2', projections: { kind: 'sequenced', asOfSeq: 1, values: {} } },
    ],
    logsExtra: {
      's-orphan': [header('deepseek', 'v4-flash'), message(1, 0, usage(8, 1), HOUR)],
      's-lost': [header('deepseek', 'v4-flash'), message(1, 0, usage(9, 9), HOUR)],
    },
    subagentsExtra: { 's-orphan': 's-gone', 's-lost': 's-gone' },
  })
  t.after(stop)
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['Chief/chat'], 160 + 220 + 10)
  assert.equal(totals(view)['other/chat'], 44 + 9)
  // No parent on record: it cannot be addressed, so it is not asked for.
  assert.ok(!pages.includes('s-lost'))
  // A scan reports one summarized line, not one per Session it could not read.
  const unread = () => warnings
    .map(([template, ...args]) => template === '%s' ? args[0] : template)
    .filter(line => line.includes('usage could not read'))
  assert.equal(unread().length, 1)
  assert.match(unread()[0], /usage could not read 2 Sessions \(first: s-broken/)

  t.mock.timers.tick(60_000)
  await call('usage', { timeZone: 'Asia/Shanghai' })
  assert.equal(pages.filter(sessionId => sessionId === 's-orphan').length, 1)
  assert.equal(unread().length, 1)
})

// #654: a Session with no Agent attached cannot grow, so once read to its tip it
// seals and later scans skip it without reading it again — until it comes back.
test('a cold Session seals once read and is read again only once it warms', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10 * HOUR })
  const { call, ctx, stop } = start(undefined, {
    listedExtra: [{ sessionId: 's-x', projections: { kind: 'cached', asOfSeq: 1, values: {} } }],
  })
  t.after(stop)
  let reads = 0
  const projections = ctx.sessionController.projections
  ctx.sessionController.projections = async (request) => {
    if (request.sessionId === 's-x') reads += 1
    return projections(request)
  }
  const relist = agentAvailable => {
    ctx.sessionController.list = async () => ({
      items: [{ sessionId: 's-x', agentAvailable, running: false, projections: { kind: 'cached', asOfSeq: 1, values: {} } }],
    })
  }
  // First scan: cold but never read, so read once and sealed.
  await call('usage', { timeZone: 'Asia/Shanghai' })
  assert.equal(reads, 1)
  // Still cold: the sealed mark skips it without any read.
  t.mock.timers.tick(60_000)
  await call('usage', { timeZone: 'Asia/Shanghai' })
  assert.equal(reads, 1)
  // Listed warm again, the seal no longer skips it.
  relist(true)
  t.mock.timers.tick(60_000)
  await call('usage', { timeZone: 'Asia/Shanghai' })
  assert.equal(reads, 2)
  // Cold once more, it is sealed at the same tip and skipped again.
  relist(false)
  t.mock.timers.tick(60_000)
  await call('usage', { timeZone: 'Asia/Shanghai' })
  assert.equal(reads, 2)
})

test('a cached projection watermark beyond the log is not used as a page cursor', async (t) => {
  const { call, ctx, stop, warnings } = start(undefined, {
    listedExtra: [{ sessionId: 's-x', projections: { kind: 'cached', asOfSeq: 202, values: {} } }],
  })
  t.after(stop)
  const page = ctx.sessionController.page
  ctx.sessionController.page = async (request) => {
    if (request.address.sessionId === 's-x' && request.throughSeq > 1) throw new Error(`session page through seq ${request.throughSeq} is past cursor 1`)
    return page(request)
  }
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['other/chat'], 44)
  assert.deepEqual(warnings, [])
})

test('a cached projection watermark behind the log does not omit later usage', async (t) => {
  const { call, stop, warnings } = start(undefined, {
    listedExtra: [{ sessionId: 's-x', projections: { kind: 'cached', asOfSeq: 0, values: {} } }],
  })
  t.after(stop)
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['other/chat'], 44)
  assert.deepEqual(warnings, [])
})

test('a sequenced projection watermark cuts the page without another projection read', async (t) => {
  const { call, ctx, stop } = start(undefined, {
    listedExtra: [{ sessionId: 's-x', projections: { kind: 'sequenced', asOfSeq: 1, values: {} } }],
  })
  t.after(stop)
  const projections = ctx.sessionController.projections
  ctx.sessionController.projections = async (request) => {
    assert.notEqual(request.sessionId, 's-x')
    return projections(request)
  }
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['other/chat'], 44)
})

test('a projection hint without a sequence space is not used as a page cursor', async (t) => {
  const { call, stop } = start(undefined, {
    listedExtra: [{ sessionId: 's-x', projections: { asOfSeq: 0, values: {} } }],
  })
  t.after(stop)
  const view = (await call('usage', { timeZone: 'Asia/Shanghai' })).value
  assert.equal(totals(view)['other/chat'], 44)
})
