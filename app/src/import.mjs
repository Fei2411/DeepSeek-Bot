// The first-run import: a copy of the Bot team in the user's own DSH home. It only reads there.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { parse, stringify } from 'yaml'
import { copyTree, within } from './copy-tree.mjs'

export { within }

// The rows of a profile patch that hold model settings: DeepSeek's API and account, other
// providers, the default model and the agent presets. Rows of other plugins may name plugins
// that the app does not have.
export const MODEL_ROWS = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model', 'agent-preset-registry']
// The team's lock, its turns in flight and its workspace belong to the old home.
const LEFT_BEHIND = new Set(['state.lock', 'inflight.json', 'workspace'])
const LOCK_STALE_MS = 60_000

/** The DSH home of the user's own DSH, read as DSH reads DSH_HOME. */
export function userDshHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  return resolve(value === '~' ? homedir() : /^~[\\/]/u.test(value) ? join(homedir(), value.slice(2)) : value)
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Every Session the team names: each Bot's and group's parts, the group conversations and each group's own Session. */
export function sessionIdsOf(team) {
  const ids = segments => segments.map(part => part?.sessionId)
  return [...new Set([
    ...Object.values(team.bots ?? {}).flatMap(bot => [bot.id, bot.sessionId, ...ids(bot.segments ?? [])]),
    // A group keeps the earlier parts per member: { [botId]: segments }. The group's own
    // Session, the one it relays in, has the group's id.
    ...Object.values(team.rooms ?? {}).flatMap(room => [room.id, ...Object.values(room.sessions ?? {}), ...ids(Object.values(room.segments ?? {}).flat())]),
  ].filter(id => typeof id === 'string' && id !== ''))]
}

/**
 * The team in a DSH home, with the profiles that hold model settings.
 * @returns {{ from: string, team: any, bots: number, rooms: number, profiles: { name: string, rows: any[] }[] } | undefined}
 */
export function findTeam(from) {
  const statePath = join(from, 'bot', 'state.json')
  if (!existsSync(statePath)) return undefined
  const team = readJson(statePath)
  const bots = Object.keys(team.bots ?? {}).length
  if (bots === 0) return undefined
  return { from, team, bots, rooms: Object.keys(team.rooms ?? {}).length, profiles: modelProfiles(from) }
}

