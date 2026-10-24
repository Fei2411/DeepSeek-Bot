import { createElement as h, Fragment, useEffect, useId, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { CheckIcon, CloseIcon, CopyIcon, DotsIcon, DownloadIcon, InfoIcon } from './icons.js'
import { t } from './i18n.js'
import { AnsweredCell, keyLetter, useOptionKeys } from './questions.js'
import { useDockHold } from './card-hold.js'
import { heldCardKey } from './sources.js'
import { Segmented } from './motion.js'
import { CHART_CSS, TableIcon, WidgetChart } from './widget-chart.js'
import { HTML_CSS, HtmlFrame } from './widget-html.js'
import { asText, checkShownView, choiceValue, inputDefault, resolve, viewInputs, viewScope } from '../shared/views.js'

// -------------------------------------------------------------------------
// Views (show_view): a Bot draws a declarative blueprint — text, numbers, tables,
// charts, inputs, and answers it waits for — as part of its reply. Nothing
// model-written executes in the page: every node maps to one of the components
// below, formulas go through the shared evaluator, and html runs in a sandboxed
// frame. Inputs keep their values in the page only. A view that awaits a reply
// lives in state.views like an ask_user question; any other renders from the
// call's arguments.

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })
const TONES = ['good', 'warn', 'bad']
const CALLOUT_TONES = ['info', 'good', 'warn', 'bad']

const optionsOf = node => (Array.isArray(node?.options) ? node.options : [])
  .map(option => (typeof option === 'string' ? { label: option } : option))
  .filter(option => option !== null && typeof option === 'object' && option.label !== undefined)
const fieldsOf = node => (Array.isArray(node?.fields) ? node.fields : [])
  .filter(field => field !== null && typeof field === 'object' && field.id !== undefined)
const cellText = value => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : asText(value))
const NUMERIC_CELL = /^[-+]?[\d.,]+\s?(%|[a-zA-Z]{1,4})?$/

const countType = (node, type) => {
  if (node === null || typeof node !== 'object') return 0
  const children = Array.isArray(node.children) ? node.children : []
  return (node.type === type ? 1 : 0) + children.reduce((sum, child) => sum + countType(child, type), 0)
}
const ANSWER_TYPES = new Set(['options', 'confirm', 'form', 'submit', 'slider', 'choice', 'toggle', 'number'])
const hasControls = (node) => {
  if (node === null || typeof node !== 'object') return false
  if (ANSWER_TYPES.has(node.type)) return true
  return Array.isArray(node.children) && node.children.some(hasControls)
}

// The values an answer carries belong to the component whose id is its action.
const answerValues = (answer, node) => (answer?.action === node.id ? answer.values : undefined)

function OptionsInput({ node, onSubmit, keys, busy = false }) {
  const [picked, setPicked] = useState([])
  const options = optionsOf(node)
  const multi = node.multi === true
  const choose = (label) => {
    if (busy) return
    if (multi) {
      setPicked(current => (current.includes(label) ? current.filter(item => item !== label) : [...current, label]))
      return
    }
    onSubmit?.(node.id, { selected: [label] })
  }
  const submit = () => { if (!busy && picked.length > 0) onSubmit?.(node.id, { selected: picked }) }
  const ownRef = useRef(null)
  const hints = useOptionKeys(busy || !keys ? 0 : options.length, index => choose(options[index].label), ownRef)
  return h(Fragment, null,
    h('div', { className: 'bt-q-list', role: 'group' }, options.map((option, index) => {
      const selected = multi && picked.includes(option.label)
      return h('button', {
        key: option.label, type: 'button', className: 'bt-q-opt', disabled: busy,
        'aria-pressed': multi ? selected : undefined,
        'aria-keyshortcuts': hints ? keyLetter(index).toLowerCase() : undefined,
        onClick: () => choose(option.label),
      },
      hints ? h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(index)) : null,
      h('span', { className: 'bt-q-body' },
        h('span', { className: 'bt-q-label' }, option.label),
        option.description ? h('span', { className: 'bt-q-desc' }, option.description) : null),
      selected ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)
    })),
    multi ? h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy || picked.length === 0, onClick: submit }, t('Submit'))) : null)
}

function SettledOptions({ node, answer }) {
  const selected = answerValues(answer, node)?.selected
  const chosen = Array.isArray(selected) ? selected : []
  return h('div', { className: 'bt-q-list', role: 'group', 'aria-label': t('Your answer') },
    optionsOf(node).map(option => h('div', { key: option.label, className: 'bt-q-opt' },
      h('span', { className: 'bt-q-body' },
        h('span', { className: 'bt-q-label' }, option.label),
        option.description ? h('span', { className: 'bt-q-desc' }, option.description) : null),
      chosen.includes(option.label) ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)))
}

