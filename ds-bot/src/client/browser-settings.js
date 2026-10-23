import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar } from './mark.js'
import { dateLocale, t } from './i18n.js'

const ACTIONS = [['post', 'Post'], ['upload', 'Upload'], ['download', 'Download'], ['delete', 'Delete']]
const DURATIONS = [['hour', '1 hour'], ['today', 'Today'], ['week', '7 days'], ['permanent', 'Permanent']]
const expired = grant => Number.isFinite(grant.until) && grant.until <= Date.now()

function siteValue(value) {
  return value.trim().toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/:\d+$/, '') || '*'
}

function grantTime(grant) {
  if (!Number.isFinite(grant.until)) return t('Permanent')
  if (grant.until <= Date.now()) return t('Expired')
  const time = new Date(grant.until).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  return t('Until {time}', { time })
}

function grantKinds(grant) {
  if (grant.kinds.includes('*')) return [t('All four')]
  return ACTIONS.filter(([kind]) => grant.kinds.includes(kind)).map(([, label]) => t(label))
}

export function BrowserPage({ roster, actions, run, Section, Row }) {
  const bots = roster.bots ?? []
  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [site, setSite] = useState('')
  const [kinds, setKinds] = useState(['post'])
  const [duration, setDuration] = useState('hour')
  const [busy, setBusy] = useState(false)
  const selectedBot = bots.find(bot => bot.id === botId)

  useEffect(() => {
    if (!bots.some(bot => bot.id === botId)) setBotId(bots[0]?.id ?? '')
  }, [bots, botId])

  const grants = bots.flatMap(bot => (bot.browserGrants ?? []).map((grant, index) => ({
    bot, grant, index, expired: expired(grant),
  })))
  const remove = (bot, index) => {
    const next = (bot.browserGrants ?? []).filter((grant, position) => position !== index && !expired(grant))
    void run(actions.updateBot(bot.id, { browserGrants: next.length ? next : null }))
  }
  const add = event => {
    event.preventDefault()
    if (!selectedBot || kinds.length === 0 || busy) return
    const now = Date.now()
    let until
    if (duration === 'hour') until = now + 60 * 60 * 1000
    else if (duration === 'today') {
      const end = new Date(now)
      end.setHours(23, 59, 59, 999)
      until = end.getTime()
    } else if (duration === 'week') until = now + 7 * 24 * 60 * 60 * 1000
    const grant = { site: siteValue(site), kinds: [...kinds], ...(until !== undefined ? { until } : {}) }
    setBusy(true)
    void run(actions.updateBot(selectedBot.id, {
      browserGrants: [...(selectedBot.browserGrants ?? []).filter(grant => !expired(grant)), grant],
    })).finally(() => setBusy(false))
  }
  const toggleKind = (kind, checked) => {
    setKinds(current => checked
      ? (current.includes(kind) ? current : [...current, kind])
      : current.filter(value => value !== kind))
  }

  return h('div', { className: 'bt-browser-settings' },
    h(Section, { title: t('Browser access') },
      h('p', { className: 'bt-browser-note' }, t('Bots browse, click and fill in forms freely. Posting, uploading, downloading and deleting ask you first unless you allow them here. Payments are always yours: the Bot hands the page to you.'))),
    h(Section, { title: t('Allowed actions') },
      grants.length === 0
        ? h(Row, { label: t('Nothing allowed yet.') })
        : grants.map(({ bot, grant, index, expired }) => h('div', {
          key: `${bot.id}:${index}`,
          className: `bt-browser-grant${expired ? ' bt-browser-grant-expired' : ''}`,
        },
        h('div', { className: 'bt-browser-grant-who' },
          h(BotAvatar, { bot, size: 28 }),
          h('span', null, bot.name)),
        h('div', { className: 'bt-browser-grant-meta' },
          h('span', { className: 'bt-browser-grant-site' }, grant.site === '*' ? t('All sites') : grant.site),
          h('div', { className: 'bt-browser-grant-kinds' }, grantKinds(grant).map(label => h('span', { key: label, className: 'bt-chip' }, label))),
          h('span', { className: 'bt-set-hint' }, grantTime(grant))),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => remove(bot, index),
          'aria-label': t('Remove grant'),
        }, t('Remove grant'))))),
    h(Section, { title: t('Allow an action') },
      h('form', { className: 'bt-browser-form', onSubmit: add },
        h(Row, { label: t('Bot') },
          h('select', { className: 'bt-select', value: botId, onChange: event => setBotId(event.target.value), disabled: bots.length === 0 },
            bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
        h(Row, { label: t('Site') },
          h('input', {
            className: 'bt-select bt-browser-site',
            type: 'text',
            value: site,
            placeholder: t('example.com — leave empty for all sites'),
            onChange: event => setSite(event.target.value),
          })),
        h(Row, { label: t('Actions') },
          h('div', { className: 'bt-browser-action-list' },
            ACTIONS.map(([kind, label]) => h('label', { key: kind, className: 'bt-browser-action-choice' },
              h('input', {
                type: 'checkbox',
                checked: kinds.includes(kind),
                onChange: event => toggleKind(kind, event.target.checked),
              }),
              t(label))))),
        h(Row, { label: t('Duration') },
          h('div', { className: 'bt-browser-duration', role: 'group', 'aria-label': t('Duration') },
            DURATIONS.map(([key, label]) => h('button', {
              key,
              type: 'button',
              className: 'bt-browser-duration-choice',
              'aria-pressed': duration === key,
              onClick: () => setDuration(key),
            }, t(label))))),
        h('div', { className: 'bt-browser-form-foot' },
          h('button', {
            type: 'submit',
            className: 'bt-soft',
            disabled: busy || !selectedBot || kinds.length === 0,
          }, busy ? t('Saving…') : t('Add'))))))
}