function modelProfiles(from) {
  const dir = join(from, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap((entry) => {
    const file = join(dir, entry.name, 'cordis.patch.yml')
    if (!existsSync(file)) return []
    let patch
    try {
      patch = parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // An unreadable profile has no model settings to copy; the team is still there.
      console.warn(`DeepSeek Bot: skipped the model settings in ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const rows = Array.isArray(patch) ? patch.filter(row => MODEL_ROWS.includes(row?.id)) : []
    return rows.length > 0 ? [{ name: entry.name, rows }] : []
  })
}

/**
 * Whether a running DSH holds the team, by the rule of ds-bot's own lock (src/host/home-lock.js):
 * the holder bumps the lock's mtime, so a stale lock is a holder that is gone, even when its pid
 * now belongs to another process.
 */
export function teamInUse(from, { host = hostname(), now = Date.now(), isAlive = pidAlive } = {}) {
  const path = join(from, 'bot', 'state.lock')
  const lock = statSync(path, { throwIfNoEntry: false })
  if (lock === undefined || now - lock.mtimeMs >= LOCK_STALE_MS) return false
  let holder
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Being written right now.
    return true
  }
  return holder?.host !== host || isAlive(holder.pid)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

// sessions/<group>/<id>/: the group is the folder the Session works in.
function sessionDirs(from, ids) {
  const root = join(from, 'sessions')
  const groups = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
  const found = []
  const missing = []
  for (const id of ids) {
    const group = groups.find(name => existsSync(join(root, name, id)))
    if (group === undefined) missing.push(id)
    else found.push({ id, group })
  }
  return { found, missing }
}

async function copySessionDirs(from, to, sessions, signal) {
  for (const { id, group } of sessions) {
    signal?.throwIfAborted()
    await cp(join(from, 'sessions', group, id), join(to, 'sessions', group, id), { recursive: true })
  }
}

/**
 * Copy the team's Sessions into the DSH home `to`, as they lie in `from`; an abort stops it between Sessions.
 * @param {string} from @param {any} team @param {string} to @param {AbortSignal} [signal]
 * @returns {Promise<string[]>} their ids
 */
export async function copySessions(from, team, to, signal) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  await copySessionDirs(from, to, found, signal)
  return found.map(({ id }) => id)
}

const logVersion = name => parseSessionFormatLogFilename(name.replace(/\.(zstd|zst|gz|br)$/u, ''))

/** The Sessions whose log is in a newer format than the pinned DSH reads. */
export function newerSessions(from, team) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  return found.filter(({ id, group }) => readdirSync(join(from, 'sessions', group, id))
    .some(name => (logVersion(name) ?? 0) > sessionFormatCatalog.currentVersion)).map(({ id }) => id)
}

// The Host's first start on the data location writes a .credentials.yaml of its own: the browser
// session grant of the connection plugin, under client-connection/. A file with nothing else in
// it holds no key of the user's.
async function onlyHostRecords(file) {
  let document
  try {
    document = parse(await readFile(file, 'utf8')) ?? {}
  } catch {
    // A file that does not read as DSH's is the user's to fix, not ours to replace.
    return false
  }
  if (typeof document !== 'object' || Array.isArray(document)) return false
  const { version, refs, records, ...other } = document
  return (version === undefined || version === 1) && Object.keys(other).length === 0
    && Object.keys(refs ?? {}).length === 0
    && Object.keys(records ?? {}).every(key => key.startsWith('client-connection/'))
}

// A key file the data location has already is the user's own, saved there since, and stays;
// a .credentials.yaml that only the Host wrote is not.
// Returns 'copied', 'kept', or undefined when the old home has none.
async function copyKey(from, to, name) {
  const source = join(from, name)
  if (!existsSync(source)) return undefined
  const target = join(to, name)
  const replace = name === '.credentials.yaml' && existsSync(target) && await onlyHostRecords(target)
  try {
    await cp(source, target, { force: replace, errorOnExist: !replace })
  } catch (error) {
    if (error?.code === 'ERR_FS_CP_EEXIST') return 'kept'
    throw error
  }
  if (process.platform !== 'win32') await chmod(target, 0o600)
  return 'copied'
}

async function writeModelRows(to, rows) {
  const file = join(to, 'profiles', 'ds-bot', 'cordis.patch.yml')
  const current = existsSync(file) ? parse(await readFile(file, 'utf8')) : undefined
  const ids = new Set(rows.map(row => row.id))
  const kept = Array.isArray(current) ? current.filter(row => !ids.has(row?.id)) : []
  await mkdir(join(to, 'profiles', 'ds-bot'), { recursive: true })
  await writeFile(file, stringify([...kept, ...rows]))
}

/**
 * Copy the team of `from` into the data location `to`, which the Host has started on once,
 * so that DSH does not take the copied Sessions' folders for its own projects. The old team's
 * workspace files go into `workspace`, without replacing a file that is there, and the key
 * files only where the data location has none of the user's own.
 * Everything but the keys, the model settings and the workspace files is put together in a
 * folder beside the data and moved in at the end. A copy that stops or fails removes that
 * folder; one that was killed leaves it behind, and the next copy removes it.
 * @param {{ from: string, to: string, workspace: string, profile?: string, dsh?: string, signal?: AbortSignal }} options
 */
export async function importTeam({ from, to, workspace, profile, dsh, signal }) {
  const found = findTeam(from)
  if (found === undefined) throw new Error(`There is no Bot team in ${from}`)
  const present = existsSync(join(to, 'bot', 'state.json')) ? readJson(join(to, 'bot', 'state.json')) : undefined
  if (Object.keys(present?.bots ?? {}).length > 0) throw new Error(`${to} already has a Bot team`)
  for (const name of (existsSync(to) ? readdirSync(to) : []).filter(entry => /^\.import-\d+$/u.test(entry))) {
    await rm(join(to, name), { recursive: true, force: true })
  }
  const stage = join(to, `.import-${String(Date.now())}`)
  try {
    return await copyThroughStage({ found, from, to, workspace, profile, dsh, signal, stage })
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

async function copyThroughStage({ found, from, to, workspace, profile, dsh, signal, stage }) {
  const oldBot = join(from, 'bot')
  signal?.throwIfAborted()
  await cp(oldBot, join(stage, 'bot'), { recursive: true, filter: path => !LEFT_BEHIND.has(relative(oldBot, path).split(/[\\/]/u)[0]) })
  const team = readJson(join(stage, 'bot', 'state.json'))
  // The new data location registers its own team workspace. A DSH Agent's Sessions do not move
  // to a fresh part, so they would go on working in the old team folder in the user's DSH home.
  delete team.workspaceId
  team.agents = {}
  await writeFile(join(stage, 'bot', 'state.json'), JSON.stringify(team, null, 2))
  const { found: sessions, missing } = sessionDirs(from, sessionIdsOf(found.team))
  signal?.throwIfAborted()
  await copySessionDirs(from, stage, sessions, signal)
  signal?.throwIfAborted()
  if (existsSync(join(from, 'attachments'))) await cp(join(from, 'attachments'), join(stage, 'attachments'), { recursive: true })

  signal?.throwIfAborted()
  await mkdir(workspace, { recursive: true })
  if (existsSync(join(oldBot, 'workspace'))) {
    // Bots that ran npm or pnpm there leave links, some of them to nothing.
    const skipped = await copyTree(join(oldBot, 'workspace'), workspace, { force: false, skip: true, signal })
    if (skipped.length > 0) console.warn('DeepSeek Bot: the import skipped what it could not read in the old team workspace:', skipped)
  }
  signal?.throwIfAborted()
  const keys = []
  const keptKeys = []
  for (const name of ['.credentials.yaml', '.env']) {
    const done = await copyKey(from, to, name)
    if (done === 'copied') keys.push(name)
    if (done === 'kept') keptKeys.push(name)
  }
  if (keptKeys.length > 0) console.warn(`DeepSeek Bot: the import kept the ${keptKeys.join(' and ')} that the data location has`)
  const rows = found.profiles.find(entry => entry.name === profile)?.rows ?? []
  if (rows.length > 0) await writeModelRows(to, rows)

  for (const { id, group } of sessions) {
    signal?.throwIfAborted()
    await mkdir(join(to, 'sessions', group), { recursive: true })
    // A copy that stopped can have moved the Session in already.
    await rm(join(to, 'sessions', group, id), { recursive: true, force: true })
    await rename(join(stage, 'sessions', group, id), join(to, 'sessions', group, id))
  }
  signal?.throwIfAborted()
  if (existsSync(join(stage, 'attachments'))) await cp(join(stage, 'attachments'), join(to, 'attachments'), { recursive: true, force: false })
  const summary = {
    from, at: new Date().toISOString(), ...(dsh ? { dsh } : {}),
    bots: found.bots, rooms: found.rooms, sessions: sessions.length, missingSessions: missing,
    keys, keptKeys, modelSettings: rows.length > 0 ? profile : null,
  }
  signal?.throwIfAborted()
  await writeFile(join(stage, 'bot', 'imported.json'), `${JSON.stringify(summary, null, 2)}\n`)
  // Until this rename the data has no Bot team, so a copy that stopped can run again.
  await rm(join(to, 'bot'), { recursive: true, force: true })
  await rename(join(stage, 'bot'), join(to, 'bot'))
  return summary
}
