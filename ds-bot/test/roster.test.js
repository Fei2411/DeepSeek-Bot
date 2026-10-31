import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// DSH's settings and credentials for a DeepSeek route that takes an API key. A key set
// or removed is announced the way DSH announces it. `records` are the stored records
// (an account sign-in's), announced by the test.
function keyed(ctx, stored, records) {
  return {
    settings: { describe: () => [{ ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: {} }] },
    credentials: {
      describe: async ref => ({ configured: stored.has(ref), writable: true }),
      set: async (ref) => { stored.add(ref); ctx.emit('credentials/reference-updated', ref) },
      unset: async (ref) => { stored.delete(ref); ctx.emit('credentials/reference-updated', ref) },
      describeRecord: async key => ({ configured: records.has(key), writable: true }),
    },
  }
}

// Enough of the dsh services for the roster to make Sessions; kickoff messages are dropped.
// With `keys`, the models' route takes an API key and these are the ones set.
function start(team, { models = [], reasoning = {}, archiveError, keys, selection } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roster-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const services = {}
  const ctx = fakeContext({ services })
  const records = new Set()
  if (keys !== undefined) Object.assign(services, keyed(ctx, new Set(keys), records))
  if (selection !== undefined) {
    const baseGet = ctx.get
    ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => selection } : baseGet(name)
  }
  const workspaces = new Map()
  const sent = []
  const selected = []
  const archived = []
  const warnings = []
  let sessions = 0
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
      ...(keys === undefined ? {} : { listConfigurableProviders: () => [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }] }),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId, options) => {
        if (archiveError !== undefined) throw archiveError
        archived.push([sessionId, options])
      },
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async (request) => { selected.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, sent, selected, ctx, archived, warnings, records }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
// A greeting goes out after the team is saved, which can take longer than one settle() on a
// busy machine.
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}

test('the first Main Bot waits for the user to pick a model, then greets', async (t) => {
  const { call, stop, sent, selected } = start(undefined, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  let team = (await call('state', {})).value
  let main = team.bots.find(bot => bot.id === team.mainBotId)
  await settle()
  assert.equal(main.model, undefined)
  assert.equal(main.waiting, true)
  assert.equal(main.kickoff, undefined)
  assert.equal(sent.length, 0)
  assert.equal(selected.length, 0)
  assert.deepEqual(team.models.map(model => model.ref), ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'])
  assert.equal(team.defaultModel, 'deepseek/deepseek-v4-flash')

  assert.equal((await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-pro' })).ok, true)
  await until(() => sent.length > 0)
  team = (await call('state', {})).value
  main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.model, 'deepseek/deepseek-v4-pro')
  assert.equal(main.waiting, undefined)
  assert.deepEqual(selected.map(({ sessionId, model }) => [sessionId, model]), [[main.id, 'deepseek-v4-pro']])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, main.id)
  assert.equal(sent[0].message.source.role, 'kickoff')

  // A later model change does not greet again.
  await call('update-bot', { id: main.id, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, 1)
})

test('other Bots start on the default model and greet at once', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.length > 0)
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(sent.map(entry => entry.sessionId), [writer.id])
})

test('a new name must be one "@" can call; a name saved before the rule still saves', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  for (const name of ['a@b', 'All', '所有人']) assert.equal((await call('create-bot', { name })).ok, false, name)
  const writer = (await call('create-bot', { name: 'Writer 2' })).value
  assert.equal((await call('update-bot', { id: writer.id, name: 'Writer@home' })).ok, false)
  assert.equal((await call('update-bot', { id: writer.id, name: '新 Writer' })).ok, true)
})

// The kickoff arrives as a user message, so it must not name a question tool the Bot's
// instructions can rule out, and it gives way to those instructions.
for (const kind of ['main', 'copy', 'made by a Main Bot', 'made by the user']) {
  test(`the ${kind} kickoff asks in plain text and gives way to the Bot's instructions`, async (t) => {
    const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'] })
    t.after(stop)
    const chief = (await call('state', { locale: 'zh-CN' })).value.mainBotId
    const instructions = 'Use only plain text. Never call ask_user or ask_user_question.'
    let bot
    if (kind === 'main') {
      bot = (await call('update-bot', { id: chief, instructions, model: 'deepseek/deepseek-v4-flash' })).value
    } else if (kind === 'copy') {
      const original = (await call('create-bot', { name: 'Writer', instructions })).value
      await until(() => sent.some(entry => entry.sessionId === original.id))
      bot = (await call('duplicate-bot', { id: original.id })).value
    } else if (kind === 'made by a Main Bot') {
      await ctx.registeredTools.get('create_bot').execute({ name: 'Writer', role: 'Writer', instructions, brief: 'Review the team notes.' }, { agent: { id: chief } })
      bot = (await call('state', {})).value.bots.find(entry => entry.name === 'Writer')
    } else {
      bot = (await call('create-bot', { name: 'Writer', instructions })).value
    }
    await until(() => sent.some(entry => entry.sessionId === bot.id && entry.message.source.role === 'kickoff'))
    const greetings = sent.filter(entry => entry.sessionId === bot.id && entry.message.source.role === 'kickoff')
    assert.equal(greetings.length, 1)
    const { message } = greetings[0]
    const text = message.content[0].text
    assert.equal(message.source.role, 'kickoff')
    assert.equal(bot.instructions, instructions)
    assert.doesNotMatch(text, /\b(?:ask_user(?:_question)?|allowCustom)\b/)
    assert.match(text, /ask in one short question/)
    assert.match(text, /Where your instructions say otherwise, follow them\./)
    assert.match(text, /Write in Chinese \(简体中文\)\./)
    if (kind === 'copy') assert.match(text, /copy of Writer/)
    if (kind === 'made by a Main Bot') assert.match(text, /Why you exist: Review the team notes\./)
  })
}

