// Import cookies from a browser installed on this machine — ego-lite's idea adapted to an app
// that is not its own Chromium: copy the profile's cookie files into a throwaway user-data-dir,
// launch the source browser's own binary on that copy and let IT decrypt; the app only reads
// plain cookies back over a debugging pipe. The real profile is never modified, and on Windows
// a running source holds its cookie store locked, so it has to close (and is restarted with its
// session) before the copy can happen. Firefox keeps cookies in plain sqlite, no launch needed.
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'

// Kinds we can harvest: Chromium-family through their own exe, Firefox through its plain db.
const KIND_ORDER = ['chrome', 'edge', 'brave', 'chromium', 'firefox']

// ------------------------------------------------------------------ installed binaries

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/

function kindOfExe(exePath) {
  const p = exePath.toLowerCase().replace(/\//g, '\\')
  const base = basename(p)
  if (base.startsWith('firefox')) return 'firefox'
  if (base === 'msedge.exe' || p.includes('microsoft edge') || p.includes('microsoft-edge')) return 'edge'
  if (p.includes('brave')) return 'brave'
  if (p.includes('chromium')) return 'chromium'
  if (p.includes('chrome')) return 'chrome'
  return null
}

async function exeVersion(exePath) {
  // The version-named folder next to the exe; `--version` would open a window in a running browser.
  try {
    const names = await readdir(dirname(exePath))
    return names.filter((n) => VERSION_DIR.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null
  } catch { return null }
}

function regQuery(key, view) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve', `/reg:${view}`], { encoding: 'buffer', windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const m = stdout.toString('utf8').match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)
      resolve(m ? m[1].replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : null)
    })
  })
}

function exeCandidates() {
  const home = homedir()
  if (platform() === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe',
      'Mozilla Firefox\\firefox.exe',
    ]
    return roots.flatMap((r) => rels.map((rel) => join(r, rel)))
  }
  if (platform() === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser', 'Chromium.app/Contents/MacOS/Chromium',
      'Firefox.app/Contents/MacOS/firefox',
    ]
    return ['/Applications', join(home, 'Applications')].flatMap((d) => apps.map((a) => join(d, a)))
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge',
    '/usr/bin/brave-browser', '/usr/bin/brave', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox',
  ]
}

/** → Map<kind, { exe, version }> of installed browsers. */
export async function findBrowserExes() {
  const candidates = exeCandidates()
  if (platform() === 'win32') {
    for (const exe of ['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe']) {
      for (const hive of ['HKLM', 'HKCU']) {
        for (const view of ['64', '32']) {
          const path = await regQuery(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, view)
          if (path) candidates.unshift(path)
        }
      }
    }
  }
  const found = new Map()
  for (const path of candidates) {
    const kind = kindOfExe(path)
    if (!kind || found.has(kind)) continue
    try {
      const real = await (await import('node:fs/promises')).realpath(path)
      if (existsSync(real)) found.set(kind, { exe: real, version: await exeVersion(real) })
    } catch { /* not installed */ }
  }
  return found
}

// ------------------------------------------------------------------ profile enumeration

function userDataRoots() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const home = homedir()
  if (platform() === 'win32') {
    return {
      chrome: [join(local, 'Google', 'Chrome', 'User Data')],
      edge: [join(local, 'Microsoft', 'Edge', 'User Data')],
      brave: [join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      chromium: [join(local, 'Chromium', 'User Data')],
      firefox: [join(roaming, 'Mozilla', 'Firefox')],
    }
  }
  if (platform() === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support')
    return {
      chrome: [join(appSupport, 'Google', 'Chrome')],
      edge: [join(appSupport, 'Microsoft Edge')],
      brave: [join(appSupport, 'BraveSoftware', 'Brave-Browser')],
      chromium: [join(appSupport, 'Chromium')],
      firefox: [join(appSupport, 'Firefox')],
    }
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return {
    chrome: [join(config, 'google-chrome'), join(config, 'google-chrome-beta')],
    edge: [join(config, 'microsoft-edge'), join(config, 'microsoft-edge-beta')],
    brave: [join(config, 'BraveSoftware', 'Brave-Browser')],
    chromium: [join(config, 'chromium')],
    firefox: [join(home, '.mozilla', 'firefox')],
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Chromium profiles under one user-data root: `info_cache` names + a scan for Network/Cookies. */
export async function chromiumProfiles(root) {
  const names = new Map()
  for (const [dir, info] of Object.entries(readJson(join(root, 'Local State'))?.profile?.info_cache ?? {})) {
    names.set(dir, info?.name || info?.gaia_name || dir)
  }
  let dirs = []
  try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const profiles = []
  for (const dir of dirs) {
    if (dir === 'System Profile' || dir === 'Guest Profile') continue
    const cookieDb = join(root, dir, 'Network', 'Cookies')
    const legacy = join(root, dir, 'Cookies')
    const hasCookies = existsSync(cookieDb) || existsSync(legacy)
    if (!hasCookies && !names.has(dir)) continue
    profiles.push({ dir, name: names.get(dir) ?? dir, cookieDb: existsSync(cookieDb) ? cookieDb : legacy, hasCookies })
  }
  profiles.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })))
  return profiles
}