function ConfirmInput({ node, onSubmit, busy = false }) {
  return h('div', { className: 'bt-q-foot' },
    h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => onSubmit?.(node.id, { confirmed: false }) }, node.cancelLabel ?? t('Cancel')),
    h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => onSubmit?.(node.id, { confirmed: true }) }, node.confirmLabel ?? t('Confirm')))
}

function SettledConfirm({ node, answer }) {
  const confirmed = answerValues(answer, node)?.confirmed
  if (confirmed !== true && confirmed !== false) {
    return h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: true }, node.cancelLabel ?? t('Cancel')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: true }, node.confirmLabel ?? t('Confirm')))
  }
  const label = confirmed ? (node.confirmLabel ?? t('Confirm')) : (node.cancelLabel ?? t('Cancel'))
  return h('span', { className: 'bt-q-badge' }, label)
}

function FormInput({ node, onSubmit, busy = false }) {
  const fields = fieldsOf(node)
  const [draft, setDraft] = useState({})
  const submit = () => { if (!busy) onSubmit?.(node.id, { fields: Object.fromEntries(fields.map(field => [field.id, draft[field.id] ?? ''])) }) }
  return h('form', {
    className: 'bt-widget-form',
    onSubmit: (event) => { event.preventDefault(); submit() },
  },
  fields.map(field => h('label', { key: field.id, className: 'bt-widget-field' },
    h('span', { className: 'bt-widget-field-label' }, field.label),
    h('span', { className: 'bt-q-field' },
      h('input', {
        className: 'bt-q-input', type: 'text', value: draft[field.id] ?? '',
        autoComplete: 'off', spellCheck: false, readOnly: busy,
        'aria-label': field.label, placeholder: field.placeholder ?? undefined,
        onChange: (event) => { if (!busy) setDraft(current => ({ ...current, [field.id]: event.target.value })) },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        },
      })))),
  h('div', { className: 'bt-q-foot' }, h('button', { type: 'submit', className: 'bt-q-submit', disabled: busy }, node.submitLabel ?? t('Submit'))))
}

function SettledForm({ node, answer }) {
  const fields = answerValues(answer, node)?.fields
  const values = fields !== null && typeof fields === 'object' ? fields : {}
  return h('div', { className: 'bt-widget-form' },
    fieldsOf(node).map(field => h('label', { key: field.id, className: 'bt-widget-field' },
      h('span', { className: 'bt-widget-field-label' }, field.label),
      h('span', { className: 'bt-q-field' },
        h('input', { className: 'bt-q-input', type: 'text', value: values[field.id] ?? '', disabled: true, readOnly: true, 'aria-label': field.label })))))
}

function SubmitInput({ node, ctx }) {
  if (ctx.settled) return null
  return h('div', { className: 'bt-q-foot' },
    h('button', { type: 'button', className: 'bt-q-submit', disabled: ctx.busy, onClick: () => ctx.onSubmit?.(node.id, {}) }, node.label || t('Send')))
}

function WidgetTable({ node, lookup }) {
  const columns = (Array.isArray(node.columns) ? node.columns : []).filter(column => column !== null && typeof column === 'object')
  const rows = (Array.isArray(node.rows) ? node.rows : []).map(row => (Array.isArray(row) ? row : []).map(cell => resolve(cell, lookup, '')))
  // A column of numbers lines up on the right.
  const numeric = columns.map((_, index) => {
    const cells = rows.map(row => row[index]).filter(cell => cell !== undefined && cell !== '')
    return cells.length > 0 && cells.every(cell => typeof cell === 'number' || (typeof cell === 'string' && NUMERIC_CELL.test(cell.trim())))
  })
  return h('div', { className: 'bt-widget-table' },
    h('table', null,
      h('thead', null, h('tr', null, columns.map((column, index) => h('th', { key: column.key ?? index, scope: 'col', className: numeric[index] ? 'bt-num' : undefined }, column.label)))),
      h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
        columns.map((column, columnIndex) => h('td', { key: column.key ?? columnIndex, className: numeric[columnIndex] ? 'bt-num' : undefined }, cellText(row[columnIndex]))))))))
}

