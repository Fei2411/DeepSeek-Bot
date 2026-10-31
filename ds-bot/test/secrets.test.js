import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { canUse, encodeUrlComponent, normalizeName, redactDeep, redactor, SECRET_NAME } from '../src/host/secrets.js'
import { fakeContext } from './fake-ctx.js'

// Test values are random on every run, so a leak can only come from this run.
const fresh = () => `t-${randomBytes(12).toString('hex')}`

test('names are normalized, then checked', () => {
  assert.equal(normalizeName(' github-token '), 'GITHUB_TOKEN')
  assert.equal(normalizeName('$DSH_SECRET_demo_token'), 'DEMO_TOKEN')
  assert.equal(normalizeName('$env:DSH_SECRET_X1'), 'X1')
  assert.ok(SECRET_NAME.test('GITHUB_TOKEN'))
  for (const bad of ['', '1ABC', '_X', 'A'.repeat(65), 'A B', 'Ä']) assert.ok(!SECRET_NAME.test(bad), bad)
})

test('scope is every Bot or a list', () => {
  assert.ok(canUse({ scope: 'all' }, 'b'))
  assert.ok(canUse({ scope: ['a', 'b'] }, 'b'))
  assert.ok(!canUse({ scope: ['a'] }, 'b'))
  assert.ok(!canUse({ scope: [] }, 'b'))
  assert.ok(!canUse(undefined, 'b'))
  assert.ok(!canUse({ scope: 'all' }, undefined))
})

test('redaction replaces the longest value first, JSON-escaped forms too, and skips short values', () => {
  const long = fresh()
  const inner = long.slice(0, 12)
  const quoted = `${fresh()}"\\x`
  const redact = redactor([{ name: 'INNER', value: inner }, { name: 'LONG', value: long }, { name: 'SHORT', value: 'abc' }, { name: 'Q', value: quoted }])
  assert.equal(redact(`a ${long} b ${inner} c abc`), 'a [secret:LONG] b [secret:INNER] c abc')
  assert.equal(redact(JSON.stringify({ text: quoted })), '{"text":"[secret:Q]"}')
  assert.equal(redact(42), 42)
  const value = { list: ['x', { text: `see ${long}` }], n: 1 }
  const out = redactDeep(value, redact)
  assert.deepEqual(out, { list: ['x', { text: 'see [secret:LONG]' }], n: 1 })
  assert.equal(value.list[1].text, `see ${long}`)
  const clean = { list: ['x'] }
  assert.equal(redactDeep(clean, redact), clean)
})

test('redaction replaces URL-encoded values', () => {
  const value = `${fresh()} /+&?=#'!()* 中文`
  const redact = redactor([{ name: 'TOKEN', value }])
  assert.equal(redact(`https://example.test/mcp?key=${encodeUrlComponent(value)}&mode=1`), 'https://example.test/mcp?key=[secret:TOKEN]&mode=1')
  assert.equal(redact(new URL(`https://example.test/mcp?key=${encodeUrlComponent(value)}`).href), 'https://example.test/mcp?key=[secret:TOKEN]')
  const broken = `${fresh()}\uD800`
  assert.equal(redactor([{ name: 'BROKEN', value: broken }])(`x ${broken}`), 'x [secret:BROKEN]')
})

