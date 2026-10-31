import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readStartFrame, writeStartFrame } from '../src/start-frame.mjs'
import {
  acceptsAct, centred, clampInto, clockMs, cubicBezier, detailsText, explainOf, failureReason, fallbackMs, GROWTH, GROWTH_EASING,
  growthSteps, isStartPage, MAIN_SIZE, mainRect, START_ACT, START_ACTS, START_STATE, startSize, startSnapshot, startUrl, StartWindow,
  TEAM_VIEW_MS, WATCHDOG_MS,
} from '../src/start-window.mjs'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

test('the start window is 720 × 540, and 720 × 500 on a work area under 588 high', () => {
  assert.deepEqual(startSize(AREA), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 588 }), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 587 }), { width: 720, height: 500 })
})

test('the start window is centred on the work area under the cursor', () => {
  assert.deepEqual(centred(startSize(AREA), AREA), { x: 600, y: 250, width: 720, height: 540 })
  // A second display left of the first, below a taskbar at the top.
  assert.deepEqual(centred({ width: 720, height: 540 }, { x: -1280, y: 40, width: 1280, height: 984 }), { x: -1000, y: 262, width: 720, height: 540 })
})

test('the team window is centred on the start window and stays inside the work area', () => {
  const start = centred(startSize(AREA), AREA)
  assert.deepEqual(mainRect(start, AREA), { x: 300, y: 90, ...MAIN_SIZE })
  // Dragged to the top left corner: the team window keeps to the work area.
  assert.deepEqual(mainRect({ x: 10, y: 5, width: 720, height: 540 }, AREA), { x: 0, y: 0, ...MAIN_SIZE })
  assert.deepEqual(mainRect({ x: 1190, y: 495, width: 720, height: 540 }, AREA), { x: 600, y: 180, ...MAIN_SIZE })
  // A laptop's work area smaller than the team window: it fills the work area.
  assert.deepEqual(mainRect({ x: 323, y: 94, width: 720, height: 540 }, { x: 0, y: 0, width: 1366, height: 728 }), { x: 23, y: 0, width: 1320, height: 728 })
  assert.deepEqual(clampInto({ x: -50, y: 900, width: 2000, height: 300 }, AREA), { x: 0, y: 740, width: 1920, height: 300 })
})

test('the easing is CSS cubic-bezier()', () => {
  const ease = cubicBezier(0.25, 0.1, 0.25, 1)
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3)
  assert.equal(GROWTH_EASING(0), 0)
  assert.equal(GROWTH_EASING(1), 1)
  let previous = 0
  for (let step = 1; step <= 100; step += 1) {
    const value = GROWTH_EASING(step / 100)
    assert.ok(value >= previous && value <= 1, `at ${String(step)}%`)
    previous = value
  }
  // cubic-bezier(.2, .7, .2, 1) is quick at first: most of the way in the first half.
  assert.ok(GROWTH_EASING(0.5) > 0.9)
})

test('the start window grows into the team window in about 14 ms steps over 300 ms', () => {
  const from = centred(startSize(AREA), AREA)
  const to = mainRect(from, AREA)
  const steps = growthSteps(from, to)
  assert.equal(GROWTH.duration, 300)
  assert.equal(GROWTH.delay, 160)
  assert.equal(steps.length, 22)
  assert.deepEqual(steps.at(-1), { at: 300, rect: to })
  assert.ok(steps.every((step, index) => index === 0 || step.at > steps[index - 1].at))
  assert.ok(steps.slice(0, -1).every(step => step.at % 14 === 0))
  for (const key of ['x', 'y', 'width', 'height']) {
    const toward = Math.sign(to[key] - from[key])
    let previous = from[key]
    for (const { rect } of steps) {
      assert.ok((rect[key] - previous) * toward >= 0, `${key} turns back`)
      previous = rect[key]
    }
  }
  // At least one size between the two: a growth, not a jump.
  assert.ok(steps.some(({ rect }) => rect.width > from.width && rect.width < to.width))
  // The same rects from wherever the start window was dragged to.
  const dragged = { x: 40, y: 30, width: 720, height: 540 }
  assert.deepEqual(growthSteps(dragged, mainRect(dragged, AREA)).at(-1).rect, { x: 0, y: 0, ...MAIN_SIZE })
})