test('a first message from the user is helped with, not replaced by an opening question', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  const brief = 'Review the team notes and list the next tasks.'
  const bot = (await call('create-bot', { name: 'Writer', brief })).value
  await until(() => sent.some(entry => entry.sessionId === bot.id))
  const text = sent.find(entry => entry.sessionId === bot.id).message.content[0].text
  assert.ok(text.includes(brief))
  assert.match(text, /then help with it\./)
  assert.doesNotMatch(text, /\b(?:ask_user(?:_question)?|allowCustom)\b/)
})

test('a group the user makes without a first message opens with its admin asking what it is for', async (t) => {
  const { call, stop, sent, ctx, home } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  sent.length = 0
  await call('create-room', { members: [chief, writer.id], admin: writer.id })
  assert.equal(sent.length, 0)
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id, greet: true })).value
  assert.deepEqual(sent.map(entry => [entry.sessionId, entry.message.source.role]), [[room.id, 'kickoff']])

  // The relay gives the admin alone a turn, and the cue adds no line to the group.
  for (const listener of ctx.listeners.get('session/event')) listener({ id: room.id }, { type: 'user/message', data: sent[0].message })
  const controller = new AbortController()
  const relay = ctx.registeredTools.get('group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: controller.signal })
  await until(() => sent.length > 1)
  controller.abort()
  const result = JSON.parse(await relay)
  const turns = sent.slice(1)
  assert.equal(turns.length, 1)
  const text = turns[0].message.content[0].text
  assert.match(text, /^\[Group chat "[^"]+" · the group was just created\]\n/)
  assert.match(text, /The user just created this group/)
  assert.doesNotMatch(text, /This round so far|Nothing new in this round/)
  assert.deepEqual(result.passed, ['Writer'])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(saved.sessions[writer.id], turns[0].sessionId)
  assert.deepEqual(saved.log, [])
})

test('a Bot takes a thinking level its model serves, applied with the model', async (t) => {
  const reasoning = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal((await call('update-bot', { id: chief, effort: 'low' })).ok, true)
  await settle()
  const main = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(main.effort, 'low')
  assert.equal(main.appliedEffort, 'low')
  assert.equal(selected.at(-1).reasoningEffort, 'low')

  // A level the model does not serve is refused; null clears the pick.
  assert.equal((await call('update-bot', { id: chief, effort: 'max' })).ok, false)
  assert.equal((await call('update-bot', { id: chief, effort: null })).ok, true)
  await settle()
  const cleared = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(cleared.effort, undefined)
  assert.equal(cleared.appliedEffort, undefined)

  // Creating a Bot with a level stores and applies it.
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'high' })).value
  await settle()
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')
})

test('a new Bot inherits the profile default thinking level', async (t) => {
  const reasoning = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } }
  const selection = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning, selection })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')

  // An explicit level still wins, and a level the model does not serve is dropped.
  const coder = (await call('create-bot', { name: 'Coder', effort: 'low' })).value
  assert.equal(coder.effort, 'low')

  // An explicit Default pick (null) stays on the model's own level, and so does a
  // copy of a Bot that has no level of its own.
  const plain = (await call('create-bot', { name: 'Plain', effort: null })).value
  assert.equal(plain.effort, undefined)
  const copy = (await call('duplicate-bot', { id: plain.id })).value
  assert.equal(copy.effort, undefined)

  const other = { provider: 'deepseek', model: 'other', reasoningEffort: 'max' }
  const { call: call2, stop: stop2 } = start(undefined, { models: ['deepseek/deepseek-v4-flash'], reasoning, selection: other })
  t.after(stop2)
  const tester = (await call2('create-bot', { name: 'Tester' })).value
  assert.equal(tester.effort, undefined)
})

test('the state reports a changed model list without a new revision', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const first = (await call('state', {})).value
  assert.equal((await call('state', { since: first.revision, models: first.modelsKey })).value.unchanged, true)
  assert.equal((await call('state', { since: first.revision, models: 'stale' })).value.unchanged, undefined)
})

test('a new team starts with a DeepSeek-blue whale as its Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const team = (await call('state', {})).value
  assert.equal(team.mainBotIds.length, 1)
  const main = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(main.name, 'Chief')
  assert.equal(main.color, 'deepseek')
  assert.deepEqual(main.avatar, { shape: 'whale' })

  // Other Bots keep no stored look, so the client picks one from the id.
  const writer = (await call('create-bot', { name: 'Writer', role: '写作' })).value
  assert.equal(writer.color, undefined)
  assert.equal(writer.avatar, undefined)
  // Making a Bot a Main Bot later does not change how it looks.
  await call('set-main', { id: writer.id, main: true })
  const after = (await call('state', {})).value.bots.find(bot => bot.id === writer.id)
  assert.equal(after.color, undefined)
  assert.equal(after.avatar, undefined)
})

const OLD_TEAM = {
  version: 1,
  mainBotIds: ['m1', 'w2'],
  revision: 4,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1, color: 'red' },
    w2: { id: 'w2', sessionId: 'w2', name: 'Writer', role: '写作', lab: 'kimi', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('a team from before the whale was stored gets it once, on its first Main Bot only', async (t) => {
  const { call, stop, home } = start(OLD_TEAM)
  t.after(stop)
  const bots = async () => Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.id, bot]))
  let team = await bots()
  // A color the user picked stays; the missing shape becomes the whale.
  assert.equal(team.m1.color, 'red')
  assert.deepEqual(team.m1.avatar, { shape: 'whale' })
  assert.equal(team.w2.avatar, undefined)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).whaleStored, true)

  // The whale is now an ordinary look: it does not pass on when its Bot is deleted.
  assert.equal((await call('set-main', { id: 'm1', main: false })).ok, true)
  assert.equal((await call('delete-bot', { id: 'm1' })).ok, true)
  team = await bots()
  assert.equal(team.w2.avatar, undefined)
  assert.equal(team.w2.color, undefined)
})

