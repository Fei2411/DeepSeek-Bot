import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { currentPart, isHiddenTurn } from './text.js'
import { CheckIcon, CopyIcon } from './icons.js'
import { ModelKeyCard, manageModels } from './model-menu.js'
import { knownFailure } from './diagnostics.js'
import { hostText, t } from './i18n.js'

// -------------------------------------------------------------------------
// A failed turn in a Bot's chat: what went wrong and what the user can do about it,
// in place of DSH's row. The copy and the fixes go by DSH's stable failure code, never
// by the provider's message, which shows only under Technical details. The chat node
// carries no HTTP status or request id; the host keeps them, with the failing route's
// provider, on the Bot as `blocked` while a credential or balance failure stands.

const OFFICIAL = 'deepseek-official'
const ACCOUNT = 'deepseek-account'
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
// How long a sign-in started here waits for the account's models before the user picks.
const ACCOUNT_MODELS_WAIT_MS = 20_000
const SIGNED_OUT = new Set(['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID'])
// Failures of an API key route; the account route never has them.
const KEY_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'])
// Until the credentials change the host keeps these on the Bot, and a retry would fail
// the same way, so Retry waits for the fix.
const CREDENTIAL_CODES = new Set([...KEY_CODES, ...SIGNED_OUT])

// The sentence for one failure. `status` is the HTTP status, when the host has it.
export function failureText(code, { name, provider, status }) {
  switch (code) {
    case 'MISSING_CREDENTIAL': return t("{name}'s model has no API key yet.", { name })
    case 'INVALID_CREDENTIAL': return t('This API key is not in the right format.')
    case 'AUTH': return status === undefined
      ? t('{provider} did not accept the current API key.', { provider })
      : t('{provider} did not accept the current API key ({status}).', { provider, status })
    case 'QUOTA': return status === undefined
      ? t('{provider} is out of balance or quota.', { provider })
      : t('{provider} is out of balance or quota ({status}).', { provider, status })
    case 'ACCOUNT_QUOTA': return t('The DeepSeek account balance is too low.')
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_SIGNED_OUT':
    case 'ACCOUNT_TOKEN_INVALID': return t('The DeepSeek account sign-in has expired.')
    case 'TRANSPORT':
    case 'TIMEOUT': return t('Could not reach the model service.')
    case 'RATE_LIMIT': return t('Too many requests. Wait a moment, then try again.')
    case 'SERVER': return t('The model service failed.')
    case 'INTERRUPTED': return t('DeepSeek Harness stopped before this turn finished.')
    default: return knownFailure(code) ?? t('This turn failed.')
  }
}

// The fixes one failure offers, the one to try first leading. Each is offered only
// where this window can carry it out. A Bot moved onto the account route since a key
// failure has nothing left to fix there.
export function fixesFor(code, { canSignIn, official, topUp, onAccount = false }) {
  if (onAccount && KEY_CODES.has(code)) return []
  if (SIGNED_OUT.has(code)) return canSignIn ? ['sign-in-again'] : ['model']
  switch (code) {
    case 'MISSING_CREDENTIAL': return ['key', canSignIn ? 'sign-in' : null, 'model'].filter(Boolean)
    case 'INVALID_CREDENTIAL': return ['rekey', 'model']
    case 'AUTH': return ['rekey', canSignIn ? 'use-account' : null, 'model'].filter(Boolean)
    case 'QUOTA': return official ? ['top-up'] : []
    case 'ACCOUNT_QUOTA': return topUp ? ['top-up'] : []
    default: return []
  }
}

export const retryShown = (code, blocked) => !CREDENTIAL_CODES.has(code) || blocked === undefined

const FIX_LABELS = {
  key: () => t('Enter API key'),
  rekey: () => t('Enter the key again'),
  'sign-in': signedIn => (signedIn ? t('Use the DeepSeek account') : t('Sign in with a DeepSeek account')),
  'use-account': () => t('Use a DeepSeek account instead'),
  'sign-in-again': () => t('Sign in again'),
  model: () => t('Pick another model'),
  'top-up': () => t('Top up ↗'),
}

const NO_SUBSCRIBE = () => () => {}
const NO_VIEW = () => null

// The shell account plugin's view of the DeepSeek account: its sign-in status and links.
function useAccountView(actions) {
  const entry = actions.signInEntry?.() ?? null
  const ops = useMemo(() => entry?.inject?.() ?? {}, [entry])
  const source = ops.hooks?.account
  const read = source ? () => source.getSnapshot()?.view ?? null : NO_VIEW
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIBE, read, read)
}

// The DeepSeek account's own top-up page.
const topUpOf = (view) => {
  const url = view?.links?.topUpUrl
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined
}

// The account route's model for a Bot moved onto it: the DSH default when it is one,
// else the first one listed. The account lists its models only once it is signed in,
// a moment after the sign-in itself.
export function accountModel(roster) {
  const models = (roster.models ?? []).filter(model => model.provider === ACCOUNT)
  return (models.find(model => model.ref === roster.defaultModel) ?? models[0])?.ref
}

