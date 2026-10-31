import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureStdio, LogFile, logNames, redactor, rotate, shouldRotate, splitLines, tailLines } from '../src/logs.mjs'

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-logs-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}
const at = () => new Date('2026-10-28T08:00:00.000Z')

// The CI user of the onboarding acceptance has a space and Chinese in its name.
const windows = redactor({ home: 'C:\\Users\\测试 用户', platform: 'win32' })

test('the launch token, API keys and the sign-in callback do not reach the log', () => {
  assert.equal(windows('GET http://127.0.0.1:52817/?token=Zm9v.YmFy&x=1'), 'GET http://127.0.0.1:52817/?token=<hidden>&x=1')
  assert.equal(windows('access_token=abc refresh_Token=def'), 'access_token=<hidden> refresh_Token=<hidden>')
  // The mock model's keys and the three DeepSeek-shaped ones of the acceptance.
  for (const key of ['sk-test-ok', 'sk-test-bad', 'sk-test-empty', `sk-${'0123456789abcdef'.repeat(2).slice(0, 28)}0001`, `sk-${'a'.repeat(28)}0401`, `sk-${'b'.repeat(28)}0000`]) {
    assert.equal(windows(`key "${key}" saved`), 'key "sk-<hidden>" saved')
  }
  assert.equal(windows('GET /oauth/callback?code=abc&state=def 302'), 'GET /oauth/callback?<hidden> 302')
  assert.equal(windows('Authorization: Bearer eyJh.eyJz.c2ln'), 'Authorization: Bearer <hidden>')
})

test('the home folder becomes %USERPROFILE% in every spelling', () => {
  assert.equal(windows('data C:\\Users\\测试 用户\\.ds-bot'), 'data %USERPROFILE%\\.ds-bot')
  assert.equal(windows('url file:///c:/users/测试 用户/DeepSeek Bot'), 'url file:///%USERPROFILE%/DeepSeek Bot')
  assert.equal(windows('{"dataDir":"C:\\\\Users\\\\测试 用户\\\\.ds-bot"}'), '{"dataDir":"%USERPROFILE%\\\\.ds-bot"}')
  assert.equal(windows('cwd C:\\Users\\测试 用户'), 'cwd %USERPROFILE%')
  // Another user whose name starts the same way is not this one.
  assert.equal(windows('C:\\Users\\测试 用户2\\x'), 'C:\\Users\\测试 用户2\\x')
  const posix = redactor({ home: '/home/Alice', platform: 'linux' })
  assert.equal(posix('/home/Alice/.ds-bot and file:///home/Alice'), '~/.ds-bot and file://~')
  assert.equal(posix('/home/Alicey/x /HOME/Alice'), '/home/Alicey/x /HOME/Alice')
  assert.equal(redactor({ home: '/', platform: 'linux' })('/usr/bin'), '/usr/bin')
})

test('redaction keeps ordinary words and can run twice', () => {
  assert.equal(windows('desk-top task-runner risk-free'), 'desk-top task-runner risk-free')
  const line = 'GET /oauth/callback?code=1 ?token=2 sk-test-ok Bearer x C:\\Users\\测试 用户\\a'
  assert.equal(windows(windows(line)), windows(line))
})

test('output splits into whole lines; the rest waits', () => {
  assert.deepEqual(splitLines('', 'one\r\ntwo\nthr'), { lines: ['one', 'two'], rest: 'thr' })
  assert.deepEqual(splitLines('thr', 'ee\n'), { lines: ['three'], rest: '' })
  const long = 'x'.repeat(9000)
  assert.deepEqual(splitLines('', long), { lines: [long], rest: '' })
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c'])
})

test('a write that would pass 2 MB goes into a fresh file, three files at most', (t) => {
  assert.equal(shouldRotate(0, 5 * 1024 * 1024), false)
  assert.equal(shouldRotate(2 * 1024 * 1024 - 10, 10), false)
  assert.equal(shouldRotate(2 * 1024 * 1024 - 10, 11), true)
  assert.deepEqual(logNames(), ['main.log', 'main.1.log', 'main.2.log'])
  const dir = folder(t)
  writeFileSync(join(dir, 'main.log'), 'newest\n')
  writeFileSync(join(dir, 'main.1.log'), 'older\n')
  writeFileSync(join(dir, 'main.2.log'), 'oldest\n')
  rotate(dir)
  assert.deepEqual(readdirSync(dir).sort(), ['main.1.log', 'main.2.log'])
  assert.equal(readFileSync(join(dir, 'main.1.log'), 'utf8'), 'newest\n')
  assert.equal(readFileSync(join(dir, 'main.2.log'), 'utf8'), 'older\n')
})

test('the log rotates by size and its tail reads across the files', (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, limit: 400, redact: windows, now: at })
  for (let index = 0; index < 40; index += 1) log.write('main', `line ${String(index)} C:\\Users\\测试 用户\n`)
  log.write('engine', 'partial')
  log.close()
  assert.deepEqual(readdirSync(dir).sort(), ['main.1.log', 'main.2.log', 'main.log'])
  for (const name of logNames()) assert.ok(readFileSync(join(dir, name)).length <= 400, name)
  const last = readFileSync(join(dir, 'main.log'), 'utf8').trim().split('\n').at(-1)
  assert.equal(last, '2026-10-28T08:00:00.000Z [engine] partial')
  const tail = log.tail(12)
  assert.equal(tail.length, 12)
  assert.equal(tail.at(-2), '2026-10-28T08:00:00.000Z [main] line 39 %USERPROFILE%')
  assert.ok(tail.every(line => !line.includes('测试')))
})

test('a log that cannot be written does not stop the app', (t) => {
  const dir = folder(t)
  const blocked = join(dir, 'file')
  writeFileSync(blocked, '')
  const log = new LogFile({ dir: join(blocked, 'logs'), now: at })
  log.write('main', 'lost\n')
  assert.deepEqual(log.tail(5), [])
  assert.equal(existsSync(join(blocked, 'logs')), false)
})

test('the console goes on as before and into the log', (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, redact: windows, now: at })
  const seen = []
  const stream = { write: (chunk) => { seen.push(String(chunk)); return true } }
  const raw = captureStdio(log, { stdout: stream })
  stream.write('hello sk-test-ok\n')
  stream.write(Buffer.from('bytes\n'))
  raw.stdout('only the console\n')
  log.close()
  assert.deepEqual(seen, ['hello sk-test-ok\n', 'bytes\n', 'only the console\n'])
  assert.equal(readFileSync(join(dir, 'main.log'), 'utf8'), '2026-10-28T08:00:00.000Z [main] hello sk-<hidden>\n2026-10-28T08:00:00.000Z [main] bytes\n')
})
