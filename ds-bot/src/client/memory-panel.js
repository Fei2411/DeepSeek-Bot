// The memory dialog of a Bot or a group chat (`owner`: { id, name, group }): a summary
// a model writes from every saved entry, the entries themselves behind the ⋯ menu,
// and "Ask or update", one model call that answers from the entries or changes them.
// Modeled on ChatGPT's memory summary.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, DotsIcon, MemoryIcon, TrashIcon } from './icons.js'
import { dateLocale, hostText, t } from './i18n.js'
import { summaryBlocks } from './text.js'
import { useLinger } from './motion.js'

const POLL_MS = 1500
const MENU_EXIT_MS = 120

// Entry counts per Bot or group, for the details pane; the dialog updates them as it loads.
const counts = new Map()
const countListeners = new Set()
function noteCount(id, count) {
  if (counts.get(id) === count) return
  counts.set(id, count)
  for (const listener of countListeners) listener()
}

export function useMemoryCount(id, actions) {
  const [count, setCount] = useState(counts.get(id) ?? null)
  useEffect(() => {
    const listener = () => setCount(counts.get(id) ?? null)
    countListeners.add(listener)
    listener()
    let stop = false
    actions.memoryView?.(id).then((view) => { if (!stop) noteCount(id, view.entries.length) }).catch(() => {})
    return () => { stop = true; countListeners.delete(listener) }
  }, [id])
  return count
}

// The details pane's row: how much the Bot or group keeps, and the way into the dialog.
export function MemoryRow({ owner, actions }) {
  const count = useMemoryCount(owner.id, actions)
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Memory')),
    h('button', { type: 'button', className: 'bt-mem-row', 'aria-label': t("Manage {name}'s memory", { name: owner.name }), onClick: () => actions.openMemory(owner.id) },
      h(MemoryIcon),
      h('span', { className: 'bt-mem-row-copy' }, label),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

function ago(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return null
  const format = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.round(hours / 24), 'day')
}

function Skeleton({ label }) {
  return h('div', { className: 'bt-mem-skel', 'aria-busy': true },
    [0, 1].map(block => h('div', { key: block, className: 'bt-mem-skel-block' },
      h('span', { className: 'bt-mem-skel-head' }),
      h('span', null), h('span', null), h('span', { style: { width: block === 0 ? '62%' : '48%' } }))),
    label ? h('div', { className: 'bt-mem-skel-label' }, label) : null)
}

function Summary({ owner, view, regenerate }) {
  if (view.entries.length === 0) {
    return h('div', { className: 'bt-mem-empty' },
      h('div', { className: 'bt-mem-empty-mark' }, h(MemoryIcon)),
      h('div', { className: 'bt-mem-empty-title' }, owner.group ? t('Nothing is saved for this group yet') : t('{name} has not saved anything yet', { name: owner.name })),
      h('div', { className: 'bt-mem-empty-text' }, owner.group
        ? t('A group keeps the decisions, rules, and facts its work needs, for its members to read here. Tell it below, or in the group.')
        : t('Bots keep lasting preferences, decisions, and what you ask them to remember. Tell {name} below, or in its chat.', { name: owner.name })))
  }
  const failed = view.error && !view.summarizing
    ? h('div', { className: 'bt-mem-failed', role: 'alert' },
        h('span', null, view.summary ? t('The summary is out of date: {reason}', { reason: hostText(view.error) }) : t('The summary could not be written: {reason}', { reason: hostText(view.error) })),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: regenerate }, t('Try again')))
    : null
  if (!view.summary) return h(Fragment, null, failed, failed ? null : h(Skeleton, { label: t('Writing the summary…') }))
  return h(Fragment, null, failed,
    h('div', { key: view.summary.at, className: 'bt-mem-summary', 'data-stale': !view.fresh || undefined },
      summaryBlocks(view.summary.text).map((block, index) => (block.kind === 'h'
        ? h('h3', { key: index }, block.text)
        : h('p', { key: index }, block.text)))))
}

const groupEntries = entries => entries.reduce((groups, entry) => {
  const key = `${entry.scope}:${entry.topic ?? ''}`
  const group = groups.find(item => item.key === key)
  if (group) group.entries.push(entry)
  else groups.push({ key, scope: entry.scope, topic: entry.topic, entries: [entry] })
  return groups
}, [])

