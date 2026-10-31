import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { currentPart } from './text.js'
import { CheckIcon, SlidersIcon } from './icons.js'
import { BotMark } from './mark.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { SPRING_POP, SPRING_SHAPE, spring, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'

const MENU_EXIT_MS = 120

// -------------------------------------------------------------------------
// A Bot's model: the picker in its details panel and settings, and the message its
// chat opens on while it has none. Models come from DeepSeek Harness, grouped by provider.

export function groupModels(models) {
  const groups = new Map()
  for (const model of models ?? []) {
    const provider = model.provider ?? model.providerName ?? model.ref.split('/')[0]
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  const names = new Map()
  for (const [provider, list] of groups) {
    const name = list[0].providerName ?? provider
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return [...groups].map(([provider, list]) => {
    const name = list[0].providerName ?? provider
    return [names.get(name) > 1 ? `${name} (${provider})` : name, list]
  })
}

const servedOf = (roster, ref) => (roster.models ?? []).find(model => model.ref === ref)

// What a Bot runs on, for display: the chosen model, else the one it last ran on.
export function modelOf(bot, roster) {
  const ref = bot.model ?? bot.appliedModel
  if (!ref) return undefined
  const served = servedOf(roster, ref)
  const [provider, ...rest] = ref.split('/')
  return { ref, name: served?.name ?? rest.join('/'), provider: served?.providerName ?? provider, served: served !== undefined }
}

// The thinking levels of one model, `{efforts, defaultEffort?}` or undefined when it
// has none. The catalog carries them for models Bots use; any other ref asks the host.
const effortCache = new Map()
function useEfforts(served, ref, actions) {
  const [fetched, setFetched] = useState(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (ref === undefined || served?.reasoning !== undefined || actions?.efforts === undefined) return undefined
    let live = true
    if (effortCache.has(ref)) setFetched(effortCache.get(ref))
    else void Promise.resolve(actions.efforts(ref)).then((value) => {
      const reasoning = value?.efforts ? value : null
      effortCache.set(ref, reasoning)
      if (live) setFetched(reasoning)
    }).catch(() => {})
    return () => { live = false }
  }, [ref, served?.reasoning !== undefined, actions])
  return served?.reasoning ?? fetched
}

// The rows of the Thinking section: a Default row that clears the Bot's pick, then every
// level the model serves.
export function effortRows(reasoning) {
  if (reasoning?.efforts === undefined || reasoning.efforts.length === 0) return []
  return [
    { effort: undefined, label: t('Default') },
    ...reasoning.efforts.map(effort => ({ effort: effort.id, label: effort.name })),
  ]
}

function EffortRows({ reasoning, current, onPick }) {
  return h(Fragment, null,
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('div', { className: 'bt-model-group', role: 'presentation' }, t('Thinking level')),
    effortRows(reasoning).map(row => h('button', {
      key: row.effort ?? 'default', type: 'button', role: 'menuitemradio', 'aria-checked': (row.effort ?? null) === (current ?? null),
      onClick: () => onPick(row.effort),
    },
    h('span', { className: 'bt-menu-label' }, row.label),
    h('span', { className: 'bt-model-tick', 'aria-hidden': true }, (row.effort ?? null) === (current ?? null) ? h(CheckIcon) : null))))
}

function ModelRows({ roster, current, onPick }) {
  return groupModels(roster.models).map(([provider, list]) => h(Fragment, { key: list[0].provider ?? provider },
    h('div', { className: 'bt-model-group', role: 'presentation' }, provider),
    list.map(model => h('button', {
      key: model.ref, type: 'button', role: 'menuitemradio', 'aria-checked': model.ref === current, title: model.ref,
      onClick: () => onPick(model.ref),
    },
    h('span', { className: 'bt-menu-label' }, model.name),
    model.ref === roster.defaultModel ? h('span', { className: 'bt-menu-hint' }, t('Default')) : null,
    h('span', { className: 'bt-model-tick', 'aria-hidden': true }, model.ref === current ? h(CheckIcon) : null)))))
}

export const Caret = () => h('svg', { className: 'bt-model-caret', width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }))