test('the team window shows by itself after 2.5 s on a first start or a celebration, else 0.8 s', () => {
  assert.equal(fallbackMs({ start: 'first', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'first', celebrate: false }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: false }), 800)
})

test('a failure gets one of the five reasons of the failure page', () => {
  const coded = (code, message) => Object.assign(new Error(message), { code })
  assert.equal(failureReason(coded('EACCES', 'EACCES: permission denied, mkdir \'D:\\data\\profiles\'')), 'permission')
  assert.equal(failureReason(new Error('EPERM: operation not permitted, open \'x\'')), 'permission')
  assert.equal(failureReason(coded('ENOSPC', 'ENOSPC: no space left on device, write')), 'space')
  assert.equal(failureReason(new Error('There is not enough space on the disk.')), 'space')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: Cannot find module \'@deepseek-ai/dsh-base\'')), 'files')
  assert.equal(failureReason(new Error('The app could not load its own bundles:\nds-bot: missing')), 'files')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: EACCES: permission denied, open \'state.json\'')), 'permission')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 3221225477)')), 'engine')
  assert.equal(failureReason(new Error('The profile in D:\\x does not start the engine\'s web server and connection.')), 'engine')
  assert.equal(failureReason(new Error('DeepSeek Bot: no free port on 127.0.0.1')), 'other')
  assert.equal(failureReason('a string'), 'other')
  assert.equal(failureReason(undefined), 'other')
})

test('only a missing file of the app\'s own says that the install is incomplete', () => {
  const program = join(tmpdir(), 'DeepSeek Bot')
  const where = { program: [join(tmpdir(), 'electron'), program] }
  const missing = (path, message) => Object.assign(new Error(message), { code: 'ENOENT', path })
  const exe = join(program, 'DeepSeek Bot.exe')
  assert.equal(failureReason(missing(exe, `spawn ${exe} ENOENT`), where), 'files')
  assert.equal(failureReason(missing(exe, `spawn ${exe} ENOENT`)), 'other')
  // A saved data folder on a drive that is gone.
  const data = join(tmpdir(), 'gone', 'DeepSeek Bot', 'data', 'profiles', 'ds-bot')
  assert.equal(failureReason(missing(data, `ENOENT: no such file or directory, mkdir '${data}'`), where), 'other')
  // A Host that stopped: its error output names the missing file.
  const bundle = join(program, 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'index.js')
  assert.equal(failureReason(new Error(`The DSH Host stopped (exit 1):\nError: ENOENT: no such file or directory, open '${bundle}'`), where), 'files')
  assert.equal(failureReason(new Error(`The DSH Host stopped (exit 1):\nError: ENOENT: no such file or directory, open '${join(data, 'state.json')}'`), where), 'engine')
})

