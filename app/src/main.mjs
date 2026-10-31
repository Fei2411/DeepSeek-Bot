// Electron main process: a small start window while the app's own DSH Host boots, then one window
// for the Bot team. The team window loads the Host's loopback address as DSH Web does: DSH's
// sign-in sends the page's origin as the address the browser comes back to, and accepts only a
// loopback one. It loads hidden and shows once the team view is ready (start-window.mjs). Closing
// the team window hides it; the tray brings it back and its Quit ends the app (shell.mjs). Only
// what the start window and the tray need is imported up front; the rest loads once the start
// window is up (docs/plans/2026-10-26-start-window.md §11).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, shell as electronShell, systemPreferences, Tray, WebContentsView } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { canonicalExecPath } from './canonical-path.mjs'
import { hostPort } from './host-port.mjs'
import { captureStdio, LogFile } from './logs.mjs'
import { currentRootOf, driveOf, formatBytes, freeSpace, isEmptyTree, pickFrom, placeOf, rootOf } from './place.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { readStartFrame, writeStartFrame } from './start-frame.mjs'
import { explainOf, StartWindow } from './start-window.mjs'
import { langOf } from './start/text.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { CAPTION_HEIGHT, cssColor, micaAvailable, nativeThemeSource } from './window-frame.mjs'

const IPC = {
  caption: 'ds-bot:caption-colors', nativeTheme: 'ds-bot:native-theme', fullscreen: 'ds-bot:fullscreen',
  dataLocation: 'ds-bot:data-location', moveData: 'ds-bot:move-data', teamWorkspace: 'ds-bot:team-workspace',
  ready: 'ds-bot:ready', motion: 'ds-bot:motion',
  browserAcquire: 'ds-bot:browser-acquire', browserRelease: 'ds-bot:browser-release', browserForget: 'ds-bot:browser-forget',
  browserViewChanged: 'ds-bot:browser-view-changed', browserViewCreate: 'ds-bot:browser-view-create',
  browserViewSync: 'ds-bot:browser-view-sync', browserViewPlace: 'ds-bot:browser-view-place',
  browserViewNavigate: 'ds-bot:browser-view-navigate', browserViewCommand: 'ds-bot:browser-view-command',
  browserViewFocus: 'ds-bot:browser-view-focus', browserViewRead: 'ds-bot:browser-view-read',
  browserViewClose: 'ds-bot:browser-view-close', browserViewHold: 'ds-bot:browser-view-hold',
  browserImportSources: 'ds-bot:browser-import-sources', browserImportPick: 'ds-bot:browser-import-pick',
  browserImportLive: 'ds-bot:browser-import-live', browserImportApply: 'ds-bot:browser-import-apply',
  browserImportCancel: 'ds-bot:browser-import-cancel',
  appUpdateState: 'ds-bot:app-update-state', appUpdateCheck: 'ds-bot:app-update-check',
  appUpdateInstall: 'ds-bot:app-update-install', appUpdateOpen: 'ds-bot:app-update-open',
  appUpdateChanged: 'ds-bot:app-update-changed',
}
// A cookie export larger than this is not a cookie export.
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const MOVE_PROBLEMS = { drive: 'dialog.move.drive', nested: 'dialog.move.nested', workspace: 'dialog.move.workspace', program: 'dialog.move.inProgram', notEmpty: 'dialog.move.notEmpty' }
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000
// Under this, the start page notes the drive's free space for the first 10 s (onboarding §3).
const SHORT_DRIVE_BYTES = 5e9

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// The tray icon of this platform: Windows takes the .ico, macOS the template and its @2x,
// Linux the plain png.
const trayIconFile = () => join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
// Windows 11 draws Mica behind the page; mica.css lets it through the sidebar.
const mica = micaAvailable(process.platform, release())
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)
const frameFile = join(app.getPath('userData'), 'start-frame.json')

// Loaded once the start window is up (loadModules).
let BotBrowserGuests, partitionOf, BotViews, isBotId, importFromBrowser, listSources, applyCookies, CookieImports, parseCookieFile
let downloadSaver, chooseLocations, defaultPlaces, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx, HostProcess
let copySessions, findTeam, importTeam, teamInUse, userDshHome, copyData, moveProblem, CHECK_PROFILE, PROFILE
let watchReleases, watchUpdates, getDshRuntimeVersion, electronUpdater