function EntryRow({ entry, remove }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const by = entry.source === 'memory panel' ? t('by you') : entry.by ? t('by {name}', { name: entry.by }) : null
  const meta = [entry.added, by].filter(Boolean).join(' · ')
  const click = async () => {
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    if (!await remove(entry)) setBusy(false)
  }
  return h('li', { className: 'bt-mem-entry', 'data-busy': busy || undefined },
    h('div', { className: 'bt-mem-entry-copy' },
      h('span', { className: 'bt-mem-entry-text' }, entry.text),
      meta ? h('span', { className: 'bt-mem-entry-meta' }, meta) : null),
    h('button', {
      type: 'button', className: 'bt-mem-remove', 'data-confirm': confirming || undefined, disabled: busy,
      'aria-label': confirming ? t('Click again to remove') : t('Remove from memory'), title: confirming ? undefined : t('Remove from memory'), onClick: click,
    }, confirming ? t('Remove') : h(TrashIcon)))
}

function Entries({ owner, view, remove }) {
  const groups = groupEntries(view.entries)
  const sections = owner.group
    ? [{ scope: 'group', title: t('Group memory'), hint: t('Only its members read it'), size: view.sizes.group }]
    : [
        { scope: 'own', title: t("{name}'s memory", { name: owner.name }), size: view.sizes.own },
        { scope: 'team', title: t('Team memory'), hint: t('Every Bot reads it'), size: view.sizes.team },
      ]
  return h('div', { className: 'bt-mem-entries' },
    sections.map(section => h('section', { key: section.scope, className: 'bt-mem-section' },
      h('div', { className: 'bt-mem-section-head' },
        h('h3', null, section.title),
        section.hint ? h('span', null, section.hint) : null,
        h('span', { className: 'bt-mem-size', title: t('MEMORY.md, which every conversation reads') }, t('{used} of {limit} characters', { used: section.size.toLocaleString(dateLocale()), limit: view.limits.main.toLocaleString(dateLocale()) }))),
      groups.some(group => group.scope === section.scope)
        ? groups.filter(group => group.scope === section.scope).map(group => h(Fragment, { key: group.key },
            group.topic ? h('div', { className: 'bt-mem-topic' }, group.topic) : null,
            h('ul', { className: 'bt-mem-list' }, group.entries.map(entry => h(EntryRow, { key: `${entry.topic ?? ''}:${entry.text}`, entry, remove })))))
        : h('div', { className: 'bt-mem-none' }, t('Nothing saved yet')))))
}

function changeLine(change) {
  const text = change.text.length > 120 ? `${change.text.slice(0, 120)}…` : change.text
  if (!change.ok) return t('Not changed: {text} ({reason})', { text, reason: hostText(change.error ?? '') })
  if (change.op === 'remove') return change.scope === 'team' ? t('Removed from team memory: {text}', { text }) : t('Removed: {text}', { text })
  if (change.op === 'edit') return t('Updated: {text}', { text })
  return change.scope === 'team' ? t('Added to team memory: {text}', { text }) : t('Added: {text}', { text })
}

function Reply({ answer, dismiss }) {
  return h('div', { className: 'bt-mem-reply', role: 'status' },
    h('div', { className: 'bt-mem-reply-head' },
      h('span', { className: 'bt-mem-reply-asked' }, answer.asked),
      answer.pending ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Dismiss'), onClick: dismiss }, h(CloseIcon))),
    answer.pending ? h('div', { className: 'bt-mem-reply-text bt-shimmer' }, t('Thinking…'))
      : answer.error ? h('div', { className: 'bt-mem-reply-text bt-danger' }, hostText(answer.error))
        : h(Fragment, null,
            answer.reply ? h('div', { className: 'bt-mem-reply-text' }, answer.reply) : null,
            answer.changes.length > 0
              ? h('ul', { className: 'bt-mem-changes' }, answer.changes.map((change, index) => h('li', { key: index, 'data-ok': change.ok || undefined },
                  change.ok ? h(CheckIcon) : h(CloseIcon), h('span', null, changeLine(change)))))
              : null))
}

// The view as the host has it, loaded again while a summary is being written. Only the
// latest request's answer counts.
function useMemoryView(id, actions) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(0)
  const latest = useRef(0)
  const alive = useRef(true)
  const show = useCallback((next) => {
    setView(next)
    setError('')
    noteCount(id, next.entries.length)
  }, [id])
  const load = useCallback(async (flags = {}) => {
    clearTimeout(timer.current)
    const ticket = ++latest.current
    try {
      const next = await actions.memoryView(id, flags)
      if (!alive.current || ticket !== latest.current) return
      show(next)
      if (next.summarizing) timer.current = setTimeout(() => void load({ summarize: flags.summarize || flags.regenerate }), POLL_MS)
    } catch (failure) {
      if (alive.current && ticket === latest.current) setError(failure?.message ?? String(failure))
    }
  }, [id])
  useEffect(() => {
    alive.current = true
    void load({ summarize: true })
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [id])
  return { view, error, load, show }
}

function useNow(every) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}

