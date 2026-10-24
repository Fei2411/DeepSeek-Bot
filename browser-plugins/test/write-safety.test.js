import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gateScope } from '../../ds-bot/src/host/browser/gate.js'
import { mountBrowserPlugin } from '../../ds-bot/src/host/browser/mount.js'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import { toolDefs as taskTools } from '../../ds-bot/src/host/browser/task.js'

const playwrightUrl = new URL('../node_modules/playwright/index.mjs', import.meta.url).href

function pageHtml() {
  return `
      <form method="post" action="/unlabeled">
        <input type="submit">
      </form>
      <form method="post" action="/submit">
        <input name="message" aria-label="Post message">
        <button type="submit">Publish</button>
      </form>
      <form method="get" action="/filter">
        <input name="query" aria-label="Filter query">
        <button type="submit">Filter</button>
      </form>
      <a href="/link">Read link</a>
      <button type="button" onclick="fetch('/delete', {method:'POST'}).then(() => document.querySelector('#status').textContent = 'Deleted')">Delete</button>
      <button type="button" onclick="document.querySelector('#status').textContent = 'Paid'">Pay now</button>
      <input autocomplete="cc-number" aria-label="Card number" oninput="document.querySelector('#card-status').textContent = this.value">
      <p id="card-status">empty</p>
      <input type="file" aria-label="Upload file" onchange="document.querySelector('#status').textContent = this.files[0]?.name ?? ''">
      <a href="/download">Download report</a>
      <form method="post" action="/hang">
        <button type="submit">Publish delayed</button>
      </form>
      <p id="status"></p>
    `
}

