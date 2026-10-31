import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { CharacterGrid } from './bot-settings.js'
import { AvatarLibraryPanel, avatarImage } from './avatar-library.js'
import { DEFAULT_SHAPES, DEFAULT_COLORS } from './characters.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { createPayload, freshBotName, startModel } from './bot-draft.js'
import { ModelMenu } from './model-menu.js'
import { hostText, t } from './i18n.js'
import { nameProblem } from '../shared/mentions.js'

const pick = list => list[Math.floor(Math.random() * list.length)]
const randomLook = (avoid = {}) => {
  const shapes = DEFAULT_SHAPES.filter(shape => shape !== avoid.shape)
  const colors = DEFAULT_COLORS.filter(color => color !== avoid.color)
  return { shape: pick(shapes), color: pick(colors) }
}

// The new-Bot form: look first, then name and model. Nothing exists until Create.
// `inline` drops the pane's header for a form shown inside Settings.
export function CreateBot({ roster, actions, start, brief = '', onBack, canGoBack, onCreated, inline = false }) {
  const [look, setLook] = useState(() => randomLook())
  const [image, setImage] = useState(null)
  const [library, setLibrary] = useState(false)
  const [name, setName] = useState(start?.name ?? '')
  const [model, setModel] = useState(() => startModel(roster))
  const [effort, setEffort] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const frame = useRef(null)
  useEscape(onBack)
  // Inside Settings the form opens below other sections, so it scrolls itself into view.
  useEffect(() => { if (inline) frame.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [])
  const fallbackName = freshBotName(roster, t('New Bot'))
  const finalName = name.trim() || fallbackName
  const clash = roster.bots.some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const problem = nameProblem(finalName)
  const create = async () => {
    if (busy || clash || problem) return
    setError('')
    setBusy(true)
    try {
      const bot = await actions.createBot(createPayload({ name: finalName, look, image, model, effort, brief }))
      onCreated(bot)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      setBusy(false)
    }
  }
  const upload = (file) => {
    if (!file) return
    setError('')
    avatarImage(file).then(setImage, failure => setError(failure?.message ?? String(failure)))
  }
  const previewLook = image ? { ...look, image } : look
  const card = h('div', { className: 'bt-create-card' },
    h('div', { className: 'bt-create-preview' },
      // The key remounts the mark, so every new pick plays the pop.
      h('span', { key: `${look.shape}:${look.color}:${image ? 'photo' : ''}`, className: 'bt-create-pop' },
        h(BotMark, { look: previewLook, bot: { id: 'new-bot' }, size: 88, live: true, gaze: true, pokeable: true })),
      h('span', { className: 'bt-create-name' }, finalName)),
    h('div', { className: 'bt-create-step' }, t('Look')),
    h('div', { className: 'bt-create-looks' },
      h(CharacterGrid, {
        look, hasPhoto: Boolean(image),
        onShape: (shape) => { setImage(null); setLook(current => ({ ...current, shape })) },
        onColor: (color) => { setImage(null); setLook(current => ({ ...current, color })) },
      }),
      h('div', { className: 'bt-actions bt-create-lookbar' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setImage(null); setLook(current => randomLook(current)) } }, t('Shuffle')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => fileRef.current?.click() }, image ? t('Replace photo') : t('Upload photo')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': library, onClick: () => setLibrary(value => !value) }, t('Library')),
        image ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setImage(null) }, t('Remove photo')) : null,
        h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file) } }))),
    // The library is a block of its own under the look, not a part of the button row.
    library ? h(AvatarLibraryPanel, { actions, onPick: entry => { setImage(entry.image); setLibrary(false) } }) : null,
    h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Name')),
      h('input', {
        className: 'bt-input', autoFocus: !inline, value: name, placeholder: fallbackName, maxLength: 40, 'aria-label': t('Name'),
        onChange: event => setName(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create() } },
      }),
      problem ? h('span', { className: 'bt-note bt-danger' }, hostText(problem))
        : clash ? h('span', { className: 'bt-note bt-danger' }, t('A Bot named {name} already exists', { name: finalName })) : null),
    h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Model')),
      h(ModelMenu, { bot: { id: 'new-bot', name: finalName, model: model || undefined, effort }, roster, actions, wide: true, onPick: ref => { setModel(ref); setEffort(undefined) }, onPickEffort: picked => setEffort(picked ?? null) }),
      h('span', { className: 'bt-note' }, model
        ? t('The Bot runs on this model. You can change it later in its details.')
        : (roster.models ?? []).length > 0
          ? t('Pick a model here, or the Bot asks for one in its chat.')
          : t('Add a provider and a model in DeepSeek Harness first, or pick one in the Bot\'s chat later.'))),
    error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
    h('div', { className: 'bt-create-foot' },
      h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, canGoBack ? t('Back') : t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: busy || clash || Boolean(problem), onClick: () => void create() }, busy ? t('Creating…') : t('Create'))))
  if (inline) return h('div', { ref: frame, className: 'bt-create-inline', role: 'group', 'aria-label': t('Create Bot') }, card)
  return h('div', { className: 'bt-create', role: 'dialog', 'aria-label': t('Create Bot') },
    h('div', { className: 'bt-create-head' },
      canGoBack ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to new chat'), onClick: onBack }, h(ChevronLeftIcon)) : h('span', { className: 'bt-create-gap' }),
      h('span', { className: 'bt-create-title' }, t('Create Bot')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeOverlay() }, h(CloseIcon))),
    h('div', { className: 'bt-create-body' }, card))
}