let mainWindow
// Settles once the hidden team window exists.
let mainCreated
let startWindow
let logs
// Writers to the console that bypass the log: the Host's output goes into the log on its own.
let rawOutput
let host
// The Host's loopback origin, which the window loads.
let origin
let port
let hostStop
let updates
let updatesStarted = false
let stopping = false
let stopped = false
let failed = false
let places
// Which of the places this start made, so that 「换个位置…」 can take them away again.
let made = { dataDir: false, workspace: false, root: false }
// The folder picker of 「换个位置…」 is open, and the root it proposed on the 「会放在…」 card.
let picking = false
let proposed
// A retry or a start over is stopping the old engine: no second one starts meanwhile.
let restarting = false
// The first run's answer to the import; only the first boot copies.
let pendingImport
// Each boot of the engine; a retry starts a new one, and what an old one still reports is dropped.
let attempt = 0
// The Host answered and the window may talk to it without the launch URL.
let hostReady = false
// The Host's launch URL: the first window trades it for the Host's cookie.
let launchUrl
// The first load of the Host, which mints that cookie. It ends when the first load came
// through (true) or when it never did (false).
let bootstrap
// The launch URL is good for one use only: once a browser has carried it, no browser
// carries it again.
let tokenSpent = false
// The download handler of the app's session is bound once, not once per window.
let downloadsBound = false
// Quitting while a first-run dialog is open stops the first run, and during the copy (of the
// first run or of a data move) it waits for the copy to stop at a safe point, so that it leaves
// no half team and no temporary copy.
let choosing
let copying
const copyAbort = new AbortController()
let browserGuests
let botViews
let cookieImports

// The team window and the tray: closing the window hides it, the tray is the way back to it and
// the tray's Quit is the one ordinary way out. Until the hand-off the start window is the one
// showing, and the way back leads there.
const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => shellText(),
  trayImage: () => trayImage(),
  window: () => mainWindow,
  build: () => rebuildWindow(),
  reveal: (target) => {
    if (startWindow?.focus() || failed) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
  },
  quit: () => { app.quit() },
  busy: () => choosing !== undefined || copying !== undefined,
  // Before the first run has chosen its places there is no window to show, and before the
  // first load of the Host there is no address to load.
  ready: () => places !== undefined && origin !== undefined && bootstrap !== undefined,
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: (options) => dialog.showMessageBox(options) },
  // Without a tray the close asks whether the app should end.
  fallback: { show: (options) => dialog.showMessageBox(options) },
})
// The tray icon goes away with the app, and a late answer to the close notice hides nothing.
app.once('will-quit', () => { shell.dispose(); botViews?.dispose(); updates?.stop() })

// A packaged app started through an 8.3 short path or a junction restarts once on the
// canonical path: the lock below and every path the Host sees then agree with the long
// form, and the profile patch layer stops mixing the two.
const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  logs = new LogFile({ dir: join(app.getPath('userData'), 'logs') })
  rawOutput = captureStdio(logs)
  app.once('will-quit', () => { logs.flush() })
  console.log(`DeepSeek Bot ${app.getVersion()} (${process.platform} ${process.arch}), Electron ${process.versions.electron}`)
  startWindow = new StartWindow({
    electron: { BrowserWindow, ipcMain, screen, shell: electronShell, clipboard, nativeTheme, systemPreferences },
    page: join(here, 'start', 'start.html'), preload: join(here, 'preload.cjs'), icon: iconFile, mica, devTools: !app.isPackaged,
    // On Windows the locale is known only once the app is ready.
    lang: () => langOf(app.getLocale()), motion: readStartFrame(frameFile).motion,
    version: app.getVersion(), program: [dirname(process.execPath), process.resourcesPath, app.getAppPath()], log: logs, mainWindow: () => mainWindow,
    onRetry: () => { retry().catch(fail) },
    onReload: () => { mainWindow?.webContents.reload() },
    // Closing the start window before the hand-off quits: there is no team window yet to stay in
    // the tray with.
    onClose: () => { app.quit() },
    onPick: () => { changePlace().catch(fail) },
    onAnswer: (value) => { placeAnswer(value).catch(fail) },
  })
  // A second launch shows the window that is showing: the start window until the hand-off
  // (also after a failed start), then the team window, built anew when it is gone.
  app.on('second-instance', () => { if (!startWindow.focus()) shell.open() })
  app.on('before-quit', (event) => {
    if (choosing !== undefined) {
      // A first-run dialog is open: the quit waits for it, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      choosing.abort()
      return
    }
    if (copying !== undefined) {
      // A copy is under way: it stops at a safe point, and the app goes on meanwhile.
      event.preventDefault()
      shell.cancelQuit()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    // The app is on its way out: the window may close for good.
    shell.beginQuit()
    if (stopped || host === undefined) return
    event.preventDefault()
    // The Host is already stopping: the quit follows it.
    if (stopping) { void (hostStop ?? Promise.resolve()).then(() => { app.quit() }); return }
    void stopHost().then(() => { app.quit() })
  })
  app.whenReady().then(async () => { shell.install(); await start() }).catch(fail)
}