test('a short key (4 to 7 characters) is replaced only where it stands alone', () => {
  const redact = redactor([{ name: 'PIN', value: '4821' }, { name: 'PW', value: 'cat$1' }, { name: 'SECRET_WORD', value: 'secret' }])
  assert.equal(redact('pin 4821, again "4821"'), 'pin [secret:PIN], again "[secret:PIN]"')
  // Inside a longer number or word it is left alone.
  assert.equal(redact('order 148210 and x4821'), 'order 148210 and x4821')
  assert.equal(redact('login cat$1@host'), 'login [secret:PW]@host')
  assert.equal(redact('concat$12'), 'concat$12')
  // A label already written is not matched again, even when it holds the value.
  assert.equal(redact('secret and 4821'), '[secret:SECRET_WORD] and [secret:PIN]')
  assert.equal(redact('中文4821中文'), '中文4821中文')
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', lab: 'kimi', instructions: '', createdAt: 2 },
    c3: { id: 'c3', sessionId: 'c3', name: 'Coder', role: '代码', lab: 'deepseek', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Team', named: true, members: ['m1', 'b2'], admin: 'm1', mode: 'everyone', notice: '', sessions: { b2: 'g-b2' }, log: [] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

let rt
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-')) } = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const contributors = []
  const shellEnv = {
    register(contributor) {
      const entry = { ...contributor, live: true }
      contributors.push(entry)
      return () => { entry.live = false }
    },
  }
  const ctx = fakeContext({ services: { shellEnv } })
  const listeners = {}
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    ;(listeners[name] ??= []).push(listener)
    return on(name, listener, options)
  }
  const delivered = []
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: {}, followup: message => delivered.push({ sessionId, text: message.content[0].text, source: message.source }) } }),
  }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  const streamed = []
  ctx.llm.stream = (options) => {
    streamed.push(options)
    return (async function* () {})()
  }
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, agentId, extra = {}) => {
    let concluded = false
    const exec = { agent: { id: agentId }, callId: `call-${agentId}-${name}`, concludeTurn: () => { concluded = true }, ...extra }
    return rt.teamTools.find(d => d.name === name).execute(args, exec).then(text => ({ text, concluded }))
  }
  const view = async () => {
    const result = await call('state', {})
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const env = (agentId, command = '') => contributors.filter(entry => entry.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: { command } }) ?? {}
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, call, tool, view, env, listeners, delivered, streamed, contributors, stop }
}

// Bootstrap would create a Main Bot when none exists; this team has one, so it only loads.
test('a card saves a key the Bot never sees, and the shell gets it', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()

  const asked = await bench.tool('request_secret', { name: 'demo_token', purpose: '测试' }, 'b2')
  assert.equal(asked.concluded, true)
  assert.match(asked.text, /card asking the user for DEMO_TOKEN is on screen/)
  let team = await bench.view()
  const [request] = team.secretRequests.b2
  assert.equal(request.name, 'DEMO_TOKEN')
  assert.equal(request.kind, 'fill')
  assert.equal(request.status, 'pending')
  assert.equal(request.callId, 'call-b2-request_secret')

  assert.match((await bench.call('secret-set', { requestId: request.id, value: 'abc' })).error.message, /at least 4/)
  const saved = await bench.call('secret-set', { requestId: request.id, value: `  ${value}\n` })
  assert.equal(saved.ok, true)
  assert.deepEqual(Object.keys(saved.value).sort(), ['createdAt', 'name', 'purpose', 'requestedBy', 'scope', 'updatedAt'])
  assert.equal(saved.value.scope, 'all')
  assert.equal(saved.value.requestedBy, 'b2')
  assert.match((await bench.call('secret-set', { requestId: request.id, value })).error.message, /already answered/)

  const file = join(bench.home, 'secrets.json')
  // Windows has no POSIX mode bits: a writable file always stats as 0o666 there.
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).secrets[0].value, value)
  assert.deepEqual(readdirSync(bench.home).filter(name => name.endsWith('.tmp')), [])
  team = await bench.view()
  assert.equal(team.secretRequests.b2[0].status, 'saved')
  assert.deepEqual(team.secrets.map(secret => secret.name), ['DEMO_TOKEN'])
  // Nothing the browser gets holds the value.
  assert.ok(!JSON.stringify(team).includes(value))
  assert.ok(!readFileSync(join(bench.home, 'state.json'), 'utf8').includes(value))

  const note = bench.delivered.at(-1)
  assert.equal(note.sessionId, 'b2')
  assert.equal(note.source.role, 'secret')
  assert.match(note.text, /^\[Secret card\]\nThe user saved DEMO_TOKEN for every Bot\. Use it as \$DSH_SECRET_DEMO_TOKEN in bash, or \$env:DSH_SECRET_DEMO_TOKEN in PowerShell\./)
  assert.ok(!note.text.includes(value))

  // Every Bot (own chat or group Session) gets the variable; other Sessions do not.
  assert.deepEqual(bench.env('b2', 'echo $DSH_SECRET_DEMO_TOKEN'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.deepEqual(bench.env('g-b2'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.deepEqual(bench.env('not-a-bot'), {})
  const live = bench.contributors.filter(entry => entry.live)
  assert.equal(live.length, 1)
  assert.deepEqual(Object.keys(live[0].variables), ['DSH_SECRET_DEMO_TOKEN'])
  assert.equal(live[0].variables.DSH_SECRET_DEMO_TOKEN.description, 'DS Bot secret DEMO_TOKEN: 测试')

  // Asking again only names the variable.
  const again = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'x' }, 'b2')
  assert.equal(again.concluded, false)
  assert.match(again.text, /already saved and you may use it: \$DSH_SECRET_DEMO_TOKEN/)
  const listed = await bench.tool('list_secrets', {}, 'c3')
  assert.match(listed.text, /- DEMO_TOKEN — 测试 — for every Bot — you may use it as \$DSH_SECRET_DEMO_TOKEN/)
  assert.ok(!listed.text.includes(value))
})

