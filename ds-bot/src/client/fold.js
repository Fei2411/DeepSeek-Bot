import { createElement as h, useMemo, useState } from 'react'
import { t } from './i18n.js'

// A message past FOLD_AT shows folded: its first lines, then "Show all". A Bot's reply in
// its own chat is what the user reads, so it folds only past FOLD_HUGE, where rendering
// all of it would slow the chat down.
export const FOLD_AT = { chars: 1500, lines: 25 }
export const FOLD_HUGE = { chars: 20_000, lines: Infinity }
const ALWAYS = { chars: -1, lines: 0 }
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 600
const FENCE = /^ {0,3}(`{3,}|~{3,})/

// Cuts `text` at `end` code units, backing up one when the last character is a
// high surrogate so an emoji is not split in half.
function cutAt(text, end) {
  const code = text.charCodeAt(end - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

// More than `max` lines, counted only as far as needed.
function moreLines(text, max) {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (++lines > max) return true
  }
  return false
}

// The start of a long text, cut at a line end (or inside a very long first line). In
// Markdown a code fence left open is closed, so the preview does not run on as code.
// Null when `text` is within `limit`.
// The fence a preview cut left open: the marker and its line index in `lines`.
function openedFence(lines) {
  let open = null
  let openLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    const marker = FENCE.exec(lines[i])?.[1]
    if (marker === undefined) continue
    if (open === null) { open = marker; openLine = i }
    else if (marker[0] === open[0] && marker.length >= open.length) open = null
  }
  return open === null ? null : { marker: open, line: openLine }
}

// The block a preview's cut fence opens, read whole from the unfolded text: the
// lines between the fence and its close (or the end when it never closes), so a
// copy of the partly shown block does not stop at the fold.
function blockCode(body, fenceLine, open) {
  const lines = body.split('\n')
  const code = []
  for (let i = fenceLine + 1; i < lines.length; i += 1) {
    const marker = FENCE.exec(lines[i])?.[1]
    if (marker !== undefined && marker[0] === open[0] && marker.length >= open.length) break
    code.push(lines[i])
  }
  return code.join('\n')
}

// The preview `head` plus `code`, the whole block its cut fence opens (null when
// the cut does not sit inside a fence).
export function foldView(text, limit = FOLD_AT, markdown = true) {
  if (text.length <= limit.chars && !moreLines(text, limit.lines)) return null
  // Blank lines first: the preview starts at the first visible character. An
  // all-blank message has nothing to preview, so it does not fold at all.
  const body = text.replace(/^(\s*\n)+/, '')
  if (body.trim() === '') return null
  let head = body.split('\n', PREVIEW_LINES).join('\n')
  if (head.length > PREVIEW_CHARS) {
    const cut = head.lastIndexOf('\n', PREVIEW_CHARS)
    head = cutAt(head, cut > 0 ? cut : PREVIEW_CHARS)
  }
  if (head.trim() === '') head = cutAt(body, PREVIEW_CHARS)
  if (!markdown) return { head }
  let opened = openedFence(head.split('\n'))
  if (opened !== null && head.split('\n').slice(opened.line + 1).join('').trim() === '') {
    // The cut kept only the fence marker (a card opening like ```dsh-ui on
    // its own line): an empty fence renders nothing, so pull the start of
    // the fenced text in as the preview instead.
    head = cutAt(body, PREVIEW_CHARS)
    opened = openedFence(head.split('\n'))
  }
  if (opened === null) return { head }
  // A fence the preview cut open loses its language tag: a downstream
  // renderer (dsh-ui cards) would otherwise claim the half message and the
  // expansion remounts its subtree looking like a no-op.
  const lines = head.split('\n')
  lines[opened.line] = opened.marker
  return { head: `${lines.join('\n')}\n${opened.marker}`, code: blockCode(body, opened.line, opened.marker) }
}

export function foldPreview(text, limit = FOLD_AT, markdown = true) {
  return foldView(text, limit, markdown)?.head ?? null
}

// The line a long message that went as a file starts with (the host's attachLong) is
// for the model; the chat shows "Show all" instead.
export const stripLongNote = text => text.replace(/^\[A long message: \d+ characters\.[^\]\n]*\]\n/, '')

// `shown`: the text to show now; `control`: what goes under it (null for a short text).
// `whole`, when `text` is only the start of the message: its `length`, and `load()`,
// which reads it whole ({ text, whole }). `live`: still streaming, never folded.
// `markdown`: false for plain text.
export function useFold(text, { limit = FOLD_AT, whole, live = false, markdown = true } = {}) {
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState()
  const cut = whole !== undefined && whole.length > text.length
  // A message kept only in part folds whatever the length of its start.
  const view = useMemo(() => (live ? null : foldView(text, cut ? ALWAYS : limit, markdown)), [text, live, limit, markdown, cut])
  if (view === null) return { shown: text, control: null }
  // `code` is the whole block the preview's last code fence opens, for a copy
  // that must not stop at the fold; only the full text can supply it, so a
  // message kept only in part has none.
  const code = cut ? undefined : view.code
  const count = (cut ? whole.length : text.length).toLocaleString()
  if (!open) {
    const show = async () => {
      setOpen(true)
      if (!cut || read !== undefined || whole.load === undefined) return
      setRead('loading')
      setRead(await whole.load() ?? { whole: false })
    }
    return { shown: view.head, folded: true, code, control: h('span', { className: 'bt-fold' }, h('button', { type: 'button', className: 'bt-more', onClick: show }, t('Show all · {count} characters', { count }))) }
  }
  const loaded = typeof read?.text === 'string' ? read : undefined
  const note = !cut || read === undefined || read === 'loading' || loaded?.whole ? null
    : loaded !== undefined && loaded.text.length > text.length ? t('Showing the first {count} characters', { count: loaded.text.length.toLocaleString() })
      : t('Only the start of this message is kept here')
  return {
    shown: loaded?.text ?? text,
    control: h('span', { className: 'bt-fold' },
      note ? h('span', { className: 'bt-fold-note' }, note) : null,
      h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(false) }, t('Show less'))),
  }
}