function stopHost() {
  stopping = true
  hostStop ??= (host?.stop() ?? Promise.resolve()).catch((error) => { console.error(error) }).finally(() => { stopped = true })
  return hostStop
}

// A throwaway run (DS_BOT_HOME) asks nothing and shows what a later start shows.
const startKind = () => (process.env.DS_BOT_HOME || existsSync(join(app.getPath('userData'), 'locations.json')) ? 'later' : 'first')

async function start() {
  setMenu()
  nativeTheme.themeSource = readStartFrame(frameFile).themeSource
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  await prepare()
  run()
}

// What the boot needs; a retry after a failure here does what is still missing.
async function prepare() {
  // Before the windows: the team window's page is told the Host's origin.
  if (port === undefined) {
    port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
    origin = `http://127.0.0.1:${String(port)}`
  }
  startWindow.open(startKind())
  if (browserGuests === undefined) {
    await loadModules()
    handleIpc()
  }
  // The team window is made once the start window has painted, already on its final rect, and
  // made again when it is gone for good (a cancelled shutdown kept the app without one), so
  // that the next engine has a window to load into.
  if (mainCreated === undefined || (await mainCreated, mainWindow === undefined)) mainCreated = startWindow.painted.then(createWindow)
}

async function loadModules() {
  const [browser, views, sources, cookies, cookieFiles, downloads, firstRun, hostProcess, imports, moves, profile, updatesModule, boot, updater] = await Promise.all([
    import('./bot-browser.mjs'), import('./bot-views.mjs'), import('./browser-sources.mjs'), import('./cookie-import.mjs'),
    import('./cookie-parse.mjs'), import('./downloads.mjs'), import('./first-run.mjs'), import('./host-process.mjs'),
    import('./import.mjs'), import('./move-data.mjs'), import('./profile.mjs'), import('./updates.mjs'),
    import('@deepseek-ai/dsh-app-boot'), import('electron-updater'),
  ])
  ;({ BotBrowserGuests, partitionOf } = browser)
  ;({ BotViews, isBotId } = views)
  ;({ importFromBrowser, listSources } = sources)
  ;({ applyCookies, CookieImports } = cookies)
  ;({ parseCookieFile } = cookieFiles)
  ;({ downloadSaver } = downloads)
  ;({ chooseLocations, defaultPlaces, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx } = firstRun)
  ;({ HostProcess } = hostProcess)
  ;({ copySessions, findTeam, importTeam, teamInUse, userDshHome } = imports)
  ;({ copyData, moveProblem } = moves)
  ;({ CHECK_PROFILE, PROFILE } = profile)
  ;({ watchReleases, watchUpdates } = updatesModule)
  ;({ getDshRuntimeVersion } = boot)
  electronUpdater = updater.default
  browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
  botViews = new BotViews({
    window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
    statePath: join(app.getPath('userData'), 'bot-views.json'),
    onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
  })
  cookieImports = new CookieImports()
}

function run() {
  const mine = (attempt += 1)
  boot(mine).catch((error) => { if (mine === attempt) void fail(error) })
}

// The engine starts again after a failure or the 180 s question; the places stay. A first run's
// copy goes on to its end first: an engine started beside it would run on a half-copied team.
async function retry() {
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    await copying?.catch(() => {})
    if (copyAbort.signal.aborted || stopping || mine !== attempt) return
    await stopOld()
    if (stopping || mine !== attempt) return
    await prepare()
  } finally {
    restarting = false
  }
  if (!stopping && mine === attempt) run()
}

// The handshake of the Host that goes: a window rebuilt before the next engine answers must not
// load against a Host that is stopped, nor take its cookie for the new one's.
function forgetHost() {
  hostReady = false
  bootstrap = undefined
}

// The Host stays known while it stops, so that a quit meanwhile waits for it.
async function stopOld(options) {
  const old = host
  if (old === undefined) return
  await old.stop(options).catch((error) => { console.error(error) })
  if (host === old) host = undefined
}

// The dialogs of the first run belong to the start window and stop its clock.
const ui = () => ({ owner: () => startWindow.owner(), asking: answer => startWindow.asking(answer) })