function WidgetProgress({ node, lookup }) {
  let percent
  if (node.percent !== undefined) percent = Number(resolve(node.percent, lookup, 0))
  else {
    const max = Number(resolve(node.max, lookup, 0))
    percent = max > 0 ? (Number(resolve(node.value, lookup, 0)) / max) * 100 : 0
  }
  percent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const tone = resolve(node.tone, lookup)
  const right = node.valueLabel !== undefined ? asText(resolve(node.valueLabel, lookup, '')) : `${Math.round(percent)}%`
  return h('div', { className: 'bt-widget-progress', 'data-tone': TONES.includes(tone) ? tone : undefined },
    h('span', { className: 'bt-widget-progress-label' }, h('span', { className: 'bt-widget-progress-name' }, node.label), h('span', null, right)),
    h('div', {
      className: 'bt-widget-progress-track', role: 'progressbar',
      'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': node.label ?? t('Progress'), 'aria-valuetext': right,
    }, h('div', { className: 'bt-widget-progress-fill', style: { width: `${percent}%` } })))
}

function WidgetMetric({ node, lookup }) {
  const tone = resolve(node.tone, lookup)
  const caption = node.caption === undefined ? '' : asText(resolve(node.caption, lookup, ''))
  return h('div', { className: 'bt-widget-metric', 'data-tone': TONES.includes(tone) ? tone : undefined },
    h('span', { className: 'bt-widget-metric-label' }, node.label),
    h('span', { className: 'bt-widget-metric-value' }, asText(resolve(node.value, lookup, '—'))),
    caption !== '' ? h('span', { className: 'bt-view-caption' }, caption) : null)
}

function WidgetCallout({ node, lookup }) {
  const tone = resolve(node.tone, lookup)
  return h('div', { className: 'bt-view-callout', 'data-tone': CALLOUT_TONES.includes(tone) ? tone : 'info' },
    h('span', { className: 'bt-view-callout-icon', 'aria-hidden': true }, h(InfoIcon)),
    h('div', { className: 'bt-view-callout-text' }, h(MarkdownText, { text: asText(resolve(node.text, lookup, '')), labels: mdLabels(), variant: 'compact' })))
}

