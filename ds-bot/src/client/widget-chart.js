import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { asText, resolve } from '../shared/views.js'

// -------------------------------------------------------------------------
// The chart component of a view: bar, horizontal bar, line, area and donut, drawn
// as SVG at the width it gets. Hover or arrow keys show a category's values and dim
// the rest; a legend hides a series; the menu shows the data as a table, copies it
// as CSV, or saves the chart as a PNG. Colors come from the theme only.

// The first series takes the accent; the rest take the team inks.
const PALETTE = ['var(--bt-accent)', 'var(--bt-ink-tangerine)', 'var(--bt-ink-green)', 'var(--bt-ink-violet)', 'var(--bt-ink-sky)', 'var(--bt-ink-rose)', 'var(--bt-ink-yellow)', 'var(--bt-ink-cyan)', 'var(--bt-ink-magenta)']
const colorAt = index => PALETTE[index % PALETTE.length]
const TICK = 10
const LABEL = 11
// A rough width for SVG text before it is laid out; wide (CJK) characters count double.
const textWidth = (text, size) => [...String(text)].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? size : size * 0.58), 0)
const fit = (text, room, size) => {
  if (textWidth(text, size) <= room) return text
  let out = ''
  for (const char of String(text)) {
    if (textWidth(`${out}${char}…`, size) > room) break
    out += char
  }
  return out === '' ? '' : `${out}…`
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return asText(value)
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })
}
const withUnit = (value, unit) => (unit ? (unit === '%' ? `${formatNumber(value)}%` : `${formatNumber(value)} ${unit}`) : formatNumber(value))

// Round steps (1, 2, 2.5, 5 × 10ⁿ) from `low` to `high`, about four of them.
export function niceTicks(low, high) {
  let lo = low
  let hi = high
  if (lo === hi) { lo = Math.min(0, lo); hi = hi === 0 ? 1 : Math.max(0, hi) }
  if (lo === hi) hi = lo + 1
  const raw = (hi - lo) / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(scale => scale * magnitude).find(candidate => candidate >= raw)
  const start = Math.floor(lo / step + 1e-9) * step
  const end = Math.ceil(hi / step - 1e-9) * step
  const ticks = []
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Number(value.toPrecision(12)))
  return ticks
}

export function chartData(node, lookup) {
  const categories = (Array.isArray(node.categories) ? node.categories : []).map(asText)
  const series = (Array.isArray(node.series) ? node.series : []).map((item, index) => ({
    name: typeof item?.name === 'string' ? item.name : '',
    color: colorAt(index),
    values: categories.map((_, at) => {
      const value = Number(resolve(Array.isArray(item?.values) ? item.values[at] : undefined, lookup, 0))
      return Number.isFinite(value) ? value : 0
    }),
  }))
  return { kind: node.kind ?? 'bar', categories, series, unit: typeof node.unit === 'string' ? node.unit : '' }
}

const csvCell = value => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
export function chartCsv({ categories, series, unit }) {
  const head = ['', ...series.map((item, index) => item.name || (series.length === 1 ? unit || t('Value') : `${t('Series')} ${index + 1}`))]
  const rows = categories.map((label, at) => [label, ...series.map(item => String(item.values[at]))])
  return [head, ...rows].map(row => row.map(cell => csvCell(String(cell))).join(',')).join('\n')
}

// -------------------------------------------------------------------------
// Drawings. Each returns the SVG body, its height, and where each category's
// tooltip points ({ x, y } in SVG pixels).

function valueAxis(values, zero) {
  const finite = values.length > 0 ? values : [0]
  const low = Math.min(...finite)
  const high = Math.max(...finite)
  if (zero) return niceTicks(Math.min(0, low), Math.max(0, high))
  const pad = (high - low) * 0.1 || Math.abs(high) * 0.1 || 1
  return niceTicks(low - pad, high + pad)
}