test('another Bot takes the Main Bot place in one step', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.deepEqual(team.mainBotIds, [writer.id])
  assert.equal(team.mainBotId, writer.id)
  // The whale stays with the Bot it was given to.
  assert.deepEqual(team.bots.find(bot => bot.id === chief).avatar, { shape: 'whale' })
  // The old Main Bot can now be deleted, and no new Chief is made in its place.
  assert.equal((await call('delete-bot', { id: chief })).ok, true)
  const after = (await call('state', {})).value
  assert.deepEqual(after.mainBotIds, [writer.id])
  assert.deepEqual(after.bots.map(bot => bot.id), [writer.id])
})

test('a Main Bot moves to the front and the others keep their order', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.deepEqual((await call('set-main', { id: writer.id, main: true })).value.mainBotIds, [chief, writer.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: true, primary: true })).value.mainBotIds, [writer.id, chief])
  assert.deepEqual((await call('set-main', { id: reader.id, main: true })).value.mainBotIds, [writer.id, chief, reader.id])
  // Replacing a Main Bot that is not first keeps its place; one already a Main Bot moves into it.
  assert.deepEqual((await call('set-main', { id: reader.id, main: true, replace: chief })).value.mainBotIds, [writer.id, reader.id])
  assert.deepEqual((await call('set-main', { id: writer.id, main: false })).value.mainBotIds, [reader.id])
})

test('set-main keeps one Main Bot and replaces only a Main Bot', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const reader = (await call('create-bot', { name: 'Reader' })).value
  assert.equal((await call('set-main', { id: chief, main: false })).ok, false)
  assert.equal((await call('set-main', { id: writer.id, main: true, replace: reader.id })).ok, false)
  assert.equal((await call('set-main', { id: 'nope', main: true })).ok, false)
  assert.equal((await call('set-main', { id: reader.id, main: false })).ok, true)
  assert.deepEqual((await call('state', {})).value.mainBotIds, [chief])
})

test('deleting a Bot or group chat stops its Session, so its tasks are removed', async (t) => {
  const { call, stop, archived } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id })).value
  archived.length = 0
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  assert.equal((await call('delete-room', { id: room.id })).ok, true)
  // `stopActivity` lets DSH's session-stop hook drop the Session's armed
  // scheduled tasks; without it the archive is refused and they keep
  // delivering into the deleted Session.
  assert.deepEqual(archived, [
    [writer.id, { stopActivity: true }],
    [room.id, { stopActivity: true }],
  ])
})

const TEAM_WITH_PART = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test("deleting a Bot also stops its past parts' Sessions, where tasks can stay armed", async (t) => {
  const { call, stop, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  archived.length = 0
  assert.equal((await call('delete-bot', { id: 'w1' })).ok, true)
  // A part switch can leave armed tasks on the old Session (w1); archiving only
  // the current one (w2) would orphan them exactly like a skipped archive.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
})

test('an archive failure on delete is warned instead of passing silently', async (t) => {
  const { call, stop, warnings } = start(undefined, { models: ['deepseek-v4-flash'], archiveError: new Error('archive refused') })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  await settle()
  assert.equal(warnings.filter(text => text.includes('not archived')).length, 1)
})

test('a hidden Bot made Main Bot shows again, and a replaced Chief drops its held greeting', async (t) => {
  const { call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await call('set-flags', { id: writer.id, hidden: true })
  await settle()
  // Only Chief's messages count: Writer's own greeting can go out late on a busy machine.
  const toChief = () => sent.filter(item => item.sessionId === chief).length
  const greeted = toChief()
  const team = (await call('set-main', { id: writer.id, main: true, replace: chief })).value
  assert.equal(team.bots.find(bot => bot.id === writer.id).hidden, undefined)
  assert.equal(team.bots.find(bot => bot.id === chief).waiting, undefined)
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(toChief(), greeted)
})

// A turn in a Bot Session as DSH reports it, to every listener.
const emitIn = (ctx, sessionId, event) => { for (const listener of ctx.listeners.get('session/event')) listener({ id: sessionId }, event) }
function runTurn(ctx, sessionId, turn, message, reason) {
  emitIn(ctx, sessionId, { type: 'turn/start', data: { turn } })
  emitIn(ctx, sessionId, { type: 'user/message', data: message })
  emitIn(ctx, sessionId, { type: 'turn/end', data: { turn, reason } })
}
const typed = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const failed = (code, extra = {}) => ({ kind: 'error', error: { code, message: `${code}: sk-12***34 was refused`, ...extra } })
const botIn = async (call, id) => (await call('state', {})).value.bots.find(bot => bot.id === id)

test('a model whose provider has no key is never given to a new Bot', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const team = (await call('state', {})).value
  assert.equal(team.models[0].needsKey, true)
  assert.equal(team.defaultModel, null)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.model, undefined)
  // A Main Bot on such a model passes it on to no Bot it creates.
  await call('update-bot', { id: team.mainBotId, model: 'deepseek/deepseek-v4-flash' })
  await ctx.registeredTools.get('create_bot').execute({ name: 'Editor', role: 'Editor', instructions: 'Edit.' }, { agent: { id: team.mainBotId } })
  await settle()
  const editor = (await call('state', {})).value.bots.find(bot => bot.name === 'Editor')
  assert.equal(editor.model, undefined)
  assert.deepEqual(sent.map(entry => entry.sessionId), [team.mainBotId])
  assert.equal((await botIn(call, writer.id)).waiting, true)

  assert.equal((await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })).ok, true)
  assert.equal((await call('state', {})).value.defaultModel, 'deepseek/deepseek-v4-flash')
  assert.equal((await call('create-bot', { name: 'Critic' })).value.model, 'deepseek/deepseek-v4-flash')
})

