// Reconcile #613: the app carries DSH's Office runtime — the workspace-dependencies tool and
// the seven Office skills — in build/runtime (development) or beside the app's folder (packaged).
// DSH's own profile does not mount them, so when the payload is complete the Host adds them
// through a `--patch` overlay it writes into its own data area next to the profiles
// (`<DSH_HOME>/profiles/office.patch.yml`), which DSH reads only through `patchFiles`.
// Follows DeepSeek Harness apps/desktop-host/src/office.ts (MIT); see NOTICE.
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'

export const OFFICE_PATCH_NAME = 'office.patch.yml'

/**
 * The payload's runtime directory and standalone Node, when the runtime is complete.
 * @param {string} runtimeDir - The directory holding primary-runtime/ and office-skills/.
 * @returns {{ source: string, node: string } | undefined}
 */
export function officeRuntime(runtimeDir) {
  const source = join(runtimeDir, 'primary-runtime')
  const node = join(source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  // The skill plugin reads its SKILL.md files at boot: an incomplete payload must fall back
  // to no overlay rather than stop the Host from starting.
  if (!existsSync(join(source, 'runtime.json')) || !existsSync(node)
    || !existsSync(join(runtimeDir, 'office-skills', 'office', 'SKILL.md'))) return undefined
  return { source, node }
}

// The payload's Node is a plain interpreter: it cannot read through an asar archive, so a CLI
// inside one must come from the unpacked tree beside it. The app itself ships without an archive
// (#679), where the path stays as it is.
export function officeCli(manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))) {
  return join(dirname(manifest).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'lib', 'cli.js')
}

/**
 * Write the Office overlay next to the profiles and report it for `patchFiles`; without a
 * complete payload, drop a stale one from an earlier launch.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @param {string} [runtimeDir] - The directory holding primary-runtime/ and office-skills/;
 *   the packaged app's resources, or build/runtime in development.
 * @returns {{ patchFiles: string[], node?: string }} the `patchFiles` addition for this
 *   launch and the payload's Node, which the Host exports for the plugin's own use
 */
export function reconcileOfficeRuntime(profile, runtimeDir = process.env.DS_BOT_RUNTIME_DIR) {
  const file = join(dirname(profile.dir), OFFICE_PATCH_NAME)
  const runtime = runtimeDir === undefined ? undefined : officeRuntime(runtimeDir)
  if (runtime === undefined) {
    rmSync(file, { force: true })
    return { patchFiles: [] }
  }
  writeFileSync(file, stringify([{ insert: [
    { id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime.source } },
    { id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot: join(runtimeDir, 'office-skills'), node: runtime.node, cli: officeCli() } },
  ] }]), 'utf8')
  return { patchFiles: [file], node: runtime.node }
}
