import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanText, install as installDiagnostics, reportMarkdown } from '../src/host/diagnostics.js'
import { failureLine, install as installTurns, turnFailure } from '../src/host/turns.js'
import { errorCode } from '../src/host/channel.js'
import { SOURCE_KIND } from '../src/host/constants.js'

test('cleanText hides keys, tokens and the home folder', () => {
  const home = '/home/user'
  const text = 'key sk-abcdef123456 and Bearer abc.def.ghi.jkl at http://h:1/?token=XYZ123&x=1 in /home/user/.dsh/bot, "api_key": "zzzzzzzzz", saved VALUE1234'
  const out = cleanText(text, { home, redact: value => value.replaceAll('VALUE1234', '[secret:DEMO]') })
  assert.equal(out, 'key sk-[hidden] and Bearer [hidden] at http://h:1/?token=[hidden]&x=1 in ~/.dsh/bot, "api_key": "[hidden]", saved [secret:DEMO]')
  assert.equal(cleanText('C:\\Users\\Shared\\x and C:/Users/Shared/y', { home: 'C:\\Users\\Shared' }), '~\\x and ~/y')
  assert.ok(cleanText('x'.repeat(5000)).length < 2100)
})

test('cleanText hides standalone credentials it was never given', () => {
  // Synthetic shapes only, built from parts so no string looks like a real key.
  const made = (...parts) => parts.join('')
  const out = cleanText([
    made('ghp_', 'A1'.repeat(12)),
    made('github_pat_', 'B2'.repeat(12)),
    made('AKIA', '0'.repeat(16)),
    made('xoxb-', '1234', '-', 'abcd'.repeat(3)),
    made('AIza', 'C3'.repeat(12)),
    made('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'dGVzdC1zaWduYXR1cmUtcGFydA'),
  ].join(' '), { home: '' })
  assert.equal(out, '[hidden] [hidden] [hidden] [hidden] [hidden] [hidden]')
})

// `stop()` runs the cleanups, as the plugin's stop does.
function host(home, extra = {}) {
  const warnings = []
  const cleanups = []
  const effect = (execute) => {
    const cleanup = execute()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  const rt = {
    ctx: { logger: { warn: (...args) => warnings.push(args) }, effect },
    home,
    config: {},
    state: { bots: { a: { id: 'a', name: 'Chief', model: 'deepseek/deepseek-chat' } }, mainBotIds: ['a'], rooms: {} },
    readOnly: () => undefined,
    ...extra,
  }
  installDiagnostics(rt)
  rt.stop = () => Promise.all(cleanups.map(cleanup => cleanup()))
  return rt
}

test('warnings are kept, cleaned, written to the log, and read back after a restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const error = Object.assign(new Error(`cannot open ${homedir()}/x with sk-abcdefghij`), { code: 'EACCES' })
  const quiet = t.mock.method(console, 'error', () => {})
  const rt = host(home)
  rt.warn('ds-bot: state write failed: %s', error)
  rt.noteFailure({ source: 'turn', text: 'Rate limited', code: 'RATE_LIMIT', status: 429, bot: 'Chief', where: 'own chat' })
  const [first, second] = await rt.diagnostics.entries()
  assert.equal(first.level, 'warn')
  assert.equal(first.code, 'EACCES')
  assert.equal(first.text, 'state write failed: cannot open ~/x with sk-[hidden]')
  assert.match(first.stack, /^at TestContext/)
  assert.equal(second.code, 'RATE_LIMIT')

  const report = await rt.diagnostics.report({ client: { surface: 'Web', language: 'zh-CN', userAgent: 'Test/1' }, clientErrors: [{ time: 1, text: 'state: HTTP 502' }] })
  assert.match(report.markdown, /\| DS Bot \| \d+\.\d+\.\d+ \|/)
  assert.match(report.markdown, /\| Surface \| Web \|/)
  assert.match(report.markdown, /\| Models \| deepseek\/deepseek-chat \|/)
  assert.match(report.markdown, /WARN host \[EACCES\] state write failed/)
  assert.match(report.markdown, /ERROR turn \(Chief · own chat\) \[RATE_LIMIT 429\] Rate limited/)
  assert.match(report.markdown, /ERROR browser state: HTTP 502/)
  assert.doesNotMatch(report.markdown, /sk-abc|\/home\//)
  assert.equal(report.entries[0].code, 'RATE_LIMIT', 'newest first')

  // Written as JSON lines; a new host reads them back.
  await rt.stop()
  assert.equal(readFileSync(join(home, 'logs', 'diagnostics.jsonl'), 'utf8').trim().split('\n').length, 2)
  const again = host(home)
  assert.deepEqual((await again.diagnostics.entries()).map(entry => entry.code), ['EACCES', 'RATE_LIMIT'])
  assert.match(await again.diagnostics.logText(), /\n {4}at TestContext/)
  await again.diagnostics.clear()
  assert.deepEqual(await again.diagnostics.entries(), [])
  assert.deepEqual(await host(home).diagnostics.entries(), [])
  quiet.mock.restore()
})

test('warnings send only cleaned text to the logger and stderr', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const values = ['synthetic-api-key-123456', 'synthetic-bearer-token-12345', 'synthetic-query-token-12345']
  const error = new Error(`api_key=${values[0]} Bearer ${values[1]} https://example.invalid/?token=${values[2]}`)
  error.stack = `${error.name}: ${error.message}\n    at fake (https://example.invalid/?token=${values[2]}:1:1)`
  const warnings = []
  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home, { config: { diagnosticsFile: false } })
  rt.ctx.logger.warn = (...args) => warnings.push(args)
  rt.warn('ds-bot: warning: %s', error)
  quiet.mock.restore()

  assert.equal(warnings[0][0], '%s')
  assert.match(warnings[0][1], /\[hidden\]/)
  assert.match(stderr[0], /\[hidden\]/)
  assert.match(stderr[0], /at fake/)
  for (const value of values) {
    assert.equal(warnings.flat().join('\n').includes(value), false)
    assert.equal(stderr.join('\n').includes(value), false)
  }
})

