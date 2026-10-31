// The Host: the shell runs this file in Electron's Node mode. It boots the app's own `ds-bot` profile
// on a loopback port and reports the launch URL over IPC. With DS_BOT_CHECK, the path of a JSON list
// of Session ids, it boots the first-run check's profile instead and reports which of them it cannot read.
// Follows DeepSeek Harness apps/desktop-host/src/index.ts (MIT); see NOTICE.
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { loadLayeredEnv, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { writeAppPatch } from './app-patch.mjs'
import { CHECK_PROFILE, INSTALL_ANCHOR, loadAppProfile, loadCheckProfile, PROFILE } from './profile.mjs'
import { reconcileOfficeRuntime } from './office-patch.mjs'
import { reconcileSearchSelector } from './search-patch.mjs'
import { unreadableSessions } from './session-check.mjs'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

const send = (message) => new Promise((resolve, reject) => {
  if (!process.connected || process.send === undefined) { resolve(); return }
  process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
})

async function main() {
  const pnpm = process.argv[2]
  const check = process.env.DS_BOT_CHECK || undefined
  const profile = check === undefined ? loadAppProfile() : loadCheckProfile()
  reportSkippedBundles('dsh', profile)
  // The Office payload is the app's own, for the team profile; the first-run check reads
  // chats without it.
  const office = check === undefined ? reconcileOfficeRuntime(profile) : { patchFiles: [] }
  // ds-bot reads the payload's Node for the Office commands it runs itself.
  if (office.node !== undefined) process.env.DS_BOT_OFFICE_NODE = office.node
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: check === undefined ? PROFILE : CHECK_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles: check === undefined ? [...writeAppPatch(profile), ...reconcileSearchSelector(profile), ...office.patchFiles] : [],
    args: ['--no-open', '--port', process.env.DS_BOT_PORT || '0'],
    ...(pnpm === undefined ? {} : {
      packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  })
  let stopping
  const stop = () => stopping ??= (async () => {
    // A Host that failed to boot has nothing to shut down; the shell already has the failure.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message) => { if (message?.type === 'shutdown') void stop() })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  if (check !== undefined) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error(`The profile in ${profile.dir} does not store Sessions.`)
    await send({ type: 'checked', unreadable: await unreadableSessions(persistence, JSON.parse(readFileSync(check, 'utf8'))) })
    return
  }
  const [webServer, connection] = [ctx.get('webServer'), ctx.get('connection')]
  // A profile patch can turn these rows off; then the window has nothing to talk to.
  if (webServer === undefined || connection === undefined) throw new Error(`The profile in ${profile.dir} does not start the engine's web server and connection.`)
  const url = connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
  await send({ type: 'ready', url, injections: webServer.collectIndexInjections() })
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  await send({ type: 'fatal', message, diagnostic }).catch(() => undefined)
  if (process.connected) process.disconnect()
})
