// The side chat view in the Bot's panel, and the `/side` composer command that
// starts one. A chat is a list of question/answer entries; a follow-up carries
// the chat's earlier finished pairs to the model.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { MarkdownText } from './dsh-primitives.js'
import { hostText, t } from './i18n.js'
import { failureText, mdLabels } from './btw.js'
import {
  SIDE_SOURCE, SIDE_TOKEN, matchSideClaim, matchSideEnter, matchSideSpace, sideQueryMatches, sideSurface, submitSide,
} from './side-model.js'

function SideEntry({ chatId, entry, actions }) {
  const [cancelling, setCancelling] = useState(false)
  const question = typeof entry.question === 'string' ? entry.question : ''
  const answer = typeof entry.answer === 'string' ? entry.answer : ''
  const cancel = () => {
    if (cancelling || typeof actions?.cancelSide !== 'function') return
    setCancelling(true)
    Promise.resolve(actions.cancelSide(chatId, entry.id)).catch(() => {}).finally(() => setCancelling(false))
  }
  return h('div', { className: 'bt-side-pair', 'data-status': entry.status },
    h('div', { className: 'bt-side-qrow' }, h('div', { className: 'bt-side-q' }, question)),
    entry.status === 'answering'
      ? h('div', { className: 'bt-side-a' },
          h('span', { className: 'bt-shimmer' }, t('Answering…')),
          h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', disabled: cancelling,
            title: t('Cancel this side question'), 'aria-label': t('Cancel this side question'), onClick: cancel,
          }, t('Cancel')))
      : h('div', { className: 'bt-side-a' },
          entry.status === 'cancelled' ? h('p', { className: 'bt-side-status' }, t('Cancelled')) : null,
          entry.status === 'failed' ? h('p', { className: 'bt-side-fail' }, failureText(entry)) : null,
          answer !== '' ? h(MarkdownText, { text: answer, labels: mdLabels(), variant: 'compact' }) : null))
}

export function SideChatView({ subject, chat, actions }) {
  const scroll = useRef(null)
  const [draft, setDraft] = useState('')
  const [fail, setFail] = useState(null)
  const entries = Array.isArray(chat?.entries) ? chat.entries : []
  const busy = entries.some(entry => entry?.status === 'answering')
  const last = entries.at(-1)
  useEffect(() => {
    const node = scroll.current
    if (node) node.scrollTop = node.scrollHeight
  }, [chat?.id, entries.length, last?.status])
  if (!chat) return null
  const ask = () => {
    const text = draft.trim()
    if (text === '' || busy || typeof actions?.askSide !== 'function') return
    setDraft('')
    setFail(null)
    Promise.resolve(actions.askSide(subject, chat.id, text)).catch((error) => {
      // A refused question keeps what was typed unless a new draft replaced it.
      setDraft(value => (value === '' ? text : value))
      setFail(hostText(error?.message ?? ''))
    })
  }
  return h('div', { className: 'bt-side' },
    h('p', { className: 'bt-side-note' }, t('Answered from progress so far; nothing was run')),
    h('div', { className: 'bt-side-scroll', ref: scroll },
      entries.map(entry => h(SideEntry, { key: entry.id, chatId: chat.id, entry, actions }))),
    h('div', { className: 'bt-side-form' },
      h('textarea', {
        className: 'bt-side-input', rows: 1, value: draft, disabled: busy,
        placeholder: t('Ask about the work so far'),
        'aria-label': t('Ask about the work so far'),
        onChange: (event) => { setDraft(event.target.value); if (fail !== null) setFail(null) },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) return
          event.preventDefault()
          ask()
        },
      }),
      fail !== null ? h('p', { className: 'bt-side-fail' }, fail) : null))
}

