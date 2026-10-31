// The start window (docs/plans/2026-10-26-start-window.md §1, §8, §11; windows-onboarding §3): the
// app's own small window that shows start/start.html while the engine boots. It holds the
// start's state and sends the page the whole of it on every change; at the end it grows into the
// team window's rect, and the hidden team window shows on the same rect. The rect maths, the
// growth, the snapshot and the checks are plain functions, so the tests run without Electron.
import { pathToFileURL } from 'node:url'
import { within } from './copy-tree.mjs'

export const START_STATE = 'ds-bot:start-state'
export const START_ACT = 'ds-bot:start-act'

export const START_SIZE = { width: 720, height: 540 }
export const SHORT_START_SIZE = { width: 720, height: 500 }
// Work areas lower than this get the short start window.
const SHORT_WORK_AREA = 588
export const MAIN_SIZE = { width: 1320, height: 860 }
export const PHASES = ['data', 'engine', 'team']
export const START_KINDS = ['first', 'later', 'moving']
export const WATCHDOG_MS = 180_000
export const TEAM_VIEW_MS = 20_000
// handoffShow + 160 ms: the growth, 300 ms in steps of about 14 ms; the start window goes
// 300 ms after the team window shows (§8).
export const GROWTH = { delay: 160, duration: 300, step: 14 }
export const DESTROY_AFTER_MS = 300
export const FAILURE_LINES = 200
// The DeepSeek theme's --bt-main and --bt-ink (ui-standard 2.1), as in start.css: the window's
// own background and caption symbols, which show before the page paints and where Mica is not.
const COLORS = { light: { main: '#fcfcfc', ink: '#141414' }, dark: { main: '#141414', ink: '#f2f2f2' } }
const CAPTION_HEIGHT = 40
const PAINT_WAIT_MS = 3000

// What the page may ask, and in which views (null: in any). The cards of later pull requests
// send other names, which are refused.
const ACT_VIEWS = {
  handoffShow: ['handoff'],
  handoffDone: ['handoff'],
  retry: ['failed', 'watchdog'],
  wait: ['watchdog'],
  reloadView: ['viewFailed'],
  // 「换个位置…」 on the page (also under the 180 s question), and the cards it leads to
  // (「会放在…」, a place that cannot be used).
  pick: ['boot', 'card', 'watchdog'],
  answer: ['card'],
  openLogs: null,
  copyDetails: null,
}
export const START_ACTS = Object.freeze(Object.keys(ACT_VIEWS))

/** Whether the main process takes this act from the start page in this view. */
export function acceptsAct(name, view) {
  if (typeof name !== 'string' || !Object.hasOwn(ACT_VIEWS, name)) return false
  const views = ACT_VIEWS[name]
  return views === null || views.includes(view)
}

/** Whether a frame shows exactly the start page that was loaded. */
export function isStartPage(frameUrl, loadedUrl) {
  try {
    const frame = new URL(frameUrl)
    return frame.protocol === 'file:' && frame.href === new URL(loadedUrl).href
  } catch {
    return false
  }
}

export const startUrl = (page, kind) => `${pathToFileURL(page).href}?start=${kind}`

/** The start window's content size on a display's work area. */
export const startSize = workArea => ({ ...(workArea.height < SHORT_WORK_AREA ? SHORT_START_SIZE : START_SIZE) })