async function fixtureServer() {
  const counters = { submit: 0, filter: 0, hang: 0, unlabeled: 0, upload: 0, delete: 0, deleteA: 0, deleteB: 0 }
  const sockets = new Set()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
    const html = (title, body = '') => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`)
    }
    if (path === '/') {
      html('Write safety', pageHtml())
    } else if (path === '/submit' && request.method === 'POST') {
      counters.submit += 1
      request.resume()
      request.on('end', () => html('Submitted', '<p>Saved</p>'))
    } else if (path === '/unlabeled' && request.method === 'POST') {
      counters.unlabeled += 1
      request.resume()
      request.on('end', () => html('Submitted', '<p>Submitted</p>'))
    } else if (path === '/upload' && request.method === 'POST') {
      counters.upload += 1
      request.resume()
      request.on('end', () => html('Uploaded', '<p>Uploaded</p>'))
    } else if (path === '/delete' && request.method === 'POST') {
      counters.delete += 1
      const item = new URL(request.url ?? '/', `http://${request.headers.host}`).searchParams.get('item')
      if (item === 'A') counters.deleteA += 1
      if (item === 'B') counters.deleteB += 1
      request.resume()
      request.on('end', () => { response.writeHead(204); response.end() })
    } else if (path === '/delete-items') {
      html('Delete items', `
        <div><p>Item A</p><button type="button" onclick="fetch('/delete?item=A', {method:'POST'})">Delete</button></div>
        <div><p>Item B</p><button type="button" onclick="fetch('/delete?item=B', {method:'POST'})">Delete</button></div>
      `)
    } else if (path === '/filter') {
      counters.filter += 1
      html('Filtered', '<p>Filtered</p>')
    } else if (path === '/link') {
      html('Link target', '<p>Link opened</p>')
    } else if (path === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="report.txt"',
      })
      response.end('download contents')
    } else if (path === '/hang' && request.method === 'POST') {
      counters.hang += 1
      request.resume()
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': '1000',
        })
        response.write('<!doctype html><html><body>Still waiting', () => request.socket.destroy())
      })
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/`
  return {
    url,
    counters,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function findRefs(snapshot, label) {
  return snapshot.split('\n')
    .filter(value => value.match(/"([^"]*)"/)?.[1] === label && /\[ref=e\d+\]/.test(value))
    .map(line => line.match(/\[ref=(e\d+)\]/)?.[1])
}

function findRef(snapshot, label) {
  const ref = findRefs(snapshot, label)[0]
  assert.ok(ref, `no snapshot ref for ${label}`)
  return ref
}

async function waitFor(check) {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('fixture did not observe the expected request')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function setup(t, actionTimeout = 500, options = {}) {
  const fixture = await fixtureServer()
  let profileRoot
  let session
  const extra = typeof options === 'function' ? {} : options
  t.after(async () => {
    await session?.close().catch(() => {})
    try {
      await fixture.close()
    } finally {
      if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
    }
  })
  profileRoot = await mkdtemp(join(tmpdir(), 'browser-write-safety-'))
  session = await openBotBrowser({
    botId: `test-${process.pid}-${Date.now()}`,
    profileRoot,
    downloadDir: join(profileRoot, 'downloads'),
    playwrightUrl,
    actionTimeout,
    ...extra,
    uploadRoots: typeof options === 'function' ? async () => options(profileRoot) : extra.uploadRoots,
  })
  return { fixture, profileRoot, session }
}

async function mountedDownloadAndUpload(t, rootsFor) {
  const fixture = await fixtureServer()
  const profileRoot = await mkdtemp(join(tmpdir(), 'browser-mounted-download-'))
  const { roots, ...destinations } = rootsFor(profileRoot)
  await Promise.all(roots.map(root => mkdir(root, { recursive: true })))
  let cleanup
  let tool
  t.after(async () => {
    await cleanup?.()
    await fixture.close()
    await rm(profileRoot, { recursive: true, force: true })
  })
  mountBrowserPlugin({
    effect(create) { cleanup = create() },
    tools: { register(value) { tool = value } },
  }, {
    toolDefs: [{
      name: 'browser_open',
      needsBrowser: true,
      async execute(args, { session }) {
        const downloaded = await session.open(args.downloadUrl)
        const snapshot = await session.open(args.pageUrl)
        const uploaded = await session.upload(findRef(snapshot, 'Upload file'), [args.path])
        return `${downloaded}\n${uploaded}`
      },
    }],
    defineTool: value => value,
    keyOf: async () => 'bot',
    profileRoot,
    downloadRoot: join(profileRoot, 'legacy-downloads'),
    downloadRoots: async () => roots,
    uploadRoots: async () => roots,
    headless: true,
    playwrightUrl,
  })
  const result = await tool.execute({
    downloadUrl: new URL('download', fixture.url).href,
    pageUrl: fixture.url,
    path: join(roots[0], 'report.txt'),
  }, { agent: { id: 'bot' } })
  return { ...destinations, result }
}

test('unlabeled POST submits, GET forms, and links are not gated', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Submit')))
  await waitFor(() => fixture.counters.unlabeled === 1)
  assert.equal(actions.length, 0)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Filter')))
  await waitFor(() => fixture.counters.filter === 1)
  assert.equal(actions.length, 0)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Read link')))
  assert.equal(actions.length, 0)
})

test('delete requires a checked second click even when confirm is passed first', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }
  let snapshot = await session.open(fixture.url)
  let ref = findRef(snapshot, 'Delete')

  let result = await gateScope.run(gate, () => session.click(ref))
  assert.match(result, /This would delete "Delete".*Nothing was deleted yet/)
  assert.equal(actions.length, 0)
  assert.equal(fixture.counters.delete, 0)
  assert.doesNotMatch(result, /Deleted/)

  snapshot = await session.open(fixture.url)
  ref = findRef(snapshot, 'Delete')
  result = await gateScope.run(gate, () => session.click(ref, { confirm: true }))
  assert.match(result, /This would delete "Delete".*Nothing was deleted yet/)
  assert.equal(actions.length, 0)
  assert.equal(fixture.counters.delete, 0)
  assert.doesNotMatch(result, /Deleted/)

  ref = findRef(result, 'Delete')
  result = await gateScope.run(gate, () => session.click(ref, { confirm: true }))
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'delete')
  assert.equal(actions[0].label, 'Delete')
  assert.match(result, /Deleted/)
  await waitFor(() => fixture.counters.delete === 1)
})

test('delete confirmation is bound to the clicked element', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }
  let snapshot = await session.open(new URL('delete-items', fixture.url).href)
  let refs = findRefs(snapshot, 'Delete')
  assert.equal(refs.length, 2)

  let result = await gateScope.run(gate, () => session.click(refs[0]))
  assert.match(result, /This would delete "Delete".*Nothing was deleted yet/)
  assert.equal(fixture.counters.deleteA, 0)
  assert.equal(fixture.counters.deleteB, 0)

  refs = findRefs(result, 'Delete')
  result = await gateScope.run(gate, () => session.click(refs[1], { confirm: true }))
  assert.match(result, /This would delete "Delete".*Nothing was deleted yet/)
  assert.equal(fixture.counters.deleteA, 0)
  assert.equal(fixture.counters.deleteB, 0)
  assert.equal(actions.length, 0)

  refs = findRefs(result, 'Delete')
  result = await gateScope.run(gate, () => session.click(refs[1], { confirm: true }))
  await waitFor(() => fixture.counters.deleteB === 1)
  assert.equal(fixture.counters.deleteA, 0)
  assert.equal(fixture.counters.deleteB, 1)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'delete')
})

test('payment buttons are refused and card details are never typed', async (t) => {
  const { fixture, session } = await setup(t)
  const snapshot = await session.open(fixture.url)
  await assert.rejects(
    session.click(findRef(snapshot, 'Pay now')),
    /This looks like a payment \("Pay now" on 127\.0\.0\.1\).*call browser_handoff with reason "payment".*Nothing was done\./,
  )
  await assert.rejects(
    session.type(findRef(snapshot, 'Card number'), '4111111111111111'),
    /Payment details are entered by the user.*Nothing was typed\./,
  )
  const after = await session.snapshotText()
  assert.match(after, /empty/)
  assert.doesNotMatch(after, /4111111111111111/)
  assert.doesNotMatch(after, /Paid/)
})

test('Bot handoff can resume, while user takeover blocks browser actions', async t => {
  let hold = null
  const { fixture, session } = await setup(t, 500, {
    getHold: () => hold,
    onHold: value => { hold = value },
  })
  const snapshot = await session.open(fixture.url)
  assert.match(session.handoff('login', 'Sign in'), /Waiting for the user/)
  assert.equal(hold.by, 'bot')
  await assert.rejects(session.click(findRef(snapshot, 'Read link')), /browser is waiting for the user/)
  assert.equal(session.resume(), 'The browser is yours again.')
  assert.equal(hold, null)

  hold = { by: 'user', reason: 'takeover', note: '' }
  assert.throws(() => session.resume(), /Only the user can give it back/)
  await assert.rejects(session.snapshotText(), /The user has taken over this browser/)
  await assert.rejects(session.open(fixture.url), /The user has taken over this browser/)
  hold = null
  assert.match(await session.open(fixture.url), /Write safety/)
})

test('POST submit clicks are gated before the server receives them', async (t) => {
  const { fixture, session } = await setup(t)
  let allowed = true
  const actions = []
  const gate = action => {
    actions.push(action)
    if (!allowed) throw new Error('approval denied')
  }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Publish')))
  await waitFor(() => fixture.counters.submit === 1)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'post')

  allowed = false
  snapshot = await session.open(fixture.url)
  await assert.rejects(
    gateScope.run(gate, () => session.click(findRef(snapshot, 'Publish'))),
    /approval denied/,
  )
  assert.equal(fixture.counters.submit, 1)
  assert.equal(actions.length, 2)

  snapshot = await session.open(fixture.url)
  await session.click(findRef(snapshot, 'Publish'))
  await waitFor(() => fixture.counters.submit === 2)
  assert.equal(actions.length, 2)
})

test('type with submit gates POST forms but not GET forms', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.type(findRef(snapshot, 'Post message'), 'hello', true))
  await waitFor(() => fixture.counters.submit === 1)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'post')

  snapshot = await session.open(fixture.url)
  await session.type(findRef(snapshot, 'Post message'), 'hello')
  await gateScope.run(gate, () => session.press('Enter'))
  await waitFor(() => fixture.counters.submit === 2)
  assert.equal(actions.length, 2)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.type(findRef(snapshot, 'Filter query'), 'lamp', true))
  await waitFor(() => fixture.counters.filter === 1)
  assert.equal(actions.length, 2)
})

test('unknown POST results block repeats until the page is observed', { timeout: 15_000 }, async (t) => {
  const { fixture, session } = await setup(t, 300)
  const actions = []
  const gate = action => { actions.push(action) }
  const snapshot = await session.open(fixture.url)
  const ref = findRef(snapshot, 'Publish delayed')

  const result = await gateScope.run(gate, () => session.click(ref))
  assert.match(result, /was sent, but its result is unknown/)
  assert.match(result, /Do not repeat it/)
  assert.equal(fixture.counters.hang, 1)
  assert.equal(actions.length, 1)

  await assert.rejects(
    gateScope.run(gate, () => session.click(ref)),
    /An earlier "Publish delayed" action.*Do not repeat it unless the page shows it did not go through/,
  )
  assert.equal(fixture.counters.hang, 1)
  assert.equal(actions.length, 1)

  await session.snapshotText()
  await session.open(fixture.url)
  const nextSnapshot = await session.snapshotText()
  await gateScope.run(gate, () => session.click(findRef(nextSnapshot, 'Publish delayed')))
  assert.equal(actions.length, 2)
  assert.equal(fixture.counters.hang, 2)
})

test('browser_task driver tools inherit the outer authorization gate', async (t) => {
  const fixture = await fixtureServer()
  let profileRoot
  const registered = new Map()
  const disposers = []
  t.after(async () => {
    try {
      await Promise.all(disposers.map(dispose => dispose?.()))
    } finally {
      try {
        await fixture.close()
      } finally {
        if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
      }
    }
  })
  profileRoot = await mkdtemp(join(tmpdir(), 'browser-write-task-'))
  const gateActions = []
  const ctx = {
    effect(effect) {
      disposers.push(effect())
    },
    tools: { register(tool) { registered.set(tool.name, tool) } },
  }
  let modelStep = 0
  const complete = async request => {
    modelStep += 1
    const message = (toolCalls = [], content = '') => ({
      choices: [{ message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    })
    const call = (id, name, args) => ({
      id,
      function: { name, arguments: JSON.stringify(args) },
    })
    if (modelStep === 1) return message([call('open', 'browser_open', { url: fixture.url })])
    if (modelStep === 2) {
      const page = request.messages.filter(entry => entry.role === 'tool').at(-1).content
      return message([call('publish', 'browser_click', { ref: findRef(page, 'Publish') })])
    }
    return message([], 'Published')
  }

  mountBrowserPlugin(ctx, {
    toolDefs: taskTools,
    defineTool: spec => spec,
    keyOf: async exec => exec.botId,
    profileRoot,
    headless: true,
    playwrightUrl,
    actionTimeout: 500,
    complete,
    authorize: async (_exec, _botId, action) => { gateActions.push(action) },
  })
  const tool = registered.get('browser_task')
  const result = await tool.execute({ goal: 'publish a post' }, {
    botId: 'task-bot',
    name: 'browser_task',
  })

  assert.match(result.text, /Published/)
  assert.equal(gateActions.length, 1)
  assert.equal(gateActions[0].kind, 'post')
  await waitFor(() => fixture.counters.submit === 1)
})

test('uploads are confined to allowed roots and gated before setting files', async (t) => {
  const { fixture, profileRoot, session } = await setup(t, 500, root => [join(root, 'allowed')])
  const allowedRoot = join(profileRoot, 'allowed')
  await mkdir(allowedRoot)
  const file = join(allowedRoot, 'notes.txt')
  const outside = join(profileRoot, 'outside.txt')
  await writeFile(file, 'hello')
  await writeFile(outside, 'private')
  const linked = join(allowedRoot, 'outside-link.txt')
  await symlink(outside, linked)
  const actions = []
  let reject = true
  const gate = action => {
    actions.push(action)
    if (reject) throw new Error('approval denied')
  }
  const snapshot = await session.open(fixture.url)
  const ref = findRef(snapshot, 'Upload file')

  await assert.rejects(
    gateScope.run(gate, () => session.upload(ref, [outside])),
    /Uploads must come from .*outside\.txt is outside them\. Nothing was uploaded\./,
  )
  await assert.rejects(
    gateScope.run(gate, () => session.upload(ref, [linked])),
    /Uploads must come from .*outside-link\.txt is outside them\. Nothing was uploaded\./,
  )
  assert.equal(actions.length, 0)

  await assert.rejects(gateScope.run(gate, () => session.upload(ref, [file])), /approval denied/)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'upload')
  assert.equal(actions[0].label, 'notes.txt')
  reject = false
  const result = await gateScope.run(gate, () => session.upload(ref, [file]))
  assert.match(result, /notes\.txt/)
  assert.equal(actions.length, 2)
  assert.equal(fixture.counters.upload, 0)
})

test('standalone uploads without configured roots are refused', async (t) => {
  const { fixture, profileRoot, session } = await setup(t)
  const file = join(profileRoot, 'notes.txt')
  await writeFile(file, 'hello')
  const snapshot = await session.open(fixture.url)
  await assert.rejects(
    session.upload(findRef(snapshot, 'Upload file'), [file]),
    /Uploads must come from an allowed folder.*Nothing was uploaded\./,
  )
  assert.doesNotMatch(await session.snapshotText(), /notes\.txt/)
})

test('mounted downloads and uploads use the Bot working directory', async t => {
  const { result, working } = await mountedDownloadAndUpload(t, profileRoot => ({
    roots: [join(profileRoot, 'working'), join(profileRoot, 'team')],
    working: join(profileRoot, 'working'),
  }))
  assert.match(result, /Downloaded "report\.txt" to /u)
  assert.ok(result.includes(join(working, 'report.txt')))
  assert.match(result, /report\.txt/u)
  assert.equal(await readFile(join(working, 'report.txt'), 'utf8'), 'download contents')
})

test('mounted downloads and uploads fall back to the team folder', async t => {
  const { result, team } = await mountedDownloadAndUpload(t, profileRoot => ({
    roots: [join(profileRoot, 'team')],
    team: join(profileRoot, 'team'),
  }))
  assert.match(result, /Downloaded "report\.txt" to /u)
  assert.ok(result.includes(join(team, 'report.txt')))
  assert.match(result, /report\.txt/u)
  assert.equal(await readFile(join(team, 'report.txt'), 'utf8'), 'download contents')
})

test('opening a direct attachment URL saves the download instead of throwing', async (t) => {
  const { fixture, profileRoot, session } = await setup(t)
  const actions = []
  const result = await gateScope.run(action => { actions.push(action) }, () => session.open(new URL('download', fixture.url).href))
  assert.match(result, /Downloaded "report\.txt" to .*report\.txt\./)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'download')
  assert.equal(actions[0].host, '127.0.0.1')
  assert.equal(await readFile(join(profileRoot, 'downloads', 'report.txt'), 'utf8'), 'download contents')
})

test('downloads are gated, saved without overwriting, or cancelled on refusal', async (t) => {
  const { fixture, profileRoot, session } = await setup(t)
  const downloadDir = join(profileRoot, 'downloads')
  const actions = []
  let reject = true
  const gate = action => {
    actions.push(action)
    if (reject) throw new Error('The user did not approve this download. Nothing was done.')
  }
  let snapshot = await session.open(fixture.url)
  let result = await gateScope.run(gate, () => session.click(findRef(snapshot, 'Download report')))
  assert.match(result, /The user did not approve this download/)
  assert.equal(actions.at(-1).kind, 'download')
  assert.deepEqual(await readdir(downloadDir).catch(() => []), [])

  reject = false
  snapshot = result
  result = await gateScope.run(gate, () => session.click(findRef(snapshot, 'Download report')))
  assert.match(result, new RegExp(`Downloaded "report\\.txt" to ${downloadDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]report\\.txt\\.`))
  assert.equal(actions.at(-1).kind, 'download')
  assert.equal(await readFile(join(downloadDir, 'report.txt'), 'utf8'), 'download contents')
  assert.equal(fixture.counters.upload, 0)
})