function columns({ categories, series, unit, kind }, width, active, shown) {
  const visible = series.filter((_, index) => shown[index])
  const ticks = valueAxis(visible.flatMap(item => item.values), kind !== 'line')
  const lo = ticks[0]
  const hi = ticks.at(-1)
  const left = Math.ceil(Math.max(...ticks.map(tick => textWidth(withUnit(tick, unit), TICK)))) + 10
  const top = 8
  const height = 220
  const bottom = 24
  const plot = { x: left, y: top, w: Math.max(40, width - left - 4), h: height - top - bottom }
  const y = value => plot.y + plot.h - ((value - lo) / (hi - lo)) * plot.h
  const band = plot.w / categories.length
  const parts = []
  for (const tick of ticks) {
    parts.push(h('line', { key: `g${tick}`, className: 'bt-chart-grid', x1: plot.x, x2: plot.x + plot.w, y1: y(tick), y2: y(tick) }))
    parts.push(h('text', { key: `t${tick}`, className: 'bt-chart-tick', x: plot.x - 8, y: y(tick) + 3, textAnchor: 'end' }, withUnit(tick, unit)))
  }
  const points = []
  categories.forEach((label, at) => {
    const cx = plot.x + band * at + band / 2
    parts.push(h('text', { key: `c${at}`, className: 'bt-chart-label', x: cx, y: height - 7, textAnchor: 'middle' }, fit(label, band - 4, LABEL)))
    points.push({ x: cx, y: y(Math.max(...visible.map(item => item.values[at]), lo)) })
  })
  if (kind === 'bar') {
    const group = band * 0.72
    const gap = visible.length > 1 ? 2 : 0
    const barW = Math.max(2, (group - gap * (visible.length - 1)) / visible.length)
    const zero = y(Math.max(lo, Math.min(0, hi)))
    categories.forEach((_, at) => {
      visible.forEach((item, row) => {
        const value = item.values[at]
        const x = plot.x + band * at + (band - group) / 2 + row * (barW + gap)
        const top2 = Math.min(y(value), zero)
        const tall = Math.max(1, Math.abs(y(value) - zero))
        const r = Math.min(4, barW / 2, tall)
        const up = value >= 0
        const d = up
          ? `M${x},${top2 + tall}V${top2 + r}q0,-${r} ${r},-${r}h${barW - 2 * r}q${r},0 ${r},${r}V${top2 + tall}z`
          : `M${x},${top2}V${top2 + tall - r}q0,${r} ${r},${r}h${barW - 2 * r}q${r},0 ${r},-${r}V${top2}z`
        parts.push(h('path', { key: `b${at}-${row}`, className: 'bt-chart-mark', 'data-dim': active !== null && active !== at ? '' : undefined, d, style: { fill: item.color } }))
      })
    })
  } else {
    const xs = categories.map((_, at) => plot.x + band * at + band / 2)
    visible.forEach((item, row) => {
      const line = item.values.map((value, at) => `${at === 0 ? 'M' : 'L'}${xs[at]},${y(value)}`).join('')
      if (kind === 'area') {
        const base = y(Math.max(lo, Math.min(0, hi)))
        parts.push(h('path', { key: `a${row}`, className: 'bt-chart-area', d: `${line}L${xs.at(-1)},${base}L${xs[0]},${base}z`, style: { fill: item.color } }))
      }
      parts.push(h('path', { key: `l${row}`, className: 'bt-chart-line', d: line, style: { stroke: item.color } }))
      item.values.forEach((value, at) => {
        parts.push(h('circle', { key: `p${row}-${at}`, className: 'bt-chart-dot', cx: xs[at], cy: y(value), r: active === at ? 4 : 2.5, style: { fill: item.color } }))
      })
    })
    if (active !== null) parts.unshift(h('line', { key: 'guide', className: 'bt-chart-guide', x1: xs[active], x2: xs[active], y1: plot.y, y2: plot.y + plot.h }))
  }
  const hits = categories.map((_, at) => ({ x: plot.x + band * at, y: plot.y, w: band, h: plot.h }))
  return { parts, height, points, hits }
}