export function centred(size, area) {
  return {
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y + Math.round((area.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}

/** A rect moved, and shrunk if it must be, to lie inside an area. */
export function clampInto(rect, area) {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

/** The team window's rect: centred on the start window, inside the work area. */
export function mainRect(start, area, size = MAIN_SIZE) {
  const x = Math.round(start.x + start.width / 2 - size.width / 2)
  const y = Math.round(start.y + start.height / 2 - size.height / 2)
  return clampInto({ x, y, width: size.width, height: size.height }, area)
}

/** CSS's cubic-bezier() as a function of the time fraction. */
export function cubicBezier(x1, y1, x2, y2) {
  const curve = (p1, p2) => {
    const c = 3 * p1
    const b = 3 * (p2 - p1) - c
    const a = 1 - c - b
    return s => ((a * s + b) * s + c) * s
  }
  const x = curve(x1, x2)
  const y = curve(y1, y2)
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // x is monotonic for control points inside [0, 1], so halving finds its parameter.
    let low = 0
    let high = 1
    for (let step = 0; step < 40; step += 1) {
      const mid = (low + high) / 2
      if (x(mid) < t) low = mid
      else high = mid
    }
    return y((low + high) / 2)
  }
}
export const GROWTH_EASING = cubicBezier(0.2, 0.7, 0.2, 1)

export function rectAt(from, to, progress) {
  const at = key => Math.round(from[key] + (to[key] - from[key]) * progress)
  return { x: at('x'), y: at('y'), width: at('width'), height: at('height') }
}

/** The rects of the growth, one per step; the last one is the target at the full duration. */
export function growthSteps(from, to, { duration, step } = GROWTH) {
  const steps = []
  for (let at = step; ; at += step) {
    const time = Math.min(at, duration)
    steps.push({ at: time, rect: rectAt(from, to, GROWTH_EASING(time / duration)) })
    if (time >= duration) return steps
  }
}

// When the page never sends handoffShow, the main process shows the team window itself. A first
// start and a celebrating hand-off take up to about 1.2 s, plus up to 600 ms of queued swimming.
export const fallbackMs = ({ start, celebrate }) => (start === 'first' || celebrate ? 2500 : 800)

// The five reasons of the failure page (windows-onboarding §3), most specific first: a Host
// that stopped says so and carries its own error output, which names the cause.
const REASONS = [
  ['permission', /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted|access is denied/iu],
  ['space', /\b(?:ENOSPC|EDQUOT)\b|no space left|not enough space|disk (?:is )?full/iu],
  ['files', /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|cannot find (?:module|package)|could not load its own bundles|not a valid Win32 application|0xC0000135|3221225781/iu],
  ['engine', /DSH Host stopped|engine's web server/iu],
]

// Only a missing file of the program's own says that the install is incomplete: a data folder
// on a drive that is gone is missing too, and so is a workspace.
function missingOwnFile(error, text, program) {
  if (!/\bENOENT\b/u.test(text)) return false
  const paths = [error?.path, ...[...text.matchAll(/ENOENT: [^,\n]*, \w+ '([^'\n]+)'/gu)].map(match => match[1])]
  return paths.some(path => typeof path === 'string' && program.some(folder => within(path, folder)))
}

/**
 * @param {{ program?: string[] }} where `program`: the folders of the app's own files
 * @returns {'permission' | 'space' | 'files' | 'engine' | 'other'}
 */
export function failureReason(error, { program = [] } = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = `${code} ${message}`
  for (const [reason, pattern] of REASONS) {
    if (pattern.test(text) || (reason === 'files' && missingOwnFile(error, text, program))) return reason
  }
  return 'other'
}

// The Main Bot that a kept team's sidebar shows first (ds-bot's channel.js: mainBotIds[0]; an
// older state.json has mainBotId), whose name the greeting says on a reinstall.
export function mainBotName(state) {
  const id = Array.isArray(state?.mainBotIds) ? state.mainBotIds[0] : state?.mainBotId
  const name = typeof id === 'string' ? state.bots?.[id]?.name : undefined
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

// What the hint row can prepare for. previewNotice: DSH shows its preview notice when the
// Session is ready and the main view has no non-empty Session (windows-onboarding §3, the row of
// the third stop), which a data folder without a team always has. A kept or copied team may have
// read it already, and the main process cannot tell before the team view has loaded.
export function explainOf({ offered = false, team } = {}) {
  if (offered) return { mode: 'import', nextStep: false, previewNotice: false }
  if (team !== undefined) {
    const name = mainBotName(team.team)
    return { mode: 'reinstall', bots: team.bots, groups: team.rooms, ...(name === undefined ? {} : { name }), nextStep: false, previewNotice: false }
  }
  return { mode: 'new', nextStep: true, previewNotice: true }
}

export const clockMs = (clock, now) => clock.base + (clock.running ? Math.max(0, now - clock.from) : 0)

/** The whole state the page gets: the page computes the elapsed time from clock.ms at clock.at. */
export function startSnapshot(state, now) {
  const snapshot = {
    v: 1,
    lang: state.lang,
    start: state.start,
    motion: state.motion,
    // Windows draws the caption buttons over the page's band; macOS and Linux a system title bar.
    frame: state.frame,
    view: state.view,
    phase: PHASES.find(phase => !state.done.includes(phase)) ?? 'team',
    done: PHASES.filter(phase => state.done.includes(phase)),
    clock: { ms: Math.round(clockMs(state.clock, now)), at: now, running: state.clock.running, rate: 1 },
    explain: { ...state.explain },
    celebrate: state.celebrate,
  }
  if (state.hint !== undefined) snapshot.hint = { ...state.hint }
  if (state.place !== undefined) snapshot.place = { ...state.place }
  if (state.card !== undefined) snapshot.card = { ...state.card }
  if (state.failure !== undefined) snapshot.failure = { reason: state.failure.reason, log: [...state.failure.log] }
  return snapshot
}

export const detailsText = ({ version, platform, arch, reason, lines }) => [`DeepSeek Bot ${version} (${platform} ${arch})`, `reason: ${reason}`, '', ...lines].join('\n')

const note = message => { console.log(`DeepSeek Bot: start window: ${message}`) }
// The page sends a button's detail as { value }; anything else counts as none.
const valueOf = payload => (payload !== null && typeof payload === 'object' && typeof payload.value === 'string' ? payload.value.slice(0, 40) : undefined)

export class StartWindow {
  #o
  #window
  #url
  #painted = Promise.resolve()
  #state
  #explain = explainOf()
  #asks = 0
  #watchAt = WATCHDOG_MS
  #timers = {}
  #phaseAt = 0
  #readyAt = 0
  #showAt = 0
  #from
  #handing = false
  #revealed = false
  // Whether the engine of this attempt is up; the stages done say where the whale is, which a
  // retry never moves back.
  #engineUp = false
  // What a dialog of the window (the folder picker) or a card keeps waiting: the hand-off, which
  // would take the window and the dialog's owner away, and the 20 s check's verdict.
  #readyHeld = false
  #heldAt = 0
  #viewLate = false
  #teamShown
  #showTeam

  /**
   * @param {{
   *   electron: { BrowserWindow: any, ipcMain: any, screen: any, shell: any, clipboard: any, nativeTheme: any, systemPreferences: any },
   *   page: string, preload: string, icon: string, mica: boolean, devTools: boolean,
   *   lang: () => 'zh' | 'en', motion: string, version: string, program: string[],
   *   log: { dir: string, tail: (count: number) => string[] },
   *   mainWindow: () => any,
   *   onRetry: () => void, onReload: () => void, onClose: () => void,
   *   onPick?: (value?: string) => void, onAnswer?: (value?: string) => void,
   * }} options `lang` is asked at each open; `program` names the folders of the app's own files;
   *   `onClose` runs when the user closes the start window before the hand-off; `onPick` when
   *   the page asks for the folder picker ('changePlace' from its place line, nothing from a
   *   card's 〔重新选〕), `onAnswer` with a card's answer ('use' for 〔继续〕 on 「会放在…」).
   */
  constructor(options) {
    this.#o = options
    this.#teamShown = new Promise((resolve) => { this.#showTeam = resolve })
    options.electron.ipcMain.handle(START_ACT, (event, name, payload) => this.#act(event, name, payload))
  }

  get kind() { return this.#state?.start }

  /** Settles once the current window has painted its first frame (or has had time to). */
  get painted() { return this.#painted }

  /** Settles once the team window has shown at a hand-off. */
  get teamShown() { return this.#teamShown }

  /** Opens the window, unless one is open, with a fresh state for this kind of start. */
  open(kind) {
    if (this.#open()) return
    const { BrowserWindow, screen, nativeTheme } = this.#o.electron
    const start = START_KINDS.includes(kind) ? kind : 'later'
    this.#reset(start)
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const win32 = process.platform === 'win32'
    const { mica } = this.#o
    const colors = this.#colors()
    const rect = centred(startSize(area), area)
    const win = new BrowserWindow({
      ...rect,
      useContentSize: true, resizable: false, maximizable: false, fullscreenable: false, minimizable: true,
      show: true, title: 'DeepSeek Bot', icon: this.#o.icon,
      backgroundColor: mica ? '#00000000' : colors.main,
      // Frameless with the system minimize and close buttons over the page's empty 40 px band.
      ...(win32 ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { height: CAPTION_HEIGHT, color: mica ? '#00000000' : colors.main, symbolColor: colors.ink },
        ...(mica ? { backgroundMaterial: 'mica' } : {}),
      } : {}),
      webPreferences: {
        preload: this.#o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
        // The page paces the whale and the hand-off on timers, which a covered or minimized
        // window would otherwise run once a second.
        backgroundThrottling: false,
        additionalArguments: [`--ds-bot-start=${pathToFileURL(this.#o.page).href}`],
      },
    })
    // At a fractional display scale, Electron 44 on Windows makes a frameless window a few pixels
    // larger than asked; setting the size again once it exists gives the size asked for.
    win.setContentBounds(rect)
    this.#window = win
    this.#url = startUrl(this.#o.page, start)
    const contents = win.webContents
    // The window shows at once; its page paints a little later (onboarding §3: within about 1 s).
    const sinceLaunch = () => String(Math.round(process.uptime() * 1000))
    note(`${start} start window shown ${sinceLaunch()} ms after launch`)
    win.once('ready-to-show', () => { note(`the start page painted ${sinceLaunch()} ms after launch`) })
    this.#painted = new Promise((resolve) => {
      win.once('ready-to-show', resolve)
      contents.once('did-finish-load', resolve)
      setTimeout(resolve, PAINT_WAIT_MS)
    })
    win.on('page-title-updated', (event) => { event.preventDefault() })
    contents.on('will-navigate', (event) => { event.preventDefault() })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A reload loses what the preload kept, so the page gets the state again.
    contents.on('dom-ready', () => { this.#send() })
    contents.on('render-process-gone', (_event, details) => { note(`the page's renderer stopped (${String(details?.reason)})`) })
    if (this.#o.devTools) {
      contents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
      })
    }
    const recolor = () => {
      if (win.isDestroyed()) return
      const next = this.#colors()
      if (win32) win.setTitleBarOverlay({ color: mica ? '#00000000' : next.main, symbolColor: next.ink })
      if (!mica) win.setBackgroundColor(next.main)
    }
    nativeTheme.on('updated', recolor)
    win.once('closed', () => {
      nativeTheme.off('updated', recolor)
      if (this.#window !== win) return
      this.#window = undefined
      this.#clearTimers()
      if (!this.#revealed) this.#o.onClose()
    })
    void win.loadURL(this.#url).catch((error) => { note(`the start page did not load: ${error instanceof Error ? error.message : String(error)}`) })
  }

  /** The window that dialogs belong to, while it is the one showing. */
  owner() { return this.#open() && !this.#revealed ? this.#window : undefined }

  /** Brings the start window back while it is the one showing. */
  focus() {
    const win = this.owner()
    if (win === undefined) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  explain(explain) {
    this.#explain = { ...explain }
    if (this.#open()) this.#update({ explain: this.#explain })
  }

  /**
   * The line that says where the data goes, with 「换个位置…」 (start-window §2): the drive and its
   * free space, or the folder. Undefined takes the line away.
   * @param {{ drive?: string, path?: string, free?: string } | undefined} place
   */
  place(place) {
    if (this.#open()) this.#update({ place: place === undefined ? undefined : { ...place } })
  }

  /** A short drive's one-line note for the first 10 s (§4), or none. */
  hint(hint) {
    if (this.#open()) this.#update({ hint: hint === undefined ? undefined : { ...hint } })
  }

  /**
   * A card on the sheet while the start boots (the clock stands still), or none: back to the
   * boot. Only the cards of a place: 「会放在…」 and a place that cannot be used.
   * @param {{ kind: 'picked' | 'rejected', path: string, reason?: string } | undefined} card
   */
  card(card) {
    if (!this.#open() || !['boot', 'card', 'watchdog'].includes(this.#state.view)) return
    if (card === undefined && this.#state.view !== 'card') return
    // Back in the boot, a 180 s question that the card replaced comes straight back.
    this.#update(card === undefined ? { view: 'boot', card: undefined } : { view: 'card', card: { ...card } })
    if (card === undefined) this.#resume()
  }

  /**
   * The start begins again in another folder (§7): the stages go back to the start, the whale
   * sinks and surfaces at the first stop, and the clock starts from 0. The first success after
   * it celebrates, as after a retry.
   */
  restart() {
    if (!this.#open()) return
    note('starting over in another folder')
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#clear('teamView')
    this.#update({ view: 'boot', done: [], card: undefined, failure: undefined, celebrate: true, clock: { base: 0, from: Date.now(), running: true } })
  }

  /**
   * The clock stands still while the user answers a dialog: thinking time is not the engine's.
   * The hand-off and the 20 s check wait for the answer too (see ready()).
   */
  async asking(promise) {
    this.#asks += 1
    this.#refresh()
    try {
      return await promise
    } finally {
      this.#asks -= 1
      this.#refresh()
      this.#resume()
    }
  }

  // What waited for the dialogs to close and the card to go.
  #resume() {
    if (this.#asks > 0 || !this.#open() || this.#state.view !== 'boot') return
    if (this.#readyHeld) {
      this.#readyHeld = false
      note(`the hand-off waited ${String(Date.now() - this.#heldAt)} ms for the answer`)
      this.ready()
    } else if (this.#viewLate) {
      this.#viewLate = false
      this.#teamViewLate()
    }
  }

  #holdsOff() {
    if (this.#readyHeld) note(`the held hand-off is dropped after ${String(Date.now() - this.#heldAt)} ms: the start goes on elsewhere`)
    this.#readyHeld = false
    this.#viewLate = false
  }

  /** The data folder or the engine is ready; the engine also again after a retry. */
  done(phase) {
    if (!this.#open() || !['data', 'engine'].includes(phase)) return
    const again = this.#state.done.includes(phase)
    if (again && (phase !== 'engine' || this.#engineUp)) return
    if (phase === 'engine') this.#engineUp = true
    note(`${phase} took ${String(Date.now() - this.#phaseAt)} ms`)
    this.#phaseAt = Date.now()
    // The engine came up while the 180 s question was open: the question goes.
    this.#update({ ...(again ? {} : { done: [...this.#state.done, phase] }), ...(this.#state.view === 'watchdog' ? { view: 'boot' } : {}) })
  }

  /** The engine's page started loading in the hidden team window: it has 20 s to call ready(). */
  teamLoading() {
    if (!this.#open()) return
    this.#later('teamView', TEAM_VIEW_MS, () => { this.#teamViewLate() })
  }

  #teamViewLate() {
    if (!['boot', 'card'].includes(this.#state.view)) return
    // A dialog or a card is up: the verdict waits for the answer (#resume).
    if (this.#asks > 0 || this.#state.view === 'card') { this.#viewLate = true; return }
    note(`the team view did not call ready() within ${String(TEAM_VIEW_MS / 1000)} s`)
    this.#update({ view: 'viewFailed', failure: { reason: 'other', log: this.#o.log.tail(FAILURE_LINES) } })
  }

  /**
   * dsBotApp.ready() from the team view: the hand-off starts. While a dialog of the window or
   * a card is up (the folder picker, 「会放在…」), it waits: the hand-off would take the window,
   * and with it the dialog's owner, away while the user is still choosing where the data goes.
   */
  ready() {
    if (!this.#open() || !['boot', 'card', 'viewFailed'].includes(this.#state.view) || !this.#engineUp) return
    this.#clear('teamView')
    if (this.#asks > 0 || this.#state.view === 'card') {
      if (!this.#readyHeld) {
        note('the team view is ready; the hand-off waits for the answer')
        this.#heldAt = Date.now()
      }
      this.#readyHeld = true
      return
    }
    this.#readyHeld = false
    const now = Date.now()
    note(`team took ${String(now - this.#phaseAt)} ms`)
    this.#readyAt = now
    // A team view that loads after its 20 s goes in without a celebration (§7).
    const celebrate = this.#state.celebrate && this.#state.view !== 'viewFailed'
    this.#update({ view: 'handoff', done: [...PHASES], celebrate, failure: undefined })
    this.#later('fallback', fallbackMs(this.#state), () => {
      note('the page did not send handoffShow')
      this.#handoffShow({ grow: false })
    })
  }

  /**
   * The failure page: in this window, or in a new one when the team window was already showing.
   * @param {string} kind the kind of start when no start window has opened yet
   */
  fail(error, kind = 'later') {
    const showing = this.#revealed
    // The page's hand-off empties it for the growth and cannot be undone there: a fresh page
    // draws the failure.
    const emptied = !showing && this.#open() && this.#state.view === 'handoff'
    if (showing) {
      this.#destroy()
      const main = this.#o.mainWindow()
      if (main !== undefined && !main.isDestroyed()) main.hide()
    }
    if (!this.#open()) this.open(showing || this.#state === undefined ? kind : this.#state.start)
    this.#cancelHandoff()
    this.#holdsOff()
    this.#clear('teamView')
    this.#clear('fallback')
    this.#update({ view: 'failed', failure: { reason: failureReason(error, { program: this.#o.program }), log: this.#o.log.tail(FAILURE_LINES) } })
    if (emptied) this.#window.webContents.reload()
  }

  /** The team window's rect: centred on the start window, inside that display's work area. */
  mainBounds() {
    const { screen } = this.#o.electron
    if (!this.#open()) return centred(clampInto({ x: 0, y: 0, ...MAIN_SIZE }, screen.getPrimaryDisplay().workArea), screen.getPrimaryDisplay().workArea)
    const start = this.#window.getNormalBounds()
    return mainRect(start, screen.getDisplayMatching(start).workArea)
  }

  /**
   * Puts the hidden team window on its rect, also when made with it: the size it was made with
   * can be off by a few pixels (see open()), the one set afterwards is exact.
   * @returns the rect
   */
  placeMain(main = this.#o.mainWindow()) {
    const rect = this.mainBounds()
    if (main !== undefined && !main.isDestroyed()) main.setBounds(rect)
    return rect
  }

  #open() { return this.#window !== undefined && !this.#window.isDestroyed() }

  #colors() { return COLORS[this.#o.electron.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'] }

  #reset(start) {
    this.#clearTimers()
    this.#handing = false
    this.#revealed = false
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    const now = Date.now()
    this.#phaseAt = now
    this.#state = {
      lang: this.#o.lang(), start, motion: this.#o.motion, frame: process.platform === 'win32' ? 'band' : 'system',
      view: start === 'moving' ? 'moving' : 'boot',
      done: [], explain: this.#explain, celebrate: start === 'first',
      clock: { base: 0, from: now, running: true },
      hint: undefined, place: undefined, card: undefined, failure: undefined,
    }
    this.#refresh()
  }

  // Applies a change, keeps the clock running only while the start is booting and nobody is
  // being asked, and sends the page the whole state.
  #update(change) {
    const now = Date.now()
    const next = { ...this.#state, ...change }
    const running = this.#asks === 0 && (next.view === 'boot' || next.view === 'moving')
    const clock = next.clock
    if (running !== clock.running) next.clock = { base: clockMs(clock, now), from: now, running }
    this.#state = next
    this.#armWatchdog()
    this.#send()
  }

  #refresh() { if (this.#state !== undefined) this.#update({}) }

  #send() {
    if (this.#open() && this.#state !== undefined) this.#window.webContents.send(START_STATE, startSnapshot(this.#state, Date.now()))
  }

  // 180 s on the start's clock without the engine: the whale asks whether to try again.
  #armWatchdog() {
    this.#clear('watchdog')
    const { start, view, clock } = this.#state
    if (start === 'moving' || view !== 'boot' || !clock.running || this.#engineUp) return
    this.#later('watchdog', this.#watchAt - clockMs(clock, Date.now()), () => {
      note(`no engine after ${String(Math.round(this.#watchAt / 1000))} s`)
      this.#update({ view: 'watchdog' })
    })
  }

  #act(event, name, payload) {
    const win = this.#window
    if (!this.#open() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || !isStartPage(event.senderFrame?.url, this.#url)) return false
    if (!acceptsAct(name, this.#state.view)) {
      note(`refused the act ${typeof name === 'string' ? name.slice(0, 40) : typeof name} in ${this.#state.view}`)
      return false
    }
    if (name === 'handoffShow') this.#handoffShow(payload)
    else if (name === 'handoffDone') note(`handoffDone at handoffShow + ${String(Date.now() - this.#showAt)} ms`)
    else if (name === 'retry') this.#retry()
    else if (name === 'wait') this.#wait()
    else if (name === 'reloadView') this.#reload()
    else if (name === 'openLogs') this.#openLogs()
    else if (name === 'copyDetails') this.#copyDetails()
    else if (name === 'pick') this.#o.onPick?.(valueOf(payload))
    else if (name === 'answer') this.#o.onAnswer?.(valueOf(payload))
    return true
  }

  // The failed stage, or the engine after the 180 s question, starts again; the stages already
  // done stay done, and the first success after this celebrates (§7). The engine starts again
  // in any case, so the 180 s question guards it again.
  #retry() {
    note(`retry from ${this.#state.view}`)
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#update({ view: 'boot', failure: undefined, celebrate: true, done: this.#state.done.filter(phase => phase !== 'team'), clock: { base: 0, from: Date.now(), running: true } })
    this.#o.onRetry()
  }

  // 〔继续等待〕: the question comes back after another 180 s on the clock.
  #wait() {
    this.#watchAt = clockMs(this.#state.clock, Date.now()) + WATCHDOG_MS
    this.#update({ view: 'boot' })
  }

  #reload() {
    note('reloading the team view')
    this.#update({ view: 'boot', failure: undefined })
    this.#o.onReload()
    this.teamLoading()
  }

  #openLogs() {
    void this.#o.electron.shell.openPath(this.#o.log.dir).then((problem) => { if (problem) note(`the logs folder did not open: ${problem}`) })
  }

  #copyDetails() {
    const { version } = this.#o
    const reason = this.#state.failure?.reason ?? 'other'
    const text = detailsText({ version, platform: process.platform, arch: process.arch, reason, lines: this.#o.log.tail(FAILURE_LINES) })
    void Promise.resolve(this.#o.electron.clipboard.writeText(text)).catch((error) => { note(`the details were not copied: ${error instanceof Error ? error.message : String(error)}`) })
  }

  #handoffShow(payload) {
    if (this.#handing || this.#state.view !== 'handoff') return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#handing = true
    this.#clear('fallback')
    this.#showAt = Date.now()
    note(`handoffShow at ready + ${String(this.#showAt - this.#readyAt)} ms`)
    const win = this.#window
    this.#from = win.getBounds()
    // The start window may have been dragged since the team window was placed.
    const target = this.placeMain(main)
    const grow = !(payload !== null && typeof payload === 'object' && payload.grow === false) && !win.isMinimized() && !this.#reducedMotion()
    if (!grow) { this.#reveal(); return }
    this.#later('grow', GROWTH.delay, () => { this.#grow(this.#from, target) })
  }

  // Electron ignores setBounds' animate flag on Windows, so the growth is stepped here; each step
  // eases from the time it really runs at, so a busy machine skips steps rather than stretching.
  #grow(from, to) {
    const began = Date.now()
    note(`growing at handoffShow + ${String(began - this.#showAt)} ms`)
    const step = () => {
      if (!this.#open()) return
      const time = Math.min(1, (Date.now() - began) / GROWTH.duration)
      this.#window.setBounds(rectAt(from, to, GROWTH_EASING(time)))
      if (time < 1) this.#later('grow', GROWTH.step, step)
      else this.#reveal()
    }
    this.#later('grow', GROWTH.step, step)
  }

  // The team window shows on its rect: with the focus when the start window had it; otherwise
  // behind nothing new, flashing its taskbar button; minimized when the start window was.
  #reveal() {
    if (this.#revealed || !this.#open()) return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#revealed = true
    this.#showTeam()
    this.#clear('fallback')
    this.#clear('grow')
    const win = this.#window
    const how = win.isMinimized() ? 'minimized' : win.isFocused() ? 'focused' : 'behind'
    if (how === 'focused') {
      main.show()
      main.focus()
    } else if (how === 'minimized') {
      main.minimize()
    } else {
      main.showInactive()
      try { main.moveAbove(win.getMediaSourceId()) } catch { /* the order stays the system's */ }
    }
    if (how !== 'focused') {
      main.flashFrame(true)
      main.once('focus', () => { main.flashFrame(false) })
    }
    // Leaves the taskbar only now, so the app's button never goes away.
    win.setSkipTaskbar(true)
    note(`team window shown (${how}) at ready + ${String(Date.now() - this.#readyAt)} ms`)
    this.#later('destroy', DESTROY_AFTER_MS, () => { this.#destroy() })
  }

  #cancelHandoff() {
    if (!this.#handing || this.#revealed) return
    this.#clear('grow')
    this.#handing = false
    if (this.#from !== undefined && this.#open()) this.#window.setBounds(this.#from)
  }

  #destroy() {
    const win = this.#window
    if (win !== undefined && !win.isDestroyed()) win.destroy()
  }

  #reducedMotion() {
    try {
      return this.#o.electron.systemPreferences.getAnimationSettings().prefersReducedMotion === true
    } catch {
      return false
    }
  }

  #later(name, ms, run) {
    this.#clear(name)
    this.#timers[name] = setTimeout(() => {
      delete this.#timers[name]
      run()
    }, Math.max(0, ms))
  }

  #clear(name) {
    clearTimeout(this.#timers[name])
    delete this.#timers[name]
  }

  #clearTimers() { for (const name of Object.keys(this.#timers)) this.#clear(name) }
}