// The data folder (with the first run's question on a first start), the engine, then the team
// view in the hidden team window.
async function boot(mine) {
  if (places === undefined) {
    const first = startWindow.kind === 'first'
    if (first) {
      const teams = teamsAt()
      startWindow.explain(explainOf(teams))
      // A reinstall goes on with its data where it is; a new or copied team can still move.
      if (teams.team === undefined) tellPlace(defaultPlaces().dataDir)
    }
    choosing = new AbortController()
    const where = await chooseLocations(choosing.signal, ui()).finally(() => { choosing = undefined })
    if (where.quit) { app.exit(0); return }
    setPlaces({ dataDir: where.dataDir, workspace: where.workspace })
    pendingImport = where.import
    if (first) startWindow.explain(explainOf({ offered: where.offered === true, team: teamIn(where.dataDir) }))
  }
  // Also the check that the data folder can be written.
  mkdirSync(profileDir(), { recursive: true })
  startWindow.done('data')
  const engine = await startEngine(mine)
  if (engine === undefined || mine !== attempt) return
  startWindow.done('engine')
  await mainCreated
  if (mine !== attempt || mainWindow === undefined) return
  startWindow.teamLoading()
  // The launch URL trades its token for the Host's cookie and goes on to the page. The cookie
  // is there once that load came through. The token is good for one browser only: it is spent
  // as soon as a window carries it. Each engine has a token of its own.
  const win = mainWindow
  launchUrl = engine.url
  tokenSpent = true
  hostReady = false
  bootstrap = win.loadURL(engine.url).then(() => {
    if (mine === attempt) hostReady = true
    return true
  }).catch(() => false)
}

function setPlaces(next) {
  places = next
  const root = currentRootOf(places.dataDir, places.workspace)
  made = { dataDir: !existsSync(places.dataDir), workspace: places.workspace !== undefined && !existsSync(places.workspace), root: root !== undefined && !existsSync(root) }
}

// The line on the start page that says where the data goes and how much room is there, and the
// short drive's note for the first 10 s (start-window §2, §4).
function tellPlace(dataDir) {
  const free = freeSpace(dataDir)
  startWindow.place(placeOf(dataDir, { free }))
  const drive = driveOf(dataDir)
  startWindow.hint(drive !== undefined && free !== undefined && free < SHORT_DRIVE_BYTES ? { drive, free: formatBytes(free) } : undefined)
}

// 「换个位置…」 on the start page and 〔重新选〕 on its cards: the system picker, then the root rule
// (windows-onboarding §3, 一个位置). The root is used at once when it is the folder picked; a
// layer the app added is confirmed on the 「会放在…」 card; a place that cannot be used says why.
// A cancelled picker leaves things as they were: the line, or the card it came from. Not during
// the first run's copy, whose team would be left behind.
async function changePlace() {
  if (startWindow.kind !== 'first' || places === undefined || choosing !== undefined || copying !== undefined || picking || restarting || stopping || failed) return
  picking = true
  try {
    // One wait for the picker and what follows it: a team view that becomes ready meanwhile
    // hands over only once the start knows where it goes on.
    await startWindow.asking(pickAndPlace())
  } finally {
    picking = false
  }
}

// A cancelled picker, or the place the data is in now, is no change: the line stays, and a card
// that led here goes, since the start goes on where it was.
async function pickAndPlace() {
  const picked = await pickRoot(pickFrom(places.dataDir), copyAbort.signal, ui())
  if (stopping || startWindow.owner() === undefined) return
  const root = picked === undefined ? { same: true } : rootOf(picked, { dshHome: userDshHome(), program: app.isPackaged ? programFolder() : undefined, current: places })
  if (root.same) {
    proposed = undefined
    startWindow.card(undefined)
    return
  }
  if (root.reason !== undefined) {
    console.log(`DeepSeek Bot: the place ${root.at} cannot be used (${root.reason})`)
    proposed = undefined
    startWindow.card({ kind: 'rejected', reason: root.reason, path: root.at })
    return
  }
  if (root.added) {
    proposed = root
    startWindow.card({ kind: 'picked', path: root.root })
    return
  }
  await startOver(root)
}

async function placeAnswer(value) {
  if (value !== 'use' || proposed === undefined || picking || restarting) return
  const root = proposed
  proposed = undefined
  await startOver(root)
}

