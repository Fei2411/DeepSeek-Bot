import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { currentRootOf, DATA_DIR, driveOf, formatBytes, freeSpace, isEmptyTree, LAYER, pickFrom, placeOf, rootOf, shortPath, WORKSPACE_DIR } from '../src/place.mjs'

const win32 = process.platform === 'win32'
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-place-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('free space is read at the nearest existing ancestor of a folder that is not there yet', (t) => {
  const dir = temp(t)
  const free = freeSpace(join(dir, 'not', 'yet'))
  assert.equal(typeof free, 'number')
  assert.ok(free > 0)
  assert.equal(freeSpace(join(dir, 'not', 'yet')), freeSpace(dir))
})

// Explorer's units: GB and MB of 1024, so the line agrees with what the user sees there.
test('sizes read as Explorer shows them', () => {
  assert.equal(formatBytes(412.7 * 2 ** 30), '412 GB')
  assert.equal(formatBytes(10 * 2 ** 30), '10 GB')
  assert.equal(formatBytes(1.26 * 2 ** 30), '1.2 GB')
  assert.equal(formatBytes(900 * 2 ** 20), '900 MB')
  assert.equal(formatBytes(undefined), undefined)
  assert.equal(formatBytes(-1), undefined)
})

test('the drive letter is read from a Windows path only', () => {
  if (win32) {
    assert.equal(driveOf('C:\\Users\\me\\.ds-bot'), 'C')
    assert.equal(driveOf('d:/DeepSeek Bot'), 'D')
  } else {
    assert.equal(driveOf('/home/user/.ds-bot'), undefined)
  }
})

test('a path under the home folder is written with ~', () => {
  const home = resolve('/home/user')
  assert.equal(shortPath(join(home, '.ds-bot'), home), `~${sep}.ds-bot`)
  assert.equal(shortPath(home, home), '~')
  assert.equal(shortPath(resolve('/srv/data'), home), resolve('/srv/data'))
})

test('the place line names the drive and its free space, or the folder', () => {
  if (win32) {
    assert.deepEqual(placeOf('C:\\Users\\me\\.ds-bot', { free: 412 * 2 ** 30 }), { drive: 'C', free: '412 GB' })
    assert.deepEqual(placeOf('C:\\Users\\me\\.ds-bot', { free: undefined }), { drive: 'C' })
  } else {
    assert.deepEqual(placeOf('/home/user/.ds-bot', { home: '/home/user', free: 1.5 * 2 ** 30 }), { path: `~${sep}.ds-bot`, free: '1.5 GB' })
  }
})

test('the picker opens in the data folder\'s parent', (t) => {
  const dir = temp(t)
  assert.equal(pickFrom(join(dir, 'DeepSeek Bot', 'data')), join(dir, 'DeepSeek Bot'))
})

test('the current root is the parent of a data and a workspace folder that are siblings', (t) => {
  const dir = temp(t)
  assert.equal(currentRootOf(join(dir, 'R', DATA_DIR), join(dir, 'R', WORKSPACE_DIR)), join(dir, 'R'))
  // The default places are not under one root.
  assert.equal(currentRootOf(join(dir, '.ds-bot'), join(dir, 'DeepSeek Bot')), undefined)
  assert.equal(currentRootOf(join(dir, 'R', DATA_DIR), undefined), undefined)
})

test('an empty tree holds nothing but empty folders', (t) => {
  const dir = temp(t)
  mkdirSync(join(dir, 'a', 'b'), { recursive: true })
  assert.equal(isEmptyTree(dir), true)
  writeFileSync(join(dir, 'a', 'b', 'file'), '')
  assert.equal(isEmptyTree(dir), false)
  assert.equal(isEmptyTree(join(dir, 'missing')), false)
})

// The root rule of windows-onboarding §3 (一个位置), without the write probe.
const noProbe = { env: {}, probe: false }

test('a new or empty folder is the root itself', (t) => {
  const dir = temp(t)
  const fresh = join(dir, 'new')
  assert.deepEqual(rootOf(fresh, noProbe), { root: fresh, dataDir: join(fresh, DATA_DIR), workspace: join(fresh, WORKSPACE_DIR), added: false })
  const empty = join(dir, 'empty')
  mkdirSync(empty)
  assert.deepEqual(rootOf(empty, noProbe), { root: empty, dataDir: join(empty, DATA_DIR), workspace: join(empty, WORKSPACE_DIR), added: false })
})

test('a drive or a folder with other things in it gets a DeepSeek Bot layer', (t) => {
  const dir = temp(t)
  writeFileSync(join(dir, 'notes.txt'), '')
  const layered = rootOf(dir, noProbe)
  assert.equal(layered.root, join(dir, LAYER))
  assert.equal(layered.added, true)
  assert.equal(layered.reason, undefined)
  const drive = parse(dir).root
  const atDrive = rootOf(drive, noProbe)
  assert.equal(atDrive.root, join(drive, LAYER))
  assert.equal(atDrive.added, true)
})