const LinkIcon = () => h('svg', { width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M8.5 11.5l3-3' }), h('path', { d: 'M7 9.5L5.5 11a2.5 2.5 0 0 0 3.5 3.5L10.5 13' }), h('path', { d: 'M13 10.5l1.5-1.5A2.5 2.5 0 0 0 11 5.5L9.5 7' }))

function WidgetSources({ node }) {
  const items = (Array.isArray(node.items) ? node.items : []).filter(item => typeof item?.url === 'string' && /^https?:\/\//i.test(item.url))
  return h('div', { className: 'bt-view-sources', role: 'list', 'aria-label': t('Sources') },
    items.map((item, index) => h('a', { key: index, role: 'listitem', className: 'bt-view-source', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: item.url }, h(LinkIcon), item.label)))
}

// -------------------------------------------------------------------------
// Inputs. Their values stay in the page; formulas read them on every change.

function InputHead({ id, label, value }) {
  return h('div', { className: 'bt-view-input-head' },
    h('label', { htmlFor: id, className: 'bt-view-input-label' }, label),
    value !== undefined ? h('output', { htmlFor: id, className: 'bt-view-input-value' }, value) : null)
}

const withUnit = (value, unit) => `${asText(value)}${unit ? ` ${unit}` : ''}`
const grouped = value => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : asText(value))

function SliderInput({ node, ctx }) {
  const id = useId()
  const value = Number(ctx.values[node.id])
  const percent = node.max > node.min ? ((value - node.min) / (node.max - node.min)) * 100 : 0
  return h('div', { className: 'bt-view-input' },
    h(InputHead, { id, label: node.label, value: withUnit(grouped(value), node.unit) }),
    h('input', {
      id, type: 'range', className: 'bt-view-range', min: node.min, max: node.max, step: node.step ?? 'any', value,
      disabled: ctx.locked, style: { '--bt-fill': `${percent}%` },
      onChange: event => ctx.setInput(node.id, Number(event.target.value)),
    }))
}

function NumberInput({ node, ctx }) {
  const id = useId()
  const [draft, setDraft] = useState(null)
  const value = ctx.values[node.id]
  const accept = (raw) => {
    setDraft(raw)
    const next = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(next)) return
    if ((node.min !== undefined && next < node.min) || (node.max !== undefined && next > node.max)) return
    ctx.setInput(node.id, next)
  }
  return h('div', { className: 'bt-view-input' },
    h(InputHead, { id, label: node.label }),
    h('span', { className: 'bt-q-field bt-view-number' },
      h('input', {
        id, className: 'bt-q-input', type: 'number', inputMode: 'decimal', value: draft ?? asText(value),
        min: node.min, max: node.max, step: node.step ?? 'any', disabled: ctx.locked,
        onChange: event => accept(event.target.value), onBlur: () => setDraft(null),
      }),
      node.unit ? h('span', { className: 'bt-view-unit' }, node.unit) : null))
}

// A few short options sit side by side; more, or longer ones, stack as a list.
function ChoiceInput({ node, ctx }) {
  const labelId = useId()
  const options = optionsOf(node)
  const current = ctx.values[node.id]
  const side = options.length <= 4 && options.every(option => [...option.label].length <= 14)
  const pick = option => () => { if (!ctx.locked) ctx.setInput(node.id, choiceValue(option)) }
  return h('div', { className: 'bt-view-input' },
    h('span', { className: 'bt-view-input-label', id: labelId }, node.label),
    side
      ? h(Segmented, { label: node.label, value: options.findIndex(option => choiceValue(option) === current), className: 'bt-view-seg' },
        options.map(option => h('button', { key: option.label, type: 'button', 'aria-pressed': choiceValue(option) === current, disabled: ctx.locked, onClick: pick(option) }, option.label)))
      : h('div', { className: 'bt-view-radios', role: 'radiogroup', 'aria-labelledby': labelId },
        options.map(option => h('button', {
          key: option.label, type: 'button', role: 'radio', className: 'bt-view-radio',
          'aria-checked': choiceValue(option) === current, disabled: ctx.locked, onClick: pick(option),
        }, h('span', { className: 'bt-view-radio-dot', 'aria-hidden': true }), option.label))))
}

function ToggleInput({ node, ctx }) {
  const on = ctx.values[node.id] === true
  return h('div', { className: 'bt-view-toggle' },
    h('span', { className: 'bt-view-input-label' }, node.label),
    h('button', { type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': on, 'aria-label': node.label, disabled: ctx.locked, onClick: () => ctx.setInput(node.id, !on) },
      h('span', { className: 'bt-switch-knob', 'aria-hidden': true })))
}

// One blueprint node. Unknown types render nothing: the host validates the
// blueprint, so what arrives here is known or safely ignored.
function WidgetNode({ node, ctx }) {
  if (node === null || typeof node !== 'object') return null
  const { lookup } = ctx
  switch (node.type) {
    case 'stack':
    case 'row': {
      const children = Array.isArray(node.children) ? node.children : []
      return h('div', { className: node.type === 'row' ? 'bt-view-row' : 'bt-widget-stack' },
        children.map((child, index) => h(WidgetNode, { key: child?.id ?? index, node: child, ctx })))
    }
    case 'text': {
      const text = h(MarkdownText, { text: asText(resolve(node.text, lookup, '')), labels: mdLabels(), variant: 'compact' })
      return node.tone === 'muted' ? h('div', { className: 'bt-view-muted' }, text) : text
    }
    case 'metric': return h(WidgetMetric, { node, lookup })
    case 'table': return h(WidgetTable, { node, lookup })
    case 'chart': return h(WidgetChart, { node, lookup, registerChart: ctx.registerChart, refreshCharts: ctx.refreshCharts })
    case 'progress': return h(WidgetProgress, { node, lookup })
    case 'callout': return h(WidgetCallout, { node, lookup })
    case 'sources': return h(WidgetSources, { node })
    case 'html': return h(HtmlFrame, { node })
    case 'slider': return h(SliderInput, { node, ctx })
    case 'number': return h(NumberInput, { node, ctx })
    case 'choice': return h(ChoiceInput, { node, ctx })
    case 'toggle': return h(ToggleInput, { node, ctx })
    case 'submit': return h(SubmitInput, { node, ctx })
    case 'options': return ctx.settled ? h(SettledOptions, { node, answer: ctx.answer }) : h(OptionsInput, { node, onSubmit: ctx.onSubmit, keys: ctx.keys, busy: ctx.busy })
    case 'confirm': return ctx.settled ? h(SettledConfirm, { node, answer: ctx.answer }) : h(ConfirmInput, { node, onSubmit: ctx.onSubmit, busy: ctx.busy })
    case 'form': return ctx.settled ? h(SettledForm, { node, answer: ctx.answer }) : h(FormInput, { node, onSubmit: ctx.onSubmit, busy: ctx.busy })
    default: return null
  }
}

// A whole blueprint. Inputs start where the Bot set them; an answered view shows
// them as they were sent. Every answer carries the inputs' values. Letter keys
// answer a lone options block from the keyboard; with more than one in a card the
// same letter would hit both.
export function WidgetView({ view, onSubmit, settled = false, answer = null, busy = false, registerChart, refreshCharts }) {
  const inputs = viewInputs(view)
  const [values, setValues] = useState(() => Object.fromEntries(inputs.map(node => [node.id, inputDefault(node)])))
  const sent = answer?.values?.inputs
  const current = settled && sent !== null && typeof sent === 'object' ? { ...values, ...sent } : values
  const submit = (action, extra) => onSubmit?.(action, inputs.length > 0 ? { ...extra, inputs: current } : extra)
  const ctx = {
    onSubmit: submit, settled, answer, busy, keys: !settled && countType(view, 'options') === 1,
    lookup: viewScope(view, current), values: current, locked: settled || busy,
    setInput: (id, value) => setValues(before => ({ ...before, [id]: value })), registerChart, refreshCharts,
  }
  return h(WidgetNode, { node: view, ctx })
}

// A chart keeps its actions (table view, copy, save) in the card's ⋯ menu: each
// chart registers a handle in mount order and bumps the card so a table switch
// shows in the open menu's wording.
function useChartHandles() {
  const [, bump] = useState(0)
  const charts = useRef(new Map())
  const fns = useRef(null)
  if (fns.current === null) {
    const refresh = () => bump(value => value + 1)
    fns.current = {
      registerChart: (key, handle) => {
        charts.current.set(key, handle)
        refresh()
        return () => { charts.current.delete(key); refresh() }
      },
      refreshCharts: refresh,
    }
  }
  return { charts: [...charts.current.values()], ...fns.current }
}

// The dropdown's items: one flat list for a lone chart, one labelled group per
// chart otherwise.
export function ViewMenuList({ charts, pick }) {
  return h('div', { className: 'bt-menu bt-view-menu', role: 'menu' },
    charts.map((chart, index) => h(Fragment, { key: index },
      charts.length > 1 ? h(Fragment, null,
        index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
        h('div', { className: 'bt-view-menu-label' }, chart.label ?? t('Chart {n}', { n: index + 1 }))) : null,
      h('button', { type: 'button', role: 'menuitem', onClick: pick(chart.toggleTable) }, h(TableIcon), chart.asTable ? t('View as chart') : t('View as table')),
      h('button', { type: 'button', role: 'menuitem', onClick: pick(chart.copy) }, h(CopyIcon), t('Copy data')),
      h('button', { type: 'button', role: 'menuitem', onClick: pick(chart.save) }, h(DownloadIcon), t('Download image')))))
}

function ViewMenu({ charts }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const away = (event) => { if (!root.current?.contains(event.target)) setOpen(false) }
    const key = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key) }
  }, [open])
  const pick = run => () => { setOpen(false); run() }
  return h('div', { ref: root, className: 'bt-view-tools', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-view-more', 'aria-label': t('Chart options'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, h(DotsIcon)),
    open ? h(ViewMenuList, { charts, pick }) : null)
}