test('a message the user writes before the first Main Bot has a model is answered once it has one', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', { locale: 'zh-CN' })).value.mainBotId
  // The Session's own route has no key either, so that turn fails.
  runTurn(ctx, chief, 1, typed('hello?'), failed('MISSING_CREDENTIAL'))
  await settle()
  let main = await botIn(call, chief)
  assert.equal(main.waiting, true)
  assert.equal(main.blocked.code, 'MISSING_CREDENTIAL')

  // The key lifts the block; the greeting still waits for a model.
  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await settle()
  main = await botIn(call, chief)
  assert.equal(main.blocked, undefined)
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 0)

  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length > 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.source.role, 'kickoff')
  assert.equal(sent[0].message.content[0].text, [
    '[Bot team setup]',
    'You were just set up as the user\'s Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team. Write in Chinese (简体中文).',
    'Where your instructions say otherwise, follow them.',
  ].join('\n'))
})

test('a held greeting goes once a turn answered the user, and a Bot that can answer drops its own', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  // DSH's own default route answered the first Main Bot.
  runTurn(ctx, chief, 1, typed('hello?'), { kind: 'completed' })
  emitIn(ctx, writer.id, { type: 'user/message', data: typed('hi') })
  await settle()
  assert.equal((await botIn(call, chief)).waiting, undefined)
  assert.equal((await botIn(call, writer.id)).waiting, undefined)
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await call('update-bot', { id: writer.id, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(sent.length, 0)
})

test('a greeting that fails on a key is held again and goes out once the key is set', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('MISSING_CREDENTIAL'))
  await settle()
  const main = await botIn(call, chief)
  assert.equal(main.waiting, true)
  assert.deepEqual(Object.keys(main.blocked).sort(), ['at', 'code', 'provider'])
  assert.equal(main.blocked.provider, 'deepseek')
  // Setting the same model again (or only a thinking level) fixes nothing, so the
  // greeting stays held.
  const same = await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal(same.ok, true)
  assert.equal(sent.length, 1)
  assert.equal((await botIn(call, chief)).waiting, true)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)
  const after = await botIn(call, chief)
  assert.equal(after.blocked, undefined)
  assert.equal(after.waiting, undefined)
})

test('a Bot is blocked by the facts of a failure only the user can fix, until it is fixed', async (t) => {
  const { call, stop, ctx } = start(undefined, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  runTurn(ctx, chief, 1, typed('hi'), failed('QUOTA', { status: 402, requestId: 'req-1' }))
  await settle()
  const { blocked } = await botIn(call, chief)
  assert.deepEqual({ ...blocked, at: typeof blocked.at }, { code: 'QUOTA', status: 402, requestId: 'req-1', provider: 'deepseek', at: 'number' })
  // A failure a retry can fix leaves it as it is.
  runTurn(ctx, chief, 2, typed('again'), failed('SERVER', { status: 503 }))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'QUOTA')

  runTurn(ctx, chief, 3, typed('again'), { kind: 'completed' })
  await settle()
  assert.equal((await botIn(call, chief)).blocked, undefined)

  runTurn(ctx, chief, 4, typed('more'), failed('AUTH', { status: 401 }))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'AUTH')
  // A provider that registers or changes is no fix; a key is.
  ctx.emit('llm/adapters-updated')
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'AUTH')
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
  await settle()
  assert.equal((await botIn(call, chief)).blocked, undefined)

  runTurn(ctx, chief, 5, typed('more'), failed('ACCOUNT_SIGNED_OUT'))
  await settle()
  assert.equal((await botIn(call, chief)).blocked.code, 'ACCOUNT_SIGNED_OUT')
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-pro' })
  assert.equal((await botIn(call, chief)).blocked, undefined)
})

test('Retry has the Bot answer the user\'s last message without sending it again, or sends a failed greeting again', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('QUOTA', { status: 402 }))
  await settle()
  assert.equal((await call('resume', { botId: 'nobody' })).error.code, 'bot/not-found')
  assert.equal((await call('resume', { botId: chief })).ok, true)
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)

  runTurn(ctx, chief, 2, sent[1].message, { kind: 'completed' })
  runTurn(ctx, chief, 3, typed('Plan my week'), failed('QUOTA', { status: 402 }))
  await settle()
  assert.equal((await call('resume', { botId: chief })).ok, true)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].sessionId, chief)
  assert.equal(sent[2].message.source.role, 'continue')
  assert.equal(sent[2].message.content[0].text, '[Retry after a failed turn]\nYour last turn failed (QUOTA) and the user has fixed it. Answer the user\'s last unanswered message.')
  assert.equal((await botIn(call, chief)).waiting, undefined)
})

// The record a DeepSeek account sign-in writes.
const ACCOUNT_RECORD = 'deepseek-account-platform/default'

test('a sign-in lifts what a lapsed sign-in blocked and sends the held greeting; a sign-out, a key or a provider does not', async (t) => {
  const { call, stop, sent, ctx, records } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  // The provider refuses the token, and its record goes while the turn still runs.
  records.add(ACCOUNT_RECORD)
  emitIn(ctx, chief, { type: 'turn/start', data: { turn: 1 } })
  emitIn(ctx, chief, { type: 'user/message', data: sent[0].message })
  records.delete(ACCOUNT_RECORD)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  emitIn(ctx, chief, { type: 'turn/end', data: { turn: 1, reason: failed('ACCOUNT_TOKEN_INVALID') } })
  await settle()
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
  ctx.emit('llm/adapters-updated')
  await settle()
  let main = await botIn(call, chief)
  assert.equal(main.blocked.code, 'ACCOUNT_TOKEN_INVALID')
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 1)

  records.add(ACCOUNT_RECORD)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.equal(sent[1].message.content[0].text, sent[0].message.content[0].text)
  main = await botIn(call, chief)
  assert.equal(main.blocked, undefined)
  assert.equal(main.waiting, undefined)
})