// A menu that opens under its trigger, or above when the window has no room below. A
// click outside, Escape, or a scroll outside it closes it.
export function useAnchoredMenu() {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); button.current?.focus() } }
    const onScroll = (event) => { if (!menu.current?.contains(event.target)) close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [place])
  const open = () => setAnchor({})
  // Re-reads the trigger's rect whenever the visible viewport moves: the menu
  // tracks its anchor through the on-screen keyboard, not past it.
  useLayoutEffect(() => {
    if (anchor === null || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = Math.max(240, rect.width)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = viewBottom() - rect.bottom
    setPlace(below >= 260 || below >= rect.top
      ? { left, width, top: rect.bottom + 4, maxHeight: below - 16, '--bt-origin': 'top right' }
      : { left, width, bottom: viewBottom() - rect.top + 4, maxHeight: rect.top - 16, '--bt-origin': 'bottom right' })
  }, [anchor, tick])
  return { isOpen: place !== null, shownPlace, leaving, button, menu, open, close }
}

// The trigger shows the model name over its provider. A Thinking section lists the
// levels of the shown model when it has them.
// `onPick`/`onPickEffort` replace saving to the Bot, for a Bot that does not exist yet.
export function ModelMenu({ bot, roster, actions, run, wide = false, onPick, onPickEffort }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const shown = modelOf(bot, roster)
  const current = bot.model ?? bot.appliedModel
  const served = servedOf(roster, current)
  const reasoning = useEfforts(served, current, actions)
  // The level the Bot runs on: its pick when the model serves it, else the model's own.
  const picked = reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  const currentEffort = picked ?? reasoning?.defaultEffort
  const effortLabel = currentEffort === undefined
    ? (reasoning?.efforts?.length > 0 ? t('Default') : undefined)
    : reasoning.efforts.find(effort => effort.id === currentEffort)?.name ?? currentEffort
  const toggle = () => {
    if (isOpen) { close(); return }
    // DSH settings can change the list at any time, so opening asks again.
    void actions?.refreshModels?.()
    open()
  }
  const pick = (ref) => {
    close()
    if (onPick) onPick(ref)
    else if (ref !== current || !bot.model) void run(actions.updateBot(bot.id, { model: ref }))
  }
  const pickEffort = (effort) => {
    close()
    if (onPickEffort) onPickEffort(effort)
    else if (effort !== bot.effort) void run(actions.updateBot(bot.id, { effort: effort ?? null }))
  }
  const models = roster.models ?? []
  const manage = manageModels(actions)
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': t('Model: {model}', { model: shown?.name ?? t('none') }),
      'data-missing': shown !== undefined && !shown.served && models.length > 0 ? '' : undefined, onClick: toggle,
    },
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, shown?.name ?? t('Choose a model')),
      shown ? h('span', { className: 'bt-model-provider' }, shown.served || models.length === 0
        ? (effortLabel === undefined ? shown.provider : `${shown.provider} · ${effortLabel}`)
        : t('{provider} · not available', { provider: shown.provider })) : null),
    h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': t('Model for {name}', { name: bot.name }), style: shownPlace, 'data-leaving': leaving || undefined },
      models.length > 0 ? h(ModelRows, { roster, current, onPick: pick })
        : h('div', { className: 'bt-model-none' }, t('No models are set up in DeepSeek Harness yet.')),
      effortRows(reasoning).length > 0 ? h(EffortRows, { reasoning, current: picked, onPick: pickEffort }) : null,
      manage ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      manage ? h('button', { type: 'button', role: 'menuitem', onClick: () => { close(); manage() } }, h(SlidersIcon), h('span', { className: 'bt-menu-label' }, t('Models and providers…'))) : null), document.body) : null)
}

