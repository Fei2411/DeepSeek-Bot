// Scheduled tasks: Settings → Scheduled tasks, a Bot's card in its settings, and the
// line in its details panel. DSH runs the tasks (see src/host/schedules.js); a task
// sends its prompt to the Bot's chat when it is due.
import { createElement as h, Fragment, useEffect, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { ClockIcon, PlusIcon, TrashIcon } from './icons.js'
import { Segmented } from './motion.js'
import { dateLocale, hostText, t } from './i18n.js'

const POLL_MS = 30_000

// One view for every surface that shows tasks; each asks again when it mounts.
let shared = null
const listeners = new Set()
function publish(view) {
  shared = view
  for (const listener of listeners) listener(view)
}
export function useSchedules(actions) {
  const [view, setView] = useState(shared)
  useEffect(() => {
    listeners.add(setView)
    let stopped = false
    let timer
    const load = () => actions.schedules?.()
      .then((next) => { if (!stopped) publish(next) })
      .catch(() => {})
      .finally(() => { if (!stopped) timer = setTimeout(load, POLL_MS) })
    load()
    return () => { stopped = true; clearTimeout(timer); listeners.delete(setView) }
  }, [])
  return view
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const clock = time => String(time ?? '').slice(0, 5)
const when = (ms, options) => new Intl.DateTimeFormat(dateLocale(), options).format(ms)
function dayAndTime(ms) {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear()
  return when(ms, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function weekdayNames(days) {
  const names = days.map(day => when(Date.UTC(2024, 0, day), { weekday: 'short', timeZone: 'UTC' }))
  return names.join(dateLocale().startsWith('zh') ? '、' : ', ')
}
function everyText(seconds) {
  if (seconds % 86400 === 0) return seconds === 86400 ? t('Every day') : t('Every {count} days', { count: seconds / 86400 })
  if (seconds % 3600 === 0) return seconds === 3600 ? t('Every hour') : t('Every {count} hours', { count: seconds / 3600 })
  return t('Every {count} minutes', { count: Math.round(seconds / 60) })
}

// How often a task runs, in the user's words.
export function timingText(task) {
  const zone = task.timeZone && task.timeZone !== localZone() ? ` (${task.timeZone})` : ''
  switch (task.kind) {
    case 'after':
    case 'at': return t('Once, {time}', { time: dayAndTime(Date.parse(task.scheduledAt)) })
    case 'every': return everyText(task.everySeconds)
    case 'daily': return `${t('Every day at {time}', { time: clock(task.time) })}${zone}`
    case 'weekly': {
      const days = (task.weekdays ?? []).join()
      const text = days === '1,2,3,4,5' ? t('Every weekday at {time}', { time: clock(task.time) })
        : days === '6,7' ? t('Every weekend at {time}', { time: clock(task.time) })
          : days === '1,2,3,4,5,6,7' ? t('Every day at {time}', { time: clock(task.time) })
            : t('Every {days} at {time}', { days: weekdayNames(task.weekdays ?? []), time: clock(task.time) })
      return `${text}${zone}`
    }
    case 'cron': return `${t('On the schedule {expression}', { expression: task.expression })}${zone}`
    default: return ''
  }
}
const nextText = task => (task.status === 'active' ? t('Next: {time}', { time: dayAndTime(Date.parse(task.scheduledAt)) }) : t('Finished'))

function TaskRow({ task, actions, onView, showBot, roster }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const remove = () => {
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    void actions.scheduleDelete(task.sessionId, task.id).then(onView, () => setBusy(false))
  }
  const room = task.roomId ? roster.roomsById[task.roomId] : undefined
  return h('div', { className: 'bt-set-row bt-task', 'data-done': task.status === 'active' ? undefined : '', 'data-busy': busy || undefined },
    showBot ? h(BotAvatar, { bot: roster.byId[task.botId], size: 28, badge: false, live: false }) : null,
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-task-title' }, task.title),
      h('span', { className: 'bt-set-hint' }, [timingText(task), room ? t('in {name}', { name: room.name }) : ''].filter(Boolean).join(' · ')),
      task.prompt && task.prompt !== task.title ? h('span', { className: 'bt-task-prompt' }, task.prompt) : null),
    h('span', { className: 'bt-task-next' }, nextText(task)),
    h('button', {
      type: 'button', className: 'bt-mini bt-task-remove', 'data-confirm': confirming || undefined, disabled: busy,
      'aria-label': confirming ? t('Click again to delete') : t('Delete task'), title: confirming ? undefined : t('Delete task'), onClick: remove,
    }, confirming ? t('Delete') : h(TrashIcon)))
}

const pad = number => String(number).padStart(2, '0')
function inAnHour() {
  const date = new Date(Date.now() + 3600_000)
  date.setMinutes(0, 0, 0)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}
const KINDS = [['at', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['every', 'Repeat']]
const UNITS = [['minutes', 1, 'minutes'], ['hours', 60, 'hours'], ['days', 1440, 'days']]

function TaskForm({ roster, actions, start, onDone, onCancel }) {
  // A task goes to a Bot's chat or to a group chat, where it reads as your message.
  const [target, setTarget] = useState(start ?? roster.bots[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState('daily')
  const [at, setAt] = useState(inAnHour)
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5])
  const [count, setCount] = useState(1)
  const [unit, setUnit] = useState('hours')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timing = () => {
    if (kind === 'at') return { kind, at: new Date(at).toISOString() }
    if (kind === 'every') return { kind, minutes: Math.round(Number(count) * UNITS.find(([id]) => id === unit)[1]) }
    return { kind, time, timeZone: localZone(), ...(kind === 'weekly' ? { weekdays } : {}) }
  }
  const submit = (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    let when
    try { when = timing() } catch { setError(t('Pick a date and time')); setBusy(false); return }
    void actions.scheduleCreate({ target, title, prompt, when })
      .then(onDone, (failure) => { setError(hostText(failure?.message ?? String(failure))); setBusy(false) })
  }
  const toggleDay = day => setWeekdays(days => (days.includes(day) ? days.filter(item => item !== day) : [...days, day].sort()))
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Send to'))),
      h('select', { className: 'bt-select bt-task-bot', value: target, onChange: event => setTarget(event.target.value) },
        h('optgroup', { label: t('Bots') }, roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
        roster.rooms.length > 0 ? h('optgroup', { label: t('Group chats') }, roster.rooms.map(room => h('option', { key: room.id, value: room.id }, room.name))) : null)),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
      h('input', { className: 'bt-bs-input', value: title, maxLength: 120, placeholder: t('Morning briefing'), autoFocus: true, onChange: event => setTitle(event.target.value) })),
    h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('What to do'))),
      h('textarea', { className: 'bt-bs-input bt-bs-area', value: prompt, rows: 3, placeholder: t('Sum up what changed since yesterday and what needs me today.'), onChange: event => setPrompt(event.target.value) })),
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('When'))),
      h(Segmented, { label: t('When'), value: kind }, KINDS.map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': kind === id, onClick: () => setKind(id) }, t(label)))),
      h('div', { key: kind, className: 'bt-task-when bt-veil' },
        kind === 'at' ? h('input', { className: 'bt-input', type: 'datetime-local', value: at, 'aria-label': t('Date and time'), onChange: event => setAt(event.target.value) }) : null,
        kind === 'weekly' ? h('div', { className: 'bt-task-days', role: 'group', 'aria-label': t('Days') }, [1, 2, 3, 4, 5, 6, 7].map(day => h('button', {
          key: day, type: 'button', className: 'bt-task-day', 'aria-pressed': weekdays.includes(day), onClick: () => toggleDay(day),
        }, when(Date.UTC(2024, 0, day), { weekday: 'narrow', timeZone: 'UTC' })))) : null,
        kind === 'daily' || kind === 'weekly' ? h('input', { className: 'bt-input bt-task-time', type: 'time', value: time, 'aria-label': t('Time'), onChange: event => setTime(event.target.value) }) : null,
        kind === 'every' ? h(Fragment, null,
          h('span', { className: 'bt-task-every' }, t('Every')),
          h('input', { className: 'bt-input bt-task-count', type: 'number', min: 1, value: count, 'aria-label': t('How many'), onChange: event => setCount(event.target.value) }),
          h('select', { className: 'bt-select bt-task-unit', value: unit, 'aria-label': t('Unit'), onChange: event => setUnit(event.target.value) },
            UNITS.map(([id, , label]) => h('option', { key: id, value: id }, t(label))))) : null)),
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || !target || title.trim() === '' || prompt.trim() === '' }, busy ? t('Creating…') : t('Create task'))))
}