test('diagnostics append fallback redacts an error message', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const value = 'synthetic-api-key-append-123456'
  const stderr = []
  const quiet = t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const rt = host(home)
  const originalAppend = fsp.appendFile
  fsp.appendFile = async (path, ...args) => {
    if (path === join(home, 'logs', 'diagnostics.jsonl')) throw new Error(`synthetic append failure api_key=${value}`)
    return originalAppend(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    rt.noteFailure({ text: 'synthetic entry' })
    await rt.diagnostics.clear()
  } finally {
    fsp.appendFile = originalAppend
    syncBuiltinESMExports()
    quiet.mock.restore()
  }
  assert.equal(stderr.join('\n').includes(value), false)
  assert.match(stderr.join('\n'), /api_key=\[hidden\]/)
})

// #226: a test removed `home` right after the stop while a warning was still being
// written there, and the removal failed with ENOTEMPTY.
test('a stop waits for the log writes queued before it, and nothing is written after it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  t.mock.method(console, 'error', () => {})
  const log = join(home, 'logs', 'diagnostics.jsonl')
  const originalAppend = fsp.appendFile
  let reached
  const appending = new Promise((resolve) => { reached = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  fsp.appendFile = async (...args) => {
    reached()
    await gate
    return originalAppend(...args)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.appendFile = originalAppend
    syncBuiltinESMExports()
  })
  const rt = host(home)
  rt.warn('ds-bot: before the stop')
  await appending
  let stopped = false
  const stopping = rt.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false, 'the stop waits for the write in progress')
  release()
  await stopping
  assert.match(readFileSync(log, 'utf8'), /before the stop/)

  rt.warn('ds-bot: after the stop')
  await rt.diagnostics.clear()
  // A write queued after the stop would be part of what a second stop waits for.
  await rt.stop()
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'neither the warning nor the clear reached the file')
  assert.match(lines[0], /before the stop/)
  assert.equal((await rt.diagnostics.entries()).length, 0, 'the clear still empties the list in memory')
})

test('reportMarkdown says when nothing went wrong', () => {
  const text = reportMarkdown({ facts: { botVersion: '0.1.0', os: 'linux' } })
  assert.match(text, /No host errors recorded\./)
  assert.doesNotMatch(text, /DSH \|/)
})

test('errorCode tells refusals from DS Bot faults', () => {
  assert.equal(errorCode(new Error('Unknown Bot')), 'bot/refused')
  assert.equal(errorCode(new TypeError('x is undefined')), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ENOENT' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ERR_SQLITE_ERROR' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'ERR_INVALID_ARG_TYPE' })), 'bot/internal')
  assert.equal(errorCode(Object.assign(new Error('no'), { code: 'bot/read-only' })), 'bot/read-only')
})

test('turnFailure drops AUTH messages and keeps the facts', () => {
  assert.deepEqual(turnFailure({ code: 'AUTH', message: 'bad key sk-12***34', status: 401 }), { code: 'AUTH', message: '', status: 401 })
  assert.deepEqual(turnFailure({ code: 'RATE_LIMIT', message: ' slow down ', requestId: 'r1' }), { code: 'RATE_LIMIT', message: 'slow down', requestId: 'r1' })
  assert.deepEqual(turnFailure(undefined), { code: 'UNKNOWN', message: '' })
  assert.equal(failureLine({ code: 'SERVER', status: 503, message: 'busy' }), 'SERVER 503: busy')
})

