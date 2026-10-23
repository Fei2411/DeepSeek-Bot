import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { paintCss } from './inks.js'
import { CHARACTERS, PICKER_SHAPES, PICKER_COLUMNS, CHARACTER_COLORS, SHAPES, hasShape, shapeOf, bodyOf, maskBox, holes, nextMarkSerial } from './characters.js'
import { isMainOf } from './sources.js'
import { PencilIcon, ChevronRightIcon } from './icons.js'
import { lookOf, BotMark } from './mark.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { FolderMenu } from './folder-menu.js'
import { BotSchedules } from './schedules.js'
import { BotCapabilitiesCard } from './capability-settings.js'
import { AvatarLibraryPanel, avatarImage } from './avatar-library.js'
import { useMemoryCount } from './memory-panel.js'
import { SPRING_SHAPE, SPRING_TAP, spring, useGlide } from './motion.js'
import { t } from './i18n.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings save on blur or Enter, with no Save button; Escape puts the
// saved value back. A required field never saves empty.
export function InlineText({ label, value, placeholder, required = false, maxLength, multiline = false, onSave }) {
  const [draft, setDraft] = useState(null)
  const reverting = useRef(false)
  const commit = () => {
    const next = draft?.trim()
    setDraft(null)
    if (reverting.current) { reverting.current = false; return }
    if (next === undefined || next === (value ?? '') || (required && next === '')) return
    void onSave(next)
  }
  return h(multiline ? 'textarea' : 'input', {
    className: multiline ? 'bt-bs-input bt-bs-area' : 'bt-bs-input', value: draft ?? value ?? '', placeholder, maxLength, required, 'aria-label': label, spellCheck: false,
    onChange: event => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); reverting.current = true; event.currentTarget.blur() }
      if (event.key === 'Enter' && !multiline && !event.nativeEvent.isComposing) event.currentTarget.blur()
    },
  })
}