test('a held greeting goes out again only on a change that can fix its block: never a balance, a key another provider reads or a key removed', async (t) => {
  const { call, stop, sent, ctx, records } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY', 'OTHER_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('QUOTA', { status: 402 }))
  await settle()
  // A key, a sign-in, a provider registering: none of it tops up a balance.
  records.add(ACCOUNT_RECORD)
  for (const ref of ['OTHER_API_KEY', 'DEEPSEEK_API_KEY']) ctx.emit('credentials/reference-updated', ref)
  ctx.emit('credentials/record-updated', ACCOUNT_RECORD)
  ctx.emit('llm/adapters-updated')
  await settle()
  assert.equal(sent.length, 1)
  assert.equal((await botIn(call, chief)).blocked.code, 'QUOTA')

  // Retry sends it again, and this time the key is refused.
  await call('resume', { botId: chief })
  await until(() => sent.length === 2)
  runTurn(ctx, chief, 2, sent[1].message, failed('AUTH', { status: 401 }))
  await settle()
  ctx.emit('credentials/reference-updated', 'OTHER_API_KEY')
  await ctx.get('credentials').unset('DEEPSEEK_API_KEY')
  await settle()
  const main = await botIn(call, chief)
  assert.equal(main.blocked.code, 'AUTH')
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 2)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 3)
  assert.equal(sent[2].message.source.role, 'kickoff')
  assert.equal((await botIn(call, chief)).blocked, undefined)
})

test('the first Main Bot keeps its greeting when the user writes while a key blocks it, and answers once the key is fixed', async (t) => {
  // The key is set but wrong, so its model counts as usable until a turn fails on it.
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: ['DEEPSEEK_API_KEY'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('AUTH', { status: 401 }))
  runTurn(ctx, chief, 2, typed('hello?'), failed('AUTH', { status: 401 }))
  await settle()
  assert.equal((await botIn(call, chief)).waiting, true)

  await call('provider-key', { provider: 'deepseek', value: 'sk-test-ok' })
  await until(() => sent.length === 2)
  assert.equal(sent[1].message.source.role, 'kickoff')
  assert.match(sent[1].message.content[0].text, /^\[Bot team setup\]\nYou were just set up as the user's Main Bot\. The user wrote to you before your model could answer; their message above has no answer yet\./)
})

test('Retry right after a fix adds no turn while the greeting it released waits for its model, is queued or runs', async (t) => {
  const { call, stop, sent, ctx } = start(undefined, { models: ['deepseek-v4-flash'], keys: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await until(() => sent.length === 1)
  runTurn(ctx, chief, 1, sent[0].message, failed('MISSING_CREDENTIAL'))
  await settle()
  // The route is slow to list, so the greeting the key releases waits for its model.
  const listModels = ctx.llm.listModels
  let open
  const listed = new Promise((resolve) => { open = resolve })
  ctx.llm.listModels = async (id) => { await listed; return listModels(id) }
  await ctx.get('credentials').set('DEEPSEEK_API_KEY', 'sk-test-ok')
  await settle()
  assert.equal((await call('resume', { botId: chief })).ok, true)
  open()
  await until(() => sent.length === 2)
  assert.equal((await call('resume', { botId: chief })).ok, true)
  emitIn(ctx, chief, { type: 'turn/start', data: { turn: 2 } })
  emitIn(ctx, chief, { type: 'user/message', data: sent[1].message })
  assert.equal((await call('resume', { botId: chief })).ok, true)
  emitIn(ctx, chief, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()
  assert.deepEqual(sent.map(entry => entry.message.source.role), ['kickoff', 'kickoff'])
})

const takeover = (home, team) => {
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
}

test('a host that loses its lock to another dsh refuses changes instead of making a phantom Bot', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(stop)
  assert.equal((await call('state', {})).value.readOnly, null)
  let created = 0
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => { created += 1; return create(...args) }
  // Another live dsh takes the lock and writes its own team.
  takeover(home, { version: 1, revision: 9, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' }, other: { id: 'other', name: 'FromB' } } })
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/read-only')
  assert.equal(created, 0)
  // The file keeps the new owner's team, and this host now follows it.
  const team = (await call('state', {})).value
  assert.match(team.readOnly, /another dsh/)
  assert.ok(team.bots.some(bot => bot.name === 'FromB'))
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
})

test('a delete whose save fails still stops the Sessions, and the next save writes it', async (t) => {
  const { call, stop, home, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  archived.length = 0
  const blocker = join(home, `state.json.${process.pid}.tmp`)
  mkdirSync(blocker)
  const answer = await call('delete-bot', { id: 'w1' })
  assert.equal(answer.ok, false)
  // The Bot is gone from the team, so nothing could stop its tasks later.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
  rmSync(blocker, { recursive: true })
  await call('set-prefs', { theme: 'dark' })
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.bots.w1, undefined)
})

test('a rolled-back Bot does not come back with a save queued before the rollback', async (t) => {
  const { call, stop, home } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(async () => {
    fsp.rename = rename
    syncBuiltinESMExports()
    await stop()
  })
  // The first Bot also saves the team's workspace; later ones save only themselves.
  await call('create-bot', { name: 'Warm' })
  const statePath = join(home, 'state.json')
  const rename = fsp.rename
  let entered
  let release
  const first = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let failed = false
  fsp.rename = async (from, to) => {
    if (to === statePath && !failed) {
      failed = true
      entered()
      await gate
      throw Object.assign(new Error('rename failed'), { code: 'EIO' })
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  const phantom = call('create-bot', { name: 'Phantom' })
  await first
  // A second Bot's save queues a snapshot that still holds Phantom.
  const kept = call('create-bot', { name: 'Kept' })
  await settle()
  release()
  assert.equal((await phantom).ok, false)
  assert.equal((await kept).ok, true)
  // The rollback queues a save after Kept's without waiting for it, and no later change may
  // be what drops Phantom, so wait for that save itself.
  const names = () => Object.values(JSON.parse(readFileSync(statePath, 'utf8')).bots).map(bot => bot.name).sort()
  await until(() => !names().includes('Phantom'))
  assert.deepEqual(names(), ['Chief', 'Kept', 'Warm'])
})

test('a write that fails at save time archives the Session it made', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(stop)
  await call('state', {})
  const created = []
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => {
    const made = await create(...args)
    created.push(made.sessionId)
    // The disk write fails after this request's refresh, before its save.
    mkdirSync(join(home, `state.json.${process.pid}.tmp`))
    return made
  }
  const archived = []
  const archive = ctx.workspaceRegistry.archiveSession
  ctx.workspaceRegistry.archiveSession = async (id) => { archived.push(id); return archive(id) }
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/internal')
  assert.deepEqual(archived, created)
  const team = (await call('state', {})).value
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(Object.values(saved.bots).some(bot => bot.name === 'Phantom'), false)
})

// 公开#178: "User" is how a group log names the user, so a Bot may not take it.
test('a Bot cannot be named or renamed like the user; one named so before keeps working', async (t) => {
  const team = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: '', instructions: '', sessionId: 'a', createdAt: 1 },
      u: { id: 'u', name: 'User', role: '', instructions: '', sessionId: 'u', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
  const { call, stop } = start(team)
  t.after(stop)
  const made = await call('create-bot', { name: 'user' })
  assert.equal(made.ok, false)
  assert.match(made.error.message, /stands for the user in a chat/)
  const renamed = await call('update-bot', { id: 'a', name: 'You' })
  assert.equal(renamed.ok, false)
  assert.match(renamed.error.message, /stands for the user in a chat/)
  assert.equal((await call('update-bot', { id: 'u', name: 'User', role: 'Tester' })).ok, true)
  assert.equal((await call('update-bot', { id: 'u', name: 'Helper' })).ok, true)
})

// Holds every new Session until `release`, so creates that start together are all
// waiting on it at once, as with a slow DSH.
const holdSessions = (ctx) => {
  const create = ctx.sessionController.create
  let open
  const gate = new Promise(resolve => { open = resolve })
  let waiting = 0
  ctx.sessionController.create = async (request) => {
    waiting += 1
    await gate
    return create(request)
  }
  return { waiting: () => waiting, release: () => { ctx.sessionController.create = create; open() } }
}

// 公开#148: two Main Bots that each made a "Coder" at the same time both got one.
test('Bots created with one name at the same time: one is made, the others are refused', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const sessions = holdSessions(ctx)
  const creates = [1, 2, 3].map(() => call('create-bot', { name: 'Coder' }))
  // A rename to a name a create is still working on is refused too.
  const chief = (await call('state', {})).value.mainBotId
  const rename = await call('update-bot', { id: chief, name: 'coder' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false, false])
  assert.match(results[1].error.message, /A Bot named Coder already exists/)
  assert.equal(rename.ok, false)
  const names = (await call('state', {})).value.bots.map(bot => bot.name)
  assert.equal(names.filter(name => name.toLowerCase() === 'coder').length, 1)
})

test('copies of one Bot made at the same time get different names', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const sessions = holdSessions(ctx)
  const copies = [1, 2, 3].map(() => call('duplicate-bot', { id: writer.id }))
  await until(() => sessions.waiting() === 3)
  sessions.release()
  const results = await Promise.all(copies)
  assert.deepEqual(results.map(result => result.ok), [true, true, true])
  assert.deepEqual(results.map(result => result.value.name).sort(), ['Writer copy', 'Writer copy 2', 'Writer copy 3'])
})

// 公开#199: two groups made with one name at the same time were both made, and from then
// on a Main Bot could reach neither by name.
test('groups created or renamed to one name at the same time: only one gets it', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const other = (await call('create-room', { members: [chief, writer.id], name: 'Docs' })).value
  const sessions = holdSessions(ctx)
  const creates = [1, 2].map(() => call('create-room', { members: [chief, writer.id], name: 'Ops' }))
  const rename = await call('update-room', { id: other.id, name: 'ops' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false])
  assert.match(results[1].error.message, /Another group chat is already called "Ops"/)
  assert.equal(rename.ok, false)
  const rooms = (await call('state', {})).value.rooms.map(room => room.name).sort()
  assert.deepEqual(rooms, ['Docs', 'Ops'])

  // Once the create ends, its name is no longer held for anyone else.
  const later = await call('create-room', { members: [chief, writer.id], name: 'Ops 2' })
  assert.equal(later.ok, true)
})

test('a create that fails lets its name go', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const create = ctx.sessionController.create
  ctx.sessionController.create = async () => { throw new Error('dsh is busy') }
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, false)
  ctx.sessionController.create = create
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, true)
})

