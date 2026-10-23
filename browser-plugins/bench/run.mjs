import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeDeepseek, deepseekKey, MODEL } from '../../ds-bot/src/host/browser/deepseek.js'
import { runToolLoop } from '../../ds-bot/src/host/browser/loop.js'
import * as refs from '../../ds-bot/src/host/browser/refs.js'
import * as script from '../../ds-bot/src/host/browser/script.js'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import { runTask } from '../../ds-bot/src/host/browser/task.js'
import { startFixture } from './fixture.mjs'
import { tasks } from './tasks.mjs'

const outDir = new URL('./out/', import.meta.url)
const playwrightUrl = new URL('../node_modules/playwright/index.js', import.meta.url).href
const plugins = { refs, script, task: { id: 'task', label: 'Whole task', systemPrompt: '', toolDefs: [] } }

const refOf = (data, pattern) => data.items.find(item => pattern.test(`${item.name} ${item.role} ${item.type}`))?.ref

async function drive(session, fixture) {
  const checks = []
  const record = (id, ok, detail) => checks.push({ id, ok, detail })

  await session.open(`${fixture.origin}/`)
  let data = await session.snapshotData()
  const field = data.items.find(item => item.role === 'input' && /search/i.test(item.name))
  const button = data.items.find(item => item.role === 'button' && /search/i.test(item.name))
  await session.fill(field.ref, 'cedar lamp')
  await session.click(button.ref)
  data = await session.snapshotData()
  await session.click(refOf(data, /cedar lamp/i))
  data = await session.snapshotData()
  record('shop', data.text.includes('1280'), data.text.includes('1280') ? 'item page shows 1280' : data.text.slice(0, 180))

  await session.open(`${fixture.origin}/orders`)
  data = await session.snapshotData()
  await session.click(refOf(data, /next/i))
  data = await session.snapshotData()
  record('orders', /88421/.test(data.text) && /packed/i.test(data.text), 'page 2 text checked')

  await session.open(`${fixture.origin}/widget`)
  let text = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    text = await session.snapshotText()
    if (text.includes('WH-441') && text.includes('DK-19')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  record('shadow', text.includes('WH-441') && text.includes('DK-19'), 'snapshot includes shadow and frame text')
  record('canvas-hidden', !text.includes('CANVAS-73'), text.includes('CANVAS-73') ? 'canvas text leaked into the snapshot' : 'canvas code is not in the text')
  const picture = await session.shot()
  if (picture.image) {
    await mkdir(outDir, { recursive: true })
    await writeFile(new URL('./canvas.jpg', outDir), Buffer.from(picture.image, 'base64'))
  }
  record('canvas-shot', Boolean(picture.image), picture.image ? 'jpeg saved' : picture.text)

  await session.open(`${fixture.origin}/account`)
  session.handoff('login', 'Sign in, then tell me to resume.')
  let blocked = false
  try {
    data = await session.snapshotData()
    await session.fill(refOf(data, /password/i), 'guessed-secret')
  } catch (error) {
    blocked = /waiting for the user/i.test(error.message)
  }
  record('login-handoff', blocked && fixture.posted.length === 0 && session.hold?.reason === 'login', blocked ? 'actions blocked, no password posted' : 'handoff did not block')
  session.resume()
  const scripted = await session.runScript(`
    await goto(${JSON.stringify(`${fixture.origin}/`)})
    let page = await snapshot()
    const read = (text) => [...text.matchAll(/\\[#(\\d+)\\] (\\S+) "([^"]*)"/g)]
    let refs = read(page)
    const field = refs.find(([, , role, name]) => role === 'input' && /search/i.test(name))
    const button = refs.find(([, , role, name]) => role.startsWith('button') && /search/i.test(name))
    await fill(Number(field[1]), 'cedar lamp')
    await click(Number(button[1]))
    page = await snapshot()
    const lamp = read(page).find(([, , , name]) => /cedar lamp/i.test(name))
    await click(Number(lamp[1]))
    page = await snapshot()
    if (!page.includes('1280')) throw new Error('price missing')
    await done('1280 yuan')
  `)
  record('script-shop', scripted.includes('1280'), scripted.slice(0, 180))
  return checks
}

function bind(plugin, session) {
  return plugin.toolDefs.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args) => tool.execute(args, { session, botId: session.botId, profileDir: session.userDataDir, complete: completeDeepseek }),
  }))
}