/** Firefox profiles from profiles.ini (sections ProfileN with Path/IsRelative/Default). */
export async function firefoxProfiles(root) {
  let text
  try { text = await readFile(join(root, 'profiles.ini'), 'utf8') } catch { return [] }
  const profiles = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      if (current?.path) profiles.push(current)
      current = /^Profile\d+$/i.test(section[1]) ? { path: null, name: null, relative: true } : null
      continue
    }
    if (!current) continue
    const m = line.match(/^([^=]+)=(.*)$/)
    if (!m) continue
    const [, key, value] = m
    if (key === 'Path') current.path = value.trim()
    else if (key === 'Name') current.name = value.trim()
    else if (key === 'IsRelative') current.relative = value.trim() !== '0'
  }
  if (current?.path) profiles.push(current)
  return profiles
    .map((p) => {
      const dir = p.relative ? join(root, p.path) : p.path
      return { dir, path: dir, name: p.name ?? basename(dir), hasCookies: existsSync(join(dir, 'cookies.sqlite')) }
    })
    .filter((p) => p.hasCookies || p.name)
}

const BROWSER_NAME = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', chromium: 'Chromium', firefox: 'Firefox' }

/**
 * Every importable profile on this machine.
 * → [{ id, kind, label, engine:'chromium'|'firefox', profilePath, cookieDb, hasCookies, exe, exeVersion }]
 */
export async function listSources() {
  const exes = await findBrowserExes()
  const roots = userDataRoots()
  const sources = []
  for (const kind of KIND_ORDER) {
    const exe = exes.get(kind)
    // A Chromium profile without its browser cannot self-decrypt; Firefox's db is plain, so it can.
    if (!exe && kind !== 'firefox') continue
    for (const root of roots[kind] ?? []) {
      if (kind === 'firefox') {
        for (const p of await firefoxProfiles(root)) {
          if (!p.hasCookies) continue
          sources.push({
            id: `firefox:${p.path}`, kind, engine: 'firefox', name: BROWSER_NAME.firefox, label: `${BROWSER_NAME.firefox} — ${p.name}`,
            profilePath: p.path, cookieDb: join(p.path, 'cookies.sqlite'), hasCookies: true,
            exe: exe?.exe ?? null, exeVersion: exe?.version ?? null,
          })
        }
        continue
      }
      for (const p of await chromiumProfiles(root)) {
        if (!p.hasCookies) continue
        sources.push({
          id: `${kind}:${p.dir}`, kind, engine: 'chromium', name: BROWSER_NAME[kind], label: `${BROWSER_NAME[kind]} — ${p.name}`,
          profilePath: join(root, p.dir), cookieDb: p.cookieDb, hasCookies: p.hasCookies,
          exe: exe?.exe ?? null, exeVersion: exe?.version ?? null,
        })
      }
    }
  }
  return sources
}

// ------------------------------------------------------------------ the clone + harvest

const LOCKED = (error) => error?.code === 'EBUSY' || error?.code === 'EPERM'

/** Copy the files a harvest needs into workDir. Throws {code:'locked'} when the source is running. */
export async function cloneCookieStore(source, workDir) {
  const jobs = []
  if (source.engine === 'firefox') {
    for (const f of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) jobs.push({ from: join(source.profilePath, f), to: join(workDir, f), required: f === 'cookies.sqlite' })
  } else {
    // The OSCrypt key lives in Local State at the user-data root (the profile dir's parent).
    const root = dirname(source.profilePath)
    jobs.push({ from: join(root, 'Local State'), to: join(workDir, 'Local State'), required: true })
    const profile = basename(source.profilePath)
    for (const f of ['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm']) {
      jobs.push({ from: join(dirname(source.cookieDb), f), to: join(workDir, profile, 'Network', f), required: f === 'Cookies' })
    }
  }
  const copied = []
  for (const job of jobs) {
    try {
      mkdirSync(dirname(job.to), { recursive: true })
      await copyFile(job.from, job.to)
      copied.push(job.from)
    } catch (error) {
      if (LOCKED(error)) { const e = new Error('the source browser is running'); e.code = 'locked'; throw e }
      if (!job.required && error?.code === 'ENOENT') continue
      if (job.required) throw error
    }
  }
  return copied
}

