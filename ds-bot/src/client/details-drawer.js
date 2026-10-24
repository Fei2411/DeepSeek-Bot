import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { isMainOf } from './sources.js'
import { HEADER, currentPart, runStatsOf, stripHeader, usageOf } from './text.js'
import { PlusIcon, ShareIcon, CloseIcon, ChevronLeftIcon, GearIcon } from './icons.js'
import { botState, BotMark, BotAvatar } from './mark.js'
import { GlobeIcon, Favicon, PanelMenu, menuItemFor } from './browser-pane.js'
import { drawerMenuKeys } from './side-model.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm } from './bot-settings.js'
import { GroupSettingsForm, ROOM_MODES, roomSubtitle, shownMode } from './group-settings.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { FolderMenu } from './folder-menu.js'
import { MemoryRow } from './memory-panel.js'
import { ScheduleSummary } from './schedules.js'
import { useGlide, useMorph } from './motion.js'
import { MemberApprovals, MemberState, StopMemberWork, useMemberWork, workState } from './member-status.js'
import { PermissionPicker, presetDanger, presetName } from './permission-picker.js'
import { t } from './i18n.js'

function transcriptOf(list, id, name, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  const lines = []
  for (const entry of outline) {
    if (hiddenTurns.includes(entry.turn)) continue
    if (entry.prompt && !HEADER.test(entry.prompt)) lines.push(`**${t('You')}:** ${entry.prompt.trim()}`)
    if (entry.response) lines.push(`**${name}:** ${stripHeader(entry.response).trim()}`)
  }
  return lines.join('\n\n')
}

const TAB_LABELS = { details: 'Details', browser: 'Browser' }

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const shortUrl = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
const EMPTY_TABS = { ids: [], active: null }

// The Bot's permission preset, from the presets DeepSeek Harness offers.
function PermissionRow({ bot, roster, actions, run }) {
  const catalog = roster.permissions
  if (!catalog?.options?.length) return null
  return h('div', { className: 'bt-drawer-permission' },
    h('div', { className: 'bt-section-title' }, t('Permissions')),
    // A Bot without its own preset may run on another one set in DSH, so its first pick always applies.
    h(PermissionPicker, { catalog, saved: bot.permission ?? catalog.defaultPreset, repick: bot.permission === undefined, onPick: permission => run(actions.updateBot(bot.id, { permission })) }))
}

// The current part's turns, speed, cache hits and context, for a window without DSH's
// status bar (actions.runStats). It reads them again when a turn starts or ends.
function RunStats({ bot, part, running, actions }) {
  const [values, setValues] = useState(null)
  useEffect(() => {
    if (!actions.runStats) return undefined
    let current = true
    actions.runStats(bot.id).then(
      (next) => { if (current) setValues(next) },
      // The line stays as it was until the next read works.
      () => {},
    )
    return () => { current = false }
  }, [bot.id, part, running])
  const shown = runStatsOf(values)
  if (shown.length === 0) return null
  return h('div', { className: 'bt-run-stats' },
    shown.map((entry, index) => h(Fragment, { key: entry.key },
      index > 0 ? h('span', { className: 'bt-run-sep', 'aria-hidden': true }, '·') : null,
      h('span', { title: entry.title }, entry.text))))
}