// Settings has no schedule service to show: Automation tasks are off in DSH.
function AutomationOff({ actions }) {
  return h('div', { className: 'bt-set-card bt-task-off' },
    h('span', { className: 'bt-task-off-mark' }, h(ClockIcon)),
    h('span', { className: 'bt-task-off-title' }, t('Turn on Automation tasks in DSH')),
    h('span', { className: 'bt-set-hint' }, t('Switch on Automation tasks on the Plugins page in Advanced settings (DeepSeek Harness).')),
    actions.openHarnessSettings ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: actions.openHarnessSettings }, t('Open Advanced settings (DeepSeek Harness)')) : null)
}

export function SchedulesPage({ roster, actions, start }) {
  const view = useSchedules(actions)
  const [adding, setAdding] = useState(Boolean(start))
  if (view === null) return h('div', { className: 'bt-set-hint' }, t('Loading…'))
  if (!view.available) return h(AutomationOff, { actions })
  const shown = next => { publish(next); setAdding(false) }
  const byChat = [
    ...roster.bots.map(bot => [bot.id, h(BotAvatar, { bot, size: 18, badge: false, live: false }), bot.name, view.tasks.filter(task => task.botId === bot.id)]),
    ...roster.rooms.map(room => [room.id, h(RoomAvatar, { room, roster, size: 18 }), room.name, view.tasks.filter(task => task.botId === undefined && task.roomId === room.id)]),
  ].filter(([, , , tasks]) => tasks.length > 0)
  return [
    adding
      ? h(TaskForm, { key: 'form', roster, actions, start, onDone: shown, onCancel: () => setAdding(false) })
      : h('div', { key: 'add', className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, h(PlusIcon), t('New task'))),
    byChat.length === 0 && !adding
      ? h('div', { key: 'none', className: 'bt-set-card' }, h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No scheduled tasks yet.'))))
      : byChat.map(([id, avatar, name, tasks]) => h('section', { key: id, className: 'bt-set-section' },
          h('h3', { className: 'bt-task-head' }, avatar, name),
          h('div', { className: 'bt-set-card' }, tasks.map(task => h(TaskRow, { key: task.id, task, actions, roster, onView: publish }))))),
  ]
}

// A Bot's tasks in its settings form, with the way to add one.
export function BotSchedules({ bot, roster, actions }) {
  const view = useSchedules(actions)
  if (view === null) return null
  const tasks = view.available ? view.tasks.filter(task => task.botId === bot.id) : []
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Scheduled tasks')),
    h('div', { className: 'bt-set-card' },
      !view.available
        ? h('div', { className: 'bt-set-row bt-bs-row' },
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-set-hint' }, t('Switch on Automation tasks on the Plugins page in Advanced settings (DeepSeek Harness).'))),
            actions.openHarnessSettings ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: actions.openHarnessSettings }, t('Open Advanced settings (DeepSeek Harness)')) : null)
        : [
            ...tasks.map(task => h(TaskRow, { key: task.id, task, actions, roster, onView: publish })),
            h('button', { key: 'new', type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => actions.openSettings('schedules', bot.id) }, h(PlusIcon), t('New task')),
          ]))
}

