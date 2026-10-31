// The first start: where the app keeps its data and the Bots' files (the default places, or the
// one folder picked from the start page), and whether it copies the Bot team of the user's own
// DSH. The answers are kept in the app's own data.
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findTeam, newerSessions, teamInUse, userDshHome } from './import.mjs'
import { installFolder } from './move-data.mjs'
import { langOf, t } from './start/text.mjs'

// The system dialogs speak the language of the start page (main.mjs gives it the same locale).
export const lang = () => langOf(app.getLocale())
export const tx = (key, vars) => t(lang(), key, vars)

const PROFILE_NAMES = { desktop: 'DSH Desktop', web: 'DSH Web' }
const locationsFile = () => join(app.getPath('userData'), 'locations.json')

// A quit request while a first-run dialog is open stops the first run right after that dialog.
class Quit extends Error {}

// The dialogs belong to `ui.owner()` (the start window); `ui.asking` holds the start's clock while
// the user answers.
async function ask(options, signal, ui) {
  const { response } = await ui.asking(dialog.showMessageBox(ui.owner(), { title: 'DeepSeek Bot', noLink: true, ...options, signal }))
  // A quit that arrived while a synchronous macOS box was open gets to run first.
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return response
}

async function pick(title, from, signal, ui) {
  const { canceled, filePaths } = await ui.asking(dialog.showOpenDialog(ui.owner(), { title, defaultPath: existsSync(from) ? from : dirname(from), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] }))
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return canceled ? undefined : filePaths[0]
}

export const programFolder = () => installFolder(app.getPath('exe'))

/**
 * The system picker of 「换个位置…」 on the start page: one folder, from which the root rule
 * (place.mjs) makes the places. Undefined when the box was cancelled or the app is quitting.
 * @param {string} from the folder the picker opens in
 */
export async function pickRoot(from, signal, ui) {
  try {
    return await pick(tx('dialog.pickRoot'), from, signal, ui)
  } catch (error) {
    if (error instanceof Quit) return undefined
    throw error
  }
}

/** The places a first start offers. */
export const defaultPlaces = () => ({ dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DeepSeek Bot') })

/** The Bot team in a data folder, if it has one. */
export function teamIn(dataDir) {
  try {
    return findTeam(dataDir)
  } catch {
    return undefined
  }
}

/**
 * What the start window can say before the first-run questions: the team that a reinstall keeps,
 * or whether the user's own DSH has a team to offer.
 */
export function teamsAt(dataDir = defaultPlaces().dataDir) {
  const team = teamIn(dataDir)
  return { team, offered: team === undefined && teamIn(userDshHome()) !== undefined }
}

/** @returns {Promise<{ offered: boolean, import?: { from: string, profile?: string }, quit?: true }>} */
async function offerImport(dataDir, signal, ui) {
  const from = userDshHome()
  let found
  try {
    found = teamIn(dataDir) === undefined ? findTeam(from) : undefined
  } catch (error) {
    console.error(error)
  }
  if (found === undefined) return { offered: false }
  if (await ask({ type: 'question', message: tx('dialog.import.found', { bots: found.bots, groups: found.rooms }), detail: tx('dialog.import.foundDetail', { home: from }), buttons: [tx('btn.copy'), tx('btn.skipCopy')], defaultId: 0, cancelId: 1 }, signal, ui) === 1) return { offered: true }
  while (teamInUse(from)) {
    if (await ask({ type: 'warning', message: tx('dialog.import.inUse'), buttons: [tx('btn.retry'), tx('btn.skipCopy')], defaultId: 0, cancelId: 1 }, signal, ui) === 1) return { offered: true }
  }
  const newer = newerSessions(from, found.team)
  if (newer.length > 0) {
    if (await ask({ type: 'warning', message: tx('dialog.import.newer', { n: newer.length }), buttons: [tx('btn.quit'), tx('btn.startWithout')], defaultId: 0, cancelId: 0 }, signal, ui) === 0) return { offered: true, quit: true }
    return { offered: true }
  }
  const { profiles } = found
  const profile = profiles.length < 2 ? profiles[0]?.name
    : profiles[await ask({ type: 'question', message: tx('dialog.import.whichModels'), buttons: profiles.map(entry => PROFILE_NAMES[entry.name] ?? entry.name), defaultId: 0, cancelId: 0 }, signal, ui)].name
  return { offered: true, import: { from, profile } }
}

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Where the app keeps its data and the Bots' files: the saved places, or at the first start the
 * default ones without a question (the start page says where the data goes and offers
 * 「换个位置…」; windows-onboarding §3). The offer to copy a team is still a dialog that belongs
 * to `ui.owner()`. A run on throwaway folders (DS_BOT_HOME, for development and tests) asks
 * nothing and copies nothing. `offered` says whether the first run offered to copy a team.
 * @param {AbortSignal} signal
 * @param {{ owner: () => import('electron').BrowserWindow | undefined, asking: <T>(answer: Promise<T>) => Promise<T> }} ui
 * @returns {Promise<{ dataDir: string, workspace?: string, import?: { from: string, profile?: string }, offered?: boolean, quit?: true }>}
 */
export async function chooseLocations(signal, ui) {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace }
  }
  const { dataDir, workspace } = defaultPlaces()
  let offered
  try {
    const offer = await offerImport(dataDir, signal, ui)
    if (offer.quit) return { quit: true }
    if (offer.import !== undefined) return { dataDir, workspace, import: offer.import, offered: true }
    offered = offer.offered
  } catch (error) {
    if (error instanceof Quit) return { quit: true }
    throw error
  }
  // There is nothing to copy, so the first run ends with the chosen places.
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace, offered }
}
