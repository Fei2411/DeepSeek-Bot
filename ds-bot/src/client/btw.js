// The earlier `/btw` aside cards, kept read-only where they already appear.
import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { hostText, t } from './i18n.js'
import { messageClock } from './text.js'
import { dockCards, sessionCards, tailCards } from './btw-model.js'

export const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

export function failureText(card) {
  const raw = typeof card.error === 'string' ? card.error : card.error?.message
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text !== '' ? hostText(text) : t('Could not answer.')
}

function stampOf(card) {
  const time = Number.isFinite(card.finishedAt) ? card.finishedAt : card.createdAt
  return Number.isFinite(time) ? time : undefined
}

export function BtwCardView({ card, compact = false }) {
  const [open, setOpen] = useState(card?.status !== 'answering')
  useEffect(() => {
    if (card?.status && card.status !== 'answering') setOpen(true)
  }, [card?.status])
  if (!card) return null
  const question = typeof card.question === 'string' ? card.question : ''
  const answer = typeof card.answer === 'string' ? card.answer : ''
  const when = stampOf(card)
  const answering = card.status === 'answering'
  return h('div', {
    className: compact ? 'bt-btw bt-btw-compact' : 'bt-btw',
    'data-open': open || undefined,
    'data-status': card.status,
    role: 'region',
    'aria-label': t('Side question'),
  },
  h('div', { className: 'bt-btw-head' },
    h('button', {
      type: 'button', className: 'bt-btw-toggle', 'aria-expanded': open,
      onClick: () => setOpen(value => !value),
    },
    h('span', { className: 'bt-btw-chevron', 'aria-hidden': true }),
    h('span', { className: 'bt-btw-q' }, question)),
    when !== undefined ? h('time', { className: 'bt-btw-time', dateTime: new Date(when).toISOString() }, messageClock(when)) : null,
    answering ? h('span', { className: 'bt-shimmer' }, t('Answering…')) : null,
    card.status === 'cancelled' ? h('span', { className: 'bt-btw-status' }, t('Cancelled')) : null),
  h('p', { className: 'bt-btw-note' }, t('Answered from progress so far; nothing was run')),
  open ? h('div', { className: 'bt-btw-body' },
    card.status === 'failed' ? h('p', { className: 'bt-btw-fail' }, failureText(card)) : null,
    answer !== '' ? h('div', { className: 'bt-btw-answer' }, h(MarkdownText, { text: answer, labels: mdLabels(), variant: 'compact' })) : null) : null)
}

function useTurnFacts(sessionId, actions) {
  const [facts, setFacts] = useState(() => actions.turnFacts(sessionId))
  useEffect(() => {
    let live = true
    const read = () => {
      if (!live) return
      const next = actions.turnFacts(sessionId)
      setFacts(current => (current.turns === next.turns && current.openTurn === next.openTurn ? current : next))
    }
    read()
    const off = actions.watchTurns(sessionId, read)
    return () => { live = false; off() }
  }, [sessionId, actions])
  return facts
}

// Cards whose turn is still open, or that no closed turn owns, sit in the
// composer dock. Read-only like the rest: no new cards can arrive.
export function BtwDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const facts = useTurnFacts(sessionId, actions)
  const cards = dockCards(sessionCards(roster, sessionId), facts)
  if (cards.length === 0) return null
  return h('div', { className: 'bt-btw-dock' }, cards.map(card => h(BtwCardView, { key: card.id, card, compact: true })))
}

export function BtwTurnTail({ turn, sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const facts = useTurnFacts(sessionId, actions)
  const cards = tailCards(sessionCards(roster, sessionId), turn, facts?.turns)
  if (cards.length === 0) return null
  return h('div', { className: 'bt-btw-stack' }, cards.map(card => h(BtwCardView, { key: card.id, card })))
}