test('the main process takes only its own acts, each in its own views', () => {
  assert.deepEqual([...START_ACTS].sort(), ['answer', 'copyDetails', 'handoffDone', 'handoffShow', 'openLogs', 'pick', 'reloadView', 'retry', 'wait'])
  assert.equal(acceptsAct('handoffShow', 'handoff'), true)
  // 「换个位置…」 while the start boots and 〔重新选〕 on its cards; a card's answer only on a card.
  assert.equal(acceptsAct('pick', 'boot'), true)
  assert.equal(acceptsAct('pick', 'card'), true)
  assert.equal(acceptsAct('pick', 'watchdog'), true)
  assert.equal(acceptsAct('pick', 'failed'), false)
  assert.equal(acceptsAct('pick', 'viewFailed'), false)
  assert.equal(acceptsAct('answer', 'card'), true)
  assert.equal(acceptsAct('answer', 'boot'), false)
  assert.equal(acceptsAct('handoffShow', 'boot'), false)
  assert.equal(acceptsAct('handoffDone', 'handoff'), true)
  assert.equal(acceptsAct('retry', 'failed'), true)
  assert.equal(acceptsAct('retry', 'watchdog'), true)
  assert.equal(acceptsAct('retry', 'boot'), false)
  assert.equal(acceptsAct('retry', 'handoff'), false)
  assert.equal(acceptsAct('wait', 'watchdog'), true)
  assert.equal(acceptsAct('wait', 'failed'), false)
  assert.equal(acceptsAct('reloadView', 'viewFailed'), true)
  assert.equal(acceptsAct('reloadView', 'failed'), false)
  for (const view of ['boot', 'failed', 'viewFailed', 'watchdog', 'handoff', 'moving']) {
    assert.equal(acceptsAct('openLogs', view), true)
    assert.equal(acceptsAct('copyDetails', view), true)
  }
  // The cards of later pull requests, and names that are not acts at all.
  for (const name of ['reload', 'toggleDetails', 'freshStart', 'installUpdate', 'manualDownload', 'stopCopy', 'keepCopying', 'importModel', 'importOption', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(acceptsAct(name, 'failed'), false, name)
  }
  assert.equal(acceptsAct(undefined, 'failed'), false)
  assert.equal(acceptsAct(42, 'failed'), false)
})

test('acts come only from the start page that was loaded', () => {
  // A Windows path is a file URL only on Windows.
  const win32 = process.platform === 'win32'
  const page = win32 ? 'C:\\Program Files\\DeepSeek Bot\\resources\\app.asar\\src\\start\\start.html' : '/opt/DeepSeek Bot/resources/app.asar/src/start/start.html'
  const loaded = startUrl(page, 'first')
  assert.equal(loaded, win32 ? 'file:///C:/Program%20Files/DeepSeek%20Bot/resources/app.asar/src/start/start.html?start=first' : 'file:///opt/DeepSeek%20Bot/resources/app.asar/src/start/start.html?start=first')
  assert.equal(isStartPage(loaded, loaded), true)
  assert.equal(isStartPage(`${loaded}#x`, loaded), false)
  assert.equal(isStartPage(loaded.replace('first', 'later'), loaded), false)
  assert.equal(isStartPage(loaded.replace('start.html', 'other.html'), loaded), false)
  assert.equal(isStartPage('http://127.0.0.1:52817/src/start/start.html?start=first', loaded), false)
  assert.equal(isStartPage('not a url', loaded), false)
  assert.equal(isStartPage(undefined, loaded), false)
})

const state = (change = {}) => ({
  lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', done: [], celebrate: true,
  explain: explainOf(), clock: { base: 0, from: 1000, running: true }, hint: undefined, failure: undefined, ...change,
})

test('the snapshot carries the phase, the stages done and the clock', () => {
  const now = 1_700_000_000_000
  const booting = startSnapshot(state({ clock: { base: 0, from: now - 6400, running: true } }), now)
  assert.deepEqual(booting, {
    v: 1, lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', phase: 'data', done: [],
    clock: { ms: 6400, at: now, running: true, rate: 1 },
    explain: { mode: 'new', nextStep: true, previewNotice: true }, celebrate: true,
  })
  assert.equal(startSnapshot(state({ done: ['data'] }), now).phase, 'engine')
  const ready = startSnapshot(state({ view: 'handoff', done: ['team', 'data', 'engine'] }), now)
  assert.equal(ready.phase, 'team')
  assert.deepEqual(ready.done, ['data', 'engine', 'team'])
  // A paused clock (a dialog, the 180 s question, a failure) stays where it stopped.
  assert.deepEqual(startSnapshot(state({ view: 'watchdog', clock: { base: 180_000, from: 5, running: false } }), now).clock, { ms: 180_000, at: now, running: false, rate: 1 })
  assert.equal(clockMs({ base: 1000, from: now - 500, running: true }, now), 1500)
  assert.equal(clockMs({ base: 1000, from: now + 500, running: true }, now), 1000)
  const failed = startSnapshot(state({ view: 'failed', failure: { reason: 'engine', log: ['a', 'b'] } }), now)
  assert.deepEqual(failed.failure, { reason: 'engine', log: ['a', 'b'] })
  assert.equal('card' in failed, false)
  assert.equal('hint' in failed, false)
  assert.deepEqual(startSnapshot(state({ hint: { drive: 'C', free: '1.2 GB' } }), now).hint, { drive: 'C', free: '1.2 GB' })
  assert.equal('place' in startSnapshot(state(), now), false)
  assert.deepEqual(startSnapshot(state({ place: { drive: 'C', free: '412 GB' } }), now).place, { drive: 'C', free: '412 GB' })
  assert.deepEqual(startSnapshot(state({ view: 'card', card: { kind: 'picked', path: 'D:\\DeepSeek Bot' } }), now).card, { kind: 'picked', path: 'D:\\DeepSeek Bot' })
  // The page gets copies: it cannot change the main process's state.
  const source = state({ failure: { reason: 'other', log: ['x'] } })
  const sent = startSnapshot(source, now)
  sent.explain.mode = 'import'
  sent.failure.log.push('y')
  assert.equal(source.explain.mode, 'new')
  assert.deepEqual(source.failure.log, ['x'])
})

test('what the hint row can prepare for: a new team, a reinstall or an import', () => {
  // DSH shows its preview notice on a data folder without a team, which has no Session yet.
  assert.deepEqual(explainOf(), { mode: 'new', nextStep: true, previewNotice: true })
  assert.deepEqual(explainOf({ team: { bots: 6, rooms: 2 } }), { mode: 'reinstall', bots: 6, groups: 2, nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true }), { mode: 'import', nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true, team: { bots: 1, rooms: 0 } }).mode, 'import')
  // The greeting names the kept team's first Main Bot; without a readable name it names none.
  const state = { mainBotIds: ['b2', 'b1'], bots: { b1: { name: 'Chief' }, b2: { name: ' Ada ' } } }
  assert.equal(explainOf({ team: { bots: 2, rooms: 0, team: state } }).name, 'Ada')
  assert.equal(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotId: 'b1', bots: state.bots } } }).name, 'Chief')
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['gone'], bots: {} } } }), 'name'), false)
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['b1'], bots: { b1: { name: '  ' } } } } }), 'name'), false)
})