// What every view wears. A view with controls is a light card; one that only shows
// sits in the reply without a frame. The title is an optional small heading, and a
// view that still waits for its answer has a dismiss button.
function WidgetCard({ title, view, onSubmit, onDismiss, busy = false, raised = false, settled = false, answer = null }) {
  const titleId = useId()
  const { charts, registerChart, refreshCharts } = useChartHandles()
  const framed = raised || hasControls(view)
  const className = ['bt-view', framed ? 'bt-q' : 'bt-view-bare', settled ? 'bt-q-settled' : '', raised ? 'bt-q-raised' : ''].filter(Boolean).join(' ')
  const head = title || onDismiss || countType(view, 'chart') > 0
    ? h('div', { className: 'bt-view-head' },
      title ? h('p', { className: 'bt-view-title', id: titleId }, title) : h('span', { className: 'bt-view-title' }),
      countType(view, 'chart') > 0 ? h(ViewMenu, { charts }) : null,
      onDismiss ? h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Dismiss view'), title: t('Dismiss'), onClick: onDismiss, disabled: busy }, h(CloseIcon)) : null)
    : null
  return h('div', {
    className, role: 'group', 'aria-labelledby': title ? titleId : undefined, 'aria-label': title ? undefined : t('View'), 'aria-busy': busy || undefined,
  },
  head,
  h('div', { className: 'bt-view-body' }, h(WidgetView, { view, onSubmit, settled, answer, busy, registerChart, refreshCharts })))
}

// A view waiting for its answer, inline at its call or raised in the dock. Like a
// pending question it hides on submit and comes back if the reply fails.
export function PendingView({ sessionId, view, actions, inline }) {
  const [answered, setAnswered] = useState(null)
  const busyRef = useRef(false)
  const hold = useDockHold(sessionId, 'view', view.id, actions, inline)
  const flying = answered === view.id
  const run = (make) => {
    // The ref, not the state: two clicks in the same frame both read flying=false.
    if (busyRef.current) return
    busyRef.current = true
    hold()
    setAnswered(view.id)
    void Promise.resolve().then(make).catch(() => setAnswered(null)).finally(() => { busyRef.current = false })
  }
  const onSubmit = (action, values) => run(() => actions.answerView(sessionId, view.id, action, values))
  const onDismiss = () => run(() => actions.dismissView(sessionId))
  // Hidden, not unmounted, while the answer is on its way: if it fails the card comes
  // back with what the user had typed or picked. The inputs stay busy meanwhile, so a
  // letter key cannot answer a hidden card.
  return h('div', { className: inline ? 'bt-q-inline' : 'bt-q-dock', style: flying ? { display: 'none' } : undefined, onFocusCapture: hold, onPointerDownCapture: hold },
    h(WidgetCard, { key: view.id, title: view.title ?? '', view: view.view, onSubmit, onDismiss, busy: flying, raised: !inline }))
}

// The show_view call in the transcript.
export function WidgetCell({ sessionId, callId, args, done, isError, roster, actions, heldCards }) {
  const record = roster.views?.[sessionId]
  if (record !== undefined && record.callId === callId) {
    if (heldCards?.[heldCardKey('view', record.id)] > 0) return null
    return h(PendingView, { sessionId, view: record, actions, inline: true })
  }
  // A refused call (bad blueprint) drew no card; don't render an empty one.
  if (done && isError) return h('span', { className: 'bt-q-gone', hidden: true })
  // Display-only cards draw from the recorded call arguments, which keep the
  // provider's encoding: checkShownView measures and unwraps them as the host did.
  // The args accessor reads strings through `text`; `value` drops them.
  const shown = checkShownView(args?.text?.('title'), args?.value?.('view'))
  // A call the host refused — a blueprint it would not show, or a reply it cannot
  // wait for — leaves no card; the model's retry then stays the only one. So does
  // a settled interactive call: answered, dismissed or replaced, it leaves no gap
  // where it was (same as ask_user).
  if (shown.error !== undefined || shown.interactive || args?.value?.('await_reply') === true) {
    return h('span', { className: 'bt-q-gone', hidden: true })
  }
  return h('div', { className: 'bt-q-inline' }, h(WidgetCard, { title: shown.title, view: shown.view }))
}

// Views asked by a call the transcript does not draw wait above the composer,
// mirroring the question dock.
export function WidgetDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const view = useRoster(value => value.views?.[sessionId])
  const drawn = useCards?.(state => state[sessionId]?.[view?.callId] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('view', view?.id)] > 0) === true
  if (view === undefined || (view.callId && drawn && !held)) return null
  return h(PendingView, { sessionId, view, actions, inline: false })
}

