import { createElement as h } from 'react'

export function PlusIcon() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': true }, h('path', { d: 'M10 3.5v13M3.5 10h13', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
}
export function SearchIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': true }, h('circle', { cx: 8.5, cy: 8.5, r: 5.5, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' }), h('path', { d: 'M13 13l4 4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
}
export function SidebarIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('rect', { x: 3, y: 4, width: 14, height: 12, rx: 2.5 }), h('path', { d: 'M8 4v12' }))
}
export function PeopleIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
    h('circle', { cx: 7.5, cy: 7, r: 3 }), h('path', { d: 'M2 16.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5' }),
    h('path', { d: 'M13 4.3a3 3 0 0 1 0 5.4M15 12.4c1.6.6 2.6 2 3 4.1' }))
}
export function ArrowUpIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': true }, h('path', { d: 'M10 16V4M5 9l5-5 5 5', stroke: 'currentColor', strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }))
}
export function MicIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
    h('rect', { x: 7, y: 2.5, width: 6, height: 10, rx: 3, fill: 'currentColor', stroke: 'none' }),
    h('path', { d: 'M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5' }))
}
// The voice-chat glyph: five bars of a level meter.
export function WaveIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': true },
    [[3, 7.5, 5], [6.5, 4.5, 11], [10, 2.5, 15], [13.5, 5.5, 9], [17, 8, 4]].map(([x, y, height]) => h('rect', { key: x, x: x - 1, y, width: 2, height, rx: 1 })))
}

export function ShareIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M10 12.5V3M6.5 6.5L10 3l3.5 3.5M4 11v4.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V11' }))
}
export function CloseIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': true }, h('path', { d: 'M5 5l10 10M15 5L5 15', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
}

export const ChevronLeftIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M12.5 4.5L7 10l5.5 5.5' }))
export const ChevronRightIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M7.5 4.5L13 10l-5.5 5.5' }))