test('the copied details name the version and the reason before the log', () => {
  assert.equal(detailsText({ version: '0.2.2', platform: 'win32', arch: 'x64', reason: 'engine', lines: ['l1', 'l2'] }), 'DeepSeek Bot 0.2.2 (win32 x64)\nreason: engine\n\nl1\nl2')
})

test('the start window remembers the theme and the motion tier in its own file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-start-frame-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'start-frame.json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), true)
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), false)
  assert.equal(writeStartFrame(file, { motion: 'lively', themeSource: 'moonlight' }), true)
  assert.deepEqual(readStartFrame(file), { themeSource: 'dark', motion: 'lively' })
  assert.deepEqual(readdirSync(dir), ['start-frame.json'])
  writeFileSync(file, '{"themeSource":"neon","motion":7}')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  writeFileSync(file, 'not json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
})

// Onboarding acceptance: no dialog during the first start without a window it belongs to.
test('every dialog belongs to a window', () => {
  const src = new URL('../src/', import.meta.url)
  const files = readdirSync(src).filter(name => /\.m?js$/u.test(name))
  const loose = files.flatMap((name) => {
    const code = readFileSync(new URL(name, src), 'utf8')
    return [...code.matchAll(/dialog\.(show\w+)\(\s*(\{|\))/gu)].map(match => `${name}: dialog.${match[1]}`)
  })
  assert.deepEqual(loose, [])
  assert.ok(files.every(name => !readFileSync(new URL(name, src), 'utf8').includes('showErrorBox')))
})

// Just enough of Electron for StartWindow: windows that record what is done to them, and the
// start page's act channel.
function fakeElectron() {
  const windows = []
  let act
  class Contents extends EventEmitter {
    sent = []
    reloads = 0
    mainFrame = { url: '' }
    send(channel, state) { if (channel === START_STATE) this.sent.push(state) }
    setWindowOpenHandler() {}
    toggleDevTools() {}
    reload() { this.reloads += 1; this.emit('dom-ready') }
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    calls = []
    destroyed = false
    minimized = false
    focused = true
    constructor({ x = 0, y = 0, width = 800, height = 600, show = true } = {}) {
      super()
      this.bounds = { x, y, width, height }
      this.visible = show
      windows.push(this)
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
    setContentBounds(rect) { this.bounds = { ...rect } }
    setBounds(rect) { this.bounds = { ...rect }; this.calls.push('setBounds') }
    getBounds() { return { ...this.bounds } }
    getNormalBounds() { return { ...this.bounds } }
    isDestroyed() { return this.destroyed }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    isMinimized() { return this.minimized }
    isFocused() { return this.focused }
    restore() { this.minimized = false }
    minimize() { this.minimized = true; this.calls.push('minimize') }
    show() { this.visible = true; this.calls.push('show') }
    showInactive() { this.visible = true; this.calls.push('showInactive') }
    hide() { this.visible = false; this.calls.push('hide') }
    focus() { this.calls.push('focus') }
    flashFrame(on) { this.calls.push(`flash ${String(on)}`) }
    setSkipTaskbar(skip) { this.calls.push(`skipTaskbar ${String(skip)}`) }
    setTitleBarOverlay() {}
    setBackgroundColor() {}
    getMediaSourceId() { return 'window:1:0' }
    moveAbove() {}
  }
  const display = { workArea: AREA }
  const electron = {
    BrowserWindow: Window,
    ipcMain: { handle: (channel, handler) => { if (channel === START_ACT) act = handler } },
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getPrimaryDisplay: () => display },
    shell: { openPath: async () => '' },
    clipboard: { writeText() {} },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
  }
  return { electron, windows, act: (event, name, payload) => act(event, name, payload) }
}

function startWindow(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  t.mock.method(console, 'log', () => {})
  const fake = fakeElectron()
  const main = new fake.electron.BrowserWindow({ show: false })
  const calls = { retry: 0, reload: 0, close: 0, pick: [], answer: [] }
  const start = new StartWindow({
    electron: fake.electron, page: join(tmpdir(), 'start', 'start.html'), preload: 'preload.cjs', icon: 'icon.ico', mica: false, devTools: false,
    lang: () => 'en', motion: 'normal', version: '0.0.0', program: [], log: { dir: 'logs', tail: () => ['a log line'] },
    mainWindow: () => main,
    onRetry: () => { calls.retry += 1 }, onReload: () => { calls.reload += 1 }, onClose: () => { calls.close += 1 },
    onPick: (value) => { calls.pick.push(value) }, onAnswer: (value) => { calls.answer.push(value) },
  })
  const win = () => fake.windows.at(-1)
  const page = () => ({ sender: win().webContents, senderFrame: win().webContents.mainFrame })
  return {
    start, main, calls, win,
    tick: (ms) => { t.mock.timers.tick(ms) },
    state: () => win().webContents.sent.at(-1),
    act: (name, payload, event = page()) => fake.act(event, name, payload),
    other: () => new fake.electron.BrowserWindow(),
  }
}

test('the start window takes acts only from its own page, each in its own view', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  const own = s.win()
  const ownFrame = { sender: own.webContents, senderFrame: own.webContents.mainFrame }
  const other = s.other()
  assert.equal(s.act('openLogs', undefined, { sender: other.webContents, senderFrame: other.webContents.mainFrame }), false)
  assert.equal(s.act('openLogs', undefined, { sender: own.webContents, senderFrame: { url: own.webContents.mainFrame.url } }), false)
  const loaded = own.webContents.mainFrame.url
  own.webContents.mainFrame.url = loaded.replace('first', 'later')
  assert.equal(s.act('openLogs', undefined, ownFrame), false)
  own.webContents.mainFrame.url = loaded
  assert.equal(s.act('openLogs', undefined, ownFrame), true)
  assert.equal(s.act('retry', undefined, ownFrame), false)
  assert.equal(s.act('freshStart', undefined, ownFrame), false)
  assert.equal(s.calls.retry, 0)
})

