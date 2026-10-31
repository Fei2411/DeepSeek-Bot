// The app's own `--patch` overlay, written next to the profiles as search-patch.mjs does
// (`<DSH_HOME>/profiles/app-onboarding.patch.yml`) and read by DSH only through `patchFiles`.
// It turns off DSH Web's automatic credential step: the Bot team connects the model in its
// own chat instead. `credentialOnboarding` is the documented switch of
// @deepseek-ai/dsh-client-ui-settings-models.
//
// A patch replaces the targeted row's whole `config`, so this row is restated from the
// pinned DSH whenever it changes. Overlays outrank the profile, and DSH refuses a settings
// form write that an overlay overrides: the overlay holds no row the Settings page writes
// (never `ui-settings-general`).
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { stringify } from 'yaml'

export const APP_PATCH_NAME = 'app-onboarding.patch.yml'
export const APP_PATCH_ROWS = [
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { credentialOnboarding: false } },
]

/**
 * Write the overlay for this launch; DSH stops when a `patchFiles` entry is missing.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} its part of the `patchFiles` argument
 */
export function writeAppPatch(profile) {
  const file = join(dirname(profile.dir), APP_PATCH_NAME)
  writeFileSync(file, stringify(APP_PATCH_ROWS), 'utf8')
  return [file]
}