// The Bot's browser inside the details page: its tabs as small window cards in the
// desktop apps, a pointer there on web.
function BrowserCards({ bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) {
  const state = useBrowserTabs(map => map[bot.id] ?? EMPTY_TABS)
  const pages = useBrowserPages(map => map)
  useEffect(() => { actions.browserEnsure?.(bot.id) }, [bot.id])
  if (roster.browser !== true || !actions.browserShow) {
    return h('div', { className: 'bt-muted' }, t('The browser is in DSH Desktop and the DeepSeek Bot app.'))
  }
  if (state.ids.length === 0) {
    return h('div', { className: 'bt-browser-empty-mark' },
      h(BotMark, { bot, size: 40, state: 'idle', live: true }),
      h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
      h('div', { className: 'bt-muted' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
      h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openBrowser(sessionId) }, t('Open browser')))
  }
  return h('div', { className: 'bt-bcards' },
    state.ids.map((tabId, index) => {
      const page = pages[tabId] ?? {}
      const label = page.title || shortUrl(page.url) || t('New tab')
      return h('div', { key: tabId, className: 'bt-bcard', 'data-active': state.active === tabId || undefined, style: { animationDelay: `${index * 30}ms` } },
        h('button', { type: 'button', className: 'bt-bcard-shot', 'aria-label': t('Open {title}', { title: label }), title: page.url, onClick: () => actions.browserPick(sessionId, tabId) },
          page.excerpt
            ? h('span', { className: 'bt-bcard-preview' },
                h('span', { className: 'bt-bcard-ptitle' }, label),
                h('span', { className: 'bt-bcard-excerpt' }, page.excerpt))
            : h('span', { className: 'bt-bcard-blank' }, h(GlobeIcon), h('span', null, label))),
        h('button', {
          type: 'button', className: 'bt-bcard-x', 'aria-label': t('Close tab'), title: t('Close tab'),
          onClick: () => { void actions.browserCloseTab(bot.id, tabId) },
        }, '×'),
        h('div', { className: 'bt-bcard-row' },
          h(Favicon, { src: page.favicon, className: 'bt-bcard-fav' }),
          h('span', { className: 'bt-bcard-title' }, label),
          page.url ? h('span', { className: 'bt-bcard-host' }, hostOf(page.url)) : null))
    }),
    h('button', { type: 'button', className: 'bt-bcard-new', style: { animationDelay: `${state.ids.length * 30}ms` }, onClick: () => actions.browserNewTab(sessionId) }, h(PlusIcon), t('New tab')))
}

// About: a Bot's instructions or a group's notice in the overview, folded to five lines.
function About({ text, title = 'About' }) {
  const [open, setOpen] = useState(false)
  const long = text.split('\n').length > 5 || text.length > 240
  const body = useRef(null)
  useMorph(body, open)
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t(title)),
    h('div', { ref: body, className: 'bt-about', 'data-open': open || undefined }, text),
    long ? h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(value => !value) }, open ? t('Show less') : t('Show more')) : null)
}

// A group's face in its details: its first members side by side, each on a disc that
// cuts into the one before, and how many more there are.
const PILE_MAX = 4
function MemberPile({ room, roster }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const shown = members.length > PILE_MAX ? members.slice(0, PILE_MAX - 1) : members
  const more = members.length - shown.length
  return h('span', { className: 'bt-pile', 'aria-hidden': true },
    shown.map((bot, index) => h('span', { key: bot.id, className: 'bt-pile-face', style: { animationDelay: `${index * 40}ms` } }, h(BotMark, { bot, size: 44, live: true }))),
    more > 0 ? h('span', { key: 'more', className: 'bt-pile-face bt-pile-more', style: { animationDelay: `${shown.length * 40}ms` } }, `+${more}`) : null)
}

const markOf = entry => (entry?.state === 'ask' ? 'alert' : entry?.state === 'work' ? workState(entry.doing) : 'idle')

// One member: its mark, name and what it is doing on one surface that opens its chat;
// Stop beside it while it works here, and the approvals it waits on below.
function MemberRow({ member, entry, room, roster, actions }) {
  return h('div', { role: 'listitem', className: 'bt-member' },
    h('div', { className: 'bt-member-row' },
      h('button', { type: 'button', className: 'bt-member-open', title: t("Open {name}'s chat", { name: member.name }), onClick: () => actions.openSession(member.id) },
        h(BotMark, { bot: member, size: 32, state: markOf(entry) }),
        h('span', { className: 'bt-member-text' },
          h('span', { className: 'bt-member-line' },
            h('span', { className: 'bt-member-name' }, member.name),
            room.admin === member.id ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
          h(MemberState, { entry, bot: member, room, roster }))),
      h(StopMemberWork, { entry, bot: member, room, actions })),
    h(MemberApprovals, { entry, bot: member, actions }))
}

// A group's overview: what members read, who is in it, who answers, and what it
// remembers. Changes are made in its settings.
function GroupOverview({ room, roster, actions, usage, useWork, openSettings }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const { entries } = useMemberWork(room, useWork)
  return [
    room.notice
      ? h(About, { key: 'notice', title: 'Notice', text: room.notice })
      : h('button', { key: 'notice', type: 'button', className: 'bt-more', onClick: openSettings }, t('Add a notice in group settings')),
    h('div', { key: 'members' },
      h('div', { className: 'bt-section-title' }, t('Members · {count}', { count: members.length })),
      h('div', { className: 'bt-members', role: 'list' }, members.map(member => h(MemberRow, {
        key: member.id, member, entry: entries.find(item => item.id === member.id), room, roster, actions,
      })))),
    h('div', { key: 'mode' }, h('div', { className: 'bt-section-title' }, t('Who answers')),
      h('div', { className: 'bt-kv' }, h('span', null, t(ROOM_MODES.find(([id]) => id === shownMode(room, roster))?.[1] ?? 'Everyone')))),
    room.permission ? h('div', { key: 'permission' }, h('div', { className: 'bt-section-title' }, t('Permissions')),
      h('div', { className: 'bt-kv' }, h('span', { className: presetDanger(room.permission) ? 'bt-perm-danger' : undefined }, presetName(room.permission, roster.permissions)))) : null,
    roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: room.id, name: room.name, group: true }, actions }),
    usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
      h('div', { className: 'bt-kv' }, h('span', null, room.name), h('span', null, usage))) : null,
  ]
}