// The start begins again in the root R (start-window §7): the whale sinks at once, the engine
// that may be up on the default folder stops, what this start made there goes, and the boot runs
// again. The places are saved at once: the import question has been answered by now.
async function startOver(root) {
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    // restart() also takes the card away, without letting a held hand-off of the old engine go;
    // the line names the new place from here on. The Host on the old folder is ended at once:
    // neither its boot nor an orderly shutdown of a folder about to go is of any use, and either
    // would keep the whale under water for up to 10 s.
    startWindow.restart()
    tellPlace(root.dataDir)
    await stopOld({ now: true })
    if (stopping || mine !== attempt) return
    await removeMade()
    if (stopping || mine !== attempt) return
    setPlaces({ dataDir: root.dataDir, workspace: root.workspace })
    saveLocations(places)
    console.log(`DeepSeek Bot: the data goes to ${places.dataDir}`)
  } finally {
    restarting = false
  }
  run()
}

// What this start made at the place it leaves: the data folder it created (the engine may have
// put a blank team there), the team workspace while nothing has been written into it, and the
// root above them once it is empty.
async function removeMade() {
  const gone = []
  if (made.dataDir && existsSync(places.dataDir)) gone.push(places.dataDir)
  if (made.workspace && existsSync(places.workspace) && isEmptyTree(places.workspace)) gone.push(places.workspace)
  for (const folder of gone) await rm(folder, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  const root = currentRootOf(places.dataDir, places.workspace)
  if (made.root && root !== undefined && existsSync(root) && isEmptyTree(root)) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
}

const profileDir = () => join(places.dataDir, 'profiles', PROFILE)
const pnpmEntry = () => join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const hostOutput = (stream, chunk) => {
  logs.write('engine', chunk)
  rawOutput[stream](chunk)
}

function newHost() {
  // A Host of an attempt that a retry has replaced no longer stands for the start.
  const mine = attempt
  return new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir(),
    env: { ...process.env, DSH_HOME: places.dataDir, DS_BOT_PORT: String(port), DS_BOT_APP: '1', DS_BOT_USER_DSH_HOME: userDshHome(), DS_BOT_RUNTIME_DIR: app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime'), ...(places.workspace ? { DS_BOT_WORKSPACE: places.workspace } : {}) },
    pnpm: pnpmEntry(),
    onFailure: (error) => { if (mine === attempt) void fail(error) },
    output: hostOutput,
  })
}

// A failed check is not a failed start: start() rejects, and the copy goes on unchecked.
function newCheck(home, list) {
  const cwd = join(home, 'profiles', CHECK_PROFILE)
  mkdirSync(cwd, { recursive: true })
  return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list }, pnpm: pnpmEntry(), onFailure: () => {}, output: hostOutput })
}

/**
 * @returns {Promise<{ url: string } | undefined>} the Host's launch URL; none when the app quits
 *   during the copy, or when a retry during the copy starts the engine itself
 */
async function startEngine(mine) {
  if (pendingImport !== undefined) {
    const where = { ...places, import: pendingImport }
    pendingImport = undefined
    // The team is about to live here; moving it is Settings' job (the data move).
    startWindow.place(undefined)
    // The copy's time is not the engine's: the start's clock stands still, and the 180 s
    // question with it.
    copying = startWindow.asking(copyTeam(where, copyAbort.signal))
    const copied = await copying
    copying = undefined
    if (copied === 'quit') app.exit(0)
    if (copied !== undefined || mine !== attempt) return undefined
  }
  // Not during the import, which a restart would cut short; before the Host, so that an
  // update can still come when this version's Host does not start.
  if (!updatesStarted) {
    updatesStarted = true
    updates = startUpdates()
    updates?.subscribe((state) => { mainWindow?.webContents.send(IPC.appUpdateChanged, state) })
  }
  host = newHost()
  host.onMessage(message => {
    if (message?.type !== 'ds-bot:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
    const downloadRoots = message.downloadRoots
    if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
      return
    }
    void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, url })
    }).catch(() => host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
  })
  return host.start()
}

