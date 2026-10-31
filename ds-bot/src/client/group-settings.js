import { createElement as h, useEffect, useState } from 'react'
import { isMainOf } from './sources.js'
import { PlusIcon, ChevronRightIcon } from './icons.js'
import { AdminStar, BotAvatar, BotMark, RoomAvatar } from './mark.js'
import { Card, Row, InlineText, SwitchRow } from './bot-settings.js'
import { Segmented } from './motion.js'
import { FolderMenu } from './folder-menu.js'
import { PermissionPicker } from './permission-picker.js'
import { t } from './i18n.js'

export const ROOM_MODES = [
  ['admin', 'Admin leads', 'Plain messages go to the admin, who calls others with @Name.'],
  ['everyone', 'Everyone', 'Every member answers in turn, admin first.'],
]

// Without an admin the host answers as everyone, whatever the stored mode says.
export const shownMode = (room, roster) => (roster.byId[room.admin] ? room.mode : 'everyone')

export function roomSubtitle(room, roster) {
  const admin = roster.byId[room.admin]
  return [t('{count} members', { count: room.members.length }), admin ? t('Admin {name}', { name: admin.name }) : t('No admin')].join(' · ')
}

// One preset for every member in the group, or each member's own. Turning it on starts
// from DSH's default preset.
function GroupPermission({ room, catalog, update }) {
  if (!catalog?.options?.length) return null
  const shared = room.permission !== undefined
  return h(Card, { title: t('Permissions') },
    h(SwitchRow, {
      label: t('Same for every member'), hint: t("Replaces each member's own permissions in this group."), on: shared,
      onChange: on => update({ permission: on ? catalog.defaultPreset ?? catalog.options[0].value : null }),
    }),
    shared ? h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-gs-perm bt-veil' },
      h(PermissionPicker, { catalog, saved: room.permission, onPick: permission => update({ permission }) })) : null)
}