// An answered view rides on the reply message itself: the settled card, read-only.
export function AnsweredView({ node }) {
  const data = node.data ?? {}
  let payload = null
  if (Array.isArray(data.views)) payload = data
  else {
    try { payload = typeof data.text === 'string' ? JSON.parse(data.text) : null } catch { payload = null }
    if (payload?.kind !== 'answer_to_pending_view') payload = null
  }
  const view = payload?.views?.[0]
  if (view === null || typeof view !== 'object' || view.view === undefined) return null
  const answers = Array.isArray(payload.answers) ? payload.answers : []
  const answer = answers.find(entry => entry?.id === view.id) ?? answers[0] ?? null
  return h('div', { className: 'bt-q-inline' }, h(WidgetCard, { title: view.title ?? '', view: view.view, settled: true, answer }))
}

// A question reply node carries either questions (data.questions) or a view answer
// (JSON text discriminated by kind); each shape gets its own renderer.
export function AnsweredReply({ node }) {
  const data = node?.data ?? {}
  if (Array.isArray(data.views) && data.views.length > 0) return h(AnsweredView, { node })
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    let parsed = null
    try { parsed = typeof data.text === 'string' ? JSON.parse(data.text) : null } catch { parsed = null }
    if (parsed?.kind === 'answer_to_pending_view') return h(AnsweredView, { node })
  }
  return h(AnsweredCell, { node })
}

