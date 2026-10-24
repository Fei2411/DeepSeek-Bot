// The Bot panel: one right-hand column holding a Bot's details, its browser or a
// side chat. A tab strip on top flips between them — the Bot page collapses to a
// tab, each browser tab and side chat is a tab of its own. Browser pages are
// Electron webviews kept in a body-level layer by bot-browsers.js; the panel
// draws the strip and the toolbar and reports the rectangle the shown webview
// covers.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { STORAGE } from './storage.js'
import { installStyles } from './styles.js'
import { SPRING_SHAPE, springEasing } from './motion.js'
import { DetailsDrawer } from './details-drawer.js'
import { SideChatView } from './side-chat.js'
import { panelHasStrip, sideChatsOf, stripMenuKeys } from './side-model.js'
import { DotsIcon, FolderIcon, SideIcon, TerminalIcon } from './icons.js'
import { t } from './i18n.js'
import { rectsOverlap } from './browser-overlap.js'

export const PANEL_LINGER_MS = 300
const WIDTH_KEY = STORAGE.browserWidth
// One width for the panel, shared by both views. The Bot page keeps it within
// DETAILS_WIDTH..DETAILS_MAX, so a wider browser comes back to DETAILS_MAX and a
// narrower one keeps its width; the browser takes any width from MIN_WIDTH.
const DEFAULT_WIDTH = 520
const DETAILS_WIDTH = 320
const DETAILS_MAX = 520
const MIN_WIDTH = 360
// The conversation keeps at least this much room beside the panel.
const MIN_CHAT = 420
const PANEL_MIN = { details: DETAILS_WIDTH, browser: MIN_WIDTH, side: DETAILS_WIDTH }
// Below this viewport width the panel cannot leave the conversation its room:
// it covers the conversation instead of pushing it aside.
const overlayAt = (view, viewport) => viewport < MIN_CHAT + PANEL_MIN[view]
// How long the Bot's mark shows that it read the page.
const READ_FLASH_MS = 2400
const EMPTY_PAGE = { url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }
const EMPTY_TABS = { ids: [], active: null }
// The indicator's leading edge runs the fast spring, the trailing one the slow
// spring — the capsule stretches into the move, then settles.
const SPRING_LEAD = springEasing(576, 39.4)
const SPRING_TRAIL = springEasing(144, 19.7)

const icon = paths => function BrowserIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
export const GlobeIcon = icon(['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M3 10h14', 'M10 3c2 2.2 2.9 4.5 2.9 7S12 14.8 10 17c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z'])
const BackIcon = icon(['M12.5 4.5L7 10l5.5 5.5'])
const ForwardIcon = icon(['M7.5 4.5L13 10l-5.5 5.5'])
const ReloadIcon = icon(['M15.5 10a5.5 5.5 0 1 1-1.6-3.9', 'M15.5 3.5v3.5H12'])
const StopIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const CloseIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const PlusTabIcon = icon(['M10 5v10M5 10h10'])
const LockIcon = icon(['M6.5 9V7a3.5 3.5 0 0 1 7 0v2', 'M5.5 9h9v7h-9z'])
const ImportIcon = icon(['M10 3.5v8.5', 'M6 8.5l4 4 4-4', 'M4.5 14v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V14'])
const FileIcon = icon(['M6 3.5h5.5L14.5 6.5v10H6z', 'M11 3.5v3.5h3.5'])
const WindowIcon = icon(['M4 5h12v9.5H4z', 'M4 7.5h12'])

/** A page's favicon, or the globe while there is none or it fails to load. */
export function Favicon({ src, className }) {
  const [failed, setFailed] = useState(null)
  if (!src || failed === src) return h('span', { className: `${className} bt-ptab-globe` }, h(GlobeIcon))
  return h('img', { className, src, alt: '', 'aria-hidden': true, onError: () => setFailed(src) })
}

// null until the user sets a width: the Bot page then opens at DETAILS_WIDTH and the
// browser at DEFAULT_WIDTH.
const savedWidth = () => {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value >= DETAILS_WIDTH ? value : null
  } catch { return null }
}
const widthRange = (view, viewport) => (view === 'browser'
  ? [MIN_WIDTH, viewport - MIN_CHAT]
  : [DETAILS_WIDTH, Math.min(DETAILS_MAX, viewport - MIN_CHAT)])
const fitWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))

// The conversation column's right margin lives in one rule of our own, matched on the
// column's exact class. A custom property on <body> would restyle the whole page, tens
// of milliseconds a write. A changed rule still restyles the column's subtree, so a drag
// writes the column's own inline style each frame and the rule once, on release.
const room = { rule: null, selector: '' }
const roomRule = () => {
  const live = room.rule?.parentStyleSheet?.ownerNode?.isConnected
  if (live && room.selector) return room.rule
  const column = document.querySelector('[class*="_centerCol"]')
  const selector = column ? [...column.classList].filter(name => name.includes('_centerCol')).map(name => `.${CSS.escape(name)}`).join(',') : ''
  if (live && !selector) return room.rule
  const declarations = room.rule?.style.cssText ?? ''
  room.rule?.parentStyleSheet?.ownerNode?.remove()
  const style = installStyles(`${selector || '[class*="_centerCol"]'}{${declarations}}`, 'chat-room')
  room.rule = style.sheet.cssRules[0]
  room.selector = selector
  return room.rule
}
let roomHold = 0
const chatRoom = {
  /** The column's right margin in px, or null for the shell's own. */
  set(width) {
    const { style } = roomRule()
    if (width === null) style.removeProperty('margin-right')
    else style.setProperty('margin-right', `${width}px`, 'important')
  },
  /** While on, a margin change lands at once instead of gliding. */
  hold(on) {
    cancelAnimationFrame(roomHold)
    if (on) { roomRule().style.setProperty('transition', 'none', 'important'); return }
    // Two frames, so the last held write is on screen before the glide comes back.
    roomHold = requestAnimationFrame(() => { roomHold = requestAnimationFrame(() => roomRule().style.removeProperty('transition')) })
  },
  /** The columns themselves, for a drag's per-frame writes. */
  columns() {
    roomRule()
    return room.selector ? [...document.querySelectorAll(room.selector)] : []
  },
}
// The address as the bar shows it while not editing: no scheme, no trailing slash.
const shortAddress = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const tabLabel = page => page.title || shortAddress(page.url) || t('New tab')