const lineIcon = paths => function LineIcon() {
  return h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
// The classic cloud with a down arrow; `done` swaps the arrow for a check. The arrow
// is its own group so it can move while an update installs.
const CLOUD = 'M6.5 15.25H5.75a3.25 3.25 0 0 1-.55-6.45 4.75 4.75 0 0 1 9.2-1.1 3.75 3.75 0 0 1 .1 7.55H13.5'
export function CloudDownloadIcon({ done = false }) {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: CLOUD }),
    done
      ? h('path', { d: 'M7.75 13.25l1.75 1.75 3-3.25' })
      : h('g', { className: 'bt-cloud-arrow' }, h('path', { d: 'M10 9.75v7' }), h('path', { d: 'M7.75 14.5L10 16.75l2.25-2.25' })))
}
export const SmileIcon = lineIcon(['M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M7.3 11.6a3.4 3.4 0 0 0 5.4 0', 'M7.75 8.25h.01M12.25 8.25h.01'])
export const ReplyIcon = lineIcon(['M8 5L4 9l4 4', 'M4 9h7.5a4.5 4.5 0 0 1 4.5 4.5V15'])
export const DotsIcon = lineIcon(['M5 10h.01M10 10h.01M15 10h.01'])
export const CheckIcon = lineIcon(['M4.5 10.5l3.5 3.5 7.5-8'])
export const ArrowDownIcon = lineIcon(['M10 4v12', 'M5 11l5 5 5-5'])
export const DownloadIcon = lineIcon(['M10 3.5v9', 'M6.5 9.5L10 13l3.5-3.5', 'M4 16h12'])
export const GaugeIcon = lineIcon(['M3.5 13.5a6.5 6.5 0 1 1 13 0', 'M10 13.5l3-4', 'M10 13.5h.01'])
export const PlugIcon = lineIcon(['M7 3v4M13 3v4', 'M5 7h10v2.5a5 5 0 0 1-10 0z', 'M10 14.5V17'])
export const CalendarIcon = lineIcon(['M5.5 5h9A1.5 1.5 0 0 1 16 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z', 'M4 8.75h12', 'M7.25 3.5v3M12.75 3.5v3'])
export const ConnectorIcon = lineIcon(['M7 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M18 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M7 10h6'])
export const SwitchIcon = lineIcon(['M4 7h9.5M10.5 3.5L14 7l-3.5 3.5', 'M16 13H6.5M9.5 9.5L6 13l3.5 3.5'])
export const SignOutIcon = lineIcon(['M8.5 17H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5', 'M10 10h6.5', 'M13.5 7l3 3-3 3'])
export const PaperclipIcon = lineIcon(['M15.5 9.5l-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8l6.1-6.1a2.25 2.25 0 0 1 3.2 3.2l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.5-5.5'])
export const ClockIcon = lineIcon(['M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M10 6.5V10l2.5 1.5'])
// Six broad, shallow teeth around a wide hub: it reads as a gear even at 15px.
export const GearIcon = lineIcon(['M10 7.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z', 'M7.85 4.4l.29-1.87a7.7 7.7 0 0 1 3.72 0l.29 1.87a6 6 0 0 1 1.63.94l1.76-.69a7.7 7.7 0 0 1 1.86 3.23l-1.47 1.18a6 6 0 0 1 0 1.88l1.47 1.18a7.7 7.7 0 0 1-1.86 3.23l-1.76-.69a6 6 0 0 1-1.63.94l-.29 1.87a7.7 7.7 0 0 1-3.72 0l-.29-1.87a6 6 0 0 1-1.63-.94l-1.76.69a7.7 7.7 0 0 1-1.86-3.23l1.47-1.18a6 6 0 0 1 0-1.88L2.6 7.88a7.7 7.7 0 0 1 1.86-3.23l1.76.69a6 6 0 0 1 1.63-.94z'])
export const PinIcon = lineIcon(['M12.5 3l4.5 4.5-3 1.5-2.5 2.5.5 3.5-1.5 1.5L7 13 3.5 16.5', 'M7 13l-3.5-3.5L5 8l3.5.5L11 6l1.5-3'])
// The mark beside a pinned chat's name: a solid pushpin, head up and to the right.
export function PinMarkIcon() {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': true },
    h('g', { transform: 'rotate(45 10 10)' },
      h('path', { d: 'M8 2.5h4a.9.9 0 0 1 0 1.8h-.4v4.1c0 1.4 1.1 2.6 2.6 3.1l.7.3v1.5H5.1v-1.5l.7-.3c1.5-.5 2.6-1.7 2.6-3.1V4.3H8a.9.9 0 0 1 0-1.8z' }),
      h('path', { d: 'M9.35 13.3h1.3v3.6L10 18l-.65-1.1z' })))
}
export const UnreadIcon = lineIcon(['M10 3.5a4.5 4.5 0 0 0-4.5 4.5v3L4 13.5h12L14.5 11V8', 'M8.3 16a1.8 1.8 0 0 0 3.4 0', 'M15.5 3.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z'])
export const PencilIcon = lineIcon(['M9 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3', 'M14.3 3.7a1.6 1.6 0 0 1 2.3 2.3L10.5 12l-3 .8.8-3z'])
export const InfoIcon = lineIcon(['M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M10 9.25v4', 'M10 6.6h.01'])
export const StarLineIcon = lineIcon(['M10 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z'])
export const CopyIcon = lineIcon(['M8.5 7h6A1.5 1.5 0 0 1 16 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 7 14.5v-6A1.5 1.5 0 0 1 8.5 7z', 'M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4H13'])
export const HideIcon = lineIcon(['M3 3l14 14', 'M8.6 5.2A7.6 7.6 0 0 1 10 5c4.5 0 7 5 7 5a12.6 12.6 0 0 1-2 2.6M12.2 14.5A6.8 6.8 0 0 1 10 15c-4.5 0-7-5-7-5a12.4 12.4 0 0 1 3-3.4', 'M8.5 8.5a2 2 0 0 0 3 3'])
export const TrashIcon = lineIcon(['M3.5 5.5h13', 'M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5', 'M5 5.5l.7 10A1.5 1.5 0 0 0 7.2 17h5.6a1.5 1.5 0 0 0 1.5-1.5l.7-10', 'M8.5 9v4.5M11.5 9v4.5'])
export const DuplicateIcon = lineIcon(['M7 7h8.5v9.5H7z', 'M4.5 13V3.5H13', 'M11.25 9.5v4.5M9 11.75h4.5'])
export const SlidersIcon = lineIcon(['M4 6.5h5M12.5 6.5H16M4 13.5h4M11.5 13.5H16', 'M10.5 4.5v4M9.5 11.5v4'])
// A notebook with a ribbon: what a Bot remembers.
export const MemoryIcon = lineIcon(['M5.5 3.5h8A1.5 1.5 0 0 1 15 5v10a1.5 1.5 0 0 1-1.5 1.5h-8z', 'M5.5 3.5v13', 'M8.5 7.5h3.5M8.5 10.5h2.5', 'M12 3.5v4l1-.8 1 .8'])
// A command prompt in a window: the `>` caret and the cursor's `_`.
export const TerminalIcon = lineIcon(['M4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4z', 'M6.5 8l2.5 2.5L6.5 13', 'M11 13h3.5'])
export const FolderIcon = lineIcon(['M3 6A1.5 1.5 0 0 1 4.5 4.5h3.2l1.8 2h6A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z'])
// One speech bubble with two text lines: a side chat.
export const SideIcon = lineIcon(['M4.5 4h11A1.5 1.5 0 0 1 17 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9L5.5 16v-3h-1A1.5 1.5 0 0 1 3 11.5v-6A1.5 1.5 0 0 1 4.5 4z', 'M6.5 7h7', 'M6.5 10h4.5'])
// Defined here, after the icons: SettingsDialog only reads them at render time.
// Two speech bubbles, the back one peeking out: a group chat.
export const ChatsIcon = lineIcon(['M3.5 5.5A1.5 1.5 0 0 1 5 4h7a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 12 11.5H8L5 14v-2.5A1.5 1.5 0 0 1 3.5 10z', 'M13.5 7.5H15A1.5 1.5 0 0 1 16.5 9v4.5A1.5 1.5 0 0 1 15 15v2l-2.5-2h-3A1.5 1.5 0 0 1 8 13.5V13'])
export const SETTINGS_ICONS = { general: GearIcon, bots: PeopleIcon, groups: ChatsIcon, usage: GaugeIcon }