// The card a Bot's chat opens on while the Bot has no model, or has one that is no
// longer served. The first Main Bot greets the user only after a pick.
export function ModelChoiceDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const shown = Boolean(bot) && currentPart(bot) === sessionId && roster.ready
  useEffect(() => { if (shown) void actions.refreshModels?.() }, [shown, sessionId])
  if (!bot || currentPart(bot) !== sessionId || !roster.ready) return null
  const models = roster.models ?? []
  // A model whose provider has no API key fails every turn, so it is no choice.
  const usable = models.filter(model => !model.needsKey)
  const lost = bot.model ? !models.some(model => model.ref === bot.model) : false
  // An unknown catalog (none listed) cannot tell a lost model from a slow provider.
  if (bot.model && (!lost || models.length === 0)) return null
  // The missing key is taken here, through the host.
  const keyFor = usable.length === 0 && actions.setProviderKey ? models.find(model => model.needsKey) : undefined
  const manage = manageModels(actions)
  const pick = (ref) => {
    setBusy(ref)
    setError('')
    void Promise.resolve(actions.updateBot(bot.id, { model: ref }))
      .catch((failure) => { setError(failure?.message ?? String(failure)); void actions.refreshModels?.() })
      .finally(() => setBusy(''))
  }
  // The pick reads as the Bot's own first message, with the choices as replies under it.
  const text = lost
    ? t('{model} is not available anymore. Pick another model for me.', { model: bot.model.split('/').slice(1).join('/') })
    : keyFor
      ? t("Hi, I'm {name}. I need a {provider} API key before I can start.", { name: bot.name, provider: keyFor.providerName ?? keyFor.provider })
      : usable.length === 0
        ? t("Hi, I'm {name}. I don't have a model yet. How do you want to set one up?", { name: bot.name })
        : t("Hi, I'm {name}. Pick a model for me first. You can change it later in my details.", { name: bot.name })
  const choices = usable.length === 0
    ? setupChoices(actions).map(([label, run]) => h('button', { key: label, type: 'button', className: 'bt-model-chip', onClick: run }, label))
    : [
        ...groupModels(usable).map(([provider, list]) => h('div', { key: list[0].provider ?? provider, className: 'bt-model-choice-group', role: 'group', 'aria-label': provider },
          h('div', { className: 'bt-model-choice-provider', 'aria-hidden': true }, provider),
          h('div', { className: 'bt-model-choice-chips' }, list.map(model => h('button', {
            key: model.ref, type: 'button', className: 'bt-model-chip', disabled: busy !== '', 'aria-busy': busy === model.ref || undefined,
            'aria-label': `${model.name} · ${provider}`,
            title: model.ref === roster.defaultModel ? `${model.ref} · ${t('Harness default')}` : model.ref,
            onClick: () => pick(model.ref),
          }, model.name, busy === model.ref ? h('span', { className: 'bt-model-spin', 'aria-label': t('Saving…') }) : null))))),
        manage ? h('button', { key: 'manage', type: 'button', className: 'bt-model-chip bt-model-chip-quiet', onClick: manage }, h(SlidersIcon), t('Manage models')) : null,
      ]
  return h('div', { className: 'bt-model-dock' },
    h('div', { className: 'bt-astack', 'data-lead': '' },
      h('div', { className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          h(BotMark, { bot, size: 22 }),
          h('div', { className: 'bt-bubble' }, text)))),
    keyFor
      ? h(ModelKeyCard, { key: keyFor.provider, model: keyFor, actions })
      : h('div', { className: 'bt-model-chips', role: 'group', 'aria-label': t('Choose a model') }, choices),
    error ? h('div', { className: 'bt-secret-error bt-model-error', role: 'alert' }, error) : null)
}

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'

// The provider's API key, saved through the host; once it is set, the provider's
// models become the choices. `onSaved` runs once the host took the key.
export function ModelKeyCard({ model, actions, onSaved }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = t('{provider} API key', { provider: model.providerName ?? model.provider })
  const ready = value.trim() !== '' && !busy
  const save = () => {
    if (!ready) return
    setBusy(true)
    setError('')
    void Promise.resolve(actions.setProviderKey(model.provider, value))
      .then(() => { setValue(''); onSaved?.() }, failure => setError(hostText(failure?.message ?? String(failure))))
      .finally(() => setBusy(false))
  }
  const official = model.provider === 'deepseek-official'
  return h('div', { className: 'bt-q bt-model-key', role: 'group', 'aria-label': label },
    h('div', { className: 'bt-model-key-title' }, h(KeyIcon), label),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label, autoFocus: true })),
    official ? h('div', { className: 'bt-model-key-help' },
      h('a', { className: 'bt-model-key-link', href: DEEPSEEK_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, t('Create a key on the DeepSeek platform ↗')),
      h('span', { className: 'bt-model-key-note' }, t('The API is billed by usage; the account needs a balance first.'))) : null,
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      actions.openModels ? h('button', { type: 'button', className: 'bt-q-btn bt-model-key-other', onClick: actions.openModels }, t('Another provider')) : null,
      h('button', { type: 'button', className: 'bt-q-submit', disabled: !ready, onClick: save }, busy ? t('Saving…') : t('Save'))))
}

// Where the providers are set up: DS Bot's Models page, else DSH's own.
export const manageModels = actions => actions.openModels ?? actions.openHarnessModels ?? actions.openHarnessSettings