test('the 180 s question comes on the start\'s clock while the engine is not up', async (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  // A dialog stops the clock: the user's thinking time is not the engine's.
  let answer
  const asked = s.start.asking(new Promise((resolve) => { answer = resolve }))
  s.tick(WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
  answer()
  await asked
  s.tick(WATCHDOG_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.state().clock.running, false)
  // 〔继续等待〕: another 180 s on the clock.
  assert.equal(s.act('wait'), true)
  assert.equal(s.state().view, 'boot')
  s.tick(WATCHDOG_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  // The engine comes up meanwhile: the question goes, and does not come back.
  s.start.done('engine')
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, ['data', 'engine'])
  s.tick(2 * WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
})

test('a retry after the engine was up guards the new engine, while the whale keeps its stop', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  assert.equal(s.state().view, 'failed')
  assert.equal(s.state().failure.reason, 'engine')
  assert.equal(s.act('retry'), true)
  assert.equal(s.calls.retry, 1)
  assert.deepEqual(s.state().done, ['data', 'engine'])
  assert.equal(s.state().phase, 'team')
  // The old team view cannot hand over before the new engine is up.
  s.start.ready()
  assert.equal(s.state().view, 'boot')
  s.tick(WATCHDOG_MS)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.act('retry'), true)
  s.start.done('engine')
  s.tick(2 * WATCHDOG_MS)
  assert.equal(s.state().view, 'boot')
  s.start.ready()
  assert.equal(s.state().view, 'handoff')
  // The first success after a retry celebrates.
  assert.equal(s.state().celebrate, true)
})