test('a Bot outside the scope gets an allow card, and allowing resolves it', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: '测试' }, 'b2')
  let [request] = (await bench.view()).secretRequests.b2
  assert.equal((await bench.call('secret-set', { requestId: request.id, value, scope: 'bot' })).value.scope.join(), 'b2')
  assert.deepEqual(bench.env('c3'), {})

  // Coder asks too, while a second Writer card would be superseded by the first answer.
  const asked = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  assert.match(asked.text, /let you use DEMO_TOKEN/)
  ;[request] = (await bench.view()).secretRequests.c3
  assert.equal(request.kind, 'allow')
  const listed = await bench.tool('list_secrets', {}, 'c3')
  assert.match(listed.text, /for Writer — you may not use it/)

  const allowed = await bench.call('secret-allow', { requestId: request.id })
  assert.deepEqual(allowed.value.scope, ['b2', 'c3'])
  assert.equal((await bench.view()).secretRequests.c3[0].status, 'allowed')
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.match(bench.delivered.at(-1).text, /^\[Secret card\]\nThe user let you use DEMO_TOKEN\./)

  // Settings: narrow the scope, which turns a new card back into an allow card.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2', 'nope'] })
  assert.deepEqual((await bench.view()).secrets[0].scope, ['b2'])
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  const pending = (await bench.view()).secretRequests.c3.at(-1)
  assert.equal(pending.kind, 'allow')
  // Widening it resolves the waiting card and tells Coder.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: 'all' })
  assert.equal((await bench.view()).secretRequests.c3.at(-1).status, 'saved')
  assert.match(bench.delivered.at(-1).text, /The user saved DEMO_TOKEN, and you may use it now\./)

  // Replacing the value keeps the scope; the old value is no longer injected.
  const next = fresh()
  await bench.call('secret-set', { name: 'demo_token', value: next })
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_DEMO_TOKEN: next })
  assert.equal((await bench.view()).secrets[0].scope, 'all')

  // Deleting turns a waiting allow card into a fill card and drops the variable.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2'] })
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  await bench.call('secret-delete', { name: 'DEMO_TOKEN' })
  const team = await bench.view()
  assert.deepEqual(team.secrets, [])
  assert.equal(team.secretRequests.c3.at(-1).kind, 'fill')
  assert.equal(bench.contributors.filter(entry => entry.live).length, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets, [])
})

test('a key\'s purpose can be changed or cleared on its own', async (t) => {
  const bench = start()
  t.after(bench.stop)
  await bench.call('secret-set', { name: 'DEMO_TOKEN', value: fresh(), purpose: 'first', scope: 'all' })

  const changed = await bench.call('secret-update', { name: 'DEMO_TOKEN', purpose: 'renamed' })
  assert.equal(changed.value.purpose, 'renamed')
  assert.equal(changed.value.scope, 'all')
  const cleared = await bench.call('secret-update', { name: 'DEMO_TOKEN', purpose: '' })
  assert.equal(cleared.value.purpose, '')
  const scoped = await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2'] })
  assert.deepEqual(scoped.value.scope, ['b2'])
  assert.equal(scoped.value.purpose, '')
  const both = await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: 'all', purpose: 'kept' })
  assert.equal(both.value.scope, 'all')
  assert.equal(both.value.purpose, 'kept')
  const saved = JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets[0]
  assert.equal(saved.purpose, 'kept')
  assert.equal(saved.scope, 'all')
})

test('cards stay in a Bot\'s own chat; canceling tells the Bot', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const group = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'x' }, 'g-b2')
  assert.equal(group.concluded, false)
  assert.match(group.text, /only work in your own chat/)
  assert.match((await bench.tool('request_secret', { name: '9bad', purpose: 'x' }, 'b2')).text, /capitals, digits, and underscores/)
  assert.match((await bench.tool('request_secret', { name: 'X_KEY', purpose: 'x' }, 'stranger')).text, /Only Bots/)

  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'first' }, 'b2')
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'second' }, 'b2')
  const [first, second] = (await bench.view()).secretRequests.b2
  assert.equal(first.status, 'canceled')
  assert.equal(second.status, 'pending')
  assert.equal((await bench.call('secret-cancel', { requestId: second.id })).ok, true)
  assert.equal((await bench.view()).secretRequests.b2[1].status, 'canceled')
  assert.match(bench.delivered.at(-1).text, /^\[Secret card\]\nThe user canceled your request for DEMO_TOKEN\./)
  assert.match((await bench.call('secret-allow', { requestId: 'gone' })).error.message, /request is gone/)
})