function handleIpc() {
  // A throwaway run (DS_BOT_HOME) keeps its folders where it was told.
  const fixed = Boolean(process.env.DS_BOT_HOME)
  // The team view has mounted (ds-bot calls dsBotApp.ready()): the start window hands over.
  ipcMain.on(IPC.ready, (event) => { if (fromWindow(event)) startWindow.ready() })
  // The start window takes the app's theme and the Bot animation tier at the next start, before
  // the team view has loaded; Mica and the caption buttons follow the theme at once.
  ipcMain.on(IPC.nativeTheme, (event, source) => {
    const value = nativeThemeSource(source)
    if (!fromWindow(event) || value === undefined) return
    nativeTheme.themeSource = value
    writeStartFrame(frameFile, { themeSource: value })
  })
  ipcMain.on(IPC.motion, (event, tier) => { if (fromWindow(event)) writeStartFrame(frameFile, { motion: tier }) })
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  // ds-bot's Bot browsers: one webview per lease, in the storage of the Bot's key.
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  // Cookie imports: a file or an installed browser's profile is parsed or harvested into a
  // pending set first; only apply (the user's confirm) writes into the Bot's partition.
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Cookie files', extensions: ['txt', 'json', 'cookies'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    const buffer = await readFile(picked.filePaths[0])
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(picked.filePaths[0]) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('DeepSeek Bot: an unknown browser profile')
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error('DeepSeek Bot: a Bot storage key is required')
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error('DeepSeek Bot: this import is no longer pending')
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  // The app's own update state, for the About row. `updates` exists once the engine's first
  // start created it; before that (and in runs without an updater) the state is null.
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await updates.install()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
    const state = updates?.state()
    if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
      void electronShell.openExternal(state.page)
    }
  })
  // The plugin keeps the team workspace; the app remembers it for its own checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
  })
  if (process.platform === 'win32') {
    // Windows ignores the alpha of the caption buttons' color, so they take the opaque color
    // of the surface under them, which the page measures.
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }
}

// The window that a dialog belongs to: the start window while it shows, then the team window.
const owner = () => startWindow.owner() ?? mainWindow
const setProgress = (value) => { owner()?.setProgressBar(value) }