// #99: the team tools take a Bot's thinking level. `effort` is optional, an empty
// string returns to the model's default, and a level the model does not serve is
// refused before anything about the Bot changes.
const TOOL_REASONING = {
  'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
}

test('create_bot and update_bot advertise an optional thinking level without a fixed enum', async (t) => {
  const { ctx, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  for (const name of ['create_bot', 'update_bot']) {
    const schema = ctx.registeredTools.get(name).parameters
    assert.equal(schema.properties.effort?.type, 'string')
    assert.equal(schema.required?.includes('effort') ?? false, false)
    assert.equal(schema.properties.effort.enum, undefined)
  }
})

test('update_bot sets, keeps and clears the thinking level', async (t) => {
  const { ctx, call, stop, selected, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const tool = args => ctx.registeredTools.get('update_bot').execute({ bot: 'Writer', ...args }, { agent: { id: chief } })
  const current = async () => (await call('state', {})).value.bots.find(bot => bot.id === writer.id)

  assert.equal(await tool({ effort: 'low' }), 'Updated Writer.')
  assert.equal((await current()).effort, 'low')
  await until(() => selected.at(-1)?.sessionId === writer.id && selected.at(-1).reasoningEffort === 'low')

  // Left out, the pick is kept; an empty string returns to the model's default.
  assert.equal(await tool({ instructions: 'Be concise' }), 'Updated Writer.')
  assert.equal((await current()).effort, 'low')
  assert.equal(await tool({ effort: '' }), 'Updated Writer.')
  assert.equal((await current()).effort, undefined)
})

test('update_bot checks a level against the model it names, and a failure changes nothing', async (t) => {
  const reasoning = {
    ...TOOL_REASONING,
    'deepseek/other': { reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] } },
  }
  const { ctx, call, stop, selected, sent } = start(undefined, { models: ['deepseek-v4-flash', 'other'], reasoning })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'low' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const tool = args => ctx.registeredTools.get('update_bot').execute({ bot: 'Writer', ...args }, { agent: { id: chief } })
  const current = async () => (await call('state', {})).value.bots.find(bot => bot.id === writer.id)

  // Model and level together resolve the level against the new model.
  assert.equal(await tool({ model: 'deepseek/other', effort: 'medium' }), 'Updated Writer.')
  assert.equal((await current()).model, 'deepseek/other')
  assert.equal((await current()).effort, 'medium')
  await until(() => selected.at(-1)?.sessionId === writer.id && selected.at(-1).reasoningEffort === 'medium')

  // A level the new model does not serve leaves name, model and level as they were.
  assert.match(await tool({ name: 'Renamed', model: 'deepseek/deepseek-v4-flash', effort: 'bogus' }), /^Could not update the Bot: Thinking level bogus is not available/)
  assert.equal((await current()).name, 'Writer')
  assert.equal((await current()).model, 'deepseek/other')
  assert.equal((await current()).effort, 'medium')
  // A level the kept model does not serve fails the same way.
  assert.match(await tool({ effort: 'low' }), /^Could not update the Bot: Thinking level low is not available/)
  assert.equal((await current()).effort, 'medium')
  // A model that is not served fails before anything changes too.
  assert.match(await tool({ name: 'Renamed', model: 'deepseek/nothing' }), /^Could not update the Bot: Model deepseek\/nothing is not available/)
  assert.equal((await current()).name, 'Writer')
})