// One labelled card row with its control on the right, or below when `stack`.
export function Row({ label, hint, stack = false, children }) {
  return h('label', { className: stack ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children)
}

export function Card({ title, children }) {
  return h('section', { className: 'bt-set-section' }, title ? h('h3', null, title) : null, h('div', { className: 'bt-set-card' }, children))
}

export function Switch({ on, label, disabled, onChange }) {
  return h('button', { type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': on, 'aria-label': label, disabled, onClick: () => onChange(!on) },
    h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))
}

// A row with a switch. Not a label: a click on the copy must not flip it twice.
export function SwitchRow({ label, hint, on, disabled, onChange }) {
  return h('div', { className: 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    h(Switch, { on, label, disabled, onChange }))
}

function modelHint(bot, roster) {
  const shown = modelOf(bot, roster)
  if (shown === undefined) return t('Pick the model this Bot runs on.')
  if (!shown.served && (roster.models ?? []).length > 0) return t('This model is not available now. Pick another one.')
  if (bot.appliedModel && bot.appliedModel === bot.model) return t('Every message of this Bot runs on it.')
  return t('Applies from the next message.')
}

// The selection ring of a picker cell follows the shape: a 1px line 3px outside it.
function ShapeRing({ shape, size }) {
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-ring-${nextMarkSerial()}`
  const def = shapeOf(shape)
  const unit = def.size / size
  const markup = `<defs><mask id="${maskId.current}" ${maskBox(def.size)}>${holes(def, `<g stroke="#000" stroke-width="${6 * unit}" stroke-linejoin="round">${bodyOf(def, '#000', true)}</g>`)}</mask></defs><g mask="url(#${maskId.current})" stroke="currentColor" stroke-width="${8 * unit}" stroke-linejoin="round">${bodyOf(def, 'currentColor', true)}</g>`
  return h('svg', { className: 'bt-ring', viewBox: `0 0 ${def.size} ${def.size}`, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: markup } })
}

// Every character shape, six to a row, then the color swatches.
export function CharacterGrid({ look, hasPhoto = false, onShape, onColor }) {
  const shapes = [...PICKER_SHAPES, ...Object.keys(SHAPES).filter(id => !Object.hasOwn(CHARACTERS, id))]
  if (!shapes.includes(look.shape)) shapes.push(look.shape)
  const rows = []
  for (let index = 0; index < shapes.length; index += PICKER_COLUMNS) rows.push(shapes.slice(index, index + PICKER_COLUMNS))
  return h(Fragment, null,
    h('div', { className: 'bt-shapes', role: 'group', 'aria-label': t('Character shape') }, rows.map((row, index) => h('div', { key: index, className: 'bt-shape-row' }, row.map(id => h('button', {
      key: id, type: 'button', className: 'bt-shape', 'aria-label': t(shapeOf(id).label), title: t(shapeOf(id).label), 'aria-pressed': !hasPhoto && look.shape === id,
      onClick: () => onShape(id),
    }, h(ShapeRing, { shape: id, size: 36 }), h(BotMark, { look: { shape: id, color: look.color }, size: 36 })))))),
    h('div', { className: 'bt-colors', role: 'group', 'aria-label': t('Character color') }, CHARACTER_COLORS.map(color => h('button', {
      key: color, type: 'button', className: 'bt-color', 'aria-label': t(capitalize(color)), title: t(capitalize(color)), 'aria-pressed': look.color === color,
      onClick: () => onColor(color),
    }, h('span', { style: { background: paintCss(color) } })))))
}

// The avatar editor: the Bot tab picks a character (every click saves), the
// Upload tab takes a photo, the Library tab picks one the user imported before, and
// Reset returns to the look the Bot id gives.
function AvatarEditor({ bot, actions, run, onClose }) {
  const look = lookOf(bot)
  const [tab, setTab] = useState(look.image ? 'upload' : 'bot')
  const [over, setOver] = useState(false)
  const ref = useRef(null)
  const fileRef = useRef(null)
  const upload = (file) => {
    if (file) void run(avatarImage(file).then(image => actions.updateBot(bot.id, { avatar: { ...(bot.avatar ?? {}), image } })))
  }
  useEffect(() => {
    const onDown = (event) => {
      if (!(event.target instanceof Element) || ref.current?.contains(event.target) || event.target.closest('.bt-avatar-trigger')) return
      onClose()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  useEffect(() => {
    if (tab !== 'upload') return undefined
    const onPaste = (event) => {
      const file = [...(event.clipboardData?.files ?? [])].find(item => item.type.startsWith('image/'))
      if (file) { event.preventDefault(); upload(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [tab, bot])
  const hasPhoto = Boolean(look.image)
  const glide = useGlide(tab)
  return h('div', { ref, className: 'bt-avedit', role: 'dialog', 'aria-label': t('Avatar editor') },
    h('div', { className: 'bt-avedit-top' },
      h('div', { ref: glide.box, role: 'tablist', 'aria-label': t('Avatar source'), className: 'bt-avedit-tabs' },
        h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        [['bot', 'Bot'], ['upload', 'Upload'], ['library', 'Library']].map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', className: 'bt-avedit-tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, t(label)))),
      h('button', {
        type: 'button', className: 'bt-avedit-tab bt-avedit-reset', title: t('Reset character to default'),
        onClick: () => run(actions.updateBot(bot.id, { avatar: null, color: null })),
      }, t('Reset'))),
    tab === 'bot' ? h(CharacterGrid, {
      look, hasPhoto,
      onShape: shape => run(actions.updateBot(bot.id, { avatar: { shape } })),
      onColor: color => run(actions.updateBot(bot.id, { color })),
    }) : null,
    tab === 'upload' ? h('div', {
      className: 'bt-dropzone', 'data-over': over || undefined,
      onDragOver: (event) => { event.preventDefault(); setOver(true) },
      onDragLeave: () => setOver(false),
      onDrop: (event) => { event.preventDefault(); setOver(false); upload(event.dataTransfer.files?.[0]) },
    },
    hasPhoto ? h('img', { src: look.image, alt: '' }) : null,
    h('div', null, t('Drag, drop, or paste an image')),
    h('div', { className: 'bt-actions', style: { justifyContent: 'center' } },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => fileRef.current?.click() }, hasPhoto ? t('Replace') : t('Browse files')),
      hasPhoto ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.updateBot(bot.id, { avatar: hasShape(bot.avatar?.shape) ? { shape: bot.avatar.shape } : null })) }, t('Remove photo')) : null),
    h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file) } })) : null,
    // A photo from the library is the same photo the user uploaded before: the Bot
    // keeps its own copy, and the library keeps its entry.
    tab === 'library' ? h(AvatarLibraryPanel, {
      actions,
      onPick: entry => run(actions.updateBot(bot.id, { avatar: { ...bot.avatar, image: entry.image } })),
    }) : null)
}

function MemoryCard({ bot, actions }) {
  const count = useMemoryCount(bot.id, actions)
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return h(Card, { title: t('Memory') },
    h('button', { type: 'button', className: 'bt-set-row bt-bs-row', 'aria-label': t("Manage {name}'s memory", { name: bot.name }), onClick: () => actions.openMemory(bot.id) },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label)),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

// A Bot's settings as grouped cards: who it is (avatar, name, label), what it runs on
// (model), what it does (instructions), its memory and tasks, its Main Bot role, its
// sidebar place, and copies.
export function BotSettingsForm({ bot, roster, actions, run }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const closeEditor = useCallback(() => setEditing(false), [])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const isMainBot = isMainOf(roster, bot.id)
  const onlyMain = isMainBot && (roster.mainBotIds ?? []).length === 1
  const isTile = roster.mainBotId === bot.id
  const save = patch => run(actions.updateBot(bot.id, patch))
  const duplicate = () => run(actions.duplicateBot(bot.id).then(copy => actions.openSession(copy.id)))
  const remove = () => { if (confirming) void run(actions.deleteBot(bot.id)); else setConfirming(true) }
  // DSH settings can change the model list at any time; the hint should match it.
  useEffect(() => { void actions.refreshModels?.() }, [bot.id])
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h('div', { className: 'bt-avatar-anchor' },
        h('button', { type: 'button', className: 'bt-avatar-trigger', 'aria-label': t('Edit Bot avatar'), 'aria-expanded': editing, onClick: () => setEditing(value => !value) },
          h(BotMark, { bot, size: 64, live: true }),
          h('span', { className: 'bt-avatar-pencil', 'aria-hidden': true }, h(PencilIcon))),
        editing ? h(AvatarEditor, { bot, actions, run, onClose: closeEditor }) : null),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, bot.name),
        h('span', { className: 'bt-bs-sub' }, [bot.role, isMainBot ? t('Main Bot') : ''].filter(Boolean).join(' · ') || t('Bot')))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name') }, h(InlineText, { label: t('Name'), value: bot.name, placeholder: 'Bob', required: true, maxLength: 40, onSave: name => save({ name }) })),
      h(Row, { label: t('Label'), hint: t('Optional. Shown under the name.') }, h(InlineText, { label: t('Label'), value: bot.role, placeholder: t('Research, admin…'), maxLength: 24, onSave: role => save({ role }) }))),
    h(Card, { title: t('Model') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Model')), h('span', { className: 'bt-set-hint' }, modelHint(bot, roster))),
        h(ModelMenu, { bot, roster, actions, run }))),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder'))),
        h(FolderMenu, { value: bot.workDir, actions, run, onPick: workDir => save({ workDir }) }))),
    h(Card, { title: t('Instructions') },
      h(Row, { label: t('What this Bot does'), hint: t('Its job on the team. Part of the Bot\'s system prompt.'), stack: true },
        h(InlineText, { label: t('Instructions'), value: bot.instructions, multiline: true, placeholder: t('What this Bot is responsible for…'), onSave: instructions => save({ instructions }) }))),
    h(BotCapabilitiesCard, { bot, roster, actions, run, Card, SwitchRow }),
    roster.memory === false ? null : h(MemoryCard, { bot, actions }),
    h(BotSchedules, { bot, roster, actions }),
    h(Card, { title: t('Main Bot') },
      onlyMain
        ? h('div', { className: 'bt-set-row bt-bs-row' },
            h('span', { className: 'bt-set-copy' },
              h('span', { className: 'bt-bs-label' }, t('Main Bot')),
              h('span', { className: 'bt-set-hint' }, t('The only Main Bot. To hand the role to another Bot, use Main Bot on the Bots page.'))),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('bots') }, t('Change')))
        : h(SwitchRow, { label: t('Main Bot'), hint: t('Can create and change Bots, and runs every group chat.'), on: isMainBot, onChange: on => run(actions.setMain(bot.id, on)) })),
    // The Main Bot tile is always first and always shown, like in the context menu.
    isTile ? null : h(Card, { title: t('Sidebar') },
      h(SwitchRow, { label: t('Pin'), hint: t('Kept above the other chats.'), on: bot.pinned === true, onChange: pinned => run(actions.setFlags(bot.id, { pinned })) }),
      isMainBot ? null : h(SwitchRow, { label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: bot.hidden === true, onChange: hidden => run(actions.setFlags(bot.id, { hidden })) })),
    h(Card, { title: t('Manage') },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row', onClick: duplicate },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Duplicate')), h('span', { className: 'bt-set-hint' }, t('A copy with the same job and model, and fresh memory.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
      isMainBot ? null : h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined, onClick: remove },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Delete {name}?', { name: bot.name }) : t('Delete Bot')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to delete. Its chats are archived.') : t('Removes the Bot from the team.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

export const BOT_SETTINGS_CSS = `
.bt-bs{display:flex;flex-direction:column;gap:18px}
.bt-bs-hero{display:flex;align-items:center;gap:14px;padding:2px 4px}
.bt-bs-who{display:flex;flex-direction:column;min-width:0;gap:2px}
.bt-bs-name{font-size:17px;line-height:24px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-bs-sub{font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-bs .bt-avedit{left:0;transform:none}
.bt-bs-row{min-height:48px}
label.bt-bs-row{cursor:text}
.bt-bs-row>.bt-set-copy{flex:1 1 auto}
.bt-bs-label{font-size:13px;line-height:18px;font-weight:500}
.bt-bs-row .bt-model-trigger{flex:none;max-width:58%}
.bt-bs-input{flex:0 1 220px;width:0;min-width:96px;height:30px;box-sizing:border-box;margin:-4px -6px -4px 0;padding:0 8px;border:1px solid transparent;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:13px;text-align:right;outline:none;transition:background-color .12s ease,border-color .12s ease}
.bt-bs-input:hover{background:var(--bt-hover)}
.bt-bs-input:focus{background:var(--bt-main);border-color:var(--bt-line-2);text-align:left}
.bt-bs-input::placeholder{color:var(--bt-ink-3)}
.bt-bs-input.bt-bs-num{flex:0 0 72px;min-width:0}
.bt-bs-stack{flex-direction:column;align-items:stretch;gap:8px}
.bt-bs-area{flex:none;width:auto;min-height:112px;height:auto;margin:0 -6px -4px;padding:8px;line-height:19px;text-align:left;resize:vertical;background:var(--bt-hover)}
.bt-bs-area:hover{background:var(--bt-active)}
.bt-bs-danger .bt-bs-label{color:var(--bt-danger)}
.bt-bs-danger[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 8%,transparent)}
.bt-bs-danger[data-confirm]:hover{background:color-mix(in srgb,var(--bt-danger) 12%,transparent)}
.bt-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--bt-line-2);cursor:pointer;transition:background-color .2s ease}
.bt-switch[aria-checked=true]{background:var(--bt-accent)}
.bt-switch:disabled{opacity:.45;cursor:default}
.bt-switch:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:${spring(SPRING_SHAPE, 'transform')},${spring(SPRING_TAP, 'width')}}
.bt-switch[aria-checked=true] .bt-switch-knob{transform:translateX(16px)}
.bt-switch:active:not(:disabled) .bt-switch-knob{width:21px}
.bt-switch[aria-checked=true]:active:not(:disabled) .bt-switch-knob{transform:translateX(11px)}
.bt-avedit :is(.bt-shapes,.bt-colors,.bt-dropzone){animation:bt-veil-in .18s ease-out}
@media (prefers-reduced-motion:reduce){.bt-switch,.bt-switch-knob{transition:none}.bt-avedit :is(.bt-shapes,.bt-colors,.bt-dropzone){animation:none}}
`
