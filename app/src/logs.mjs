// main.log: the main process's console output and the Host's, in the app's own userData
// (%APPDATA%\DeepSeek Bot\logs on Windows), redacted before it is written and kept to three
// files of 2 MB (docs/plans/2026-10-26-windows-onboarding.md §3).
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOG_LIMIT = 2 * 1024 * 1024
export const LOG_FILES = 3
// A line without its end (a progress line redrawn with \r) is written once it gets this long.
const PARTIAL_MAX = 8 * 1024

/** main.log, then main.1.log and main.2.log, newest first. */
export const logNames = (count = LOG_FILES) => Array.from({ length: count }, (_, index) => (index === 0 ? 'main.log' : `main.${String(index)}.log`))

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Removes what must not reach a log or a copied report: the launch token, API keys, the query of
 * a sign-in callback and the user's home folder, which names the user.
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {(text: string) => string}
 */
export function redactor({ home = homedir(), platform = process.platform } = {}) {
  const parts = home.split(/[\\/]+/u).filter(Boolean)
  // Any separator, doubled as in JSON, and on Windows any case: the same folder. A home of '/'
  // or '' names nobody.
  const lead = /^[\\/]/u.test(home) ? '[\\\\/]' : ''
  const homePattern = parts.length > 0 ? new RegExp(`${lead}${parts.map(escape).join('[\\\\/]+')}(?=[\\\\/\\s"'\`<>|:;,)\\]}]|$)`, platform === 'win32' ? 'giu' : 'gu') : undefined
  const label = platform === 'win32' ? '%USERPROFILE%' : '~'
  return (text) => {
    let out = text
      .replace(/(token=)[^&\s"'<>]+/giu, '$1<hidden>')
      .replace(/(\/oauth\/callback)\?[^\s"'<>]+/gu, '$1?<hidden>')
      .replace(/\bsk-[A-Za-z0-9][\w-]*/gu, 'sk-<hidden>')
      .replace(/\b(Bearer\s+)[\w.~+/=-]+/gu, '$1<hidden>')
    if (homePattern !== undefined) out = out.replace(homePattern, label)
    return out
  }
}

/**
 * Splits a chunk of output into whole lines; the rest waits for the next chunk.
 * @returns {{ lines: string[], rest: string }}
 */
export function splitLines(rest, chunk) {
  const pieces = (rest + chunk).split(/\r?\n/u)
  let tail = pieces.pop() ?? ''
  const lines = pieces.map(line => line.replace(/\r/gu, ''))
  if (tail.length > PARTIAL_MAX) {
    lines.push(tail.replace(/\r/gu, ''))
    tail = ''
  }
  return { lines, rest: tail }
}

/** Whether a write of `add` bytes goes into a fresh file. */
export const shouldRotate = (size, add, limit = LOG_LIMIT) => size > 0 && size + add > limit

/** Shifts main.log to main.1.log and so on; the oldest is overwritten. */
export function rotate(dir, count = LOG_FILES) {
  const names = logNames(count)
  for (let index = names.length - 1; index > 0; index -= 1) {
    try {
      renameSync(join(dir, names[index - 1]), join(dir, names[index]))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/** The last `count` lines of a text. */
export function tailLines(text, count) {
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count)
}

export class LogFile {
  #dir
  #file
  #fd
  #size = 0
  #limit
  #redact
  #now
  #rests = new Map()
  #broken = false

  /** @param {{ dir: string, limit?: number, redact?: (text: string) => string, now?: () => Date }} options */
  constructor({ dir, limit = LOG_LIMIT, redact = redactor(), now = () => new Date() }) {
    this.#dir = dir
    this.#file = join(dir, logNames()[0])
    this.#limit = limit
    this.#redact = redact
    this.#now = now
  }

  get dir() { return this.#dir }

  /** Writes the whole lines of a chunk of output, each with the time and its source. */
  write(source, chunk) {
    const { lines, rest } = splitLines(this.#rests.get(source) ?? '', String(chunk))
    this.#rests.set(source, rest)
    for (const line of lines) this.#line(source, line)
  }

  /** Writes the lines still waiting for their end. */
  flush() {
    for (const [source, rest] of this.#rests) if (rest !== '') this.#line(source, rest)
    this.#rests.clear()
  }

  /** The last `count` lines across the files, oldest first, redacted. */
  tail(count) {
    this.flush()
    const texts = []
    for (const name of logNames()) {
      try {
        texts.unshift(readFileSync(join(this.#dir, name), 'utf8'))
      } catch {
        break
      }
      if (tailLines(texts.join(''), count).length >= count) break
    }
    return tailLines(texts.join(''), count).map(this.#redact)
  }

  close() {
    this.flush()
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }

  #line(source, line) {
    if (this.#broken) return
    const text = `${this.#now().toISOString()} [${source}] ${this.#redact(line)}\n`
    const bytes = Buffer.byteLength(text)
    try {
      if (this.#fd === undefined) this.#open()
      if (shouldRotate(this.#size, bytes, this.#limit)) {
        closeSync(this.#fd)
        this.#fd = undefined
        // Another process can still hold main.log open (the one that relaunched this one);
        // then the file grows past the limit until the next start.
        try { rotate(this.#dir) } catch { /* kept */ }
        this.#open()
      }
      writeSync(this.#fd, text)
      this.#size += bytes
    } catch {
      // A log that cannot be written must not stop the app.
      this.#broken = true
    }
  }

  #open() {
    mkdirSync(this.#dir, { recursive: true })
    this.#fd = openSync(this.#file, 'a')
    this.#size = statSync(this.#file).size
  }
}

/**
 * Copies everything the main process writes to stdout and stderr into the log.
 * @returns {{ stdout: (text: string) => void, stderr: (text: string) => void }} writers that bypass the log
 */
export function captureStdio(log, streams = { stdout: process.stdout, stderr: process.stderr }) {
  const raw = {}
  for (const [name, stream] of Object.entries(streams)) {
    const write = stream.write.bind(stream)
    raw[name] = (text) => { try { write(text) } catch { /* no console */ } }
    stream.write = (chunk, encoding, callback) => {
      log.write('main', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'))
      try {
        return write(chunk, encoding, callback)
      } catch {
        // A packaged app on Windows can have no console behind stdout.
        return true
      }
    }
  }
  return raw
}