export function MemoryDialog({ owner, actions, leaving = false }) {
  const { view, error, load, show } = useMemoryView(owner.id, actions)
  const [page, setPage] = useState('summary')
  const [menu, setMenu] = useState(false)
  const [menuShown, menuLeaving] = useLinger(menu, MENU_EXIT_MS)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState(null)
  const menuRef = useRef(null)
  const dotsRef = useRef(null)
  const inputRef = useRef(null)
  const now = useNow(30_000)
  const close = useCallback(() => actions.closeMemory(), [])
  useEscape(close)
  useEffect(() => {
    if (!menu) return undefined
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target) || dotsRef.current?.contains(event.target)) return
      setMenu(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); dotsRef.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])
  const regenerate = () => { setMenu(false); setPage('summary'); void load({ regenerate: true }) }
  const openEntries = () => { setMenu(false); setPage('entries') }
  const backToSummary = () => { setPage('summary'); void load({ summarize: true }) }
  const remove = async (entry) => {
    try {
      show(await actions.memoryForget(owner.id, entry))
      return true
    } catch (failure) {
      setAnswer({ asked: entry.text, error: failure?.message ?? String(failure) })
      return false
    }
  }
  const ask = async (event) => {
    event.preventDefault()
    const asked = text.trim()
    if (asked === '' || answer?.pending) return
    setText('')
    setAnswer({ asked, pending: true })
    try {
      const result = await actions.memoryAsk(owner.id, asked)
      setAnswer({ asked, reply: result.reply, changes: result.changes })
      show(result.view)
      if (result.changes.some(change => change.ok)) void load({ summarize: page === 'summary' })
    } catch (failure) {
      setAnswer({ asked, error: failure?.message ?? String(failure) })
    }
    inputRef.current?.focus()
  }

  const count = view?.entries.length ?? 0
  const when = view?.summary ? ago(view.summary.at, now) : null
  const status = view === null ? ''
    : page === 'entries' ? (count === 1 ? t('1 entry') : t('{count} entries', { count }))
      : view.summarizing && view.summary ? t('Updating…')
        : view.summary && view.fresh ? (when ? t('Updated {time}', { time: when }) : t('Updated just now'))
          : ''
  const busy = answer?.pending === true
  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem', role: 'dialog', 'aria-modal': true, 'aria-label': t("{name}'s memory", { name: owner.name }) },
      h('div', { className: 'bt-mem-head' },
        page === 'entries' ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to the summary'), onClick: backToSummary }, h(ChevronLeftIcon)) : null,
        h('h2', null, page === 'entries' ? t('All entries') : t('Memory summary')),
        h('span', { className: 'bt-mem-status' }, page === 'summary' ? [owner.name, status].filter(Boolean).join(' · ') : status),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { ref: dotsRef, type: 'button', className: 'bt-icon-btn', 'aria-label': t('Memory options'), 'aria-haspopup': 'menu', 'aria-expanded': menu, onClick: () => setMenu(value => !value) }, h(DotsIcon)),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close memory'), onClick: close }, h(CloseIcon)),
        menuShown ? h('div', { ref: menuRef, className: 'bt-menu bt-mem-menu', role: 'menu', 'aria-label': t('Memory options'), 'data-leaving': menuLeaving || undefined },
          h('button', { type: 'button', role: 'menuitem', onClick: openEntries },
            h('span', { className: 'bt-menu-label' }, t('All entries')), h('span', { className: 'bt-menu-hint' }, String(count))),
          h('button', { type: 'button', role: 'menuitem', disabled: count === 0 || view?.summarizing, onClick: regenerate },
            h('span', { className: 'bt-menu-label' }, t('Regenerate summary')))) : null),
      h('div', { className: 'bt-mem-body' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, hostText(error)) : null,
        view === null ? (error ? null : h(Skeleton))
          : page === 'entries' ? h(Entries, { owner, view, remove })
            : h(Summary, { owner, view, regenerate })),
      h('div', { className: 'bt-mem-foot' },
        answer ? h(Reply, { answer, dismiss: () => setAnswer(null) }) : null,
        h('form', { className: 'bt-mem-ask', onSubmit: ask },
          h('input', {
            ref: inputRef, className: 'bt-mem-input', value: text, maxLength: 2000, disabled: view === null,
            placeholder: t('Ask or update'), 'aria-label': t("Ask about or update {name}'s memory", { name: owner.name }),
            onChange: event => setText(event.target.value),
          }),
          h('button', { type: 'submit', className: 'bt-mem-send', disabled: busy || text.trim() === '', 'aria-label': t('Send') },
            busy ? h('span', { className: 'bt-mem-spin', 'aria-hidden': true }) : h(ArrowUpIcon))))))
}