const providerOf = (bot, roster) => {
  const ref = bot?.model ?? bot?.appliedModel
  if (!ref) return undefined
  return (roster.models ?? []).find(model => model.ref === ref)?.provider ?? ref.split('/')[0]
}
// A provider without a key may not be in the catalog yet, so DeepSeek's own two routes
// keep a readable name instead of their id.
const KNOWN_PROVIDERS = { 'deepseek-official': 'DeepSeek', 'deepseek-account': 'DeepSeek account' }
const providerName = (roster, provider) => (provider === undefined
  ? t('The model service')
  : (roster.models ?? []).find(model => model.provider === provider)?.providerName
    ?? (KNOWN_PROVIDERS[provider] ? t(KNOWN_PROVIDERS[provider]) : provider))

// What Technical details lists, and copies in English for a report.
export function failureFacts(data, blocked) {
  const facts = []
  if (data.code) facts.push(['Code', t('Code'), data.code])
  if (blocked?.status !== undefined) facts.push(['HTTP status', t('HTTP status'), String(blocked.status)])
  if (blocked?.requestId) facts.push(['Request ID', t('Request ID'), blocked.requestId])
  // DSH already blanks an AUTH message; it never shows here either way.
  if (data.code !== 'AUTH' && data.message) facts.push(['Message', t('Provider message'), data.message])
  return facts
}

function TechnicalDetails({ facts }) {
  const [copied, setCopied] = useState(false)
  if (facts.length === 0) return null
  const copy = () => {
    const text = facts.map(([name, , value]) => `${name}: ${value}`).join('\n')
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) }).catch(() => {})
  }
  return h('details', { className: 'bt-fail-tech' },
    h('summary', null, t('Technical details')),
    h('dl', null, facts.map(([name, label, value]) => [h('dt', { key: `${name}:t` }, label), h('dd', { key: `${name}:d` }, value)])),
    h('button', { type: 'button', className: 'bt-mini bt-fail-copy', onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon), copied ? t('Copied') : t('Copy')))
}