test('the team view has 20 s to call ready(); a late ready() hands over without a celebration', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  s.tick(TEAM_VIEW_MS - 1)
  assert.equal(s.state().view, 'boot')
  s.tick(1)
  assert.equal(s.state().view, 'viewFailed')
  assert.deepEqual(s.state().failure, { reason: 'other', log: ['a log line'] })
  // 〔重新载入〕: the hidden team view loads again and has another 20 s.
  assert.equal(s.act('reloadView'), true)
  assert.equal(s.calls.reload, 1)
  assert.equal(s.state().view, 'boot')
  s.tick(TEAM_VIEW_MS)
  assert.equal(s.state().view, 'viewFailed')
  s.start.ready()
  assert.equal(s.state().view, 'handoff')
  assert.equal(s.state().celebrate, false)
  assert.equal('failure' in s.state(), false)
})

for (const [kind, wait] of [['first', 2500], ['later', 800]]) {
  test(`without handoffShow the team window shows by itself after ${String(wait)} ms on a ${kind} start`, async (t) => {
    const s = startWindow(t)
    s.start.open(kind)
    s.start.done('data')
    s.start.done('engine')
    s.start.ready()
    s.tick(wait - 1)
    assert.equal(s.main.visible, false)
    s.tick(1)
    assert.equal(s.main.visible, true)
    assert.deepEqual(s.main.calls.slice(-2), ['show', 'focus'])
    assert.ok(s.win().calls.includes('skipTaskbar true'))
    await s.start.teamShown
    s.tick(300)
    assert.equal(s.win().destroyed, true)
    // Gone after the hand-off, the start window does not quit the app.
    assert.equal(s.calls.close, 0)
  })
}