test('an empty root of the app\'s own is used again; someone else\'s layer is refused', (t) => {
  const dir = temp(t)
  mkdirSync(join(dir, DATA_DIR, 'profiles'), { recursive: true })
  mkdirSync(join(dir, WORKSPACE_DIR))
  assert.equal(rootOf(dir, noProbe).added, false)
  const busy = temp(t)
  writeFileSync(join(busy, 'notes.txt'), '')
  mkdirSync(join(busy, LAYER))
  writeFileSync(join(busy, LAYER, 'theirs.txt'), '')
  const refused = rootOf(busy, noProbe)
  assert.equal(refused.reason, 'foreign')
  assert.equal(refused.at, join(busy, LAYER))
  const file = join(dir, 'a-file')
  writeFileSync(file, '')
  assert.equal(rootOf(file, noProbe).reason, 'foreign')
})

test('the place the data is in now is no change, and a place inside it is refused', (t) => {
  const dir = temp(t)
  const current = { dataDir: join(dir, 'R', DATA_DIR), workspace: join(dir, 'R', WORKSPACE_DIR) }
  mkdirSync(join(current.dataDir, 'profiles'), { recursive: true })
  mkdirSync(current.workspace)
  for (const same of [join(dir, 'R'), current.dataDir, `${join(dir, 'R')}${sep}`]) assert.deepEqual(rootOf(same, { ...noProbe, current }), { same: true })
  const inside = rootOf(join(current.dataDir, 'old'), { ...noProbe, current })
  assert.equal(inside.reason, 'nested')
  assert.equal(inside.at, join(current.dataDir, 'old'))
  // The team workspace with something in it is a place too; an empty one, just made, is free.
  writeFileSync(join(current.workspace, 'notes.md'), '')
  assert.equal(rootOf(join(current.workspace, 'sub'), { ...noProbe, current }).reason, 'nested')
  // The default places: picking the home puts the root on the workspace the start made.
  const home = join(dir, 'home')
  mkdirSync(join(home, 'DeepSeek Bot'), { recursive: true })
  writeFileSync(join(home, 'other.txt'), '')
  const defaults = { dataDir: join(home, '.ds-bot'), workspace: join(home, 'DeepSeek Bot') }
  const atHome = rootOf(home, { ...noProbe, current: defaults })
  assert.equal(atHome.reason, undefined)
  assert.equal(atHome.root, join(home, 'DeepSeek Bot'))
  assert.equal(atHome.added, true)
  assert.equal(rootOf(join(home, 'DeepSeek Bot'), { ...noProbe, current: defaults }).added, false)
  // Once the workspace holds files, the layer the home pick would add is a used folder.
  writeFileSync(join(home, 'DeepSeek Bot', 'theirs.txt'), '')
  assert.equal(rootOf(home, { ...noProbe, current: defaults }).reason, 'foreign')
  assert.equal(rootOf(join(home, 'DeepSeek Bot', 'sub'), { ...noProbe, current: defaults }).reason, 'nested')
  assert.equal(rootOf(join(home, 'elsewhere'), { ...noProbe, current: defaults }).reason, undefined)
})

test('a folder that cannot be read counts as one without permission', { skip: !win32 || !existsSync('C:\\System Volume Information') }, () => {
  const refused = rootOf('C:\\System Volume Information', noProbe)
  assert.equal(refused.reason, 'permission')
  assert.equal(refused.at, 'C:\\System Volume Information')
})

test('OneDrive, the DSH home and the program folder are refused, through links too', (t) => {
  const dir = temp(t)
  const cloud = join(dir, 'OneDrive', 'Docs')
  assert.equal(rootOf(cloud, noProbe).reason, 'onedrive')
  assert.equal(rootOf(cloud, noProbe).at, cloud)
  assert.equal(rootOf(join(dir, 'OneDrive - Contoso', 'Docs'), noProbe).reason, 'onedrive')
  assert.equal(rootOf(join(dir, 'Library', 'CloudStorage', 'OneDrive-Personal', 'Docs'), noProbe).reason, 'onedrive')
  // A folder that only has OneDrive in its name is not the cloud.
  assert.equal(rootOf(join(dir, 'OneDrive-old', 'Docs'), noProbe).reason, undefined)
  const synced = join(dir, 'Synced')
  assert.equal(rootOf(synced, { ...noProbe, env: { OneDrive: join(dir, 'Synced') } }).reason, 'onedrive')
  const dsh = join(dir, '.dsh')
  mkdirSync(dsh)
  const inDsh = rootOf(join(dsh, 'bots'), { ...noProbe, dshHome: dsh })
  assert.equal(inDsh.reason, 'dsh')
  assert.equal(inDsh.at, join(dsh, 'bots'))
  assert.equal(rootOf(dir, { ...noProbe, dshHome: join(dir, 'missing-dsh') }).reason, undefined)
  assert.equal(rootOf(join(dir, 'app', 'data'), { ...noProbe, program: join(dir, 'app') }).reason, 'program')
  // A link into the DSH home leads there.
  const link = join(dir, 'link')
  try {
    symlinkSync(dsh, link, 'junction')
  } catch {
    return
  }
  assert.equal(rootOf(join(link, 'bots'), { ...noProbe, dshHome: dsh }).reason, 'dsh')
})

test('the write probe makes only the missing layers and takes them away again', (t) => {
  const dir = temp(t)
  const fresh = join(dir, 'deep', 'er')
  const root = rootOf(fresh, { env: {} })
  assert.equal(root.reason, undefined)
  assert.equal(existsSync(join(dir, 'deep')), false)
  const kept = join(dir, 'kept')
  mkdirSync(kept)
  rootOf(kept, { env: {} })
  assert.equal(existsSync(kept), true)
  assert.equal(existsSync(join(kept, DATA_DIR)), false)
})