export function DetailsDrawer({ sessionId, startRenaming, startTab, hasStrip, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages }) {
  const owner = roster.byId[sessionId]
  const part = owner ? currentPart(owner) : sessionId
  const isMainBot = isMainOf(roster, owner?.id)
  const [tab, setTab] = useState('details')
  const room = roster.roomsById[sessionId]
  // The info pane swaps its overview for the Bot or group settings view in place.
  const [view, setView] = useState(startTab === 'settings' && (owner || room) ? 'settings' : 'overview')
  const [editing, setEditing] = useState(Boolean(startRenaming && (roster.byId[sessionId] || roster.roomsById[sessionId])))
  const [draftName, setDraftName] = useState(roster.byId[sessionId]?.name ?? (roster.roomsById[sessionId]?.named ? roster.roomsById[sessionId].name : ''))
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const glide = useGlide(tab)
  // The settings view comes in from the right and the overview back from the left; a
  // new tab clears from a blur. The first view arrives with the panel.
  const last = useRef({ view, tab, move: undefined })
  if (last.current.view !== view) last.current = { view, tab, move: view === 'settings' ? 'in' : 'out' }
  else if (last.current.tab !== tab) last.current = { view, tab, move: 'tab' }
  const move = last.current.move
  const side = move === 'tab' ? undefined : move
  const close = () => actions.closeOverlay()
  useEscape(close)
  const bot = owner
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const doing = useActivity(map => map[bot?.id ?? sessionId])
  const transcript = useSessions(list => transcriptOf(list, part, bot?.name ?? room?.name ?? t('Bot'), roster.exchangeTurns[part]))
  const usage = useSessions(list => usageOf(list, [part, ...(bot?.parts ?? room?.parts ?? [])]))
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  const share = () => {
    void navigator.clipboard?.writeText(transcript).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  if ((bot || room) && view === 'settings') {
    return [
      h('div', { key: 'head', className: 'bt-subhead', 'data-move': move },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: () => setView('overview') }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, bot ? t('Settings') : t('Group settings')),
        hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
      h('div', { key: 'set-body', className: 'bt-drawer-body bt-set-body', 'data-move': move }, errorLine,
        bot ? h(BotSettingsForm, { bot, roster, actions, run }) : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })),
    ]
  }
  // The `···` button holds Browser, a new side chat, and DSH's right-column
  // tabs; it hides when none of them applies.
  const more = drawerMenuKeys({
    bot: bot !== undefined,
    room: room !== undefined,
    canBrowse: bot !== undefined && roster.browser === true && actions.openBrowser !== undefined,
    canTerminal: actions.canOpenTerminal?.() === true,
    canFiles: actions.canOpenFiles?.() === true,
  }).map(key => menuItemFor(key, actions, sessionId))
  const top = h('div', { className: 'bt-drawer-top', 'data-move': side },
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': bot ? t('Edit Bot') : t('Group settings'), title: bot ? t('Edit Bot') : t('Group settings'), 'data-info-row': 'settings', onClick: () => setView('settings') }, h(GearIcon)) : null,
    more.length > 0 ? h('span', { 'data-info-row': 'more' }, h(PanelMenu, { items: more, className: 'bt-round', 'aria-label': t('More') })) : null,
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': copied ? t('Copied conversation') : t('Share conversation'), title: copied ? t('Copied') : t('Copy conversation as Markdown'), onClick: share }, copied ? h('span', { key: 'copied', className: 'bt-pop-in' }, '✓') : h(ShareIcon)) : null,
    hasStrip ? null : h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon)))
  if (!bot && !room) {
    return [h(Fragment, { key: 'top' }, top),
      h('div', { key: 'body', className: 'bt-drawer-body' }, h('div', { className: 'bt-muted' }, t('This conversation is not part of your Bot team.')))]
  }
  const current = bot?.name ?? room.name
  const saveName = async () => {
    setEditing(false)
    const next = draftName.trim()
    if (next === current || (room && !room.named && next === '')) return
    if (bot && next) await run(actions.updateBot(bot.id, { name: next }))
    // An empty group name goes back to naming the group after its members.
    if (room) await run(actions.updateRoom(room.id, { name: next }))
  }
  const subtitle = bot ? bot.role : roomSubtitle(room, roster)
  // Tab sets: a 1:1 Bot has Details and Browser; a group has only Details, so no tab row.
  const tabs = bot ? ['details', 'browser'] : ['details']
  return [h(Fragment, { key: 'top' }, top),
    h('div', { key: 'id', className: 'bt-drawer-id', 'data-move': side },
      bot ? h(BotAvatar, { bot, size: 64, state: botState(running, doing, roster.questions?.[part] !== undefined), main: isMainBot, badge: false, gaze: true, pokeable: true })
        : h(MemberPile, { room, roster }),
      editing
        ? h('input', {
            className: 'bt-drawer-name-input', autoFocus: true, value: draftName, 'aria-label': bot ? t('Bot name') : t('Group name'),
            placeholder: room ? t('Name after members') : undefined,
            onChange: event => setDraftName(event.target.value), onBlur: saveName,
            onKeyDown: (event) => { if (event.key === 'Enter') void saveName(); if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) } },
          })
        : h('button', { type: 'button', className: 'bt-drawer-name', 'aria-label': t('Rename {name}', { name: current }), title: t('Rename'), onClick: () => { setDraftName(room && !room.named ? '' : current); setEditing(true) } }, current),
      subtitle ? h('span', { className: 'bt-drawer-role' }, subtitle) : null),
    tabs.length > 1 ? h('div', { key: 'tabs', ref: glide.box, className: 'bt-tabs', role: 'tablist', 'data-move': side },
      h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
      tabs.map(key => h('button', { key, type: 'button', role: 'tab', className: 'bt-tab', 'aria-selected': tab === key, onClick: () => setTab(key) }, t(TAB_LABELS[key])))) : null,
    h('div', { key: `body:${tab}`, className: 'bt-drawer-body', 'data-move': move },
      errorLine,
      room && tab === 'details' ? h(GroupOverview, { room, roster, actions, usage, useWork, openSettings: () => setView('settings') }) : null,
      bot && tab === 'details' ? [
        h(RunStats, { key: 'stats', bot, part, running, actions }),
        h('div', { key: 'model', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Model')),
          h(ModelMenu, { bot, roster, actions, run, wide: true }),
          modelOf(bot, roster) ? null : h('div', { className: 'bt-note' }, t('Pick a model and {name} can start.', { name: bot.name }))),
        h(PermissionRow, { key: 'permission', bot, roster, actions, run }),
        h('div', { key: 'folder', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Working folder')),
          h(FolderMenu, { value: bot.workDir, actions, run, wide: true, onPick: workDir => run(actions.updateBot(bot.id, { workDir })) })),
        bot.instructions
          ? h(About, { key: 'about', text: bot.instructions })
          : h('button', { key: 'about', type: 'button', className: 'bt-more', onClick: () => setView('settings') }, t('Add instructions in Bot settings')),
        roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: bot.id, name: bot.name }, actions }),
        usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
          h('div', { className: 'bt-kv' }, h('span', null, bot.name), h('span', null, usage))) : null,
        h(ScheduleSummary, { key: 'routines', bot, actions }),
      ] : null,
      bot && tab === 'browser' ? h(BrowserCards, { bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) : null)]
}