test('create_bot stores a named thinking level and refuses one without a model', async (t) => {
  const { ctx, call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  const create = args => ctx.registeredTools.get('create_bot').execute(args, exec)
  assert.match(await create({ name: 'Writer', role: 'Write', instructions: 'Write clearly', model: 'deepseek/deepseek-v4-flash', effort: 'low' }), /^Created Writer/)
  const writer = (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.equal(writer.effort, 'low')
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  // A level the model does not serve leaves no Bot behind.
  assert.match(await create({ name: 'Phantom', role: 'Write', instructions: 'Write', model: 'deepseek/deepseek-v4-flash', effort: 'bogus' }), /^Could not create the Bot: Thinking level bogus is not available/)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)
})

test('create_bot with a level but no resolvable model fails before a Session is made', async (t) => {
  // No models are served, so no model can be resolved and an effort has nothing to
  // resolve against.
  const { ctx, call, stop } = start(undefined, { models: [] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  let created = 0
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => { created += 1; return create(...args) }
  const answer = await ctx.registeredTools.get('create_bot').execute({ name: 'Phantom', role: 'Write', instructions: 'Write', effort: 'low' }, { agent: { id: chief } })
  assert.match(answer, /^Could not create the Bot: Pick a model before choosing a thinking level/)
  assert.equal(created, 0)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)
})

test('a non-Main Bot still cannot change another Bot\u2019s thinking level', async (t) => {
  const { ctx, call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'], reasoning: TOOL_REASONING })
  t.after(stop)
  await call('state', {})
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'high' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const exec = { agent: { id: writer.id } }
  assert.match(await ctx.registeredTools.get('update_bot').execute({ bot: 'Chief', effort: 'low' }, exec), /^Only a Main Bot can change another Bot/)
  // Its own level it may change.
  assert.equal(await ctx.registeredTools.get('update_bot').execute({ effort: 'low' }, exec), 'Updated Writer.')
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).effort, 'low')
})

test('list_bot_models names the thinking levels of the models a Bot runs on', async (t) => {
  const { ctx, call, stop } = start(undefined, { models: ['deepseek-v4-flash', 'plain'], reasoning: TOOL_REASONING })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  const result = await ctx.registeredTools.get('list_bot_models').execute({}, { agent: { id: chief } })
  assert.match(result, /deepseek\/deepseek-v4-flash.*thinking: low, high \(default: high\)/)
  assert.doesNotMatch(result.split('\n').find(line => line.includes('deepseek/plain')), /thinking/)
})

// #320: create_bot and update_bot take a photo from a local path or a data URL, and
// store it in the same data URL the settings page writes.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
const tempAvatarDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-avatar-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('create_bot and update_bot advertise an optional photo', async (t) => {
  const { ctx, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  for (const name of ['create_bot', 'update_bot']) {
    const schema = ctx.registeredTools.get(name).parameters
    assert.equal(schema.properties.avatar?.type, 'string')
    assert.equal(schema.required?.includes('avatar') ?? false, false)
    assert.match(schema.properties.avatar.description, /local image path.*data URL/)
    assert.doesNotMatch(schema.properties.avatar.description, /http/)
    assert.match(schema.properties.avatar.description, /256x256/)
  }
})

test('create_bot stores a photo, and update_bot changes and clears it', async (t) => {
  const { ctx, call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const dir = tempAvatarDir(t)
  const photo = join(dir, 'photo.png')
  writeFileSync(photo, PNG_BYTES)
  const exec = { agent: { id: chief } }
  assert.match(await ctx.registeredTools.get('create_bot').execute({ name: 'Writer', role: 'Write', instructions: 'Write', avatar: photo }, exec), /^Created Writer/)
  const writer = async () => (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
  const writerId = (await writer()).id
  await until(() => sent.some(entry => entry.sessionId === writerId))

  const tool = args => ctx.registeredTools.get('update_bot').execute({ bot: 'Writer', ...args }, exec)
  // A mime that does not match the bytes is corrected, not stored as given.
  assert.equal(await tool({ avatar: `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}` }), 'Updated Writer.')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
  // An empty string removes the photo, so the Bot shows its character again.
  assert.equal(await tool({ avatar: '' }), 'Updated Writer.')
  assert.equal((await writer()).avatar, undefined)
  // The photo can be set again after it was cleared.
  assert.equal(await tool({ avatar: PNG_DATA_URL }), 'Updated Writer.')
  assert.equal((await writer()).avatar.image, PNG_DATA_URL)
})

test('a photo through update_bot keeps the Bot\'s other avatar fields', async (t) => {
  const { ctx, call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  assert.match(await ctx.registeredTools.get('create_bot').execute({ name: 'Writer', role: 'Write', instructions: 'Write' }, exec), /^Created Writer/)
  const writer = async () => (await call('state', {})).value.bots.find(bot => bot.name === 'Writer')
  const writerId = (await writer()).id
  await until(() => sent.some(entry => entry.sessionId === writerId))
  await call('update-bot', { id: writerId, avatar: { shape: 'fox' } })
  const tool = args => ctx.registeredTools.get('update_bot').execute({ bot: 'Writer', ...args }, exec)
  // Setting a photo keeps the character; clearing the photo keeps it too.
  assert.equal(await tool({ avatar: PNG_DATA_URL }), 'Updated Writer.')
  assert.deepEqual((await writer()).avatar, { shape: 'fox', image: PNG_DATA_URL })
  assert.equal(await tool({ avatar: '' }), 'Updated Writer.')
  assert.deepEqual((await writer()).avatar, { shape: 'fox' })
})

test('a photo in the team\'s data is refused, and one in the team workspace there is read', async (t) => {
  const { ctx, call, stop, home } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const exec = { agent: { id: chief } }
  const tool = avatar => ctx.registeredTools.get('update_bot').execute({ avatar }, exec)
  writeFileSync(join(home, 'photo.png'), PNG_BYTES)
  assert.match(await tool(join(home, 'photo.png')), /is in DeepSeek Harness data, so it cannot be a Bot's photo/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar?.image, undefined)
  // The default team workspace lies in the team's data, and the Bots' own files are there.
  const workspace = ctx.workspaceRegistry.get((await call('state', {})).value.workspaceId)?.path ?? join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'photo.png'), PNG_BYTES)
  assert.match(await tool(join(workspace, 'photo.png')), /^Updated /)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar.image, PNG_DATA_URL)
})

test('a photo that cannot be read changes nothing, and a non-Main Bot cannot set another Bot\'s', async (t) => {
  const { ctx, call, stop, sent } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const dir = tempAvatarDir(t)
  const notes = join(dir, 'notes.png')
  writeFileSync(notes, 'this is not an image')
  const exec = { agent: { id: chief } }
  assert.match(await ctx.registeredTools.get('create_bot').execute({ name: 'Phantom', role: 'Write', instructions: 'Write', avatar: notes }, exec), /^Could not create the Bot: The avatar must be a PNG, JPEG, WebP, or GIF image/)
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Phantom'), false)

  const writer = (await call('create-bot', { name: 'Writer' })).value
  await until(() => sent.some(entry => entry.sessionId === writer.id))
  const mine = { agent: { id: writer.id } }
  // Another Bot's photo is a Main Bot's to change, as its other settings are.
  assert.match(await ctx.registeredTools.get('update_bot').execute({ bot: 'Chief', avatar: PNG_DATA_URL }, mine), /^Only a Main Bot can change another Bot/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === chief).avatar?.image, undefined)
  // Its own it may set; a later bad photo leaves the good one alone.
  assert.equal(await ctx.registeredTools.get('update_bot').execute({ avatar: PNG_DATA_URL }, mine), 'Updated Writer.')
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).avatar.image, PNG_DATA_URL)
  assert.match(await ctx.registeredTools.get('update_bot').execute({ avatar: notes }, mine), /^Could not update the Bot: The avatar must be a PNG/)
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === writer.id).avatar.image, PNG_DATA_URL)
})