// The Host starts once on the new data location first: DSH then sets up its project list
// without the copied Sessions' folders, so the old team's folders are not offered as projects.
// Before that, the app's own DSH reads every chat of the team once: a newer DSH can write
// records that this one refuses while the log format stays the same. Such a chat stops the
// copy, as a newer log format does; 'quit' means the user updates DeepSeek Bot first, and
// 'stopped' that the app quit during the copy.
async function copyTeam(where, signal) {
  const unreadable = await checkTeam(where, signal)
  if (signal.aborted) return 'stopped'
  if (unreadable > 0) {
    const { response } = await startWindow.asking(dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', noLink: true, message: tx('dialog.import.newer', { n: unreadable }), buttons: [tx('btn.quit'), tx('btn.startWithout')], defaultId: 0, cancelId: 0, signal }))
    if (signal.aborted) return 'stopped'
    if (response === 0) return 'quit'
    saveLocations(where)
    return undefined
  }
  const warm = newHost()
  host = warm
  const stopWarm = () => { void warm.stop() }
  signal.addEventListener('abort', stopWarm, { once: true })
  try {
    await warm.start()
    if (signal.aborted) return 'stopped'
    setProgress(2)
    await warm.stop()
    host = undefined
    const summary = await importTeam({ ...where.import, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), signal })
    console.log(`DeepSeek Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
  } catch (error) {
    if (signal.aborted) return 'stopped'
    console.error(error)
    await startWindow.asking(dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: tx('dialog.import.failed', { message: error instanceof Error ? error.message : String(error) }), signal }))
    if (signal.aborted) return 'stopped'
  } finally {
    signal.removeEventListener('abort', stopWarm)
    setProgress(-1)
  }
  saveLocations(where)
  return undefined
}

// A copy of the chats in a DSH home of its own, so that nothing of the check stays in the data.
async function checkTeam(where, signal) {
  // A run that was killed can leave its temporary check home behind.
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(where.import.from)
    const ids = found === undefined ? [] : await copySessions(where.import.from, found.team, home, signal)
    if (ids.length === 0) return 0
    setProgress(2)
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(ids))
    const check = newCheck(home, list)
    const stop = () => { void check.stop() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const { unreadable } = await check.start()
      if (unreadable.length > 0) console.warn(`DeepSeek Bot: this DSH cannot read ${unreadable.join(', ')}`)
      return unreadable.length
    } finally {
      signal.removeEventListener('abort', stop)
      await check.stop()
    }
  } catch (error) {
    if (!signal.aborted) console.error('DeepSeek Bot: the chats were not checked before the copy:', error)
    return 0
  } finally {
    setProgress(-1)
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (copying !== undefined || stopping || mainWindow === undefined) return false
  const { canceled, filePaths } = await dialog.showOpenDialog(owner(), { title: tx('dialog.pickMove'), defaultPath: dirname(places.dataDir), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  if (canceled || filePaths[0] === undefined) return false
  const to = resolve(filePaths[0])
  const dshHome = userDshHome()
  // The team workspace can move while a dialog is open; the window tells the latest one.
  const refused = async () => {
    for (const current of new Set([workspace, places.workspace])) {
      const problem = moveProblem({ from: places.dataDir, to, workspace: current, dshHome, program: app.isPackaged ? programFolder() : undefined })
      if (problem === undefined) continue
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: problem === 'dsh' ? tx('dialog.move.inDsh', { home: dshHome }) : tx(MOVE_PROBLEMS[problem]), buttons: [tx('btn.ok')] })
      return true
    }
    return false
  }
  if (await refused()) return false
  const { response } = await dialog.showMessageBox(owner(), { type: 'question', title: 'DeepSeek Bot', noLink: true, message: tx('dialog.move.confirm', { to }), detail: tx('dialog.move.detail', { from: places.dataDir }), buttons: [tx('btn.move'), tx('btn.cancel')], defaultId: 0, cancelId: 1 })
  if (response !== 0 || stopping || await refused()) return false
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the team workspace from here on; the
    // start window shows the move meanwhile.
    void mainWindow?.loadURL('about:blank').catch(() => {})
    mainWindow?.hide()
    startWindow.open('moving')
    await stopHost()
    // The app may have heard of a team workspace change while the Host stopped.
    if (await refused()) {
      app.relaunch()
      return
    }
    // Another DSH on the same data would go on writing while the copy is made.
    if (teamInUse(places.dataDir)) {
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: tx('dialog.move.inUse') })
      app.relaunch()
      return
    }
    setProgress(2)
    try {
      await copyData(places.dataDir, to, signal)
      try {
        saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
      } catch (error) {
        // Unused, the copy would only keep the folder from being chosen again.
        await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
        throw error
      }
    } catch (error) {
      if (signal.aborted) return
      console.error(error)
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: tx('dialog.move.failed', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setProgress(-1)
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
  return true
}

// Windows and a Linux AppImage update themselves; macOS and a Linux deb ask to download the new
// version. Throwaway runs check only a given feed and never ask.
function startUpdates() {
  const feed = process.env.DS_BOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
      asset: version => `DeepSeek-Bot-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    // The update ends the app: the window closes for good, and the Host stops before the
    // installer replaces its files.
    return watchUpdates({
      updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : (version) => restartPrompt.prompt(version),
      beforeInstall: () => { shell.beginQuit(); return stopHost() },
    })
  }
  return undefined
}

// A prompt that belongs to a window is not asked while the window is hidden or minimized: it
// waits for the window to be on the screen again.
function windowShown() {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}

// The update questions wait for the team window: the start window goes at the hand-off, and a
// question on it would go with it. After a failed start, fail() takes the update over.
const afterHandoff = async () => { await startWindow.teamShown; return !failed }

async function askRestartNow(version) {
  if (failed || !await afterHandoff()) return false
  const { response } = await dialog.showMessageBox(owner(), { type: 'info', title: 'DeepSeek Bot', message: tx('dialog.update.ready', { version }), detail: tx('dialog.update.readyDetail'), buttons: [tx('btn.restart'), tx('btn.notNowRestart')], defaultId: 0, cancelId: 1, noLink: true })
  return response === 0
}

async function askDownloadNow(version) {
  if (failed || !await afterHandoff()) return false
  const { response } = await dialog.showMessageBox(owner(), { type: 'info', title: 'DeepSeek Bot', message: tx('dialog.update.available', { version }), detail: tx('dialog.update.availableDetail'), buttons: [tx('btn.download'), tx('btn.notNowDownload')], defaultId: 0, cancelId: 1, noLink: true })
  return response === 0
}

// What the updater does when the user says yes. The answer may come later, when the window
// is shown again; then the work is done here.
async function installUpdate() { await updates?.install() }

async function openUpdatePage() {
  const state = updates?.state()
  if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
    await electronShell.openExternal(state.page)
  }
}

const restartPrompt = createDeferredPrompt({ ask: askRestartNow, shown: windowShown, onYes: installUpdate })
const downloadPrompt = createDeferredPrompt({ ask: askDownloadNow, shown: windowShown, onYes: openUpdatePage })

async function flushDeferredUpdate() {
  await restartPrompt.flush()
  await downloadPrompt.flush()
}