// A group chat's settings as grouped cards: its name and notice, who answers, its
// members and admin, its permissions, its sidebar place, and deleting it. The user may
// change all of it; the host enforces what Bots may change.
export function GroupSettingsForm({ room, roster, actions, run, onDeleted }) {
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const outside = roster.bots.filter(bot => !room.members.includes(bot.id))
  const admin = roster.byId[room.admin]
  const mode = shownMode(room, roster)
  const modeHint = ROOM_MODES.find(([id]) => id === mode)?.[2] ?? ''
  const update = patch => run(actions.updateRoom(room.id, patch))
  const openBot = (id) => { actions.closeSettings(); actions.openSession(id) }
  const remove = () => {
    if (!confirming) { setConfirming(true); return }
    void Promise.resolve(run(actions.deleteRoom(room.id))).then((done) => { if (done) onDeleted?.() })
  }
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h(RoomAvatar, { room, roster, size: 64 }),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, room.name),
        h('span', { className: 'bt-bs-sub' }, roomSubtitle(room, roster)))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name'), hint: t('Leave it empty to name the group after its members.') },
        h(InlineText, { label: t('Group name'), value: room.named ? room.name : '', placeholder: t('Name after members'), maxLength: 60, onSave: name => update({ name }) })),
      h(Row, { label: t('Notice'), hint: t('Every member reads it before speaking in this group.'), stack: true },
        h(InlineText, { label: t('Group notice'), value: room.notice, multiline: true, maxLength: 2000, placeholder: t('Shared instructions every member reads before speaking…'), onSave: notice => update({ notice }) }))),
    h(Card, { title: t('Who answers') },
      h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h(Segmented, { label: t('Who answers'), value: mode }, ROOM_MODES.map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'admin' && !admin,
          title: id === 'admin' && !admin ? t('Choose an admin first') : undefined,
          onClick: () => { if (mode !== id) void update({ mode: id }) },
        }, t(label)))),
        h('span', { key: mode, className: 'bt-set-hint bt-veil' }, `${t(modeHint)} ${t('@mentions always pick who answers.')}`))),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder'))),
        h(FolderMenu, { value: room.workDir, group: true, actions, run, onPick: workDir => update({ workDir }) }))),
    h(GroupPermission, { room, catalog: roster.permissions, update }),
    h(Card, { title: t('Members · {count}', { count: members.length }) },
      members.map((member) => {
        const leads = room.admin === member.id
        return h('div', { key: member.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
          h('button', { type: 'button', className: 'bt-gs-who', title: t("Open {name}'s chat", { name: member.name }), onClick: () => openBot(member.id) },
            h(BotAvatar, { bot: member, size: 26, main: isMainOf(roster, member.id), admin: leads, live: false }),
            h('span', { className: 'bt-row-title' }, member.name),
            leads ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
          leads
            ? h('button', { type: 'button', className: 'bt-mini', title: t('Leave the group without an admin'), onClick: () => update({ admin: null }) }, t('Unset'))
            : h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ admin: member.id }) }, t('Make admin')),
          members.length > 2 ? h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: member.name }), title: t('Remove from group'), onClick: () => update({ remove: [member.id] }) }, '×') : null)
      }),
      adding
        ? [...outside.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', onClick: () => { setAdding(false); void update({ add: [bot.id] }) } },
            h(BotMark, { bot, size: 22 }),
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, bot.name)),
            h('span', { className: 'bt-set-hint' }, t('Add')))),
          h('button', { key: 'cancel', type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(false) }, t('Cancel'))]
        : outside.length > 0
          ? h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(true) }, h(PlusIcon), t('Add member'))
          : null,
      h('div', { className: 'bt-set-row bt-gs-note' }, h('span', { className: 'bt-set-hint' },
        // The host checks for two members on every change, even a rename.
        members.length < 2 ? t('Add a Bot first: a group chat needs at least two.')
          : admin ? t('{name} leads this group: it can call members with @Name, change the group, and post here.', { name: admin.name })
            : t('No admin yet. An admin can call members with @Name, change the group, and post here.')))),
    h(Card, { title: t('Sidebar') },
      h(SwitchRow, { label: t('Pin'), hint: t('Kept above the other chats.'), on: room.pinned === true, onChange: pinned => run(actions.setFlags(room.id, { pinned })) }),
      h(SwitchRow, { label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: room.hidden === true, onChange: hidden => run(actions.setFlags(room.id, { hidden })) })),
    h(Card, { title: t('Manage') },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined, onClick: remove },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Delete {name}?', { name: room.name }) : t('Delete group')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to delete. Its history is archived.') : t('Removes the group chat. Its members stay on the team.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

// A new group chat from Settings: its admin first, then the other members, then a name
// if the member names will not do.
export function NewGroupForm({ roster, actions, run, onCreated, onCancel }) {
  const [admin, setAdmin] = useState(null)
  const [members, setMembers] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const toggle = id => setMembers(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const pickAdmin = (id) => { setAdmin(id); setMembers(list => list.filter(item => item !== id)) }
  const create = async () => {
    if (busy || admin === null || members.length === 0) return
    setBusy(true)
    let room
    const done = await run(actions.createRoom([admin, ...members], { admin, greet: true, ...(name.trim() ? { name: name.trim() } : {}) }).then((value) => { room = value }))
    if (done && room) onCreated(room)
    else setBusy(false)
  }
  const chip = (bot, on, onClick, role) => h('button', {
    key: bot.id, type: 'button', role, className: 'bt-ng-chip', 'aria-checked': on, onClick,
  }, h(BotAvatar, { bot, size: 22, badge: false, live: false }), h('span', { className: 'bt-ng-name' }, bot.name), on && role === 'radio' ? h(AdminStar) : null)
  return h('div', { className: 'bt-set-card bt-ng' },
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label bt-ng-label' }, h(AdminStar), t('Choose the group admin'))),
      h('div', { className: 'bt-ng-picks', role: 'radiogroup', 'aria-label': t('Group admin') },
        roster.bots.map(bot => chip(bot, admin === bot.id, () => pickAdmin(bot.id), 'radio')))),
    admin === null ? null : h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-ng-step' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Who to chat with…'))),
      h('div', { className: 'bt-ng-picks', role: 'group', 'aria-label': t('Members') },
        roster.bots.filter(bot => bot.id !== admin).map(bot => chip(bot, members.includes(bot.id), () => toggle(bot.id), 'checkbox')))),
    admin === null || members.length === 0 ? null : h('label', { className: 'bt-set-row bt-bs-row bt-ng-step' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
      h('input', { className: 'bt-bs-input', value: name, maxLength: 60, placeholder: t('Name after members'), onChange: event => setName(event.target.value) })),
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || admin === null || members.length === 0, onClick: () => void create() }, t('Create group chat'))))
}

export const GROUP_SETTINGS_CSS = `
.bt-ng{animation:bt-q-in .4s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-ng-step{animation:bt-veil-in .22s ease-out}
.bt-ng-label{display:inline-flex;align-items:center;gap:6px}
.bt-ng-picks{display:flex;flex-wrap:wrap;gap:6px}
.bt-ng-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 5px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease,scale .3s cubic-bezier(.34,1.56,.64,1)}
.bt-ng-chip:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ng-chip:active{scale:.96}
.bt-ng-chip[aria-checked=true]{background:var(--bt-active);border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-ng-chip .bt-admin-star{animation:bt-check-pop .4s cubic-bezier(.34,1.56,.64,1)}
.bt-ng-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.bt-ng,.bt-ng-step,.bt-ng-chip .bt-admin-star{animation:none}}
.bt-gs-member{gap:8px}
.bt-gs-who{flex:1;display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-gs-who .bt-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-gs-who:hover .bt-row-title{text-decoration:underline;text-underline-offset:2px}
.bt-gs-add{gap:8px;color:var(--bt-ink-2)}
.bt-gs-pick{gap:10px;animation:bt-rise .16s ease-out}
.bt-bs-stack .bt-seg{align-self:stretch}
.bt-gs-perm .bt-seg button{flex:auto;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.bt-gs-pick{animation:none}}
`
