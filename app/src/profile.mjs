// The app's own DSH profile: its name, its bundles and its installation.
import { fileURLToPath } from 'node:url'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

export const PROFILE = 'ds-bot'
// DSH's shared core, DSH's web front end (the window) and voice input, then the Bot team.
// Bundles the user installs follow.
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'ds-bot']
// The first-run check reads a copy of the team's chats without the Bot team running on them.
// DSH reads a log the same way whatever the profile mounts.
export const CHECK_PROFILE = 'import-check'
export const CHECK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
// Bundles that earlier builds of the app put in its profile: the engine layer of its own window (../engine).
const RETIRED_BUNDLES = ['deepseek-bot-engine']
// The app's own manifest is the installation: DSH imports plugins only from the installation's dependency
// graph, resolves bundles there first, and keeps the bundles it names as direct dependencies from removal.
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Put the app's bundles at the head of a profile's bundle list and keep the user's after them.
 * initProfile writes the list only into a new profile, so a profile from an earlier build keeps its old list.
 * @param {string} dir - the profile directory
 */
export function claimBundles(dir) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const bundles = [...BUNDLES, ...listed.filter((name) => !BUNDLES.includes(name) && !RETIRED_BUNDLES.includes(name))]
  if (bundles.join('\n') !== listed.join('\n')) writeProfileBundles(dir, manifest, bundles)
}

/**
 * Create or update the profile under the current DSH_HOME and load it.
 * @returns {import('@deepseek-ai/dsh-app-boot').Profile} the loaded profile
 * @throws when one of the app's own bundles does not load
 */
export function loadAppProfile() {
  const dir = resolveProfileDir(PROFILE)
  initProfile(dir, BUNDLES)
  claimBundles(dir)
  return loadOwnBundles(dir, BUNDLES)
}

/** The profile of the first-run check, under the current DSH_HOME. */
export function loadCheckProfile() {
  const dir = resolveProfileDir(CHECK_PROFILE)
  initProfile(dir, CHECK_BUNDLES)
  return loadOwnBundles(dir, CHECK_BUNDLES)
}

function loadOwnBundles(dir, bundles) {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => bundles.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}