async function judge(task, answer, pageText) {
  if (task.check) return { ok: false, detail: 'local tasks are judged in code' }
  try {
    const response = await completeDeepseek({
      messages: [
        { role: 'system', content: 'Judge a web agent. Reply with JSON only: {"success":true|false,"reason":"..."}.' },
        { role: 'user', content: `Task: ${task.goal('')}\nAgent answer:\n${answer || '(empty)'}\nFinal page text:\n${pageText.slice(0, 4000)}` },
      ],
    })
    const text = response.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return { ok: parsed.success === true, detail: String(parsed.reason ?? '').slice(0, 300) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function runModelTask(plugin, task, session, fixture) {
  const goal = task.goal(fixture.origin)
  const started = Date.now()
  try {
    const result = plugin.id === 'task'
      ? await runTask({ session, goal, complete: completeDeepseek, maxSteps: task.maxSteps })
      : await runToolLoop({
        tools: bind(plugin, session),
        complete: completeDeepseek,
        goal,
        system: plugin.systemPrompt,
        maxSteps: task.maxSteps,
      })
    const pageText = await session.snapshotText().catch(() => '')
    const localOk = task.check ? task.check(result.answer, { handoff: session.hold?.reason, passwords: fixture.posted }) : null
    const judged = task.check ? null : await judge(task, result.answer, pageText)
    return {
      id: task.id,
      ok: task.check ? localOk === true : judged?.ok === true,
      steps: result.steps,
      stopped: result.stopped,
      vision: result.vision,
      ms: Date.now() - started,
      answer: (result.answer || '').slice(0, 800),
      judge: judged?.detail ?? '',
      trace: result.trace.map(step => step.name),
    }
  } catch (error) {
    return {
      id: task.id,
      ok: false,
      steps: 0,
      ms: Date.now() - started,
      answer: '',
      error: error instanceof Error ? error.message : String(error),
      trace: [],
    }
  }
}

async function isolate(playwrightUrl) {
  const fixture = await startFixture()
  const profileRoot = join(tmpdir(), `bot-browser-${Date.now()}`)
  const open = (botId) => openBotBrowser({ botId, profileRoot, headless: true, playwrightUrl })
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
  await fixture.close()
  return {
    alphaSawCookie: alphaText.includes('bot=alpha'),
    betaSawCookie: betaText.includes('bot=alpha'),
    alphaKeptCookie: againText.includes('bot=alpha'),
  }
}

const onlyTasks = (process.env.BENCH_TASKS ?? '').split(',').map(item => item.trim()).filter(Boolean)
const onlyPlugins = (process.env.BENCH_PLUGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
const selectedTasks = onlyTasks.length ? tasks.filter(task => onlyTasks.includes(task.id)) : tasks
const selectedPlugins = onlyPlugins.length
  ? Object.fromEntries(Object.entries(plugins).filter(([name]) => onlyPlugins.includes(name)))
  : plugins

const fixture = await startFixture()
const profileRoot = join(tmpdir(), `bot-browser-bench-${Date.now()}`)
const driverSession = await openBotBrowser({ botId: 'driver', profileRoot, headless: true, playwrightUrl })
const driver = await drive(driverSession, fixture)
await driverSession.close()

const key = deepseekKey()
const results = {
  model: MODEL,
  endpoint: 'https://amr-link.open-design.ai/v1',
  key: key ? 'present' : 'missing',
  driver,
  isolation: await isolate(playwrightUrl),
  plugins: {},
}

if (!key) {
  for (const name of Object.keys(selectedPlugins)) results.plugins[name] = { skipped: 'OPENDESIGN_API_KEY is not set in this environment' }
} else {
  for (const [name, plugin] of Object.entries(selectedPlugins)) {
    const rows = []
    for (const task of selectedTasks) {
      fixture.posted.length = 0
      const session = await openBotBrowser({ botId: `${name}-${task.id}`.replace(/[^a-z0-9-]/gi, '-'), profileRoot, headless: true, playwrightUrl })
      console.log(`run ${name} ${task.id}`)
      const row = await runModelTask(plugin, task, session, fixture)
      console.log(`  ${row.ok ? 'ok' : 'fail'} steps=${row.steps} ${row.error ?? row.answer.slice(0, 80)}`)
      rows.push(row)
      await session.close()
    }
    results.plugins[name] = { rows }
  }
}

await fixture.close()
await mkdir(outDir, { recursive: true })
await writeFile(new URL('./results.json', outDir), JSON.stringify(results, null, 2))
console.log(JSON.stringify({ key: results.key, driver: results.driver, isolation: results.isolation }, null, 2))
