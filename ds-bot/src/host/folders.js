// Working folders: where a Bot's Sessions run. A group's folder holds for every member
// there, else a Bot works in its own folder, else in the team workspace. A Session's
// folder is fixed when it is made, so a change moves the conversation on to a fresh
// part (parts.js).
import { mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { unquote } from './text.js'

const PICK_TIMEOUT_MS = 10 * 60_000

export const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)

// Read as DSH reads it, so the team's data and the guarded folder are where DSH keeps
// its own: a blank value counts as unset.
export const dshHomeOf = value => resolve(expandHome(value?.trim() ? value : join(homedir(), '.dsh')))

export function install(rt) {
  const { ctx, state } = rt

  const teamFolder = () => ctx.workspaceRegistry.get?.(state.workspaceId)?.path
  // The desktop app names the folder the user chose for the Bots' files.
  const defaultTeamFolder = () => rt.config.workspace ?? (process.env.DS_BOT_WORKSPACE?.trim() || join(rt.home, 'workspace'))
  const workDirOf = ({ botId, roomId } = {}) => rt.roomOf(roomId)?.workDir ?? rt.botOf(botId)?.workDir
  const isFolder = path => stat(path).then(info => info.isDirectory(), () => false)
  const real = path => realpath(path).catch(() => resolve(path))
  // The real path of the deepest part that exists, with the rest after it.
  const realBeyond = async (path) => {
    const rest = []
    for (let at = path; ; at = dirname(at)) {
      const found = await realpath(at).catch(() => undefined)
      if (found !== undefined) return join(found, ...rest)
      if (dirname(at) === at) return path
      rest.unshift(basename(at))
    }
  }
  // The registry keeps the team workspace as it was given; folders compare as real paths.
  const realTeam = async () => {
    const team = teamFolder()
    return team === undefined ? undefined : real(team)
  }
  // Where `input` leads from `base`, as a real path, the way DSH's working_directory resolves
  // a change; undefined when nothing is there.
  const folderAt = (base, input) => realpath(resolve(base, input)).catch(() => undefined)
  // Where a Session works: the folder DSH has for it, else the one DS Bot made it for.
  const sessionFolder = (session) => {
    const reported = session?.header === undefined ? undefined : ctx.get?.('workingDirectory')?.get?.(session) ?? session.header.cwd
    if (reported !== undefined) return reported
    const id = session?.id
    return workDirOf({ botId: rt.selfOf?.(id), roomId: rt.groupOwners?.get(id)?.roomId }) ?? teamFolder()
  }

  // The desktop app runs its own DSH and names the user's, which Bots must not write either.
  const dataRoots = () => [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)

  // A Bot that could write where DSH or the team keeps its data could change its own
  // permissions or the team, so neither those folders nor one that holds them is allowed.
  // The workspace exception covers only a workspace lying inside the data root (the
  // plugin's default does): one that holds or is a data root does not open it up.
  async function guarded(path) {
    const team = await realTeam()
    for (const root of dataRoots()) {
      const data = await real(root)
      if (within(data, path)) return true
      if (within(path, data) && !(team !== undefined && within(path, team) && team !== data && within(team, data))) return true
    }
    return false
  }

  // A file a Bot names to read into the team, such as a photo, may not come from DSH's or
  // the team's data; the team workspace, which can lie in it, is the exception, for the
  // same reason as in guarded().
  async function inData(path) {
    const team = await realTeam()
    for (const root of dataRoots()) {
      const data = await real(root)
      if (within(path, data) && !(team !== undefined && within(path, team) && team !== data && within(team, data))) return true
    }
    return false
  }

  // Saved as the real path, which is what a Session's cwd shows. Undefined means the
  // team workspace.
  async function cleanWorkDir(input) {
    const text = unquote(input)
    if (text === '') return undefined
    const expanded = expandHome(text)
    if (!isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`)
    let path
    try {
      path = await realpath(expanded)
    } catch {
      throw new Error(`There is no folder at ${text}`)
    }
    if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`)
    return workFolder(path)
  }

  // A folder, as a real path, as a working folder: undefined for the team workspace.
  async function workFolder(path) {
    if (await guarded(path)) throw new Error(`${path} holds DeepSeek Harness data, so Bots cannot work there`)
    return path === await realTeam() ? undefined : path
  }

  // The user moves the team workspace. Bots and groups without a folder of their own move on
  // to a fresh part there at their next turn, as for any other change of folder; the old
  // folder and its files stay as they are.
  async function setTeamWorkspace(input) {
    const text = unquote(input)
    const expanded = expandHome(text)
    if (text === '' || !isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`)
    // The plugin's own default lies in DSH's data, and going back to it stays possible: that
    // folder itself, not where a link put in its place leads.
    const fallback = resolve(defaultTeamFolder())
    const own = join(await realBeyond(dirname(fallback)), basename(fallback))
    const holdsData = async (path) => {
      const roots = await Promise.all(dataRoots().map(real))
      if (roots.some(data => within(data, path))) return true
      if (path === own && await realBeyond(fallback) === own) return false
      return roots.some(data => within(path, data))
    }
    // A folder to be made counts where it would be made: a link above it can lead into the data.
    if (await holdsData(await realBeyond(resolve(expanded)))) throw new Error(`${text} holds DeepSeek Harness data, so it cannot be the team workspace`)
    await mkdir(expanded, { recursive: true })
    const path = await realpath(expanded)
    if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`)
    if (await holdsData(path)) throw new Error(`${text} holds DeepSeek Harness data, so it cannot be the team workspace`)
    if (path === await realTeam()) return path
    const clash = await rt.privateClash(path)
    if (clash) throw new Error(`${text} is in or around the folder of ${clash.name}, a private Bot, so it cannot be the team workspace`)
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'DS Bot')
    state.workspaceId = workspace.id
    await rt.save()
    return path
  }

  // Every Session of a Bot: its own chat and its conversation in each of its groups.
  const sessionsOfBot = botId => [rt.chatOf(botId), ...Object.values(state.rooms)
    .filter(room => room.members.includes(botId)).map(room => room.sessions?.[botId])].filter(Boolean)

  // A folder outside the team workspace widens where a Bot may write, so a Bot that
  // sets one for Bots whose writes are bounded by their folder asks the user first.
  // `sessions` are the Sessions that would work there; the default policy counts too,
  // since the Sessions made there later start under it. Throws when it is not allowed.
  async function approveFolder(exec, { path, sessions = [], who }) {
    const team = await realTeam()
    const policy = ctx.get?.('sandboxPolicy')
    if (path === undefined || (team !== undefined && within(path, team))) return
    if (policy !== undefined) {
      const agents = await Promise.all(sessions.map(id => rt.resolveAgent(id)))
      const modes = [policy.resolve(), ...agents.map(agent => policy.resolve({ session: agent.session }))].map(entry => entry.mode)
      if (!modes.includes('workspace-write')) return
    }
    // With no policy service a Session's bounds cannot be checked, so a folder outside
    // the workspace asks like a bounded one would; when nobody can be asked it throws.
    const approval = ctx.get?.('approval')
    const agent = exec.agent
    if (approval === undefined || agent?.session === undefined) throw new Error(`Working in ${path} needs the user's approval, and there is no way to ask for it here, so nothing changed. The user can make this change in the settings.`)
    const outcome = await approval.request({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: `Let ${who.en} work in ${path}? Files there can then be changed.`,
      displayReason: { en: `Let ${who.en} work in ${path}? Files there can then be changed.`, zh: `允许${who.zh}在 ${path} 中工作吗？之后可以修改这个文件夹里的文件。` },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome === 'allowed-once') return
    // An approval policy that never asks answers 'rejected' as well.
    throw new Error(outcome === 'rejected' ? `Working in ${path} was not allowed, so nothing changed. The user can make this change in the settings.`
      : outcome === 'cancelled' ? 'The approval was cancelled, so nothing changed.'
        : `Working in ${path} needs the user's approval, and no one could answer, so nothing changed. The user can make this change in the settings.`)
  }

  const picker = () => {
    try {
      return ctx.get?.('directoryPicker')?.capability()
    } catch {
      return undefined
    }
  }

  async function folderEndpoint(endpoint, body, signal) {
    switch (endpoint) {
      case 'folders': {
        // A copied team has its workspace registered at its first turn; until then it is the default.
        const team = teamFolder() ?? resolve(defaultTeamFolder())
        const known = new Map()
        for (const workspace of ctx.workspaceRegistry.list?.() ?? []) {
          if (workspace.path !== team) known.set(workspace.path, workspace.title)
        }
        for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms)]) {
          if (entry.workDir && !known.has(entry.workDir)) known.set(entry.workDir, basename(entry.workDir) || entry.workDir)
        }
        const present = await Promise.all([...known].map(async ([path, title]) => (await isFolder(path) ? { path, title } : undefined)))
        const kind = picker()?.kind
        return {
          team,
          picker: kind === 'native' || kind === 'browse' ? kind : null,
          folders: present.filter(Boolean),
        }
      }
      case 'folder-pick': {
        const native = picker()
        if (native?.kind !== 'native') throw new Error('This DeepSeek Harness has no folder chooser')
        return await native.pick(AbortSignal.any([signal, AbortSignal.timeout(PICK_TIMEOUT_MS)].filter(Boolean)))
      }
      case 'folder-list': {
        const browse = picker()
        if (browse?.kind !== 'browse') throw new Error('This DeepSeek Harness cannot list folders')
        const listing = await browse.list(typeof body.path === 'string' && body.path !== '' ? body.path : undefined, signal)
        return { path: listing.path, home: listing.home, crumbs: listing.crumbs, entries: listing.entries, truncated: listing.truncated }
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, { teamFolder, defaultTeamFolder, workDirOf, sessionFolder, isFolder, real, realBeyond, folderAt, cleanWorkDir, workFolder, inData, setTeamWorkspace, sessionsOfBot, approveFolder, folderEndpoint })
}