// The `···` popover anchored to its button. `items` holds {key, icon, label,
// onPick} and {sep:true} entries; Escape or a click outside closes it. The
// callers hide the button when the list is empty.
export function PanelMenu({ items, className, 'aria-label': label }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (wrap.current && !wrap.current.contains(event.target)) setOpen(false) }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (items.length === 0) return null
  return h('span', { className: 'bt-pmenu', ref: wrap },
    h('button', {
      type: 'button', className, 'aria-label': label, title: label,
      'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value),
    }, h(DotsIcon)),
    open ? h('div', { className: 'bt-pmenu-pop', role: 'menu' },
      items.map((item, index) => (item.sep
        ? h('span', { key: `sep-${index}`, className: 'bt-pmenu-sep', role: 'separator' })
        : h('button', {
          key: item.key, type: 'button', role: 'menuitem', className: 'bt-pmenu-item',
          onClick: () => { setOpen(false); item.onPick() },
        }, h(item.icon), h('span', null, item.label))))) : null)
}

// The menu builders in side-model.js give keys; each maps to an icon, a label
// and the action it runs. A rejected action surfaces through reportError.
export function menuItemFor(key, actions, subject) {
  const report = run => () => { void Promise.resolve(run()).catch(error => actions.reportError(error, 'panel-menu')) }
  switch (key) {
    case 'browser': return { key, icon: GlobeIcon, label: t('Browser'), onPick: report(() => actions.openBrowser(subject)) }
    case 'new-tab': return { key, icon: PlusTabIcon, label: t('New browser tab'), onPick: report(() => actions.browserNewTab(subject)) }
    case 'side': return { key, icon: SideIcon, label: t('Side chat'), onPick: report(() => actions.newSideChat(subject)) }
    case 'terminal': return { key, icon: TerminalIcon, label: t('Terminal'), onPick: report(() => actions.newTerminal()) }
    case 'files': return { key, icon: FolderIcon, label: t('Files'), onPick: report(() => actions.openFiles()) }
    default: return { sep: true }
  }
}

// A side chat tab names itself after its first question.
const sideTitle = chat => chat?.entries?.[0]?.question?.trim() || t('Side chat')

// The strip across the panel's top: the Bot's own tab first (the details view,
// collapsed), then one tab per browser page, one per side chat, then `···` and
// close.
function PanelStrip({ bot, subject, view, ids, active, sides, side, canBrowse, reading, onView, actions, useBrowserPages }) {
  const pages = useBrowserPages(map => map)
  const wrap = useRef(null)
  const ind = useRef(null)
  const spot = useRef(null)
  const under = useRef(null)
  const watcher = useRef(null)
  // The capsule sits under the active tab; its two edges move on different springs.
  useLayoutEffect(() => {
    const box = wrap.current
    const capsule = ind.current
    if (!box || !capsule) return undefined
    const node = view === 'details'
      ? box.querySelector('.bt-ptab-bot')
      : view === 'side'
        ? box.querySelector(`[data-side="${side}"]`)
        : box.querySelector(`[data-tab="${active}"]`)
    if (under.current !== node) {
      if (under.current) watcher.current?.unobserve(under.current)
      under.current = node
      if (node) watcher.current?.observe(node)
    }
    if (!node) { capsule.style.opacity = '0'; spot.current = null; return undefined }
    // The Bot tab is pinned at the strip's start; showing it scrolls the pages back
    // so the capsule and the pinned tab line up.
    if (view === 'details') box.scrollLeft = 0
    else node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    const to = { left: node.offsetLeft, right: box.offsetWidth - node.offsetLeft - node.offsetWidth }
    const from = spot.current
    spot.current = to
    capsule.style.opacity = '1'
    capsule.style.left = `${to.left}px`
    capsule.style.right = `${to.right}px`
    if (from === null || (from.left === to.left && from.right === to.right) || reducedMotion()) return undefined
    const ahead = to.left > from.left ? 'right' : 'left'
    const behind = ahead === 'right' ? 'left' : 'right'
    const lead = capsule.animate([{ [ahead]: `${from[ahead]}px` }, { [ahead]: `${to[ahead]}px` }], { duration: SPRING_LEAD.duration, easing: SPRING_LEAD.easing })
    const trail = capsule.animate([{ [behind]: `${from[behind]}px` }, { [behind]: `${to[behind]}px` }], { duration: SPRING_TRAIL.duration, easing: SPRING_TRAIL.easing })
    return () => { lead.cancel(); trail.cancel() }
  })
  // A drag resizes the strip without a render; the capsule's right edge keeps to its tab.
  // The tab itself is watched too — its width can still change after the measure.
  useEffect(() => {
    const box = wrap.current
    if (!box) return undefined
    const observer = new ResizeObserver(() => {
      const node = under.current
      const capsule = ind.current
      if (!node?.isConnected || !capsule || spot.current === null) return
      spot.current = { left: node.offsetLeft, right: box.offsetWidth - node.offsetLeft - node.offsetWidth }
      capsule.style.left = `${spot.current.left}px`
      capsule.style.right = `${spot.current.right}px`
    })
    watcher.current = observer
    observer.observe(box)
    if (under.current) observer.observe(under.current)
    return () => { watcher.current = null; observer.disconnect() }
  }, [])
  const items = stripMenuKeys({
    canBrowse,
    canTerminal: actions.canOpenTerminal?.() === true,
    canFiles: actions.canOpenFiles?.() === true,
  }).map(key => menuItemFor(key, actions, subject))
  return h('div', { className: 'bt-ptabs', role: 'tablist', 'aria-label': t('Panel tabs') },
    h('div', { className: 'bt-ptabs-in', ref: wrap },
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': view === 'details', className: 'bt-ptab bt-ptab-bot',
        title: bot.name, onClick: () => onView('details'),
      },
        h(BotMark, { bot, size: 20, state: reading ? 'searching' : 'idle' }),
        view === 'details' ? h('span', { className: 'bt-ptab-name' }, bot.name) : null),
      ids.map((tabId) => {
        const page = pages[tabId] ?? EMPTY_PAGE
        const on = view === 'browser' && tabId === active
        return h('button', {
          key: tabId, type: 'button', role: 'tab', 'aria-selected': on, 'data-tab': tabId, className: 'bt-ptab',
          title: page.url || t('New tab'),
          onClick: () => { actions.browserActivate(bot.id, tabId); onView('browser') },
          onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); void actions.browserCloseTab(bot.id, tabId) } },
        },
          h(Favicon, { src: page.favicon, className: 'bt-ptab-fav' }),
          h('span', { className: 'bt-ptab-title' }, tabLabel(page)),
          h('span', {
            className: 'bt-ptab-x', role: 'button', 'aria-label': t('Close tab'), title: t('Close tab'),
            onClick: (event) => { event.stopPropagation(); void actions.browserCloseTab(bot.id, tabId) },
          }, '×'))
      }),
      sides.map((chat) => {
        const on = view === 'side' && chat.id === side
        return h('button', {
          key: chat.id, type: 'button', role: 'tab', 'aria-selected': on, 'data-side': chat.id, className: 'bt-ptab bt-ptab-side',
          title: sideTitle(chat),
          onClick: () => actions.openSideChat(subject, chat.id),
          onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); void actions.closeSideChat(chat.id) } },
        },
          h('span', { className: 'bt-ptab-globe', 'aria-hidden': true }, h(SideIcon)),
          h('span', { className: 'bt-ptab-title' }, sideTitle(chat)),
          h('span', {
            className: 'bt-ptab-x', role: 'button', 'aria-label': t('Close side chat'), title: t('Close side chat'),
            onClick: (event) => { event.stopPropagation(); void actions.closeSideChat(chat.id) },
          }, '×'))
      }),
      h('span', { ref: ind, className: 'bt-ptab-ind', 'aria-hidden': true })),
    // The `···` and Close stay outside the scrolling tabs, so a narrow panel keeps both.
    h(PanelMenu, { items, className: 'bt-ptab-new', 'aria-label': t('More') }),
    h('button', { type: 'button', className: 'bt-icon-btn bt-ptab-close', 'aria-label': t('Close panel'), title: t('Close panel'), onClick: () => actions.closePanel() }, h(CloseIcon)))
}

