// The avatar library: photos the user imported once, kept in the Bot data folder so the
// same picture can be picked for several Bots and outlives the Bot that used it. Every
// image is named by the hash of its bytes, so the same picture is stored once, and the
// index and the images are written whole, so a half-written file is never read.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { avatarBytes } from './avatar.js'
import { replaceFile } from './files.js'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const HASH = /^[0-9a-f]{64}$/
const MAX_PHOTOS = 500
// How many photos one answer carries. A window asks for the rest when it wants them,
// so a big library does not become one huge reply.
const MAX_LISTED = 48

export function install(rt) {
  const root = typeof rt.home === 'string' ? join(rt.home, 'avatars') : undefined
  const files = root === undefined ? undefined : join(root, 'files')
  const indexPath = root === undefined ? undefined : join(root, 'index.json')

  const fileOf = entry => join(files, `${entry.id}.${EXTENSIONS[entry.mime]}`)

  // One write at a time: two imports that overlap would each read the index, and the
  // second write would drop what the first one added.
  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => {}, () => {})
    return run
  }

  // The index on disk, with the entries that can be trusted: an id that is a hash, a
  // known type, and a name that is text.
  const readIndex = async () => {
    if (indexPath === undefined) return []
    let parsed
    try { parsed = JSON.parse(await readFile(indexPath, 'utf8')) } catch { return [] }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return items
      .filter(entry => typeof entry?.id === 'string' && HASH.test(entry.id) && EXTENSIONS[entry.mime] !== undefined)
      .map(entry => ({
        id: entry.id,
        name: String(entry.name ?? '').slice(0, 120),
        mime: entry.mime,
        bytes: Number(entry.bytes) || 0,
        createdAt: Number(entry.createdAt) || 0,
      }))
  }

  const writeIndex = async (items) => {
    await mkdir(root, { recursive: true })
    const temp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
    await replaceFile(temp, indexPath)
  }

  const writeImage = async (entry, bytes) => {
    await mkdir(files, { recursive: true })
    const path = fileOf(entry)
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, bytes)
    await replaceFile(temp, path)
  }

  const there = async path => stat(path).then(() => true, () => false)

  // One photo at a time, so a photo that cannot be read does not lose the others. The
  // picture is checked as an image, and the same bytes are kept once.
  const importPhotos = (items) => serial(async () => {
    if (root === undefined) throw new Error('This host keeps no Bot data folder, so it has no avatar library.')
    const index = await readIndex()
    const result = { imported: [], duplicates: [], failed: [] }
    for (const item of items) {
      const name = String(item?.name ?? '').trim().slice(0, 120)
      try {
        const { bytes, mime } = avatarBytes(item?.image)
        const id = createHash('sha256').update(bytes).digest('hex')
        const known = index.find(entry => entry.id === id)
        if (known) {
          // The same picture again: the one that is there stays, and its file is put
          // back when it went missing.
          if (!await there(fileOf(known))) await writeImage(known, bytes)
          result.duplicates.push({ id: known.id, name: known.name })
          continue
        }
        if (index.length >= MAX_PHOTOS) throw new Error(`The avatar library holds at most ${MAX_PHOTOS} photos.`)
        const entry = { id, name: name || 'photo', mime, bytes: bytes.length, createdAt: Date.now() }
        await writeImage(entry, bytes)
        index.push(entry)
        await writeIndex(index)
        result.imported.push(entry)
      } catch (error) {
        result.failed.push({ name, message: error?.message ?? String(error) })
      }
    }
    return result
  })

  // The photos the user can pick, with the image itself, so the window needs one
  // request to draw the library. The newest come first, and a library with many photos
  // is asked for page by page.
  const libraryView = async ({ offset = 0, limit = MAX_LISTED } = {}) => {
    const index = await readIndex()
    const ordered = [...index].sort((a, b) => b.createdAt - a.createdAt)
    const start = Math.max(0, Math.floor(Number(offset)) || 0)
    const count = Math.min(MAX_LISTED, Math.max(1, Math.floor(Number(limit)) || MAX_LISTED))
    const items = []
    const page = ordered.slice(start, start + count)
    for (const entry of page) {
      const bytes = await readFile(fileOf(entry)).catch(() => undefined)
      if (bytes === undefined) continue
      items.push({ ...entry, image: `data:${entry.mime};base64,${bytes.toString('base64')}` })
    }
    // The next page starts where this one stopped, even when a photo went missing.
    return { items, total: ordered.length, next: start + page.length }
  }

  // A photo leaves the library; the Bots that use it keep their own copy.
  const deletePhoto = (id) => serial(async () => {
    const index = await readIndex()
    const entry = index.find(item => item.id === id)
    if (entry === undefined) return false
    await writeIndex(index.filter(item => item.id !== id))
    await rm(fileOf(entry), { force: true })
    return true
  })

  Object.assign(rt, { avatarLibraryView: libraryView, avatarLibraryImport: importPhotos, avatarLibraryDelete: deletePhoto })
}