function rows({ categories, series, unit }, width, active, shown) {
  const visible = series.filter((_, index) => shown[index])
  const ticks = valueAxis(visible.flatMap(item => item.values), true)
  const lo = ticks[0]
  const hi = ticks.at(-1)
  const labelW = Math.min(width * 0.38, Math.ceil(Math.max(...categories.map(label => textWidth(label, LABEL)))) + 10)
  const valueW = Math.ceil(Math.max(...visible.flatMap(item => item.values).map(value => textWidth(withUnit(value, unit), LABEL)))) + 10
  const barH = 14
  const rowH = 10 + visible.length * barH + (visible.length - 1) * 2
  const top = 4
  const height = top + rowH * categories.length + 22
  const plot = { x: labelW, y: top, w: Math.max(40, width - labelW - valueW), h: rowH * categories.length }
  const x = value => plot.x + ((value - lo) / (hi - lo)) * plot.w
  const parts = []
  for (const tick of ticks) {
    parts.push(h('line', { key: `g${tick}`, className: 'bt-chart-grid', x1: x(tick), x2: x(tick), y1: plot.y, y2: plot.y + plot.h }))
    parts.push(h('text', { key: `t${tick}`, className: 'bt-chart-tick', x: x(tick), y: height - 6, textAnchor: 'middle' }, withUnit(tick, unit)))
  }
  const points = []
  const zero = x(Math.max(lo, Math.min(0, hi)))
  categories.forEach((label, at) => {
    const rowY = plot.y + rowH * at + 5
    parts.push(h('text', { key: `c${at}`, className: 'bt-chart-label', x: labelW - 10, y: rowY + (rowH - 10) / 2 + 4, textAnchor: 'end' }, fit(label, labelW - 12, LABEL)))
    visible.forEach((item, row) => {
      const value = item.values[at]
      const by = rowY + row * (barH + 2)
      const left = Math.min(x(value), zero)
      const long = Math.max(1, Math.abs(x(value) - zero))
      parts.push(h('rect', { key: `b${at}-${row}`, className: 'bt-chart-mark', 'data-dim': active !== null && active !== at ? '' : undefined, x: left, y: by, width: long, height: barH, rx: Math.min(4, long / 2), style: { fill: item.color } }))
      parts.push(h('text', { key: `v${at}-${row}`, className: 'bt-chart-value', x: left + long + 6, y: by + barH - 3 }, withUnit(value, unit)))
    })
    points.push({ x: Math.max(...visible.map(item => x(item.values[at])), zero), y: rowY })
  })
  const hits = categories.map((_, at) => ({ x: 0, y: plot.y + rowH * at, w: width, h: rowH }))
  return { parts, height, points, hits }
}

function donut({ categories, series }, width, active, hover) {
  const values = (series[0]?.values ?? []).map(value => Math.max(0, value))
  const total = values.reduce((sum, value) => sum + value, 0)
  const size = Math.min(180, Math.max(120, width * 0.42))
  const r = size / 2
  const inner = r * 0.62
  const cx = r
  const cy = r
  const parts = []
  const points = []
  let angle = -Math.PI / 2
  values.forEach((value, at) => {
    const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0
    const end = angle + sweep
    const mid = angle + sweep / 2
    points.push({ x: cx + Math.cos(mid) * (r - (r - inner) / 2), y: cy + Math.sin(mid) * (r - (r - inner) / 2) })
    if (sweep > 0) {
      const large = sweep > Math.PI ? 1 : 0
      const full = sweep >= Math.PI * 2 - 1e-6
      const p = (radius, theta) => `${cx + Math.cos(theta) * radius},${cy + Math.sin(theta) * radius}`
      const d = full
        ? `M${p(r, angle)}A${r},${r} 0 1 1 ${p(r, angle + Math.PI)}A${r},${r} 0 1 1 ${p(r, angle)}M${p(inner, angle)}A${inner},${inner} 0 1 0 ${p(inner, angle + Math.PI)}A${inner},${inner} 0 1 0 ${p(inner, angle)}z`
        : `M${p(r, angle)}A${r},${r} 0 ${large} 1 ${p(r, end)}L${p(inner, end)}A${inner},${inner} 0 ${large} 0 ${p(inner, angle)}z`
      parts.push(h('path', { key: `s${at}`, className: 'bt-chart-mark', 'data-dim': active !== null && active !== at ? '' : undefined, d, fillRule: 'evenodd', style: { fill: colorAt(at) }, onPointerEnter: () => hover(at) }))
    }
    angle = end
  })
  return { parts, height: size, size, points, total, values, categories }
}