// Hidden, on the rect the start window grows into; the start window shows it at the hand-off.
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win32 = process.platform === 'win32'
  const win = new BrowserWindow({
    // The window never squeezes the chat: RAIL_WIDTH + MIN_CHAT from ds-bot's
    // src/client/frame-layout.js is the avatar rail plus the smallest chat column.
    ...startWindow.mainBounds(), minWidth: 508, minHeight: 480,
    title: 'DeepSeek Bot', show: false, icon: iconFile,
    backgroundColor: mica ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the caption buttons overlay the page's band. They keep the
    // sidebar's colors until the page sends the colors of the surface under them.
    ...(win32 ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: CAPTION_HEIGHT, color: dark ? '#1b1b1c' : '#f9fafb', symbolColor: dark ? '#f9fafb' : '#0f1115' },
      ...(mica ? { backgroundMaterial: 'mica' } : {}),
    } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-bot-origin=${origin}`, ...(win32 ? [`--ds-bot-caption=${String(CAPTION_HEIGHT)}`, ...(mica ? ['--ds-bot-mica'] : [])] : [])],
    },
  })
  mainWindow = win
  startWindow.placeMain(win)
  // No ready-to-show here: the first window shows at the hand-off (start-window.mjs), a window
  // built anew when the shell opens it.
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = undefined
    // The Bot browsers' tabs belonged to this window; they wait for the next one.
    botViews.release()
  })
  // The window hides instead of closing; the shell decides when it really goes.
  shell.watch(win)
  browserGuests.bind(win)
  // The tabs that outlived the last window join this one.
  botViews.attach(win)
  const contents = win.webContents
  // The session is the same for every window of the app, so the handler is bound once.
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({ window: () => mainWindow, dialog, getPath: name => app.getPath(name) }))
  }
  if (win32) {
    // Fullscreen hides the caption buttons, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  if (mica) {
    const css = readFileSync(join(here, 'mica.css'), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(fonts) })
  contents.setWindowOpenHandler(({ url }) => {
    // DSH's sign-in opens a blank window during the click and sends it to the sign-in page later.
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  // The window that is shown again asks for the update that waited for it. A window that was
  // minimized asks for it when it comes back.
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  return win
}

// The window is gone for good: a new one takes its place and talks to the Host that runs.
function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch((error) => { console.error(error) })
  return win
}

// The window talks to the Host that runs. The first one trades the launch URL for the Host's
// cookie; the later ones use the plain address, which that cookie carries. The launch URL is
// used again only when no browser carried it at all, so that a token is never spent twice.
async function connectHost(win) {
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load of the Host decides how this window comes in.
  if (bootstrap !== undefined) await bootstrap
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  // The first load never came through. The cookie may be there anyway: it belongs to the
  // session of the browser, which outlives the window.
  if (await hostCookie()) {
    hostReady = true
    await win.loadURL(`${origin}/`)
    return
  }
  // There is no cookie: the launch URL is the one way in, and only while it was not used.
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    await win.loadURL(launchUrl)
    hostReady = true
    return
  }
  await win.loadURL(`${origin}/`)
}

// The Host's cookie: the launch URL trades its token for it. The app does not need to know
// its name, only whether the browser holds one for the Host's address.
async function hostCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${origin}/` })
    return cookies.length > 0
  } catch (error) {
    console.error(error)
    return false
  }
}

// The mark of the tray: the file of this platform, and on macOS the template that follows the
// colour of the menu bar.
function trayImage() {
  const file = trayIconFile()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
  if (process.platform === 'darwin') {
    const retina = nativeImage.createFromPath(join(assets, 'trayTemplate@2x.png'))
    const size = retina.getSize()
    if (!retina.isEmpty() && size.width > image.getSize().width) {
      image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG(), width: size.width, height: size.height })
    }
    image.setTemplateImage(true)
  }
  return image
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const t = shellText()
  // The application menu of macOS, without its Quit: the tray's Quit is the one ordinary way
  // out. Only when the tray is not there does the menu carry one, so that the app can still
  // be ended.
  const items = [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
  ]
  if (!shell.hasTray()) {
    items.push({ type: 'separator' }, { label: t.quit, click: () => { shell.quit() } })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: items },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
}

// The tray's and the menu's copy, in the app's language. On Windows the locale is known only once
// the app is ready.
function shellText() {
  return SHELL_TEXT[langOf(app.getLocale())]
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error('DeepSeek Bot: rejected IPC from an unknown page')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void electronShell.openExternal(url)
}

// The start window shows the failure page and stays. A new version may fix what keeps this one
// from starting; until the page has its update row, a box on it says what comes: the release
// page opens (macOS, a Linux deb), or the version that installs itself does so once it is
// downloaded, unless the user has tried again meanwhile.
async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const mine = attempt
  startWindow.fail(error, startKind())
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  if (!found || mine !== attempt) return
  await dialog.showMessageBox(owner(), { type: 'info', title: 'DeepSeek Bot', message: tx(found.page ? 'dialog.update.onFailurePage' : 'dialog.update.onFailure', { version: found.version }) })
  if (found.page) {
    if (!process.env.DS_BOT_HOME) await electronShell.openExternal(found.page)
    return
  }
  if (await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS).then(() => false)]) && failed && mine === attempt) await updates.install()
}
