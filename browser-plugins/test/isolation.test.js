import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mountBrowserPlugin } from '../../ds-bot/src/host/browser/mount.js'
import { toolDefs as refsTools } from '../../ds-bot/src/host/browser/refs.js'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import { startFixture } from '../bench/fixture.mjs'

const playwrightUrl = new URL('../node_modules/playwright/index.js', import.meta.url).href
const browserOptions = {
  headless: true,
  playwrightUrl,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
}

async function startPopupFixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/reference') {
      response.end('<!doctype html><title>Reference</title><h1>Reference page</h1>')
      return
    }
    if (path === '/empty') {
      response.end('<!doctype html><title>Empty</title><h1>Empty page</h1>')
      return
    }
    if (path === '/many') {
      response.end('<!doctype html><title>Many</title><h1>Many links</h1><a href="/empty">One</a><a href="/empty">Two</a><a href="/empty">Three</a><a href="/empty">Four</a><a href="/empty">Five</a>')
      return
    }
    response.end('<!doctype html><title>Home</title><h1>Home page</h1><a href="/reference" target="_blank">Open reference</a>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('one Bot keeps its cookies and another Bot does not see them', async () => {
  const fixture = await startFixture()
  const profileRoot = mkdtempSync(join(tmpdir(), 'bot-profiles-'))
  const sessions = []
  const open = async botId => {
    const session = await openBotBrowser({ botId, profileRoot, ...browserOptions })
    sessions.push(session)
    return session
  }
  try {
    const alpha = await open('alpha')
    await alpha.open(`${fixture.origin}/set-cookie`)
    await alpha.open(`${fixture.origin}/who`)
    const alphaText = await alpha.snapshotText()
    await alpha.close()
    const beta = await open('beta')
    await beta.open(`${fixture.origin}/who`)
    const betaText = await beta.snapshotText()
    await beta.close()
    const again = await open('alpha')
    await again.open(`${fixture.origin}/who`)
    const againText = await again.snapshotText()
    await again.close()
    assert.match(alphaText, /bot=alpha/)
    assert.doesNotMatch(betaText, /bot=alpha/)
    assert.match(againText, /bot=alpha/)
  } finally {
    await Promise.all(sessions.map(session => session.close()))
    await fixture.close()
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('a target=_blank click activates the new tab and snapshots both tabs', async () => {
  const fixture = await startPopupFixture()
  const profileRoot = mkdtempSync(join(tmpdir(), 'bot-popup-profiles-'))
  let session
  try {
    session = await openBotBrowser({ botId: 'popup', profileRoot, ...browserOptions })
    await session.open(fixture.origin)
    const initial = await session.snapshotText()
    const ref = initial.match(/Open reference[^\n]*\[ref=(e\d+)\]/)?.[1]
    assert.ok(ref, 'snapshot should give the reference link an ARIA ref')
    const afterClick = await session.click(ref)
    assert.match(afterClick, /Title: Reference/)
    assert.match(afterClick, /Tabs:\n/)
    assert.match(afterClick, /\[1\] \(current\).*\/reference/)
    assert.equal((await session.tabs()).length, 2)

    const homeTab = await session.selectTab(0)
    assert.match(homeTab, /Title: Home/)
    const referenceTab = await session.selectTab(1)
    assert.match(referenceTab, /Title: Reference/)
    const afterClose = await session.closeTab(1)
    assert.match(afterClose, /Title: Home/)
    assert.doesNotMatch(afterClose, /Tabs:\n/)
  } finally {
    await session?.close()
    await fixture.close()
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('a stale ARIA ref reports that a new snapshot is required', async () => {
  const fixture = await startPopupFixture()
  const profileRoot = mkdtempSync(join(tmpdir(), 'bot-stale-ref-profiles-'))
  let session
  try {
    session = await openBotBrowser({ botId: 'stale', profileRoot, ...browserOptions })
    await session.open(`${fixture.origin}/many`)
    const refs = [...(await session.snapshotText()).matchAll(/\[ref=e(\d+)\]/g)]
      .map(match => Number(match[1]))
    const ref = `e${Math.max(...refs)}`
    assert.ok(refs.length > 1)
    await session.open(`${fixture.origin}/empty`)
    await assert.rejects(
      session.click(ref),
      { message: `No element ${ref}. Take a new snapshot; refs change when the page changes.` },
    )
  } finally {
    await session?.close()
    await fixture.close()
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('mounts distinct Bot profiles and reuses one browser across a Bot’s sessions', async () => {
  const fixture = await startFixture()
  const home = mkdtempSync(join(tmpdir(), 'bot-mounted-home-'))
  const profileRoot = join(home, 'browser-profiles')
  const registered = new Map()
  let dispose
  const ctx = {
    tools: { register: tool => registered.set(tool.name, tool) },
    effect: create => { dispose = create() },
  }
  mountBrowserPlugin(ctx, {
    toolDefs: refsTools,
    defineTool: value => value,
    async keyOf(exec) { return exec.botId },
    profileRoot,
    headless: true,
    playwrightUrl,
    executablePath: browserOptions.executablePath,
  })
  try {
    await registered.get('browser_open').execute(
      { url: `${fixture.origin}/item?id=lamp` },
      { botId: 'alpha', sessionId: 'alpha-own-chat' },
    )
    await registered.get('browser_open').execute(
      { url: fixture.origin },
      { botId: 'beta', sessionId: 'beta-own-chat' },
    )
    const alphaGroup = await registered.get('browser_snapshot').execute(
      {},
      { botId: 'alpha', sessionId: 'alpha-group-chat' },
    )
    assert.match(alphaGroup, /Title: Cedar lamp/)
    assert.equal(existsSync(join(profileRoot, 'alpha')), true)
    assert.equal(existsSync(join(profileRoot, 'beta')), true)
    assert.notEqual(join(profileRoot, 'alpha'), join(profileRoot, 'beta'))
  } finally {
    await dispose?.()
    await fixture.close()
    rmSync(home, { recursive: true, force: true })
  }
})