// -------------------------------------------------------------------------

function useWidth(box, initial) {
  const [width, setWidth] = useState(initial)
  useLayoutEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver !== 'function') return undefined
    const measure = () => { const next = Math.round(node.clientWidth); if (next > 0) setWidth(next) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return width
}

// SVG styles live in the page's CSS; a saved image needs them written onto each node.
const INLINE = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'font-size', 'font-family', 'font-weight']
function saveImage(svg, name) {
  const clone = svg.cloneNode(true)
  const live = [svg, ...svg.querySelectorAll('*')]
  const copy = [clone, ...clone.querySelectorAll('*')]
  live.forEach((node, index) => {
    const style = getComputedStyle(node)
    copy[index].setAttribute('style', INLINE.map(prop => `${prop}:${style.getPropertyValue(prop)}`).join(';'))
  })
  // The attributes, not the layout box: under the table view the SVG is hidden.
  const width = Number(svg.getAttribute('width'))
  const height = Number(svg.getAttribute('height'))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const page = getComputedStyle(document.body)
  const background = page.getPropertyValue('--bt-main').trim() || page.backgroundColor
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
  const image = new Image()
  image.onload = () => {
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const paint = canvas.getContext('2d')
    paint.fillStyle = background
    paint.fillRect(0, 0, canvas.width, canvas.height)
    paint.drawImage(image, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    canvas.toBlob((blob) => {
      if (!blob) return
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    }, 'image/png')
  }
  image.onerror = () => URL.revokeObjectURL(url)
  image.src = url
}

export const TableIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4z' }), h('path', { d: 'M3 8.5h14M8 8.5V16' }))

function ChartTable({ data }) {
  const { categories, series, unit } = data
  const heads = series.map((item, index) => item.name || (series.length === 1 ? unit || t('Value') : `${t('Series')} ${index + 1}`))
  return h('div', { className: 'bt-widget-table' },
    h('table', null,
      h('thead', null, h('tr', null, h('th', { scope: 'col' }), heads.map((head, index) => h('th', { key: index, scope: 'col', className: 'bt-num' }, head)))),
      h('tbody', null, categories.map((label, at) => h('tr', { key: at },
        h('th', { scope: 'row' }, label),
        series.map((item, index) => h('td', { key: index, className: 'bt-num' }, withUnit(item.values[at], series.length === 1 && !item.name ? '' : unit))))))))
}

export function WidgetChart({ node, lookup, registerChart, refreshCharts }) {
  const data = chartData(node, lookup)
  const { kind, categories, series, unit } = data
  const box = useRef(null)
  const svg = useRef(null)
  const width = useWidth(box, 520)
  const [active, setActive] = useState(null)
  const [hidden, setHidden] = useState([])
  const [asTable, setAsTable] = useState(false)
  const [copied, setCopied] = useState(false)
  const labelId = useId()
  const menuKey = useId()
  const table = useRef(asTable)
  table.current = asTable
  const shown = series.map((_, index) => !hidden.includes(index))
  const toggle = (index) => {
    if (hidden.includes(index)) setHidden(hidden.filter(item => item !== index))
    else if (shown.filter(Boolean).length > 1) setHidden([...hidden, index])
  }
  const label = typeof node.caption === 'string' && node.caption !== '' ? node.caption : t('Chart')
  const isDonut = kind === 'donut'
  const legendBeside = isDonut && width >= 360
  const drawn = isDonut ? donut(data, legendBeside ? width - 200 : width, active, setActive)
    : kind === 'hbar' ? rows(data, width, active, shown) : columns(data, width, active, shown)
  const svgWidth = isDonut ? drawn.size : width
  const move = (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    if (event.key === 'Escape') { setActive(null); return }
    if (keys[event.key] === undefined) return
    event.preventDefault()
    setActive(current => (current === null ? 0 : (current + keys[event.key] + categories.length) % categories.length))
  }
  const point = active === null ? null : drawn.points[active]
  // A share in a donut already in percent needs no second percent.
  const share = at => (unit === '%' ? withUnit(drawn.values[at], unit) : `${withUnit(drawn.values[at], unit)} · ${drawn.total > 0 ? Math.round((drawn.values[at] / drawn.total) * 100) : 0}%`)
  const tipRows = active === null || isDonut ? [] : series.filter((_, index) => shown[index]).map(item => ({ color: item.color, name: item.name, value: withUnit(item.values[active], unit) }))
  const copy = () => {
    void navigator.clipboard?.writeText(chartCsv(data)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
  }
  const toggleTable = () => { table.current = !table.current; setAsTable(table.current) }
  const menuLabel = typeof node.caption === 'string' && node.caption !== '' ? node.caption : null
  const action = useRef(null)
  action.current = { label: menuLabel, copy, save: () => { if (svg.current) saveImage(svg.current, 'chart.png') }, toggleTable }
  // The card's ⋯ menu shows the chart's actions. Register once on mount — a
  // re-register would move the chart to the end of the card's group order —
  // and let the getters hand the menu the current name and table state.
  useEffect(() => registerChart?.(menuKey, {
    get label() { return action.current.label },
    get asTable() { return table.current },
    toggleTable: () => action.current.toggleTable(),
    copy: () => action.current.copy(),
    save: () => action.current.save(),
  }), [registerChart, menuKey])
  // A table switch or a new caption asks the card for a fresh menu, without
  // touching the registration order.
  useEffect(() => refreshCharts?.(), [refreshCharts, asTable, menuLabel])
  const legend = isDonut
    ? h('div', { className: 'bt-chart-legend bt-chart-legend-list' }, categories.map((name, at) => h('div', {
      key: at, className: 'bt-chart-key', 'data-dim': active !== null && active !== at ? '' : undefined,
      onPointerEnter: () => setActive(at), onPointerLeave: () => setActive(null),
    }, h('i', { style: { background: colorAt(at) } }), h('span', { className: 'bt-chart-key-name' }, name),
    h('span', { className: 'bt-chart-key-value' }, share(at)))))
    : series.length > 1 ? h('div', { className: 'bt-chart-legend' }, series.map((item, index) => h('button', {
      key: index, type: 'button', className: 'bt-chart-key', 'aria-pressed': shown[index], onClick: () => toggle(index),
    }, h('i', { style: { background: item.color } }), item.name || `${t('Series')} ${index + 1}`))) : null
  const plot = h('div', { className: 'bt-chart-plot', style: isDonut ? { width: svgWidth } : undefined },
    h('svg', {
      ref: svg, className: 'bt-chart-svg', width: svgWidth, height: drawn.height, viewBox: `0 0 ${svgWidth} ${drawn.height}`,
      role: 'img', 'aria-labelledby': labelId, tabIndex: 0,
      onKeyDown: move, onBlur: () => setActive(null), onPointerLeave: () => setActive(null),
    },
    drawn.parts,
    isDonut
      ? (active === null
        ? h('text', { className: 'bt-chart-center', x: svgWidth / 2, y: drawn.height / 2 + 5, textAnchor: 'middle' }, unit === '%' ? '' : withUnit(drawn.total, unit))
        : h(Fragment, null,
          h('text', { className: 'bt-chart-center-name', x: svgWidth / 2, y: drawn.height / 2 - 4, textAnchor: 'middle' }, fit(categories[active], drawn.size * 0.56, LABEL)),
          h('text', { className: 'bt-chart-center', x: svgWidth / 2, y: drawn.height / 2 + 14, textAnchor: 'middle' }, share(active))))
      : drawn.hits.map((hit, at) => h('rect', { key: `h${at}`, className: 'bt-chart-hit', x: hit.x, y: hit.y, width: hit.w, height: hit.h, onPointerEnter: () => setActive(at) }))),
    point && !asTable && !isDonut ? h('div', { className: 'bt-chart-tip', role: 'status', style: { left: point.x, top: point.y } },
      h('b', null, categories[active]),
      tipRows.map((row, index) => h('span', { key: index }, h('i', { style: { background: row.color } }), row.name ? `${row.name}  ` : '', row.value))) : null)
  const body = asTable ? h(ChartTable, { data })
    : isDonut ? h('div', { className: legendBeside ? 'bt-chart-donut bt-chart-donut-beside' : 'bt-chart-donut', onPointerLeave: () => setActive(null) }, plot, legend)
      : h(Fragment, null, legend, plot)
  return h('figure', { ref: box, className: 'bt-chart', 'data-kind': kind },
    h('span', { id: labelId, hidden: true }, label),
    body,
    // The SVG stays mounted under the table, so the image can still be saved from it.
    asTable ? h('div', { hidden: true }, plot) : null,
    copied ? h('span', { className: 'bt-chart-copied', role: 'status' }, t('Copied')) : null,
    typeof node.caption === 'string' && node.caption !== '' ? h('figcaption', { className: 'bt-view-caption' }, node.caption) : null)
}

export const CHART_CSS = `
.bt-chart{position:relative;margin:0;min-width:0;display:flex;flex-direction:column;gap:8px}
.bt-chart-plot{position:relative;min-width:0}
.bt-chart-svg{display:block;overflow:visible;outline:none;font-family:inherit}
.bt-chart-svg text{pointer-events:none}
.bt-chart-svg:focus-visible{outline:2px solid var(--bt-accent);outline-offset:4px;border-radius:4px}
.bt-chart-grid{stroke:var(--bt-line);stroke-width:1;stroke-dasharray:3 3}
.bt-chart-tick{font-size:${TICK}px;fill:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-chart-label{font-size:${LABEL}px;fill:var(--bt-ink-2)}
.bt-chart-value{font-size:${LABEL}px;fill:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-chart-center{font-size:15px;font-weight:600;fill:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-chart-center-name{font-size:${LABEL}px;fill:var(--bt-ink-2)}
.bt-chart-mark{transition:opacity .12s ease}
.bt-chart-mark[data-dim]{opacity:.28}
.bt-chart-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bt-chart-area{opacity:.14}
.bt-chart-dot{transition:r .12s ease}
.bt-chart-guide{stroke:var(--bt-line-2);stroke-width:1}
.bt-chart-hit{fill:transparent}
.bt-chart-tip{position:absolute;z-index:4;pointer-events:none;transform:translate(-50%,calc(-100% - 8px));display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-radius:10px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);font-size:12px;line-height:16px;color:var(--bt-ink);white-space:nowrap;font-variant-numeric:tabular-nums;animation:bt-veil-in .12s ease-out}
.bt-chart-tip b{font-weight:600}
.bt-chart-tip span{display:flex;align-items:center;gap:6px;color:var(--bt-ink-2)}
.bt-chart-tip i,.bt-chart-key i{flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round}
.bt-chart-legend{display:flex;flex-wrap:wrap;gap:4px 12px;padding-right:32px}
.bt-chart-key{display:inline-flex;align-items:center;gap:6px;min-height:20px;padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:16px;color:var(--bt-ink-2);cursor:pointer;transition:opacity .12s ease}
.bt-chart-key[aria-pressed=false]{opacity:.4}
.bt-chart-key:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-chart-legend-list{flex-direction:column;flex-wrap:nowrap;gap:6px;padding:0;min-width:0}
.bt-chart-legend-list .bt-chart-key{cursor:default;width:100%}
.bt-chart-legend-list .bt-chart-key[data-dim]{opacity:.4}
.bt-chart-key-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink)}
.bt-chart-key-value{flex:none;font-variant-numeric:tabular-nums}
.bt-chart-donut{display:flex;flex-direction:column;align-items:center;gap:12px}
.bt-chart-donut-beside{flex-direction:row;align-items:center;gap:24px}
.bt-chart-donut-beside .bt-chart-legend-list{flex:1 1 auto;max-width:280px}
.bt-chart-copied{position:absolute;top:2px;right:36px;font-size:12px;line-height:16px;color:var(--bt-ink-2);animation:bt-veil-in .16s ease-out}
.bt-widget-table .bt-num{text-align:end;font-variant-numeric:tabular-nums}
.bt-widget-table tbody th{padding:6px 10px;font-weight:400;text-align:start;color:var(--bt-ink);border-bottom:0}
@media (prefers-reduced-motion:reduce){.bt-chart-mark,.bt-chart-dot{transition:none}.bt-chart-tip{animation:none}}
`