test('a deleted Bot leaves every scope list and takes its cards along', async (t) => {
  const bench = start()
  t.after(bench.stop)
  await bench.call('secret-set', { name: 'API_KEY', value: fresh(), scope: ['b2', 'c3'], purpose: 'p' })
  await bench.tool('request_secret', { name: 'OTHER_KEY', purpose: 'x' }, 'c3')
  assert.equal((await bench.call('delete-bot', { id: 'c3' })).ok, true)
  const team = await bench.view()
  assert.deepEqual(team.secrets[0].scope, ['b2'])
  assert.equal(team.secretRequests.c3, undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets[0].scope, ['b2'])
})

test('tool results and model requests lose the values', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()
  await bench.call('secret-set', { name: 'DEMO_TOKEN', value })
  // The team tools' listener (working_directory) registers first.
  const execute = bench.listeners['tools/execute'].at(-1)
  const ok = await execute({}, async () => ({ isError: false, value: { kind: 'foreground', stdout: { text: `${value}\n`, truncated: false } }, content: [{ type: 'text', text: value }], meta: { stdout: value } }))
  assert.deepEqual(ok, { isError: false, value: { kind: 'foreground', stdout: { text: '[secret:DEMO_TOKEN]\n', truncated: false } } })
  const failed = await execute({}, async () => ({ isError: true, error: { message: `bad ${value}` }, content: [{ type: 'text', text: `bad ${value}` }] }))
  assert.equal(failed.content[0].text, 'bad [secret:DEMO_TOKEN]')
  assert.equal(failed.error.message, 'bad [secret:DEMO_TOKEN]')
  const plain = { isError: false, value: 'nothing here' }
  assert.equal(await execute({}, async () => plain), plain)

  // The usage meter registers after the secrets listener.
  const stream = bench.listeners['llm/stream'].at(-2)
  const passed = []
  const next = () => { passed.push(true); return (async function* () {})() }
  const options = {
    provider: 'p', model: 'm', sessionId: 'b2', system: `sys ${value}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `my key is ${value}` }] }, { role: 'tool', content: [{ type: 'text', text: value }] }],
  }
  stream(options, next)
  assert.equal(passed.length, 0)
  const sent = bench.streamed.at(-1)
  assert.equal(sent.system, 'sys [secret:DEMO_TOKEN]')
  assert.equal(sent.provider, 'p')
  assert.ok(!JSON.stringify(sent).includes(value))
  assert.ok(JSON.stringify(options).includes(value))
  // The rewritten request passes through, even when a value sits inside its own label.
  stream(sent, next)
  assert.equal(passed.length, 1)
  stream({ ...options, system: 'clean', messages: [] }, next)
  assert.equal(passed.length, 2)
})

test('a secrets file that cannot be read blocks every write instead of being overwritten', async (t) => {
  // A directory reads as EISDIR on every platform; no chmod games needed. It has to
  // exist before the plugin loads, or the first read has already found the file empty.
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  mkdirSync(join(home, 'secrets.json'))
  const bench = start({ home })
  t.after(bench.stop)
  const file = join(home, 'secrets.json')
  const denied = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /secrets\.json could not be read \(EISDIR\)\. DS Bot does not change it/)
  assert.ok(statSync(file).isDirectory())
  // While it stays unreadable, nothing is written; once it is gone, saving works.
  rmSync(file, { recursive: true })
  const saved = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(saved.ok, true, JSON.stringify(saved.error))
})

test('a secrets file that is not JSON is kept aside, and the store goes on', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  writeFileSync(join(home, 'secrets.json'), 'not a secrets file\n')
  const bench = start({ home })
  t.after(bench.stop)
  const saved = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(saved.ok, true, JSON.stringify(saved.error))
  const broken = readdirSync(home).filter(name => name.startsWith('secrets.json.broken-'))
  assert.deepEqual(broken.length, 1)
  assert.equal(readFileSync(join(home, broken[0]), 'utf8'), 'not a secrets file\n')
})