test('after handoffShow the start window grows into the team window\'s rect, and the team window shows on it', (t) => {
  const s = startWindow(t)
  s.start.open('later')
  s.start.done('data')
  s.start.done('engine')
  s.start.ready()
  const from = s.win().getBounds()
  assert.equal(s.act('handoffShow'), true)
  const target = mainRect(from, AREA)
  assert.deepEqual(s.main.bounds, target)
  s.tick(GROWTH.delay - 1)
  assert.deepEqual(s.win().bounds, from)
  s.tick(1)
  const widths = []
  for (let step = 0; step < 40 && !s.main.visible; step += 1) {
    s.tick(GROWTH.step)
    widths.push(s.win().bounds.width)
  }
  assert.equal(s.main.visible, true)
  assert.deepEqual(s.win().bounds, target)
  assert.ok(widths.some(width => width > from.width && width < target.width), 'the start window jumps instead of growing')
  // A second handoffShow does nothing.
  assert.equal(s.act('handoffShow'), true)
  assert.equal(s.main.calls.filter(call => call === 'show').length, 1)
})

for (const how of ['behind', 'minimized']) {
  test(`the team window comes up ${how} when the start window is`, (t) => {
    const s = startWindow(t)
    s.start.open('later')
    if (how === 'behind') s.win().focused = false
    else s.win().minimized = true
    s.start.done('data')
    s.start.done('engine')
    s.start.ready()
    s.act('handoffShow')
    for (let step = 0; step < 60 && !s.main.calls.includes('flash true'); step += 1) s.tick(GROWTH.step)
    assert.deepEqual(s.main.calls.slice(-2), [how === 'behind' ? 'showInactive' : 'minimize', 'flash true'])
    assert.equal(s.main.calls.includes('focus'), false)
  })
}

test('closing the start window before the hand-off quits, and its timers go with it', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  const sent = s.win().webContents.sent.length
  s.win().destroy()
  assert.equal(s.calls.close, 1)
  s.tick(WATCHDOG_MS + TEAM_VIEW_MS)
  assert.equal(s.win().webContents.sent.length, sent)
  assert.equal(s.start.owner(), undefined)
})

test('a failure during the hand-off draws the failure page on a fresh page', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.ready()
  s.act('handoffShow')
  s.tick(GROWTH.delay + GROWTH.step)
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  assert.equal(s.state().view, 'failed')
  assert.equal(s.win().webContents.reloads, 1)
  // The growth is undone, and the team window stays hidden.
  assert.deepEqual(s.win().bounds, centred(startSize(AREA), AREA))
  s.tick(5000)
  assert.equal(s.main.visible, false)
  assert.equal(s.act('handoffShow'), false)
})

test('a failure after the hand-off opens a fresh start window over the hidden team window', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.ready()
  s.tick(2500)
  const handed = s.win()
  assert.equal(s.main.visible, true)
  s.start.fail(new Error('The DSH Host stopped (exit 1)'), 'later')
  assert.equal(handed.destroyed, true)
  assert.notEqual(s.win(), handed)
  assert.equal(s.main.visible, false)
  assert.equal(s.state().view, 'failed')
  assert.equal(s.state().start, 'later')
  assert.equal(s.start.owner(), s.win())
  assert.equal(s.calls.close, 0)
})