// The browser view: toolbar (back, forward, reload/stop, address) over the frame
// the guest webview covers.
function BrowserView({ bot, tabId, leaving, landed, actions, useBrowserPages, hold }) {
  const page = useBrowserPages(pages => pages[tabId ?? '']) ?? EMPTY_PAGE
  const frame = useRef(null)
  const input = useRef(null)
  const [draft, setDraft] = useState(null)
  const [covered, setCovered] = useState(false)

  // Cookie imports (the desktop app's bridge only): 'menu' lists the sources; a card
  // stage then runs running → preview → result | error above the guest.
  const imports = actions.browserImport
  const [flow, setFlow] = useState(null)
  // A mirrored flow: the cleanup on leaving the tab or the panel can still cancel
  // an unconfirmed pending import.
  const flowRef = useRef(null)
  const [sources, setSources] = useState(null)
  const [busy, setBusy] = useState(false)
  const setFlowTracked = (next) => {
    flowRef.current = typeof next === 'function' ? next(flowRef.current) : next
    setFlow(flowRef.current)
  }

  // The guest goes on screen once the panel has landed and settled on its width,
  // and only over a page: the empty, error and import states are the panel's own.
  const showGuest = landed && !leaving && !covered && Boolean(page.url) && !page.error && flow === null

  useEffect(() => {
    const update = () => {
      const panel = frame.current?.getBoundingClientRect()
      const overlaps = panel && [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"]')]
        .some(element => rectsOverlap(panel, element.getBoundingClientRect()))
      setCovered(Boolean(overlaps))
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'data-leaving'] })
    window.addEventListener('resize', update)
    update()
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [])

  // Leaving the tab or the panel abandons an unconfirmed import.
  useEffect(() => {
    setFlowTracked(null)
    return () => {
      const id = typeof flowRef.current === 'object' && flowRef.current !== null ? flowRef.current.id : null
      if (id) void imports?.cancel(id).catch(() => {})
    }
    // The flow controls live in this component; the effect re-runs only per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  const openImport = () => {
    setFlowTracked('menu')
    if (sources === null) void imports.sources().then(setSources, () => setSources([]))
  }
  const showPicked = (r) => {
    if (r?.id) setFlowTracked({ stage: 'preview', id: r.id, preview: r.preview, restarted: r.restarted === true })
    else if (r?.error) setFlowTracked({ stage: 'error', message: importError(r.error) })
    else setFlowTracked(null)
  }
  const job = async (work) => {
    setBusy(true)
    try { await work() } catch (error) { setFlowTracked({ stage: 'error', message: String(error?.message ?? error) }) } finally { setBusy(false) }
  }
  const pickFile = () => job(async () => showPicked(await imports.pick()))
  const pickSource = (source) => job(async () => {
    const r = await imports.live(source.id)
    if (r?.running) setFlowTracked({ stage: 'running', source })
    else showPicked(r)
  })
  const closeAndImport = () => job(async () => showPicked(await imports.live(flowRef.current?.source?.id, true)))
  const applyImport = () => job(async () => {
    const report = await imports.apply(bot.id, flowRef.current?.id)
    setFlowTracked((current) => ({ stage: 'result', report, label: current?.preview?.source?.label ?? null }))
  })
  const cancelImport = () => {
    const id = typeof flow === 'object' && flow !== null ? flow.id : null
    setFlowTracked(null)
    if (id) void imports?.cancel(id).catch(() => {})
  }
  useLayoutEffect(() => {
    const element = frame.current
    if (!element || leaving || !tabId) { void actions.browserShow(null); return undefined }
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = 0
      const box = element.getBoundingClientRect()
      void actions.browserShow(tabId, showGuest ? { left: box.left, top: box.top, width: box.width, height: box.height } : null)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    // Measured inside the observer callback, where layout is fresh: the guest moves in
    // the same frame as the panel edge instead of one behind it.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [tabId, showGuest, leaving])

  // A fresh tab starts on its address bar.
  useEffect(() => {
    setDraft(null)
    if (landed && !page.url) input.current?.focus()
  }, [tabId, landed])

  const go = (event) => {
    event.preventDefault()
    const text = draft ?? ''
    if (text.trim() === '') return
    setDraft(null)
    input.current?.blur()
    void actions.browserNavigate(tabId, text).then((opened) => { if (opened) actions.browserFocus(tabId) })
  }

  const editing = draft !== null
  const secure = /^https:/i.test(page.url)
  return h('div', { className: 'bt-panel-view bt-panel-browser', 'aria-label': t("{name}'s browser", { name: bot.name }) },
    actions.browserTakeover ? h('div', { className: 'bt-browser-takeover', 'data-held': hold?.by === 'user' || undefined },
      h('span', null, hold?.by === 'user' ? t('You control this browser') : hold?.by === 'bot' ? t('The Bot handed this browser to you: {reason}', { reason: hold.reason }) : t('The Bot controls this browser')),
      hold?.by
        ? h('button', { type: 'button', onClick: () => void actions.browserGiveBack(bot.id) }, t('Give back'))
        : h('span', { className: 'bt-browser-takeover-actions' },
            h('button', { type: 'button', onClick: () => void actions.browserTakeover(bot.id) }, t('Take over')),
            h('button', { type: 'button', onClick: () => void actions.browserStop(bot.id) }, t('Stop')))) : null,
    h('div', { className: 'bt-browser-bar' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), title: t('Back'), disabled: !page.canGoBack, onClick: () => actions.browserCommand(tabId, 'back') }, h(BackIcon)),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Forward'), title: t('Forward'), disabled: !page.canGoForward, onClick: () => actions.browserCommand(tabId, 'forward') }, h(ForwardIcon)),
      h('button', {
        type: 'button', className: 'bt-icon-btn', disabled: !page.url,
        'aria-label': page.loading ? t('Stop') : t('Reload'), title: page.loading ? t('Stop') : t('Reload'),
        onClick: () => actions.browserCommand(tabId, page.loading ? 'stop' : 'reload'),
      }, h(page.loading ? StopIcon : ReloadIcon)),
      h('form', { className: 'bt-browser-address', onSubmit: go, 'data-editing': editing || undefined },
        h('span', { className: 'bt-browser-scheme', 'aria-hidden': true }, h(secure && !editing ? LockIcon : GlobeIcon)),
        h('input', {
          ref: input, type: 'text', spellCheck: false, autoComplete: 'off', 'aria-label': t('Address'),
          placeholder: t('Search or enter address'),
          value: editing ? draft : shortAddress(page.url),
          onFocus: (event) => { setDraft(page.url); const target = event.target; requestAnimationFrame(() => target.select()) },
          onBlur: () => setDraft(null),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); event.currentTarget.blur() } },
        })),
      h('button', {
        type: 'button', className: 'bt-icon-btn', 'aria-label': t('New browser tab'), title: t('New browser tab'),
        onClick: () => actions.browserNewTab(bot.id),
      }, h(PlusTabIcon)),
      imports ? h('button', {
        type: 'button', className: 'bt-icon-btn bt-import-btn', 'aria-label': t('Import cookies'), title: t('Import cookies'),
        'aria-expanded': flow === 'menu', disabled: busy,
        onClick: () => { if (flow === 'menu') setFlowTracked(null); else openImport() },
      }, h(ImportIcon)) : null,
      page.loading ? h('span', { className: 'bt-browser-progress', 'aria-hidden': true }) : null),
    h('div', { ref: frame, className: 'bt-browser-frame', 'data-guest': showGuest || undefined },
      flow === 'menu' ? h(ImportMenu, { sources, busy, onFile: pickFile, onSource: pickSource, onClose: () => setFlowTracked(null) }) : null,
      typeof flow === 'object' && flow !== null
        ? h(ImportCard, { flow, page, busy, onApply: applyImport, onCancel: cancelImport, onCloseAndImport: closeAndImport, onDone: () => setFlowTracked(null), onReload: () => actions.browserCommand(tabId, 'reload') })
        : null,
      flow === null && page.error
        ? h('div', { className: 'bt-browser-empty' },
            h('div', { className: 'bt-browser-empty-title' }, t('This page didn’t load')),
            h('div', { className: 'bt-browser-empty-text' }, t(page.error)),
            page.url ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => { void actions.browserNavigate(tabId, page.url) } }, t('Try again')) : null)
        : flow === null && !page.url
          ? h('div', { className: 'bt-browser-empty' },
              h(BotMark, { bot, size: 48, state: 'idle', live: true }),
              h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
              h('div', { className: 'bt-browser-empty-text' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
              imports ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: openImport }, t('Import cookies')) : null)
          : null))
}