/** A fresh throwaway dir for a clone; remove() deletes it. */
export async function cloneWorkDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-cookie-import-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }) }
}

const QUIET_ARGS = [
  '--headless', '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-breakpad',
]

/** Minimal pipe CDP: commands on fd 3, events on fd 4, JSON + NUL. */
function pipeConnection(child) {
  const writer = child.stdio[3]
  const reader = child.stdio[4]
  const pending = new Map()
  let nextId = 1
  let chunks = []
  reader.on('data', (buf) => {
    let start = 0
    for (;;) {
      const end = buf.indexOf(0, start)
      if (end === -1) { if (start < buf.length) chunks.push(buf.subarray(start)); break }
      chunks.push(buf.subarray(start, end))
      const text = Buffer.concat(chunks).toString('utf8')
      chunks = []
      start = end + 1
      if (!text) continue
      let msg
      try { msg = JSON.parse(text) } catch { continue }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; p.reject(e) }
        else p.resolve(msg.result)
      }
    }
  })
  const die = (reason) => {
    for (const p of pending.values()) { const e = new Error(`CDP pipe closed (${reason})`); e.code = 'PIPE_CLOSED'; p.reject(e) }
    pending.clear()
  }
  reader.on('close', () => die('pipe close'))
  child.once('exit', (code) => die(`exit ${code}`))
  return {
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        // Chrome's pipe transport frames messages with a trailing NUL.
        writer.write(`${JSON.stringify({ id, method, params })}\0`)
      })
    },
  }
}

/** Harvest a Chromium clone: the source's own exe decrypts its cookies for us. */
async function harvestChromium(source, workDir) {
  const child = spawn(source.exe, ['--remote-debugging-pipe', `--user-data-dir=${workDir}`, ...QUIET_ARGS, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const browser = pipeConnection(child)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    const { cookies } = await withTimeout(browser.send('Storage.getCookies'), 20_000, 'Storage.getCookies')
    return cookies.map(cdpCookie)
  } finally {
    browser.send('Browser.close').catch(() => {})
    const done = await Promise.race([exited, sleepMs(3000).then(() => 'timeout')])
    if (done === 'timeout') { try { child.kill('SIGKILL') } catch { /* gone */ } await Promise.race([exited, sleepMs(5000)]) }
  }
}

function cdpCookie(c) {
  const cookie = {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
  }
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') cookie.sameSite = c.sameSite
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) cookie.expires = c.expires
  if (c.partitionKey && typeof c.partitionKey === 'object' && typeof c.partitionKey.topLevelSite === 'string') {
    cookie.partitionKey = { topLevelSite: c.partitionKey.topLevelSite, hasCrossSiteAncestor: Boolean(c.partitionKey.hasCrossSiteAncestor) }
  }
  return cookie
}

/** Firefox: cookies.sqlite is plain — read the copied db directly. */
function harvestFirefox(workDir, now = Date.now() / 1000) {
  const db = new DatabaseSync(join(workDir, 'cookies.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT host, name, value, path, isHttpOnly, isSecure, expiry, sameSite, rawSameSite, originAttributes FROM moz_cookies').all()
    const cookies = []
    const skipped = []
    rows.forEach((row, index) => {
      if (row.expiry <= now) { skipped.push({ where: `entry ${index + 1}`, name: row.name, domain: row.host, code: 'expired', reason: 'already expired' }); return }
      // nsICookie: SAMESITE_UNSET 0, LAX 1, STRICT 2, NONE 3 (sameSite column, rawSameSite as fallback)
      const ss = { 1: 'Lax', 2: 'Strict', 3: 'None' }[row.sameSite ?? row.rawSameSite] ?? undefined
      const cookie = { name: row.name, value: row.value ?? '', domain: row.host, path: row.path || '/', secure: !!row.isSecure, httpOnly: !!row.isHttpOnly, expires: row.expiry }
      if (ss) cookie.sameSite = ss
      if (row.originAttributes && row.originAttributes !== '') {
        skipped.push({ where: `entry ${index + 1}`, name: row.name, domain: row.host, code: 'container', reason: `a Firefox container cookie (${row.originAttributes}); importing it flat would mix it into the default context` })
        return
      }
      cookies.push(cookie)
    })
    return { cookies, skipped }
  } finally { db.close() }
}