test('the place line, its picker and its cards, and a start over in another folder', (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  assert.equal('place' in s.state(), false)
  s.start.place({ drive: 'C', free: '412 GB' })
  assert.deepEqual(s.state().place, { drive: 'C', free: '412 GB' })
  // 「换个位置…」 from the line, with its detail; the picker's own wait is the main process's.
  assert.equal(s.act('pick', { value: 'changePlace' }), true)
  assert.deepEqual(s.calls.pick, ['changePlace'])
  assert.equal(s.act('answer', { value: 'use' }), false)
  // A layer the app added: the 「会放在…」 card waits for the answer, and the clock with it.
  s.start.card({ kind: 'picked', path: 'D:\\DeepSeek Bot' })
  assert.equal(s.state().view, 'card')
  assert.deepEqual(s.state().card, { kind: 'picked', path: 'D:\\DeepSeek Bot' })
  assert.equal(s.state().clock.running, false)
  assert.equal(s.act('pick', undefined), true)
  assert.deepEqual(s.calls.pick, ['changePlace', undefined])
  assert.equal(s.act('answer', { value: 'use' }), true)
  assert.equal(s.act('answer', 'use'), true)
  assert.deepEqual(s.calls.answer, ['use', undefined])
  s.start.card(undefined)
  assert.equal(s.state().view, 'boot')
  assert.equal('card' in s.state(), false)
  assert.equal(s.state().clock.running, true)
  // A rejected place names the reason and the path.
  s.start.card({ kind: 'rejected', reason: 'onedrive', path: 'C:\\Users\\me\\OneDrive' })
  assert.equal(s.state().card.reason, 'onedrive')
  s.start.card(undefined)
  // Under the 180 s question the place can still change; the question comes back after a card.
  s.tick(180_000)
  assert.equal(s.state().view, 'watchdog')
  assert.equal(s.act('pick', { value: 'changePlace' }), true)
  s.start.card({ kind: 'picked', path: 'D:\\DeepSeek Bot' })
  assert.equal(s.state().view, 'card')
  s.start.card(undefined)
  s.tick(1)
  assert.equal(s.state().view, 'watchdog')
  // Starting over: the stages go back, the clock starts from 0, the engine is guarded again,
  // and the place line stays for the new folder.
  s.start.done('engine')
  s.tick(30_000)
  s.start.restart()
  s.start.place({ drive: 'D', free: '412 GB' })
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, [])
  assert.equal(s.state().clock.ms, 0)
  assert.equal(s.state().celebrate, true)
  assert.deepEqual(s.state().place, { drive: 'D', free: '412 GB' })
  s.start.done('data')
  s.tick(180_000)
  assert.equal(s.state().view, 'watchdog')
  s.start.done('engine')
  assert.equal(s.state().view, 'boot')
  assert.deepEqual(s.state().done, ['data', 'engine'])
  // No card after a failure: the failure page has its own buttons.
  s.start.fail(new Error('The DSH Host stopped (exit 1)'))
  s.start.card({ kind: 'picked', path: 'D:\\DeepSeek Bot' })
  assert.equal(s.state().view, 'failed')
  assert.equal(s.act('pick', { value: 'changePlace' }), false)
})

// The picker is open when the team view becomes ready: the window, the picker's owner, stays.
test('the hand-off waits while the picker is open', async (t) => {
  const s = startWindow(t)
  s.start.open('first')
  s.start.done('data')
  s.start.done('engine')
  s.start.teamLoading()
  let answer
  const asked = s.start.asking(new Promise((resolve) => { answer = resolve }))
  s.start.ready()
  assert.equal(s.state().view, 'boot')
  s.tick(2500)
  assert.equal(s.main.visible, false)
  answer()
  await asked
  assert.equal(s.state().view, 'handoff')
})

test('a card holds the hand-off the same way, and the ready is not lost when the card goes', (t) => {
  const c = startWindow(t)
  c.start.open('first')
  c.start.done('data')
  c.start.done('engine')
  c.start.card({ kind: 'picked', path: 'D:\\DeepSeek Bot' })
  c.start.ready()
  assert.equal(c.state().view, 'card')
  c.start.card(undefined)
  assert.equal(c.state().view, 'handoff')
})

test('a start over in another folder drops the old engine\'s held ready', (t) => {
  const o = startWindow(t)
  o.start.open('first')
  o.start.done('data')
  o.start.done('engine')
  o.start.card({ kind: 'picked', path: 'D:\\DeepSeek Bot' })
  o.start.ready()
  o.start.restart()
  assert.equal(o.state().view, 'boot')
  o.tick(3000)
  assert.equal(o.state().view, 'boot')
  o.start.done('data')
  o.start.done('engine')
  o.start.ready()
  assert.equal(o.state().view, 'handoff')
})

test('the 20 s check\'s verdict waits for a card\'s answer instead of being lost', (t) => {
  const v = startWindow(t)
  v.start.open('first')
  v.start.done('data')
  v.start.done('engine')
  v.start.teamLoading()
  v.start.card({ kind: 'rejected', reason: 'onedrive', path: 'C:\\OneDrive' })
  v.tick(20_000)
  assert.equal(v.state().view, 'card')
  v.start.card(undefined)
  assert.equal(v.state().view, 'viewFailed')
})