export function FailureCell({ node, sessionId, useRoster, useTurnClock, actions }) {
  const roster = useRoster(value => value)
  const data = node?.data ?? {}
  const bot = roster.byId?.[sessionId]
  // A later turn, or a later part of the Bot's chat, has moved past this failure.
  const later = useTurnClock(state => Object.keys(state[sessionId] ?? {}).some(turn => Number(turn) > data.turn))
  const account = useAccountView(actions)
  const signedIn = account?.status === 'credential-stored'
  const topUp = topUpOf(account)
  const [keying, setKeying] = useState(false)
  const [retry, setRetry] = useState('idle')
  const [error, setError] = useState('')
  // A sign-in started here to leave a failing key route, with the model the Bot was on.
  const [joining, setJoining] = useState(null)
  const blocked = bot?.blocked?.code === data.code ? bot.blocked : undefined
  const provider = blocked?.provider ?? providerOf(bot, roster)
  const text = failureText(data.code, { name: bot?.name ?? t('This Bot'), provider: providerName(roster, provider), status: blocked?.status })
  const facts = failureFacts(data, blocked)
  const current = bot !== undefined && currentPart(bot) === sessionId && !later
  // The key route never takes the account's credential, so a sign-in alone leaves the Bot
  // failing; it moves onto the account route. With no account model listed yet, the
  // user picks one.
  const moveToAccount = () => {
    const model = accountModel(roster)
    if (model === undefined) { actions.showDetails?.(sessionId); return }
    if (model === bot.model) return
    setError('')
    void Promise.resolve(actions.updateBot(bot.id, { model })).catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const listed = accountModel(roster)
  useEffect(() => {
    if (joining === null || !signedIn) return undefined
    // A model the user picked meanwhile stands.
    if (bot === undefined || bot.model !== joining.from) { setJoining(null); return undefined }
    if (listed !== undefined) { setJoining(null); moveToAccount(); return undefined }
    // The account's models come with the next listing; without them for a while, the
    // user picks.
    void actions.refreshModels?.()
    const timer = setTimeout(() => { setJoining(null); actions.showDetails?.(sessionId) }, ACCOUNT_MODELS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [joining, signedIn, listed])
  const settled = () => h('div', { className: 'bt-fail', 'data-settled': '', role: 'status' },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)),
    h(TechnicalDetails, { facts }))
  if (!current) return settled()
  const official = provider === OFFICIAL
  const canSignIn = typeof actions.signIn === 'function' && actions.canSignIn?.() === true
  const keyHere = typeof actions.setProviderKey === 'function' && provider !== undefined
  const keyElsewhere = official && actions.openHarnessOnboarding ? () => actions.openHarnessOnboarding(OFFICIAL) : manageModels(actions)
  const viaAccount = () => {
    if (signedIn) { moveToAccount(); return }
    setJoining({ from: bot.model })
    actions.signIn()
  }
  const runs = {
    key: keyHere ? () => setKeying(value => !value) : keyElsewhere,
    rekey: keyHere ? () => setKeying(value => !value) : keyElsewhere,
    'sign-in': viaAccount,
    'use-account': viaAccount,
    'sign-in-again': () => actions.signIn(),
    model: actions.showDetails ? () => actions.showDetails(sessionId) : undefined,
  }
  const fixes = fixesFor(data.code, { canSignIn, official, topUp: topUp !== undefined, onAccount: provider === ACCOUNT }).filter(fix => fix === 'top-up' || runs[fix] !== undefined)
  // A turn another Bot asked for answers that Bot, which was already told it failed.
  // Retry would answer the user's last message instead, so it is not offered.
  const asked = isHiddenTurn(roster, sessionId, data.turn)
  const retrying = !asked && typeof actions.resume === 'function' && retryShown(data.code, blocked)
  // Once a credential failure is fixed, going on is the next step.
  const retryFirst = retrying && (fixes.length === 0 || CREDENTIAL_CODES.has(data.code))
  const resume = () => {
    setRetry('busy')
    setError('')
    void Promise.resolve(actions.resume(bot.id))
      .then(() => setRetry('sent'), (failure) => { setRetry('idle'); setError(hostText(failure?.message ?? String(failure))) })
  }
  const button = (fix, primary) => {
    const className = primary ? 'bt-send bt-fail-go' : 'bt-soft bt-soft-sm'
    if (fix === 'top-up') {
      return h('a', { key: fix, className: `${className} bt-fail-link`, href: data.code === 'ACCOUNT_QUOTA' ? topUp : TOP_UP_URL, target: '_blank', rel: 'noopener noreferrer' }, FIX_LABELS[fix]())
    }
    const toggles = keyHere && (fix === 'key' || fix === 'rekey')
    return h('button', { key: fix, type: 'button', className, 'aria-expanded': toggles ? keying : undefined, onClick: () => runs[fix]() }, FIX_LABELS[fix](signedIn))
  }
  const retryButton = primary => h('button', { key: 'retry', type: 'button', className: primary ? 'bt-send bt-fail-go' : 'bt-soft bt-soft-sm', disabled: retry !== 'idle', onClick: resume }, retry === 'idle' ? t('Retry') : t('Retrying…'))
  const row = retryFirst
    ? [retryButton(true), ...fixes.map(fix => button(fix, false))]
    : [...fixes.map((fix, index) => button(fix, index === 0)), retrying ? retryButton(false) : null]
  // With nothing to do here the card reads as one a later turn moved past.
  if (!row.some(Boolean)) return settled()
  return h('div', { className: 'bt-fail', role: 'status' },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)),
    h('div', { className: 'bt-fail-actions' }, row),
    keying && keyHere ? h(ModelKeyCard, { model: { provider, providerName: providerName(roster, provider) }, actions, onSaved: () => setKeying(false) }) : null,
    error ? h('div', { className: 'bt-fail-error', role: 'alert' }, error) : null,
    h(TechnicalDetails, { facts }))
}

export const TURN_ERROR_CSS = `
.bt-fail{display:flex;flex-direction:column;gap:10px;margin:4px 0 6px;width:max-content;max-width:min(550px,86%);padding:12px 14px;border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line);box-sizing:border-box;color:var(--bt-ink);font-size:14px;line-height:20px}
.bt-fail[data-settled]{gap:4px;padding:2px 0;background:none;box-shadow:none;color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-fail-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-fail-dot{flex:none;width:7px;height:7px;margin-top:6.5px;border-radius:50%;background:var(--bt-danger)}
.bt-fail[data-settled] .bt-fail-dot{margin-top:5.5px}
.bt-fail-text{min-width:0;overflow-wrap:anywhere}
.bt-fail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:15px}
.bt-fail-actions .bt-fail-go{height:28px;padding:0 12px;font:inherit;font-size:12px}
.bt-fail-link{display:inline-flex;align-items:center;box-sizing:border-box;text-decoration:none}
.bt-fail:has(.bt-model-key){width:min(480px,86%)}
.bt-fail .bt-q.bt-model-key{margin:0 0 0 15px;width:auto;padding:0;background:none;box-shadow:none;border-radius:0;animation:none}
.bt-fail-error{margin-left:15px;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-fail-tech{margin-left:15px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-fail-tech summary{width:max-content;cursor:pointer;color:var(--bt-ink-3)}
.bt-fail-tech summary:hover{color:var(--bt-ink-2)}
.bt-fail-tech dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:6px 0}
.bt-fail-tech dt{color:var(--bt-ink-3)}
.bt-fail-tech dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere;white-space:pre-wrap;user-select:text}
.bt-fail-copy{display:inline-flex;align-items:center;gap:4px}
.bt-fail-copy svg{width:13px;height:13px}
`