export function sideSource({ roster, actions }) {
  const claimFor = (sessionId) => ({
    name: 'side',
    token: SIDE_TOKEN,
    hint: t('Ask about the work so far'),
    submit: (args, actx, attachments) => {
      void actx
      return submitSide({
        call: actions?.sideCall ?? call, roster: roster.getSnapshot(), sessionId, args, attachments,
        open: chatId => actions?.openSideChat(sessionId, chatId),
      })
    },
  })
  return {
    trigger: '/',
    name: SIDE_SOURCE,
    order: -50,
    showGroupTitle: false,
    async candidates(session, req) {
      if (req?.position === 'inline') return []
      if (sideSurface(roster.getSnapshot(), session.sessionId) !== 'bot') return []
      if (!sideQueryMatches(req?.query)) return []
      return [{ name: 'side', description: t('Ask without interrupting'), value: 'side' }]
    },
    onPick(pick) {
      if (pick?.action === 'drill') return undefined
      if (sideSurface(roster.getSnapshot(), pick.session.sessionId) !== 'bot') return undefined
      return { claim: claimFor(pick.session.sessionId) }
    },
    matchSpace(session, token) {
      const outcome = matchSideSpace(roster.getSnapshot(), session.sessionId, token)
      return outcome === undefined ? undefined : { claim: claimFor(session.sessionId) }
    },
    matchEnter(session, line, signal, envelope) {
      // The live roster, not a snapshot: Enter waits out the startup gap instead
      // of letting `/side` become an ordinary send.
      return matchSideEnter(roster, session.sessionId, line, envelope, signal).then((outcome) => {
        if (outcome === undefined) return undefined
        return { claim: claimFor(session.sessionId) }
      })
    },
    async matchClaim(session, token) {
      return matchSideClaim(roster.getSnapshot(), session.sessionId, token) ? claimFor(session.sessionId) : undefined
    },
  }
}

export const SIDE_CSS = `
.bt-side{flex:1;min-height:0;display:flex;flex-direction:column;animation:bt-panel-view-in .22s cubic-bezier(.16,1,.3,1)}
.bt-side-note{flex:none;margin:0;padding:10px 16px 8px;font-size:12px;line-height:17px;color:var(--bt-ink-3);border-bottom:.5px solid var(--bt-line)}
.bt-side-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:14px 16px}
.bt-side-pair{display:flex;flex-direction:column;gap:8px}
.bt-side-qrow{display:flex;justify-content:flex-end}
.bt-side-q{max-width:85%;padding:7px 12px;border-radius:18px;background:var(--bt-user);color:var(--bt-user-ink);font-size:13px;line-height:19px;box-sizing:border-box;overflow-wrap:anywhere;white-space:pre-wrap}
.bt-side-a{display:flex;flex-direction:column;gap:8px;align-items:flex-start;font-size:13px;line-height:19px;color:var(--bt-ink)}
.bt-side-status{margin:0;font-size:12px;color:var(--bt-ink-3)}
.bt-side-fail{margin:0;font-size:12px;line-height:17px;color:var(--bt-danger)}
.bt-side-form{flex:none;padding:10px 14px 14px;border-top:.5px solid var(--bt-line)}
.bt-side-input{display:block;width:100%;box-sizing:border-box;min-height:36px;max-height:120px;padding:8px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;line-height:19px;resize:none;outline:none;field-sizing:content}
.bt-side-input::placeholder{color:var(--bt-ink-3)}
.bt-side-input:focus{border-color:var(--bt-accent)}
.bt-side-input:disabled{opacity:.6}
.bt-pmenu{position:relative;display:inline-flex;flex:none}
.bt-pmenu-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:6;min-width:172px;padding:6px;border-radius:12px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 32px -8px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:2px;animation:bt-bcard-in .18s cubic-bezier(.16,1,.3,1) both}
.bt-pmenu-item{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:7px 10px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer}
.bt-pmenu-item:hover{background:var(--bt-hover)}
.bt-pmenu-item svg{flex:none;width:15px;height:15px;color:var(--bt-ink-3)}
.bt-pmenu-sep{height:.5px;flex:none;margin:4px 8px;background:var(--bt-line-2)}
`