test('a group\'s relay limit is a user setting the state view shows, and old late-round fields load away', async (t) => {
  const { call, stop, home } = start({
    version: 1,
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['chief', 'writer'], mode: 'admin', admin: 'chief', named: true,
        log: [], seq: 0, seen: {}, lateRounds: 7, quietNoticed: true, quietShown: true,
      },
    },
  })
  t.after(stop)
  const shown = (await call('state', {})).value.rooms.find(room => room.id === 'r1')
  // The released late-round fields load away, and the live relay count never shows.
  assert.equal('lateRounds' in shown, false)
  assert.equal('quietNoticed' in shown, false)
  assert.equal('quietShown' in shown, false)
  assert.equal('relays' in shown, false)
  assert.equal(shown.relayLimit, undefined)
  assert.equal(shown.relayLimitDefault, 6, 'the default is three relays per member')
  assert.equal('lateRounds' in JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1, false)

  const set = await call('update-room', { id: 'r1', relayLimit: 4 })
  assert.equal(set.ok, true)
  assert.equal(set.value.room.relayLimit, 4)
  assert.match(set.value.changes.join(' '), /Bots now pause after 4 relays/)
  const cleared = await call('update-room', { id: 'r1', relayLimit: null })
  assert.equal(cleared.ok, true)
  assert.match(cleared.value.changes.join(' '), /Bots pause at the default relay count again/)
  assert.equal((await call('state', {})).value.rooms.find(room => room.id === 'r1').relayLimit, undefined)

  for (const bad of [0, 2.5, 201, 'six']) {
    const result = await call('update-room', { id: 'r1', relayLimit: bad })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.match(result.error.message, /Relay limit must be a whole number from 1 to 200/)
  }
})