const withTimeout = (p, ms, label) => Promise.race([p, sleepMs(ms).then(() => { throw new Error(`${label} timed out`) })])
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Rows a Chromium clone can never have its browser decrypt: app-bound (v20) values only
 * decrypt in the profile's real user-data dir — launched on a copy, the browser gets a
 * temporary key error and drops them silently. Names and domains stay plain text; only
 * the value is locked. → { locked: skipped entries, readable } or null when unreadable.
 */
export function appBoundRows(dbPath) {
  let db
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return null }
  try {
    const rows = db.prepare('SELECT name, host_key AS domain, hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies').all()
    const locked = []
    let readable = 0
    rows.forEach((row, index) => {
      if (row.prefix === '763230') {
        locked.push({ where: `entry ${index + 1}`, name: row.name, domain: row.domain, code: 'app-bound', reason: 'locked by app-bound encryption — only the browser itself can read it' })
      } else readable += 1
    })
    return { locked, readable }
  } finally { db.close() }
}

/**
 * Cookies from one source profile. → { cookies, skipped } in the parser's normalized shape.
 * Throws {code:'locked'} when the source holds its store open (Windows), and
 * {code:'app-bound'} when every row is app-bound encrypted — there is nothing to harvest.
 */
export async function harvestCookies(source, workDir) {
  await cloneCookieStore(source, workDir)
  if (source.engine === 'firefox') return harvestFirefox(workDir)
  const census = appBoundRows(join(workDir, basename(source.profilePath), 'Network', 'Cookies'))
  if (census && census.readable === 0 && census.locked.length > 0) {
    const error = new Error(`${census.locked.length} cookies locked by app-bound encryption`)
    error.code = 'app-bound'
    throw error
  }
  return { cookies: await harvestChromium(source, workDir), skipped: census?.locked ?? [] }
}

/**
 * The whole live import: clone → (close the source on Windows when asked) → harvest → relaunch.
 * → { running: true } when the source must close first, { running: false, restarted, result }.
 */
export async function importFromBrowser(source, { close = false } = {}) {
  const work = await cloneWorkDir()
  let closed = false
  try {
    try {
      await cloneCookieStore(source, work.dir)
    } catch (error) {
      if (error?.code !== 'locked' || !close) {
        if (error?.code === 'locked') return { running: true }
        throw error
      }
      const pids = await closeBrowser(source.exe, source)
      closed = pids.length > 0
      await cloneCookieStore(source, work.dir) // still locked → throws 'locked' again
    }
    const result = await harvestCookies(source, work.dir)
    return { running: false, restarted: closed, result }
  } finally {
    if (closed) relaunchBrowser(source.exe, source.kind)
    await work.remove().catch(() => {})
  }
}

// ------------------------------------------------------------------ closing a running source (Windows)

const powershell = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr?.trim() || err.message))
    else resolve(stdout)
  })
})

/** Processes (pid + command line) of one exe, Windows only. */
export async function browserProcesses(exe) {
  const name = basename(exe)
  const out = await powershell(
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`)
  if (!out.trim()) return []
  const rows = JSON.parse(out)
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, commandLine: r.CommandLine ?? '' }))
}

const userDataDirOf = (commandLine) => {
  const m = String(commandLine).match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i)
  return m ? (m[1] ?? m[2]) : null
}

/**
 * Does this process hold the lock on the profile's user-data root? A Chromium instance binds
 * one user-data-dir: none given = the default root, which is where our sources live.
 */
export function locksProfile(process, source) {
  const dir = userDataDirOf(process.commandLine)
  if (dir === null) return true // standard invocation binds the standard root
  const norm = (p) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  // Browser command lines are compared as Windows paths (the only platform that closes a
  // source); win32 splits on both separators, so the check reads the same on every host.
  return norm(dir) === norm(win32.dirname(source.profilePath))
}

/** Ask a running source browser to quit (graceful; its session comes back on relaunch). */
export async function closeBrowser(exe, source) {
  if (platform() !== 'win32') return []
  const targets = (await browserProcesses(exe)).filter((p) => locksProfile(p, source))
  if (!targets.length) return []
  for (const p of targets) {
    await new Promise((resolve) => execFile('taskkill', ['/PID', String(p.pid)], { windowsHide: true }, () => resolve()))
  }
  const deadline = Date.now() + 20_000
  for (;;) {
    const alive = (await browserProcesses(exe)).filter((p) => targets.some((t) => t.pid === p.pid))
    if (!alive.length) return targets.map((t) => t.pid)
    if (Date.now() > deadline) { const e = new Error('the source browser did not close'); e.code = 'still-running'; throw e }
    await sleepMs(500)
  }
}

/** Reopen a browser we closed, with its previous session. */
export function relaunchBrowser(exe, kind) {
  const args = kind === 'firefox' ? [] : ['--restore-last-session']
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}
