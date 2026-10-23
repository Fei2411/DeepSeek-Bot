// Avatar input for create_bot and update_bot: a local image path or a data URL, read
// into the data URL a Bot keeps in avatar.image. There is no image library in the
// host, so images are not resized; a small square image is asked for, and every kind
// of input is capped at what the stored format holds.
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAX_AVATAR_IMAGE } from './constants.js'

// Base64 is four characters for every three bytes, and the data URL adds a mime
// prefix, so a raw image must stay under this to fit MAX_AVATAR_IMAGE once stored.
const LONGEST_PREFIX = 'data:image/jpeg;base64,'
const MAX_BYTES = Math.floor((MAX_AVATAR_IMAGE - LONGEST_PREFIX.length) / 4) * 3
const HINT = 'Use a square image; 256x256 is recommended.'
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const ascii = (bytes, start, end) => Buffer.from(bytes.subarray(start, end)).toString('latin1')

// The real format, from the bytes themselves: an extension, a Content-Type header, or
// the mime in a data URL can all be wrong.
function mimeOf(bytes) {
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

const tooLarge = size => `The avatar image is too large: ${size} bytes, and the limit is ${MAX_BYTES} bytes (about 120 KB). ${HINT}`
const NOT_IMAGE = `The avatar must be a PNG, JPEG, WebP, or GIF image. ${HINT}`

function toDataUrl(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error(tooLarge(bytes.length))
  const mime = mimeOf(bytes)
  if (mime === undefined) throw new Error(NOT_IMAGE)
  const url = `data:${mime};base64,${bytes.toString('base64')}`
  if (url.length > MAX_AVATAR_IMAGE) throw new Error(tooLarge(bytes.length))
  return url
}

const expandHome = (text) => {
  if (text === '~') return homedir()
  if (/^~[\\/]/.test(text)) return join(homedir(), text.slice(2))
  return text
}

async function readLocal(path, baseDir, isData) {
  const full = resolve(baseDir ?? process.cwd(), expandHome(path))
  // Checked and read at the real path, where links lead, so a link cannot reach into
  // DSH's data, and one changed after the check is not followed.
  let real
  let info
  try {
    real = await realpath(full)
    info = await stat(real)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`There is no image file at ${full}. Pass the path of an existing image file.`)
    throw new Error(`Cannot read the image at ${full}: ${error?.code === 'EACCES' ? 'permission denied' : error.message}`)
  }
  if (!info.isFile()) throw new Error(`${full} is not an image file. Pass the path of an image file.`)
  if (await isData?.(real)) throw new Error(`${full} is in DeepSeek Harness data, so it cannot be a Bot's photo. Pass an image from another folder.`)
  if (info.size > MAX_BYTES) throw new Error(tooLarge(info.size))
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    throw new Error(`Cannot read the image at ${full}: ${error?.code === 'EACCES' ? 'permission denied' : error.message}`)
  }
  if (bytes.length > MAX_BYTES) throw new Error(tooLarge(bytes.length))
  return toDataUrl(bytes)
}

function readDataUrl(value) {
  const comma = value.indexOf(',')
  if (comma === -1) throw new Error(`The avatar data URL has no comma before its image data. ${HINT}`)
  const header = value.slice('data:'.length, comma)
  const [mime = '', ...params] = header.split(';').map(part => part.trim().toLowerCase())
  if (!MIMES.has(mime)) throw new Error(`The avatar data URL must hold a PNG, JPEG, WebP, or GIF image. ${HINT}`)
  if (!params.includes('base64')) throw new Error('The avatar data URL must be base64 encoded, as in data:image/png;base64,...')
  const payload = value.slice(comma + 1).replace(/\s/g, '')
  if (payload === '' || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error('The avatar data URL does not hold valid base64 image data.')
  }
  const bytes = Buffer.from(payload, 'base64')
  return { url: toDataUrl(bytes), bytes, mime: mimeOf(bytes) }
}

// The image behind an avatar data URL: the bytes, the type they really are, and the
// canonical data URL. The same checks as for a Bot's own avatar apply.
export function avatarBytes(value) {
  return readDataUrl(String(value ?? ''))
}

// Returns the data URL for avatar.image, or throws with a line the user can read.
// `baseDir` is where a relative local path starts, and `isData` says whether a real path
// lies in data a Bot may not read from. Links are not fetched: the host would reach
// addresses, such as local services, that dsh's own web fetch refuses.
export async function readAvatar(input, { baseDir, isData } = {}) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') throw new Error(`Give an image path or a data URL. ${HINT}`)
  if (/^data:/i.test(value)) return readDataUrl(value).url
  if (/^https?:\/\//i.test(value)) throw new Error('An http(s) link is not downloaded here. Save the image to a file and pass its path, or pass a data URL.')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error(`The avatar must be a local image path or a data URL. ${HINT}`)
  // A network path (\\host\share) would make Windows connect to that host and sign in.
  if (/^[\\/]{2}/.test(value)) throw new Error('A network path is not read here. Copy the image to this computer and pass its path, or pass a data URL.')
  return readLocal(value, baseDir, isData)
}