// Ways to get a first model. The DeepSeek sign-in exists only where the shell carries
// its account plugin; the API key uses the shell's own editor.
function setupChoices(actions) {
  const custom = manageModels(actions)
  return [
    actions.canSignIn?.() ? [t('Sign in to DeepSeek'), () => actions.signIn()] : null,
    actions.openHarnessOnboarding ? [t('Enter a DeepSeek API key'), () => actions.openHarnessOnboarding('deepseek-official')] : null,
    custom ? [t('Open settings to set up a custom model'), () => custom()] : null,
  ].filter(Boolean)
}

// The shell's own DeepSeek sign-in dialog, borrowed from its account plugin: the
// plugin's model sign-in entry renders here with the plugin's own operations.
export function DeepSeekSignIn({ useUi, actions }) {
  const open = useUi(state => state.signIn)
  const entry = open ? actions.signInEntry?.() : null
  if (!entry) return null
  return h(SignInHost, { key: open, entry, actions })
}

function SignInHost({ entry, actions }) {
  const [ops] = useState(() => entry.inject?.() ?? {})
  const close = () => actions.closeSignIn()
  const useHook = source => selector => useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
  const [hooks] = useState(() => ({ useAccount: useHook(ops.hooks.account), useTheme: useHook(ops.hooks.theme) }))
  return h(entry.component, {
    ...ops,
    ...hooks,
    t: actions.accountT(),
    complete: close,
    useApiKey: () => { close(); actions.openHarnessOnboarding('deepseek-official') },
  })
}

export const MODEL_CSS = `
.bt-model-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;height:auto;min-height:32px;padding:4px 8px 4px 10px;border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-model-trigger:hover,.bt-model-trigger[aria-expanded=true]{background:var(--bt-active)}
.bt-model-trigger:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-trigger[data-missing] .bt-model-provider{color:var(--bt-danger)}
.bt-model-trigger[data-wide]{display:flex;width:100%;min-height:48px;padding:7px 12px;justify-content:space-between;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-model-trigger[data-wide]:hover,.bt-model-trigger[data-wide][aria-expanded=true]{background:var(--bt-hover)}
.bt-model-copy{display:flex;flex-direction:column;min-width:0}
.bt-model-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-provider{font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-model-trigger[aria-expanded=true] .bt-model-caret{transform:rotate(180deg)}
.bt-model-menu{overflow-y:auto;scrollbar-width:thin}
.bt-model-group{flex:none;padding:8px 8px 2px;font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3);text-transform:none}
.bt-model-group:first-child{padding-top:2px}
.bt-model-tick{flex:none;width:16px;height:16px;display:inline-flex;color:var(--bt-ink-2)}
.bt-model-tick svg{animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} 60ms backwards}
.bt-model-none{padding:8px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-model-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 0 10px;box-sizing:border-box;animation:bt-model-in ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-model-chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:30px;max-width:min(560px,calc(100% - 30px));max-height:min(240px,36vh);max-height:min(240px,36dvh);overflow-y:auto;scrollbar-width:thin}
.bt-model-choice-group{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0}
.bt-model-choice-provider{padding-top:4px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-model-choice-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-model-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 12px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-surface,transparent);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.bt-model-chip:hover:not(:disabled){background:var(--bt-hover)}
.bt-model-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-chip-quiet{color:var(--bt-ink-2)}
.bt-model-chip svg{width:14px;height:14px}
.bt-model-chip:disabled{cursor:default}
.bt-model-chip:disabled:not([aria-busy]){opacity:.5}
.bt-model-error{margin-left:30px}
.bt-q.bt-model-key{margin:0 0 0 30px;width:min(480px,calc(100% - 30px));gap:10px}
.bt-model-key-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink-2)}
.bt-model-key-title svg{flex:none;width:16px;height:16px}
.bt-model-key .bt-q-foot{margin-top:2px}
.bt-model-key-help{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-model-key-link{align-self:flex-start;color:var(--bt-ink);text-decoration:underline;text-decoration-color:var(--bt-line-2);text-underline-offset:2px}
.bt-model-key-link:hover{text-decoration-color:currentColor}
.bt-model-key-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px;border-radius:4px}
.bt-model-key-other{margin-right:auto}
@keyframes bt-model-in{from{opacity:0;transform:translateY(6px)}}
.bt-model-spin{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--bt-line-2);border-top-color:var(--bt-ink-2);animation:bt-model-spin .7s linear infinite}
@keyframes bt-model-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bt-model-dock{animation:none}.bt-model-spin{animation-duration:2s}.bt-model-caret{transition:none}.bt-model-tick svg{animation:none}}
`
