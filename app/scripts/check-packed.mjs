// Check a packaged app: start it on throwaway folders with the ds-bot mock model, choose a model,
// send a message, wait for the reply, then close the window the way a user does and wait until
// the app has exited. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable] [screenshot.png]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, shotFile] = process.argv.slice(2)
const executable = given || packedExecutable()

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', 'DeepSeek Bot.exe')
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, 'DeepSeek Bot.app', 'Contents', 'MacOS', 'DeepSeek Bot')
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'ds-bot-packed-'))
mkdirSync(join(work, 'home'))
const children = []

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'ds-bot', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log') }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', (code) => { reject(new Error(`check-packed: the mock model stopped (exit ${String(code)})`)) })
  })
}

async function appPage(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => target.type === 'page' && target.url.startsWith('dsh-app://app'))
      if (page) return page
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    pending.set(id, { resolve: done, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call }
}

async function chat(cdp) {
  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const bubbles = "document.querySelectorAll('.dsb-flow .bt-bubble')"
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await until("document.querySelector('.bt-model-chip')", 'the model choice')
  await evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  await until(`${bubbles}.length > 1 && !document.querySelector('.dsb-pending')`, 'the greeting')
  const before = await evaluate(`${bubbles}.length`)
  await evaluate("document.querySelector('[data-composer-input]').focus()")
  await cdp.call('Input.insertText', { text: 'packaged app check' })
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  // The mock model starts its reply with 收到： and the message.
  await until(`${bubbles}.length > ${String(before)} && [...${bubbles}].some(node => node.textContent.includes('收到：packaged app check'))`, 'the reply')
  await sleep(1000)
  console.log(`check-packed: chat ${JSON.stringify(await evaluate("document.querySelector('.dsb-flow').innerText.slice(-200)"))}`)
}

let failed = false
const problems = []
try {
  const modelUrl = await startMock()
  const port = 9300 + Math.floor(Math.random() * 600)
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(executable, [`--remote-debugging-port=${String(port)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const chatError = await chat(cdp).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  // Closed like a user closes it, also after a failure, so that the app stops its Host. The page
  // goes away with the window, so this call gets no answer.
  void cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (chatError) throw chatError
  if (outcome === undefined) throw new Error('the app did not exit after its window closed')
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
}
for (const child of children) {
  if (child.exitCode !== null || child.signalCode !== null) continue
  // On Windows a plain kill ends only the main process; /T takes the Host and Electron's helpers along.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill()
}
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