function turnsHost() {
  let listener
  const delivered = []
  const noted = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure: entry => noted.push(entry),
    warn() {},
    switchJobs: () => [],
    dropKickoff() {},
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data, session) => listener(session ?? { id }, { type, seq: ++seq, data })
  return { rt, emit, delivered, noted }
}

const failed = { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } }

test('a failed reply to message_bot tells the sender instead of leaving it waiting', () => {
  const { emit, delivered, noted } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'a', exchangeId: 'x1' } })
  emit('b', 'turn/end', { turn: 1, reason: failed })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 'x1')
  assert.match(delivered[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
  assert.deepEqual(noted.map(entry => [entry.source, entry.code, entry.bot, entry.where]), [['turn', 'SERVER', 'Writer', 'own chat']])
})

test('a failed group turn fails its waiter; a stopped one counts as no answer', () => {
  const { rt, emit } = turnsHost()
  rt.roomWaiters.set('r1', { resolve: () => assert.fail('resolved'), fail: failure => rt.roomWaiters.failed = failure })
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [], source: { kind: SOURCE_KIND, role: 'room', exchangeId: 'r1' } })
  emit('b', 'turn/end', { turn: 1, reason: failed })
  assert.deepEqual(rt.roomWaiters.failed, { code: 'SERVER', message: 'upstream busy', status: 503 })

  let value
  rt.roomWaiters.set('r2', { resolve: reply => { value = reply }, fail: () => assert.fail('failed') })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: [], source: { kind: SOURCE_KIND, role: 'room', exchangeId: 'r2' } })
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(value, null)
})

// #637: the route a refused turn ran on is read from the Session's request header,
// not from the Bot's record — a group Session may carry another Bot's route.
test('a turn refused for not being a model endpoint refuses that route', () => {
  const { rt, emit } = turnsHost()
  const calls = []
  rt.routeRefused = async (ref, bot) => { calls.push([ref, bot?.id]) }
  const session = { id: 'b', requestHeader: () => ({ config: { provider: 'external', model: 'default' } }) }
  emit('b', 'turn/start', { turn: 1 }, session)
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'HOSTED_ENGINE_ROUTE', message: 'provider "external" is a hosted loop engine route, not a model endpoint' } } }, session)
  assert.deepEqual(calls, [['external/default', 'b']])
  // An ordinary failure takes no such path.
  emit('b', 'turn/start', { turn: 2 }, session)
  emit('b', 'turn/end', { turn: 2, reason: failed }, session)
  assert.equal(calls.length, 1)
})

test('issueUrl fills the issue form, keeps the versions when the errors are too long, and falls back to the clipboard', async () => {
  const { issueUrl } = await import('../src/client/diagnostics.js')
  const base = 'https://github.com/Fei2411/DS-Bot/issues/new'
  const short = issueUrl(base, { what: 'Writer failed\nin the group', diagnostics: '| DS Bot | 0.1.0 |' })
  assert.equal(short.inline, true)
  const params = new URL(short.url).searchParams
  assert.equal(params.get('template'), 'bug.yml')
  assert.equal(params.get('title'), 'Writer failed')
  assert.equal(params.get('what'), 'Writer failed\nin the group')
  assert.equal(params.get('diagnostics'), '| DS Bot | 0.1.0 |')
  const long = issueUrl(base, { diagnostics: '错误'.repeat(2000) })
  assert.equal(long.inline, false)
  assert.ok(long.url.length < 7000)
  assert.match(new URL(long.url).searchParams.get('diagnostics'), /clipboard/)
  assert.equal(new URL(long.url).searchParams.has('title'), false)
  const table = '| | |\n|---|---|\n| DS Bot | 0.1.2 |\n| DSH | 0.2.0 |'
  const errors = issueUrl(base, { what: 'Writer failed', diagnostics: `${table}\n\nRecent host errors:\n${'错误'.repeat(2000)}` })
  assert.equal(errors.inline, false)
  assert.ok(errors.url.length < 7000)
  const kept = new URL(errors.url).searchParams.get('diagnostics')
  assert.ok(kept.startsWith(`${table}\n\n`))
  assert.match(kept, /clipboard: paste them below this line/)
  assert.doesNotMatch(kept, /错误/)
})

test('a browser error is noted once, repeats are counted, and clear empties the list', async () => {
  const { noteClientError, markNoted, clientErrors, clearClientErrors } = await import('../src/client/diagnostics.js')
  clearClientErrors()
  const shown = markNoted(new Error('Could not reach DSH.'))
  noteClientError('menu', shown)
  assert.equal(clientErrors().length, 0)
  const failed = new Error('HTTP 502')
  noteClientError('state', failed)
  noteClientError('menu', failed)
  noteClientError('state', new Error('HTTP 502'))
  assert.deepEqual(clientErrors().map(entry => entry.text), ['state: HTTP 502 (×2)'])
  clearClientErrors()
  assert.equal(clientErrors().length, 0)
})
