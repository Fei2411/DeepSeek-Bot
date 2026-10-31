// Where a first start puts the data: the line on the start page that says so, and the root rule
// of 「换个位置…」 (windows-onboarding §3, 一个位置; start-window §6). No Electron here, so the
// tests run without it.
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { real, within } from './copy-tree.mjs'

export const DATA_DIR = 'data'
export const WORKSPACE_DIR = 'workspace'
// The layer the app adds inside a drive or a folder that is someone else's.
export const LAYER = 'DeepSeek Bot'

/** Free bytes on the volume that holds `path`, measured at its nearest existing ancestor. */
export function freeSpace(path) {
  let at = resolve(path)
  for (;;) {
    if (existsSync(at)) {
      try {
        const stats = statfsSync(at)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch {
        return undefined
      }
    }
    const up = dirname(at)
    if (up === at) return undefined
    at = up
  }
}

/** Bytes as the page shows them, in Explorer's units of 1024: whole GB from 10 up, else one decimal. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  const gb = bytes / 2 ** 30
  if (gb >= 10) return `${String(Math.floor(gb))} GB`
  if (gb >= 1) return `${(Math.floor(gb * 10) / 10).toFixed(1)} GB`
  return `${String(Math.floor(bytes / 2 ** 20))} MB`
}

/** The drive letter of a Windows path ('C'), or undefined. */
export function driveOf(path) {
  const match = /^([A-Za-z]):[\\/]/u.exec(resolve(path))
  return match ? match[1].toUpperCase() : undefined
}

/** A path with the home folder written as ~, for the page. */
export function shortPath(path, home = homedir()) {
  const full = resolve(path)
  const base = resolve(home)
  if (full === base) return '~'
  return within(full, base) ? `~${sep}${full.slice(base.length).replace(/^[\\/]+/u, '')}` : full
}

/**
 * What the start page says about the place of the data: the drive and its free space on
 * Windows, the folder elsewhere.
 * @param {{ home?: string, free?: number }} what `free` from freeSpace(); none leaves it out
 * @returns {{ drive?: string, path?: string, free?: string }}
 */
export function placeOf(dataDir, { home = homedir(), free } = {}) {
  const drive = driveOf(dataDir)
  const place = drive === undefined ? { path: shortPath(dataDir, home) } : { drive }
  const text = formatBytes(free)
  return text === undefined ? place : { ...place, free: text }
}

/** The root R of places made by the root rule (R\data beside R\workspace); the default places have none. */
export function currentRootOf(dataDir, workspace) {
  if (typeof dataDir !== 'string' || typeof workspace !== 'string') return undefined
  const root = dirname(resolve(dataDir))
  if (basename(resolve(dataDir)) !== DATA_DIR || basename(resolve(workspace)) !== WORKSPACE_DIR || dirname(resolve(workspace)) !== root) return undefined
  return root
}

/** The picker starts from the current data folder's parent (windows-onboarding §3). */
export const pickFrom = dataDir => dirname(resolve(dataDir))

/** A folder with nothing but empty folders in it. */
export function isEmptyTree(folder) {
  try {
    if (!statSync(folder).isDirectory()) return false
    return readdirSync(folder).every(name => isEmptyTree(join(folder, name)))
  } catch {
    return false
  }
}

// A folder that holds nothing but what the app itself puts into an empty root (the two
// folders of a start that never got further).
const ownEmpty = folder => readdirSync(folder).every(name => [DATA_DIR, WORKSPACE_DIR].includes(name) && isEmptyTree(join(folder, name)))

// OneDrive's folders: the roots it names in the environment, a folder called OneDrive or
// 「OneDrive - <organisation>」, and macOS's Library/CloudStorage/OneDrive-<name>. A folder that
// only has OneDrive in its name (OneDrive-old) is not the cloud.
function inOneDrive(path, env) {
  const roots = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map(name => env[name]).filter(value => typeof value === 'string' && value !== '')
  if (roots.some(root => within(path, root))) return true
  const parts = path.split(/[\\/]/u)
  return parts.some((part, k) => part === 'OneDrive' || part.startsWith('OneDrive - ') || (parts[k - 1] === 'CloudStorage' && part.startsWith('OneDrive-')))
}

const sameFolder = (a, b) => within(a, b) && within(b, a)

/**
 * The root R that a picked folder gives (windows-onboarding §3, 一个位置): the folder itself
 * when it is new, empty, or an empty root of the app's own; otherwise `DeepSeek Bot` inside it,
 * as inside a drive. The data goes to R\data and the Bots' files to R\workspace.
 * @param {string} picked
 * @param {{ dshHome?: string, program?: string, env?: NodeJS.ProcessEnv, probe?: boolean, current?: { dataDir: string, workspace?: string } }} where
 *   `probe` writes a file into R\data to see that the place can be written (default true);
 *   `current` names the places the data is in now
 * @returns {{ same: true } | { root: string, dataDir: string, workspace: string, added: boolean, reason?: 'permission' | 'onedrive' | 'foreign' | 'nested' | 'dsh' | 'program', at?: string }}
 *   `same`: the place the data is in now was picked, which is no change; `reason` says why R
 *   cannot be used, with the path `at` that the card names
 */
export function rootOf(picked, { dshHome, program, env = process.env, probe = true, current } = {}) {
  const chosen = resolve(picked)
  const places = root => ({ root, dataDir: join(root, DATA_DIR), workspace: join(root, WORKSPACE_DIR) })
  try {
    // The places the data is in now: the data folder, and the team workspace once something
    // is in it (an empty one, just made, can become the new root, as a pick of the home folder
    // proposes with the default places).
    const data = typeof current?.dataDir === 'string' ? real(current.dataDir) : undefined
    const workspace = typeof current?.workspace === 'string' && existsSync(current.workspace) && !isEmptyTree(current.workspace) ? real(current.workspace) : undefined
    const now = [data, workspace].filter(path => path !== undefined)
    const nowRoot = currentRootOf(current?.dataDir, current?.workspace)
    const physicalChosen = real(chosen)
    if ([data, nowRoot === undefined ? undefined : real(nowRoot)].some(path => path !== undefined && sameFolder(physicalChosen, path))) return { same: true }
    if (now.some(path => within(physicalChosen, path))) return { ...places(chosen), added: false, reason: 'nested', at: chosen }
    const isDrive = parse(chosen).root === chosen
    let root = chosen
    let added = false
    if (isDrive) {
      root = join(chosen, LAYER)
      added = true
    } else if (existsSync(chosen)) {
      if (!statSync(chosen).isDirectory()) return { ...places(root), added, reason: 'foreign', at: chosen }
      if (readdirSync(chosen).length > 0 && !ownEmpty(chosen)) {
        root = join(chosen, LAYER)
        added = true
      }
    }
    const result = { ...places(root), added }
    const reject = (reason, at = root) => ({ ...result, reason, at })
    // An added layer that is already someone else's folder cannot be used either.
    if (added && existsSync(root) && (!statSync(root).isDirectory() || (readdirSync(root).length > 0 && !ownEmpty(root)))) return reject('foreign')
    // The checks look through links and junctions at the folder as the file system has it.
    const physical = real(root)
    if (now.some(path => within(physical, path) || within(path, physical))) return reject('nested', chosen)
    if (inOneDrive(physical, env)) return reject('onedrive', chosen)
    if (dshHome !== undefined && existsSync(dshHome)) {
      const dsh = real(dshHome)
      if (within(physical, dsh) || within(dsh, physical)) return reject('dsh', chosen)
    }
    if (program !== undefined && within(physical, real(program))) return reject('program', chosen)
    if (probe && !canWrite(result.dataDir)) return reject('permission', chosen)
    return result
  } catch {
    // A folder that cannot be read (another user's, the system's) cannot be written either.
    return { ...places(chosen), added: false, reason: 'permission', at: chosen }
  }
}

// Makes only the missing layers, writes and removes a file, and removes what it made.
function canWrite(folder) {
  const made = []
  try {
    for (let at = resolve(folder); !existsSync(at); at = dirname(at)) {
      made.unshift(at)
      if (dirname(at) === at) break
    }
    mkdirSync(folder, { recursive: true })
    const file = join(folder, '.ds-bot-write-check')
    writeFileSync(file, '')
    rmSync(file)
    return true
  } catch {
    return false
  } finally {
    for (const at of [...made].reverse()) { try { rmdirSync(at) } catch { /* not empty: left as it is */ } }
  }
}