function importError(error) {
  if (error === 'too-large') return t('That file is too large to be a cookie export.')
  if (error === 'unreadable') return t('That file could not be read.')
  if (error === 'app-bound') return t('This browser encrypts its cookies so only it can read them. Export them to a file first, then import that file.')
  return String(error)
}

// The sources popover: a cookie file, then every importable browser profile.
function ImportMenu({ sources, busy, onFile, onSource, onClose }) {
  useEffect(() => {
    const close = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return h('div', { className: 'bt-import-menu', role: 'menu', 'aria-label': t('Import cookies') },
    h('div', { className: 'bt-import-menu-title' }, t('Import cookies')),
    h('button', { type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy, onClick: onFile },
      h(FileIcon, { className: 'bt-import-item-icon' }),
      h('span', { className: 'bt-import-item-name' }, t('From a file…')),
      h('span', { className: 'bt-import-item-sub' }, t('cookies.txt, JSON, storageState'))),
    sources === null
      ? h('div', { className: 'bt-import-menu-note' }, t('Loading…'))
      : sources.length === 0
        ? h('div', { className: 'bt-import-menu-note' }, t('No browsers found'))
        : sources.map((source) => h('button', {
          key: source.id, type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy,
          onClick: () => onSource(source),
        },
          h(WindowIcon, { className: 'bt-import-item-icon' }),
          h('span', { className: 'bt-import-item-name' }, source.label),
          h('span', { className: 'bt-import-item-sub' }, t('Copy of its cookies')))))
}

// The card that runs an import: close confirmation → preview → result | error.
function ImportCard({ flow, page, busy, onApply, onCancel, onCloseAndImport, onDone, onReload }) {
  const { stage } = flow
  if (stage === 'running') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('{name} is running', { name: flow.source.name })),
      h('div', { className: 'bt-import-text' }, t('It must close for a moment so its cookies can be copied. It will reopen with your tabs.')),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onCloseAndImport }, busy ? t('Closing…') : t('Close {name} and import', { name: flow.source.name })),
        h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')))))
  }
  if (stage === 'error') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('Import failed')),
      h('div', { className: 'bt-import-text' }, flow.message),
      h('div', { className: 'bt-import-actions' }, h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Close')))))
  }
  if (stage === 'result') {
    const { report } = flow
    const problems = [...(report.dropped ?? []), ...(report.failed ?? [])]
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, report.stored > 0 ? t('Imported {count} cookies', { count: report.stored }) : t('No cookies were stored')),
      flow.label ? h('div', { className: 'bt-import-sub' }, flow.label) : null,
      problems.length ? h('div', { className: 'bt-import-list' },
        problems.slice(0, 8).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
          h('span', { className: 'bt-import-line-name' }, item.name ?? '—'),
          h('span', { className: 'bt-import-line-reason' }, item.reason))),
        problems.length > 8 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: problems.length - 8 }))) : null) : null,
      h('div', { className: 'bt-import-actions' },
        page.url ? h('button', { type: 'button', className: 'bt-import-plain', onClick: onReload }, t('Reload the page')) : null,
        h('button', { type: 'button', className: 'bt-import-primary', onClick: onDone }, t('Done')))))
  }
  // stage === 'preview'
  const { preview } = flow
  return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
    h('div', { className: 'bt-import-title' }, t('Import {count} cookies', { count: preview.cookies })),
    h('div', { className: 'bt-import-sub' },
      preview.source?.label ?? '',
      flow.restarted ? ` · ${t('the browser was restarted')}` : ''),
    preview.sites.length ? h('div', { className: 'bt-import-list' },
      preview.sites.map((site) => h('div', { key: site.site, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-name' }, site.site),
        h('span', { className: 'bt-import-line-count' },
          t('{count}', { count: site.cookies }),
          site.session > 0 ? ` · ${t('{count} session', { count: site.session })}` : '')))) : null,
    preview.skipped.length ? h('div', { className: 'bt-import-list' },
      h('div', { className: 'bt-import-note' }, t('{count} skipped', { count: preview.skipped.length })),
      preview.skipped.slice(0, 5).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-name' }, item.name ?? item.where),
        h('span', { className: 'bt-import-line-reason' }, item.reason))),
      preview.skipped.length > 5 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: preview.skipped.length - 5 }))) : null) : null,
    preview.warnings.length ? h('details', { className: 'bt-import-warns' },
      h('summary', null, t('{count} adjusted', { count: preview.warnings.reduce((n, w) => n + w.count, 0) })),
      preview.warnings.map((w, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-reason' }, `${w.count} × ${w.message}`)))) : null,
    preview.notes.includes('session-cookies') ? h('div', { className: 'bt-import-note' }, t('Cookies without an expiry stay until the app closes.')) : null,
    preview.notes.includes('local-storage-left') ? h('div', { className: 'bt-import-note' }, t('Some sites also keep sign-in outside cookies; you may need to sign in again there.')) : null,
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onApply }, busy ? t('Importing…') : t('Import')),
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')))))
}