export const WIDGET_CSS = `
.bt-view{min-width:0}
.bt-view-bare{display:flex;flex-direction:column;gap:8px;width:100%;color:var(--bt-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;animation:bt-veil-in .2s ease-out backwards}
.bt-view-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-view-title{flex:1 1 0;min-width:0;margin:0;font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-q-settled .bt-view-title{color:var(--bt-ink-2)}
.bt-view-tools{position:relative;flex:none;align-self:flex-start;opacity:0;transition:opacity .12s ease}
.bt-view:hover .bt-view-tools,.bt-view-tools:focus-within,.bt-view-tools[data-open]{opacity:1}
@media (hover:none){.bt-view-tools{opacity:1}}
.bt-view-more{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:none;color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-view-more:hover,.bt-view-tools[data-open] .bt-view-more{background:var(--bt-hover);color:var(--bt-ink)}
.bt-view-more:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-view-more svg{width:16px;height:16px}
.bt-menu.bt-view-menu{position:absolute;top:32px;right:0;--bt-origin:top right;min-width:180px}
.bt-menu.bt-view-menu button{gap:8px}
.bt-view-menu-label{padding:2px 8px;font-size:11px;line-height:14px;color:var(--bt-ink-3);white-space:nowrap}
.bt-view-body{min-width:0}
.bt-widget-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.bt-view-row{display:flex;flex-wrap:wrap;gap:12px 24px;min-width:0}
.bt-view-row>*{flex:1 1 160px;min-width:0}
.bt-widget-metric{display:flex;flex-direction:column;gap:1px;min-width:0}
.bt-widget-metric-label{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-widget-metric-value{font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-widget-metric[data-tone=good] .bt-widget-metric-value{color:var(--bt-green)}
.bt-widget-metric[data-tone=warn] .bt-widget-metric-value{color:var(--bt-star)}
.bt-widget-metric[data-tone=bad] .bt-widget-metric-value{color:var(--bt-danger)}
.bt-view-caption{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-view-muted{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-view-muted *{font-size:inherit!important;line-height:inherit!important;color:inherit!important}
.bt-widget-table{max-width:100%;overflow-x:auto;border:.5px solid var(--bt-line-2);border-radius:10px}
.bt-widget-table table{border-collapse:collapse;min-width:100%;font-size:13px;line-height:18px}
.bt-widget-table th{padding:6px 10px;font-weight:500;text-align:start;white-space:nowrap;color:var(--bt-ink-2);border-bottom:.5px solid var(--bt-line-2)}
.bt-widget-table td{padding:6px 10px;max-width:280px;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-widget-table tbody tr+tr>*{border-top:.5px solid var(--bt-line)}
.bt-widget-table .bt-num{text-align:end;font-variant-numeric:tabular-nums}
.bt-widget-form{display:flex;flex-direction:column;gap:8px;margin:0}
.bt-widget-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-widget-field-label{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-widget-field .bt-q-field:has(.bt-q-input:disabled){cursor:default;opacity:.75}
.bt-widget-progress{display:flex;flex-direction:column;gap:5px;min-width:0}
.bt-widget-progress-label{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-widget-progress-name{color:var(--bt-ink);font-weight:500}
.bt-widget-progress-track{height:6px;border-radius:999px;background:var(--bt-hover);overflow:hidden}
.bt-widget-progress-fill{height:100%;border-radius:inherit;background:var(--bt-accent);transition:width .12s ease,background-color .12s ease}
.bt-widget-progress[data-tone=good] .bt-widget-progress-fill{background:var(--bt-green)}
.bt-widget-progress[data-tone=warn] .bt-widget-progress-fill{background:var(--bt-star)}
.bt-widget-progress[data-tone=bad] .bt-widget-progress-fill{background:var(--bt-danger)}
.bt-widget-progress[data-tone=bad] .bt-widget-progress-label>span:last-child{color:var(--bt-danger)}
.bt-view-callout{display:flex;gap:8px;padding:8px 12px;border-radius:10px;--bt-tone:var(--bt-accent);background:color-mix(in srgb,var(--bt-tone) 8%,transparent);color:var(--bt-ink)}
.bt-view-callout[data-tone=good]{--bt-tone:var(--bt-green)}
.bt-view-callout[data-tone=warn]{--bt-tone:var(--bt-star)}
.bt-view-callout[data-tone=bad]{--bt-tone:var(--bt-danger)}
.bt-view-callout-icon{flex:none;display:flex;padding-top:3px;color:var(--bt-tone)}
.bt-view-callout-icon svg{width:16px;height:16px}
.bt-view-callout-text{flex:1 1 auto;min-width:0}
.bt-view-sources{display:flex;flex-wrap:wrap;gap:6px}
.bt-view-source{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:20px;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg,var(--bt-hover));color:var(--bt-ink-2);font-size:11px;line-height:16px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .12s ease,color .12s ease}
.bt-view-source:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-view-source:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-view-input{display:flex;flex-direction:column;gap:6px;min-width:0}
.bt-view-input-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.bt-view-input-label{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-view-input-value{font-size:15px;line-height:20px;font-weight:600;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-view-range{-webkit-appearance:none;appearance:none;width:100%;height:20px;margin:0;background:transparent;cursor:pointer}
.bt-view-range:disabled{cursor:default;opacity:.6}
.bt-view-range::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(to right,var(--bt-accent) var(--bt-fill,0%),var(--bt-hover) var(--bt-fill,0%))}
.bt-view-range::-moz-range-track{height:6px;border-radius:999px;background:var(--bt-hover)}
.bt-view-range::-moz-range-progress{height:6px;border-radius:999px;background:var(--bt-accent)}
.bt-view-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-5px;border-radius:50%;corner-shape:round;background:var(--bt-knob);box-shadow:0 1px 3px rgba(0,0,0,.25),0 0 0 .5px rgba(0,0,0,.12)}
.bt-view-range::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--bt-knob);box-shadow:0 1px 3px rgba(0,0,0,.25),0 0 0 .5px rgba(0,0,0,.12)}
.bt-view-range:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:6px}
.bt-view-number{max-width:200px;align-items:center;gap:6px}
.bt-view-number .bt-q-input{font-variant-numeric:tabular-nums}
.bt-view-unit{flex:none;font-size:13px;color:var(--bt-ink-2)}
.bt-seg.bt-view-seg{align-self:flex-start;max-width:100%}
.bt-seg.bt-view-seg button{flex:none;padding:0 12px;white-space:nowrap}
.bt-view-radios{display:flex;flex-direction:column;gap:2px}
.bt-view-radio{display:flex;align-items:center;gap:8px;min-height:30px;padding:4px 8px;margin:0 -8px;border:0;border-radius:8px;background:none;font:inherit;font-size:14px;line-height:20px;color:var(--bt-ink);text-align:start;cursor:pointer;transition:background-color .12s ease}
.bt-view-radio:hover:not(:disabled){background:var(--bt-hover)}
.bt-view-radio:disabled{cursor:default}
.bt-view-radio:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-view-radio-dot{flex:none;width:16px;height:16px;border-radius:50%;corner-shape:round;box-shadow:inset 0 0 0 1.5px var(--bt-line-2);transition:box-shadow .12s ease}
.bt-view-radio[aria-checked=true] .bt-view-radio-dot{box-shadow:inset 0 0 0 5px var(--bt-accent)}
.bt-view-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.bt-view-toggle .bt-view-input-label{font-size:14px;line-height:20px;color:var(--bt-ink)}
.bt-q.bt-view{gap:10px}
.bt-q.bt-view:not(.bt-q-raised):not(.bt-q-settled)>.bt-view-head:has(.bt-view-title:empty){margin-bottom:-6px}
.bt-q-raised .bt-view-head{padding:14px 16px 4px 20px}
.bt-q-raised .bt-view-body{padding:0 16px 14px 20px}
.bt-q-raised .bt-view-body .bt-q-list{padding:0;margin:0 -8px}
.bt-q-inline .bt-view{margin:0;width:100%;max-width:min(100%,max(calc(var(--bt-msg-w,.8) * 100%),560px));order:0}
body[data-bt-layout=flat] .bt-q-inline .bt-view{max-width:calc(var(--bt-flat-w,1) * 100%)}
.bt-q-inline:has(>.bt-view-bare){margin:8px 0 12px}
@media (prefers-reduced-motion:reduce){.bt-widget-progress-fill,.bt-view-radio-dot,.bt-view-tools,.bt-view-more{transition:none}.bt-view-bare{animation:none}}
${CHART_CSS}
${HTML_CSS}
`
