import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'

function patch(method, replace) {
  const original = fsp[method]
  fsp[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fsp[method] = original
    syncBuiltinESMExports()
  }
}

function patchSync(method, replace) {
  const original = fs[method]
  fs[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fs[method] = original
    syncBuiltinESMExports()
  }
}

function runtime(t, saved) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  const statePath = join(home, 'state.json')
  if (saved !== undefined) fs.writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  let disposed
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  const dispose = () => {
    disposed ??= Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    return disposed
  }
  t.after(async () => {
    await dispose()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, home, statePath, warnings, dispose }
}

test('a failed state write rejects and leaves the saved file unchanged', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  rt.state.prefs.marker = 'not saved'
  await assert.rejects(rt.save(), { code: 'EISDIR' })
  assert.deepEqual(fs.readFileSync(statePath), original)
})

test('a failed migration write warns but load() still resolves', async (t) => {
  const { rt, statePath, warnings } = runtime(t, { version: 1, mainBotId: 'chief', bots: { chief: { id: 'chief', name: 'Chief' } } })
  // The migrated team's first write fails: a directory takes the temp file's path.
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /saving the migrated Bot team failed/.test(String(args))))
  // Once the disk is free the next save() writes the migrated state.
  fs.rmSync(`${statePath}.${process.pid}.tmp`, { recursive: true })
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.mainBotId, undefined)
  assert.ok(saved.mainBotIds.includes('chief'))
})

test('a failed state rename rejects and preserves the saved file', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) throw Object.assign(new Error('synthetic rename failure'), { code: 'ENOSPC' })
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'not saved'
    await assert.rejects(rt.save(), { code: 'ENOSPC' })
    assert.deepEqual(fs.readFileSync(statePath), original)
  } finally {
    restore()
  }
})

test('malformed state is backed up before a later save', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  const backups = fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(join(rt.home, backups[0]), 'utf8'), original)
  rt.state.prefs.marker = 'recovered'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'recovered')
})

test('malformed state stays read-only when its backup cannot be copied', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  const restore = patch('copyFile', () => async () => {
    throw Object.assign(new Error('synthetic copy failure'), { code: 'EACCES' })
  })
  try {
    await rt.load()
    assert.match(rt.readOnly(), /could not be read/)
    rt.state.prefs.marker = 'not saved'
    await rt.save()
    assert.equal(fs.readFileSync(statePath, 'utf8'), original)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-')), [])
  } finally {
    restore()
  }
})

test('a state from a newer version remains untouched', async (t) => {
  const original = JSON.stringify({ version: 999, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  assert.match(rt.readOnly(), /saved by a newer DS Bot; update DS Bot/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('a read error keeps the existing state read-only', async (t) => {
  const original = JSON.stringify({ version: 1, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  const restore = patch('readFile', originalRead => async (path, ...args) => {
    if (path === statePath) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' })
    return originalRead(path, ...args)
  })
  try {
    await rt.load()
  } finally {
    restore()
  }
  assert.match(rt.readOnly(), /could not be read \(EACCES\)/)
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('refresh adopts a fixed state file and clears read-only mode', async (t) => {
  const { rt, statePath } = runtime(t, { version: 999, revision: 77 })
  await rt.load()
  assert.match(rt.readOnly(), /could not be read/)
  const fixed = { version: 1, revision: 78, recoveryMarker: 'fixed file' }
  fs.writeFileSync(statePath, JSON.stringify(fixed))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.recoveryMarker, 'fixed file')
  rt.state.prefs.marker = 'saved after repair'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved after repair')
})

test('a state file changed while the lock was gone is set aside, not adopted', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'kept'
  await rt.save()
  // A tool with full file access can edit the team file and remove the lock.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
  fs.rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.equal(rt.state.prefs.marker, 'kept')
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /not adopted/.test(String(args))))
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.edited-'))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8')).prefs.marker, 'outside edit')
  // The next save writes this host's own state over the outside file.
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'kept')
})

test('a changed file is adopted when another host left its lock behind', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'before'
  await rt.save()
  // A dsh that took over and is gone leaves its lock beside the file it wrote.
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 99999999, host: hostname(), token: 'other-host', since: Date.now() }))
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'taken over' } }))
  await rt.refresh()
  assert.equal(rt.state.prefs.marker, 'taken over')
  assert.equal(rt.readOnly(), undefined)
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'taken over')
})

test('a reading host takes over the team once the dsh that held it is gone', async (t) => {
  const { rt, home, statePath } = runtime(t, { version: 1, revision: 4, prefs: { marker: 'first write' } })
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now() }))
  await rt.load()
  assert.match(rt.readOnly(), /another dsh/)
  // The other dsh wrote its last state and closed, releasing the lock.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 5, prefs: { marker: 'handed over' } }))
  fs.rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.prefs.marker, 'handed over')
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'handed over')
})

test('an unusable state lock warns and keeps the team saving', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  const lockPath = join(home, 'state.lock')
  const restore = patchSync('writeFileSync', originalWrite => (path, ...args) => {
    if (path === lockPath) throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    return originalWrite(path, ...args)
  })
  try {
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    assert.equal(warnings.filter(([template]) => template.includes('cannot lock')).length, 1)
    rt.state.prefs.marker = 'saved without a lock'
    await rt.save()
    await rt.refresh()
    assert.equal(rt.state.prefs.marker, 'saved without a lock')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved without a lock')
  } finally {
    restore()
  }
})

test('a queued save rejects after another host takes the lock', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  let paused = false
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home && !paused) {
      paused = true
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.prefs.marker = 'old owner'
    const active = rt.save()
    await atMkdir
    const queued = rt.save()
    fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
    const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
    fs.writeFileSync(statePath, ownerState)
    unblock()
    await assert.rejects(active, { code: 'ELOCKLOST' })
    await assert.rejects(queued, { code: 'ELOCKLOST' })
    assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
    assert.equal(JSON.parse(fs.readFileSync(join(home, 'state.lock'), 'utf8')).token, 'new-owner')
  } finally {
    unblock()
    restore()
  }
})

test('a read-only host resolves awaited saves without writing', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
  fs.writeFileSync(statePath, ownerState)
  await rt.refresh()
  assert.match(rt.readOnly(), /another dsh/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
})

test('dispose waits for a pending save and prevents later writes', async (t) => {
  const { rt, home, statePath, dispose } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atRename = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) {
      entered()
      await gate
    }
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'pending save'
    const pending = rt.save()
    await atRename
    const disposing = dispose()
    assert.equal(fs.existsSync(join(home, 'state.lock')), true)
    const revision = rt.state.revision
    const afterDispose = rt.save()
    assert.equal(rt.state.revision, revision)
    unblock()
    await pending
    await disposing
    await afterDispose
    assert.equal(fs.existsSync(join(home, 'state.lock')), false)
    const saved = fs.readFileSync(statePath, 'utf8')
    await rt.save()
    assert.equal(rt.state.revision, revision)
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved)
  } finally {
    unblock()
    restore()
  }
})