/**
 * One aside for the Bot's details, browser and side chats. `pane` is
 * `{ id, view: 'details'|'browser'|'side', renaming, tab, side }`; `id` is the
 * Session id the panel follows and `side` the open chat's id. Without the
 * Desktop bridge the browser view never shows; side chats need no bridge.
 */
export function BotPanel({ pane, leaving, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds }) {
  const bot = roster.byId[pane.id]
  const canBrowse = Boolean(bot && roster.browser === true && actions.browserShow)
  const sideChats = bot ? sideChatsOf(roster, bot.id) : []
  const sideChat = sideChats.find(chat => chat?.id === pane.side)
  const view = pane.view === 'browser' && canBrowse ? 'browser' : pane.view === 'side' && sideChat !== undefined ? 'side' : 'details'
  const tabState = useBrowserTabs(map => (bot ? (map[bot.id] ?? EMPTY_TABS) : EMPTY_TABS))
  const active = tabState.active
  const page = useBrowserPages(pages => (active ? pages[active] : null) ?? EMPTY_PAGE)
  const hold = useBrowserHolds?.(map => bot ? map[bot.id] ?? null : null) ?? null
  const root = useRef(null)
  const fly = useRef(null)
  const [landed, setLanded] = useState(false)
  const [settling, setSettling] = useState(false)
  const [width, setWidth] = useState(savedWidth)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  // While dragging or while the window resizes, width changes land at once.
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const instant = dragging || resizing
  const [reading, setReading] = useState(false)

  const overlay = overlayAt(view, viewport)
  const panelWidth = fitWidth(width ?? (view === 'browser' ? DEFAULT_WIDTH : DETAILS_WIDTH), widthRange(view, viewport))
  // Once the browser has shown, the Bot page keeps its width (up to DETAILS_MAX).
  useLayoutEffect(() => { if (view === 'browser' && width === null) setWidth(DEFAULT_WIDTH) }, [view, width])
  useLayoutEffect(() => { chatRoom.hold(instant) }, [instant])
  // A view switch that changes the width holds the guest back and pins both views to
  // the final width until the panel edge has settled. It is set while rendering, so the
  // switch's own commit is already pinned and the flying mark measures where its target
  // ends up, not where it sits before the pin.
  const [last, setLast] = useState({ view, width: panelWidth })
  if (last.view !== view || last.width !== panelWidth) {
    setLast({ view, width: panelWidth })
    if (last.view !== view) setSettling(last.width !== panelWidth && !instant)
  }
  // Such a switch gives the conversation its new width at once, so it reflows once
  // instead of every frame of the glide. Opening and closing glide it with the panel.
  const shownView = useRef(view)
  useLayoutEffect(() => {
    const switched = settling && shownView.current !== view
    shownView.current = view
    if (switched) chatRoom.hold(true)
    chatRoom.set(leaving || overlay ? null : panelWidth)
    if (switched) chatRoom.hold(false)
  }, [view, panelWidth, leaving, overlay])
  useEffect(() => () => { chatRoom.set(null); chatRoom.hold(false) }, [])
  useEffect(() => {
    let timer
    const onResize = () => {
      setResizing(true)
      setViewport(window.innerWidth)
      clearTimeout(timer)
      timer = setTimeout(() => setResizing(false), 160)
    }
    window.addEventListener('resize', onResize)
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [])
  useEffect(() => {
    if (!settling) return undefined
    const timer = setTimeout(() => setSettling(false), SPRING_SHAPE.duration + 40)
    return () => clearTimeout(timer)
  }, [settling, view])
  useEffect(() => {
    const timer = setTimeout(() => setLanded(true), 360)
    return () => clearTimeout(timer)
  }, [])

  // A Bot's strip restores as soon as the panel opens for it.
  useEffect(() => { if (canBrowse) actions.browserEnsure(bot.id) }, [bot?.id, canBrowse])
  // With the last tab closed the browser view folds back into the details view.
  useEffect(() => {
    if (view === 'browser' && (active === null || !tabState.ids.includes(active))) actions.setPanelView('details')
  }, [view, active, tabState.ids.length])
  // A side chat closed here or in another window folds back into details too.
  useEffect(() => {
    if (pane.view === 'side' && sideChat === undefined) actions.setPanelView('details')
  }, [pane.view, sideChat])
  // The guest leaves the screen while the details view is up, and on close.
  useEffect(() => {
    if (view !== 'browser' || leaving) void actions.browserShow?.(null)
  }, [view, leaving])
  useEffect(() => () => { void actions.browserShow?.(null) }, [])

  useEffect(() => {
    if (!page.readAt || Date.now() - page.readAt > READ_FLASH_MS) return undefined
    setReading(true)
    const timer = setTimeout(() => setReading(false), READ_FLASH_MS)
    return () => clearTimeout(timer)
  }, [page.readAt])

  // A view switch flies the Bot's mark between the drawer avatar and the strip,
  // and the outgoing view fades out over the incoming one at its own width.
  const beginSwitch = (next) => {
    if (reducedMotion()) return
    const panel = root.current
    const outgoing = panel?.querySelector('.bt-panel-view')
    if (outgoing) {
      const ghostEl = document.createElement('div')
      ghostEl.className = 'bt-panel-ghost'
      ghostEl.style.width = `${outgoing.offsetWidth}px`
      ghostEl.append(outgoing.cloneNode(true))
      outgoing.parentElement.append(ghostEl)
      void ghostEl.animate([
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.985)' },
      ], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {}).finally(() => ghostEl.remove())
    }
    const source = next === 'browser'
      ? panel?.querySelector('.bt-drawer-id .bt-mark')
      : panel?.querySelector('.bt-ptab-bot .bt-mark')
    if (source) fly.current = { node: source.cloneNode(true), from: source.getBoundingClientRect() }
  }
  const switchView = (next) => {
    if (next === view || leaving) return
    beginSwitch(next)
    actions.setPanelView(next)
  }
  // Every path into the browser view (globe, card, +) animates the same collapse.
  const panelActions = { ...actions }
  for (const name of ['openBrowser', 'browserNewTab', 'browserPick']) {
    if (actions[name]) panelActions[name] = (...args) => { if (view !== 'browser') beginSwitch('browser'); return actions[name](...args) }
  }
  for (const name of ['openSideChat', 'newSideChat']) {
    if (actions[name]) panelActions[name] = (...args) => { if (view !== 'side') beginSwitch('side'); return actions[name](...args) }
  }
  useLayoutEffect(() => {
    const move = fly.current
    if (!move) return
    fly.current = null
    const target = view === 'browser'
      ? root.current?.querySelector('.bt-ptab-bot .bt-mark')
      : root.current?.querySelector('.bt-drawer-id .bt-mark')
    if (!target || move.from.width === 0) return
    // A strip that has just appeared still grows from zero height; the target is
    // measured where it stands once the strip is full height.
    const growing = root.current.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'bt-strip-in')
    const at = growing.map(animation => animation.currentTime)
    for (const animation of growing) animation.currentTime = animation.effect.getComputedTiming().endTime
    const to = target.getBoundingClientRect()
    growing.forEach((animation, index) => { animation.currentTime = at[index] })
    const clone = move.node
    Object.assign(clone.style, {
      position: 'fixed', left: `${move.from.left}px`, top: `${move.from.top}px`,
      width: `${move.from.width}px`, height: `${move.from.height}px`, margin: '0',
      transformOrigin: '0 0', zIndex: '80', pointerEvents: 'none', visibility: '',
    })
    document.body.append(clone)
    target.style.visibility = 'hidden'
    const scale = to.width / move.from.width
    const anim = clone.animate([
      { transform: 'translate(0px, 0px) scale(1)' },
      { transform: `translate(${to.left - move.from.left}px, ${to.top - move.from.top}px) scale(${scale})` },
    ], { duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing, fill: 'forwards' })
    void anim.finished.catch(() => {}).finally(() => { clone.remove(); target.style.visibility = '' })
  }, [view, pane.id])

  // A drag writes the width into the panel's and the column's own inline styles each
  // frame (each restyles one element) and renders once, on release.
  const startResize = (event) => {
    if (event.button !== 0 || leaving || overlay) return
    event.preventDefault()
    const panel = root.current
    const grip = event.currentTarget
    grip.setPointerCapture?.(event.pointerId)
    const range = widthRange(view, window.innerWidth)
    const from = { x: event.clientX, width: panelWidth }
    let next = panelWidth
    setDragging(true)
    setSettling(false)
    chatRoom.hold(true)
    const columns = chatRoom.columns()
    for (const column of columns) column.style.setProperty('transition', 'none', 'important')
    const onMove = (move) => {
      next = fitWidth(from.width + from.x - move.clientX, range)
      panel.style.width = `${next}px`
      if (columns.length === 0) chatRoom.set(next)
      for (const column of columns) column.style.setProperty('margin-right', `${next}px`, 'important')
    }
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
    const onEnd = (end) => {
      if (end.type === 'pointerup') onMove(end)
      grip.removeEventListener('pointermove', onMove)
      for (const name of ends) grip.removeEventListener(name, onEnd)
      // Hand the width back to the rule and the panel's variable in the same frame.
      chatRoom.set(next)
      for (const column of columns) { column.style.removeProperty('margin-right'); column.style.removeProperty('transition') }
      panel.style.setProperty('--bt-panel-w', `${next}px`)
      panel.style.removeProperty('width')
      setDragging(false)
      if (next === from.width) return
      setWidth(next)
      try { localStorage.setItem(WIDTH_KEY, String(next)) } catch { /* storage unavailable */ }
    }
    grip.addEventListener('pointermove', onMove)
    for (const name of ends) grip.addEventListener(name, onEnd)
  }

  const hasStrip = panelHasStrip(canBrowse, tabState.ids.length, sideChats.length)
  return h('aside', {
    ref: root, className: 'bt-panel', 'data-view': view,
    'aria-label': view === 'browser' && bot ? t("{name}'s browser", { name: bot.name }) : view === 'side' ? t('Side chat') : t('Conversation details'),
    'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, 'data-settling': settling || undefined,
    'data-instant': instant || undefined, 'data-dragging': dragging || undefined, 'data-overlay': overlay || undefined, style: { '--bt-panel-w': `${panelWidth}px` },
    onAnimationEnd: (event) => { if (event.target === event.currentTarget) setLanded(true) },
  },
    leaving || overlay ? null : h('div', { className: 'bt-panel-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('Resize panel'), onPointerDown: startResize }),
    // Over the whole window while dragging: the cursor stays a resize cursor and the
    // pages underneath (the chat, the guest) see no pointer.
    dragging ? createPortal(h('div', { className: 'bt-drag-shield', 'aria-hidden': true }), document.body) : null,
    hasStrip ? h(PanelStrip, { bot, subject: pane.id, view, ids: tabState.ids, active, sides: sideChats, side: pane.side, canBrowse, reading, onView: switchView, actions: panelActions, useBrowserPages }) : null,
    view === 'browser' && bot
      ? h(BrowserView, { key: `browser:${active}`, bot, tabId: active, leaving, landed: landed && !settling, actions, useBrowserPages, hold })
      : view === 'side' && sideChat
        ? h('div', { key: `side:${sideChat.id}`, className: 'bt-panel-view' }, h(SideChatView, { subject: pane.id, chat: sideChat, actions: panelActions }))
        : h('div', { key: `details:${pane.id}:${pane.renaming ? 'rename' : ''}:${pane.tab ?? ''}`, className: 'bt-panel-view' },
            h(DetailsDrawer, {
              sessionId: pane.id, startRenaming: pane.renaming, startTab: pane.tab, hasStrip,
              roster, actions: panelActions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages,
            })))
}

export const BROWSER_CSS = `
.bt-panel{--bt-panel-view-fade:${SPRING_SHAPE.duration}ms}
.bt-ptabs{position:relative;display:flex;align-items:center;height:44px;flex:none;border-bottom:.5px solid var(--bt-line);padding:0 6px;gap:0;animation:bt-strip-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-strip-in{from{height:0;opacity:0}}
.bt-ptabs-in{position:relative;display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:4px 2px;scroll-padding-left:48px;mask-image:linear-gradient(to right,#000,#000 calc(100% - 10px),transparent)}
.bt-ptabs-in>.bt-ptab-bot{position:sticky;left:0;z-index:2;background:var(--bt-main)}
.bt-ptabs-in>.bt-ptab-bot[aria-selected=true]{background:transparent}
.bt-ptabs-in::-webkit-scrollbar{display:none}
.bt-ptab{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px;height:32px;max-width:180px;padding:0 8px;flex:none;border:0;border-radius:9px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:color .12s ease}
.bt-ptab:hover{color:var(--bt-ink)}
.bt-ptab[aria-selected=true]{color:var(--bt-ink)}
.bt-ptab-bot{padding:0 7px}
.bt-ptab-bot .bt-mark{flex:none}
.bt-ptab-name{max-width:96px;overflow:hidden;text-overflow:ellipsis;font-weight:500;animation:bt-ptab-label .18s ease}
@keyframes bt-ptab-label{from{opacity:0;filter:blur(4px)}}
.bt-ptab-fav{width:14px;height:14px;flex:none;border-radius:3px;object-fit:cover;color:var(--bt-ink-3)}
.bt-ptab-globe{display:inline-flex}
.bt-ptab-globe svg{width:14px;height:14px}
.bt-ptab-title{max-width:140px;overflow:hidden;text-overflow:ellipsis}
.bt-ptab-x{flex:none;width:16px;height:16px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;color:var(--bt-ink-3);opacity:0;pointer-events:none;transition:opacity .12s ease,background-color .12s ease}
.bt-ptab:hover .bt-ptab-x,.bt-ptab[aria-selected=true] .bt-ptab-x{opacity:1;pointer-events:auto}
.bt-ptab-x:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-ptab-new{position:relative;z-index:1;flex:none;width:28px;height:32px;border:0;border-radius:9px;background:none;color:var(--bt-ink-3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-ptab-new:hover{color:var(--bt-ink)}
.bt-ptab-new svg{width:15px;height:15px}
.bt-ptab-ind{position:absolute;top:4px;bottom:4px;border-radius:9px;background:var(--bt-hover);opacity:0;pointer-events:none;z-index:0;transition:opacity .15s ease}
.bt-ptab-close{flex:none;margin-left:2px}
.bt-panel-ghost{position:absolute;top:calc(44px + var(--bt-caption-band,0px));right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:2}
.bt-panel-ghost>.bt-panel-view{position:absolute;inset:0}
.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column;animation:bt-panel-view-in .22s cubic-bezier(.16,1,.3,1)}
@keyframes bt-panel-view-in{from{opacity:0}}
/* While the panel changes width its views keep their final width on the right edge, so
   only the panel edge moves and nothing inside reflows frame by frame. */
.bt-panel[data-settling]{overflow:hidden}
.bt-panel[data-settling]>.bt-ptabs,.bt-panel[data-settling]>.bt-panel-view{flex-shrink:0;align-self:flex-end;box-sizing:border-box;width:calc(var(--bt-panel-w,320px) - .5px)}
.bt-panel-browser{position:relative}
.bt-browser-bar{position:relative;display:flex;align-items:center;gap:2px;height:52px;padding:0 10px 0 12px;flex:none;border-bottom:.5px solid var(--bt-line)}
.bt-browser-takeover{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:var(--bt-hover);border-bottom:.5px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}
.bt-browser-takeover[data-held]{background:var(--bt-active)}
.bt-browser-takeover-actions{display:flex;gap:6px}
.bt-browser-takeover button{border:1px solid var(--bt-line-2);border-radius:8px;padding:5px 9px;background:var(--bt-main);color:var(--bt-ink);font:inherit;cursor:pointer}
.bt-browser-bar .bt-icon-btn:disabled{opacity:.35;cursor:default;background:none}
.bt-browser-address{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:32px;margin:0 4px;padding:0 12px;border-radius:999px;background:var(--bt-hover);border:.5px solid transparent;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-browser-address:hover{background:var(--bt-active)}
.bt-browser-address[data-editing]{background:var(--bt-main);border-color:var(--bt-line-2);box-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
.bt-browser-scheme{display:inline-flex;color:var(--bt-ink-3);flex:none}
.bt-browser-scheme svg{width:14px;height:14px}
.bt-browser-address input{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;padding:0;text-overflow:ellipsis}
.bt-browser-address input::placeholder{color:var(--bt-ink-3)}
.bt-browser-progress{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;pointer-events:none}
.bt-browser-progress::after{content:"";position:absolute;inset:0;width:40%;background:var(--bt-accent,#4D6BFE);border-radius:2px;animation:bt-browser-load 1.1s cubic-bezier(.4,0,.2,1) infinite}
@keyframes bt-browser-load{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.bt-browser-frame{position:relative;flex:1;min-height:0;background:var(--bt-main)}
.bt-browser-frame[data-guest]{background:#fff}
.bt-browser-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;animation:bt-foot-in .3s ease}
.bt-browser-empty-title{font-size:15px;line-height:22px;font-weight:500;margin-top:6px}
.bt-browser-empty-text{max-width:300px;font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-browser-retry{margin-top:6px;height:32px;padding:0 14px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-browser-retry:hover{background:var(--bt-hover)}
.bt-bcards{display:flex;flex-direction:column;gap:12px}
.bt-bcard{position:relative;border:.5px solid var(--bt-line-2);border-radius:12px;overflow:hidden;background:var(--bt-main);animation:bt-bcard-in .24s cubic-bezier(.16,1,.3,1) both;transition:border-color .12s ease,box-shadow .12s ease}
@keyframes bt-bcard-in{from{opacity:0;filter:blur(4px);transform:translateY(4px)}}
.bt-bcard[data-active]{border-color:var(--bt-accent,#4D6BFE);box-shadow:0 0 0 1px var(--bt-accent,#4D6BFE)}
.bt-bcard-shot{position:relative;display:block;width:100%;aspect-ratio:16/10;border:0;background:var(--bt-hover);padding:0;cursor:pointer}
.bt-bcard-blank{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--bt-ink-3);font-size:12px}
.bt-bcard-blank svg{width:20px;height:20px}
.bt-bcard-preview{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;padding:14px 16px;text-align:left;background:linear-gradient(to bottom,var(--bt-main),var(--bt-hover));overflow:hidden}
.bt-bcard-ptitle{font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-excerpt{font-size:12px;line-height:17px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-row{display:flex;align-items:center;gap:7px;padding:8px 10px;min-width:0}
.bt-bcard-fav{width:14px;height:14px;flex:none;border-radius:3px;color:var(--bt-ink-3)}
.bt-bcard-row svg.bt-bcard-fav{width:14px;height:14px}
.bt-bcard-title{flex:1;min-width:0;font-size:12.5px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink)}
.bt-bcard-host{flex:none;font-size:11px;line-height:15px;color:var(--bt-ink-3);max-width:38%;overflow:hidden;text-overflow:ellipsis}
.bt-bcard-x{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:7px;background:color-mix(in srgb,var(--bt-main) 88%,transparent);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s ease;backdrop-filter:blur(4px)}
.bt-bcard:hover .bt-bcard-x{opacity:1;pointer-events:auto}
.bt-bcard-new{display:flex;align-items:center;justify-content:center;gap:6px;height:40px;border:.5px dashed var(--bt-line-2);border-radius:12px;background:none;color:var(--bt-ink-3);font:inherit;font-size:12.5px;cursor:pointer}
.bt-bcard-new:hover{color:var(--bt-ink);border-color:var(--bt-ink-3)}
.bt-bcard-new svg{width:14px;height:14px}
.bt-browser-empty-mark{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
/* Cookie imports */
.bt-import-menu{position:absolute;top:6px;right:6px;z-index:6;width:236px;padding:6px;border-radius:16px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 32px -8px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06);animation:bt-bcard-in .18s cubic-bezier(.16,1,.3,1) both}
.bt-import-menu-title{padding:6px 10px 8px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--bt-ink-3)}
.bt-import-item{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:8px 10px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.bt-import-item:hover{background:var(--bt-hover)}
.bt-import-item:disabled{opacity:.5;cursor:default}
.bt-import-item-icon{flex:none;color:var(--bt-ink-3)}
.bt-import-item-icon svg,.bt-import-item svg{width:15px;height:15px}
.bt-import-item-name{flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-sub{flex:1;min-width:0;text-align:right;font-size:11px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-menu-note{padding:8px 10px 10px;font-size:12px;color:var(--bt-ink-3)}
.bt-import-card{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bt-main);overflow:auto;animation:bt-foot-in .2s ease}
.bt-import-box{width:100%;max-width:340px;max-height:100%;display:flex;flex-direction:column;gap:10px;padding:20px;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-main);box-shadow:0 12px 36px -12px rgba(0,0,0,.14);overflow:auto}
.bt-import-title{font-size:15px;line-height:21px;font-weight:600}
.bt-import-sub{font-size:12px;line-height:17px;color:var(--bt-ink-3);margin-top:-6px}
.bt-import-text{font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-import-list{max-height:180px;overflow:auto;border:.5px solid var(--bt-line);border-radius:10px;padding:4px 10px}
.bt-import-line{display:flex;align-items:baseline;gap:8px;padding:4px 0;min-width:0}
.bt-import-line-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--bt-ink)}
.bt-import-line-count{flex:1;min-width:0;text-align:right;font-size:11.5px;color:var(--bt-ink-3);white-space:nowrap}
.bt-import-line-reason{flex:1;min-width:0;font-size:11.5px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-import-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-import-warns{font-size:12px;color:var(--bt-ink-3)}
.bt-import-warns summary{cursor:pointer;padding:2px 0}
.bt-import-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.bt-import-primary{height:32px;padding:0 16px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-primary:disabled{opacity:.55;cursor:default}
.bt-import-plain{height:32px;padding:0 14px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-plain:hover{background:var(--bt-hover)}
.bt-import-plain:disabled{opacity:.55;cursor:default}
/* A viewport too narrow to leave the conversation its room: the panel covers it,
   and its close controls get a touch-sized target. */
.bt-panel[data-overlay]{width:100vw}
.bt-panel[data-overlay] .bt-ptab-close,.bt-panel[data-overlay] .bt-drawer-top .bt-round{width:44px;height:44px}
/* Touch: the hidden-but-tappable tab and card close buttons stay visible at a
   finger-sized target instead. */
@media (hover:none){
  .bt-ptab-x,.bt-bcard-x{opacity:1;pointer-events:auto;width:44px;height:44px}
  .bt-ptab-close{width:44px;height:44px}
}
@media (prefers-reduced-motion:reduce){.bt-ptabs,.bt-panel-view,.bt-bcard,.bt-ptab-name{animation:none}}
`
