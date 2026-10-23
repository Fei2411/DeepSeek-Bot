import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { TrashIcon } from './icons.js'
import { hostText, t } from './i18n.js'

// How many photos go in one request to the host.
const CHUNK = 20
// How many photos the window asks for at a time.
const PAGE = 24

// Uploaded avatars are center-cropped to a small square so state.json stays light.
export async function avatarImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error(t('Choose a PNG, JPEG, WebP, or GIF image'))
  if (file.size > 25 * 1024 * 1024) throw new Error(t('Choose an image smaller than 25 MB'))
  const bitmap = await createImageBitmap(file)
  const side = 160
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  const crop = Math.min(bitmap.width, bitmap.height)
  context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side)
  bitmap.close?.()
  for (const quality of [0.9, 0.75, 0.6]) {
    const url = canvas.toDataURL('image/webp', quality)
    if (url.startsWith('data:image/webp') && url.length < 150000) return url
  }
  const png = canvas.toDataURL('image/png')
  if (png.length < 150000) return png
  throw new Error(t('That image is too large'))
}

// Imports the photos in small batches. A batch the host refuses does not stop the
// ones after it: every photo of that batch is named, and nothing is sent twice.
export async function importPhotos(photos, actions) {
  const imported = []
  const duplicates = []
  const failed = []
  for (let index = 0; index < photos.length; index += CHUNK) {
    const chunk = photos.slice(index, index + CHUNK)
    try {
      const result = await actions.importAvatars(chunk)
      imported.push(...(result?.imported ?? []))
      duplicates.push(...(result?.duplicates ?? []))
      failed.push(...(result?.failed ?? []))
    } catch (failure) {
      // The batch did not land. Every photo in it is reported, so none of them is
      // silently lost, and the batch is not sent again.
      failed.push(...chunk.map(photo => ({ name: photo.name, message: failure?.message ?? String(failure) })))
    }
  }
  return { imported, duplicates, failed }
}

// One page of the library: the host keeps its answer small, so a window asks for the
// photos it shows and for the next ones when the user wants more.
export async function loadLibrary(actions, { offset = 0, limit = PAGE } = {}) {
  const value = await actions.avatarLibrary({ offset, limit })
  const items = value?.items ?? []
  return { items, total: value?.total ?? items.length, next: value?.next ?? offset + items.length }
}

// The avatar library: the photos the user imported once, kept by the host beside the
// team. The window asks for them when the picker opens, and imports new ones in a
// batch: a photo that cannot be read is named, and the others still land.
export function AvatarLibraryPanel({ actions, onPick }) {
  const [items, setItems] = useState(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)
  const fileRef = useRef(null)

  const load = useCallback(async (from = 0, append = false) => {
    try {
      const page = await loadLibrary(actions, { offset: from })
      setItems(previous => (append ? [...(previous ?? []), ...page.items] : page.items))
      setTotal(page.total)
      setOffset(page.next)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }, [actions])
  useEffect(() => { void load() }, [load])

  const importFiles = async (files) => {
    if (files.length === 0) return
    setBusy(true)
    setError('')
    setReport(null)
    // Every photo is cropped and checked on its own, so one bad file does not stop the rest.
    const photos = []
    const failed = []
    for (const file of files) {
      try { photos.push({ name: file.name, image: await avatarImage(file) }) }
      catch (failure) { failed.push({ name: file.name, message: failure?.message ?? String(failure) }) }
    }
    const result = await importPhotos(photos, actions)
    setReport({ imported: result.imported, duplicates: result.duplicates, failed: [...failed, ...result.failed] })
    await load()
    setBusy(false)
  }

  const remove = async (entry) => {
    setBusy(true)
    setError('')
    try {
      await actions.deleteAvatar(entry.id)
      await load()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const shown = items?.length ?? 0
  return h('div', { className: 'bt-lib' },
    h('div', { className: 'bt-lib-bar' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => fileRef.current?.click() },
        busy ? t('Importing photos…') : t('Import photos')),
      h('input', {
        ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true,
        onChange: event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void importFiles(files) },
      })),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    items === null ? h('div', { className: 'bt-note' }, t('Loading…')) : null,
    items?.length === 0 && !error ? h('div', { className: 'bt-note' }, t('No photos in the library yet.')) : null,
    items?.length ? h('div', { className: 'bt-lib-grid' }, items.map(entry => h('div', { key: entry.id, className: 'bt-lib-cell' },
      h('button', { type: 'button', className: 'bt-lib-pick', title: entry.name, 'aria-label': t('Use this photo'), onClick: () => onPick(entry) },
        h('img', { src: entry.image, alt: '' })),
      h('button', { type: 'button', className: 'bt-lib-del', 'aria-label': t('Remove photo from the library'), onClick: () => void remove(entry) },
        h(TrashIcon))))) : null,
    shown < total ? h('div', { className: 'bt-lib-more' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void load(offset, true) }, t('Show more photos')),
      h('span', { className: 'bt-note' }, t('Showing {shown} of {total} photos', { shown, total }))) : null,
    report ? h('div', { className: 'bt-lib-report' },
      report.imported.length ? h('div', { className: 'bt-note' }, report.imported.length === 1 ? t('1 photo imported') : t('{count} photos imported', { count: report.imported.length })) : null,
      report.duplicates.length ? h('div', { className: 'bt-note' }, report.duplicates.length === 1 ? t('1 photo was already in the library') : t('{count} photos were already in the library', { count: report.duplicates.length })) : null,
      report.failed.map((item, index) => h('div', { key: index, className: 'bt-note bt-danger' },
        t('{name}: {reason}', { name: item.name || t('photo'), reason: hostText(item.message) })))) : null)
}

export const AVATAR_LIBRARY_CSS = `
.bt-lib{display:flex;flex-direction:column;gap:8px;width:100%}
.bt-lib-bar{display:flex;align-items:center;gap:8px}
.bt-lib-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;max-height:210px;overflow-y:auto}
.bt-lib-cell{position:relative}
.bt-lib-pick{display:block;width:100%;aspect-ratio:1;padding:0;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-hover);cursor:pointer;overflow:hidden}
.bt-lib-pick:hover{background:var(--bt-active)}
.bt-lib-pick img{display:block;width:100%;height:100%;object-fit:cover}
.bt-lib-del{position:absolute;right:0;top:0;width:28px;height:28px;padding:0;border:1px solid var(--bt-line-2);border-radius:50%;background:var(--bt-main);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;cursor:pointer}
.bt-lib-del:hover{color:var(--bt-ink)}
.bt-lib-del svg{width:14px;height:14px}
.bt-lib-more{display:flex;align-items:center;gap:8px}
.bt-lib-report{display:flex;flex-direction:column;gap:4px}
`
