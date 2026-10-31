// Check a packaged app's update on throwaway folders. Windows and a Linux AppImage download and
// install a feed; macOS and a Linux deb read the latest release and open no browser.
// Usage: node scripts/check-update.mjs <app executable> <feed folder with latest.yml or latest-linux.yml> [--kill]
//        node scripts/check-update.mjs <app executable> <version> (macOS, a Linux deb)
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [executable, source, mode] = process.argv.slice(2)
const mac = process.platform === 'darwin'
// An AppImage updates itself, as on Windows; any other Linux executable (a deb's) only hears
// of the release, as on macOS.
const releasePage = mac || (process.platform === 'linux' && !executable?.endsWith('.AppImage'))
const manifest = process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
// The asset the fake release lists: what this install's update check waits for. The deb's file
// name uses the Debian architecture (x64 → amd64).
const asset = mac
  ? version => `DeepSeek-Bot-${version}-mac-${process.arch}.zip`
  : version => `DeepSeek-Bot-${version}-linux-${{ x64: 'amd64' }[process.arch] ?? process.arch}.deb`
if (!executable || !source || !existsSync(executable)
  || (releasePage ? mode !== undefined : !existsSync(join(source, manifest)))) {
  console.error(`check-update: usage: ${releasePage
    ? 'node scripts/check-update.mjs <app executable> <version>'
    : `node scripts/check-update.mjs <app executable> <feed folder with ${manifest}> [--kill]`}`)
  process.exit(2)
}
const version = releasePage ? source : /^version:\s*(\S+)/mu.exec(readFileSync(join(source, manifest), 'utf8'))?.[1]
const work = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
mkdirSync(join(work, 'home'))

const served = []
const server = createServer((request, response) => {
  if (releasePage) {
    const pathname = new URL(request.url, 'http://feed/').pathname
    if (request.method !== 'GET' || pathname !== '/') { response.writeHead(404).end(); return }
    served.push(pathname)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
      tag_name: `v${version}`,
      html_url: `https://github.com/Fei2411/DS-Bot/releases/tag/v${version}`,
      draft: false,
      prerelease: false,
      assets: [{ name: asset(version) }],
    }]))
    return
  }
  const name = basename(decodeURIComponent(new URL(request.url, 'http://feed/').pathname))
  const file = join(source, name)
  served.push(name)
  if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-length': statSync(file).size })
  createReadStream(file).pipe(response)
})
await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
const feed = `http://127.0.0.1:${String(server.address().port)}/`

// The tray's Quit ends the app. The check cannot click the tray icon, so it asks the browser
// target of the debugging port to close. Tray menu dispatch is covered by the main-process tests.
async function quitApp(port, waitForReady = false) {
  // Until the Host is ready only the start window is there (a file: page); the team window
  // loads the Host's address once the engine is up.
  const find = async () => {
    const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
    const pages = targets.filter(target => target.type === 'page' && (/^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url) || /\/src\/start\/start\.html\?start=/u.test(target.url)))
    return pages.find(target => target.url.startsWith('http:')) ?? (waitForReady ? undefined : pages[0])
  }
  let page = await find()
  for (const end = Date.now() + 120_000; page === undefined && waitForReady && Date.now() < end; page = await find()) await sleep(500)
  if (!page) throw new Error('the app window is not there')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  if (waitForReady) {
    const ready = await new Promise((done, reject) => {
      const timer = setTimeout(() => { reject(new Error('the app window did not finish booting')) }, 120_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else done(message.result?.result?.value === true)
      })
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: "new Promise(resolve => { const end = Date.now() + 120000; const check = () => { if (document.querySelector('.bt-tile, .bt-row')) resolve(true); else if (Date.now() >= end) resolve(false); else setTimeout(check, 250) }; check() })",
          returnByValue: true,
          awaitPromise: true,
        },
      }))
    })
    if (!ready) throw new Error('the app window did not finish booting')
  }
  socket.close()
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const browser = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    browser.addEventListener('open', done, { once: true })
    browser.addEventListener('error', reject, { once: true })
  })
  browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  browser.close()
}

// taskkill /T takes the Host and Electron's helpers along; a unix kill ends the tree's root,
// and the app's own children go with it.
function killApp() {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  else app?.kill()
}

let failed = false
let app
try {
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, { DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'), DS_BOT_UPDATE_URL: feed })
  const port = 9300 + Math.floor(Math.random() * 600)
  app = spawn(resolve(executable), [`--remote-debugging-port=${String(port)}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((done) => { app.once('exit', (code) => { done(code) }) })
  let output = ''
  for (const stream of [app.stdout, app.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
  }
  const updateLine = `DeepSeek Bot: update ${String(version)} ${releasePage ? 'available' : 'downloaded'}`
  const end = Date.now() + (releasePage ? 3 : 5) * 60_000
  while (!output.includes(updateLine)) {
    if (releasePage ? /DeepSeek Bot: update check failed/u.test(output) : /DeepSeek Bot: update failed/u.test(output)) {
      throw new Error('the app reported a failed update')
    }
    if (app.exitCode !== null) {
      const status = releasePage ? 'the update was found' : 'the update was downloaded'
      throw new Error(`the app exited (code ${String(app.exitCode)}) before ${status}`)
    }
    if (Date.now() > end) throw new Error(releasePage ? 'the update was not found within 3 minutes' : 'the update was not downloaded within 5 minutes')
    await sleep(500)
  }
  if (releasePage && !served.includes('/')) throw new Error('the release feed was not requested')
  console.log(`check-update: ${updateLine}; the feed served ${served.join(', ')}`)
  if (releasePage) {
    await quitApp(port, true)
    const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout')])
    if (code === 'timeout') throw new Error('the app did not exit after its window closed')
    if (code !== 0) throw new Error(`the app exited with code ${String(code)}`)
    console.log('check-update: the app quit without installing')
  } else if (mode === '--kill') {
    killApp()
    await exited
    console.log('check-update: ended the app, so nothing was installed')
  } else {
    await quitApp(port)
    const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout')])
    if (code === 'timeout') throw new Error('the app did not exit after its window closed')
    if (code !== 0) throw new Error(`the app exited with code ${String(code)}, so it does not install the update`)
    console.log('check-update: the app quit; its installer runs now')
  }
  console.log('check-update: passed')
} catch (error) {
  failed = true
  console.error(`check-update: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  if (app?.exitCode === null) killApp()
}
server.close()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