// The details panel's line: the Bot's next tasks, or how to add one.
export function ScheduleSummary({ bot, actions }) {
  const view = useSchedules(actions)
  const tasks = view?.available ? view.tasks.filter(task => task.botId === bot.id && task.status === 'active') : []
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Scheduled tasks')),
    tasks.length === 0
      ? h('button', { type: 'button', className: 'bt-more', onClick: () => actions.openSettings('schedules', bot.id) }, view?.available === false ? t('Switch on Automation tasks on the Plugins page in Advanced settings (DeepSeek Harness).') : t('No scheduled tasks yet. Add one'))
      : h('div', { className: 'bt-task-list' }, tasks.slice(0, 3).map(task => h('button', { key: task.id, type: 'button', className: 'bt-task-line', onClick: () => actions.openSettings('schedules') },
          h(ClockIcon), h('span', { className: 'bt-task-line-title' }, task.title), h('span', { className: 'bt-task-line-when' }, timingText(task))))))
}

export const SCHEDULE_CSS = `
.bt-task{gap:10px}
.bt-task[data-done]{opacity:.6}
.bt-task[data-busy]{opacity:.4}
.bt-task-title{font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-task-prompt{font-size:12px;line-height:16px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-task-next{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-task-remove{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;color:var(--bt-ink-3)}
.bt-task-remove svg{width:14px;height:14px}
.bt-task-remove[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--bt-danger)}
.bt-task-head{display:flex;align-items:center;gap:6px}
.bt-task-form{animation:bt-q-in .4s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-task-bot{width:auto;min-width:160px;max-width:58%}
.bt-task-when{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.bt-task-when .bt-input{width:auto;height:32px}
.bt-task-time{min-width:110px}
.bt-task-count{width:72px!important}
.bt-task-unit{width:auto;height:32px}
.bt-task-every{font-size:13px;color:var(--bt-ink-2)}
.bt-task-days{display:flex;gap:4px}
.bt-task-day{width:30px;height:30px;border-radius:50%;border:1px solid var(--bt-line);background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.bt-task-day[aria-pressed=true]{background:var(--bt-user);border-color:var(--bt-user);color:var(--bt-user-ink)}
.bt-task-foot{justify-content:flex-end;gap:8px}
.bt-task-foot .bt-send{height:28px;font-size:12px}
.bt-task-off{align-items:center;gap:8px;padding:28px 20px;text-align:center}
.bt-task-off>*+*{border-top:0}
.bt-task-off-mark{width:44px;height:44px;border-radius:50%;background:var(--bt-hover);display:flex;align-items:center;justify-content:center;color:var(--bt-ink-2)}
.bt-task-off-mark svg{width:20px;height:20px}
.bt-task-off-title{font-size:14px;line-height:20px;font-weight:600}
.bt-task-off .bt-set-hint{max-width:380px}
.bt-task-list{display:flex;flex-direction:column;gap:2px}
.bt-task-line{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-task-line:hover{background:var(--bt-hover)}
.bt-task-line svg{flex:none;color:var(--bt-ink-3)}
.bt-task-line-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-task-line-when{flex:none;font-size:12px;color:var(--bt-ink-3)}
@media (prefers-reduced-motion:reduce){.bt-task-form{animation:none}}
/* Phone-width viewports: the form's fixed minimums would overflow; let the
   fields wrap and share the row. */
@media (max-width:640px){
  .bt-task-bot{min-width:0;width:100%}
  .bt-task-time{min-width:0;flex:1 1 110px}
  .bt-task-count{width:auto!important;flex:1 1 72px}
}
`
