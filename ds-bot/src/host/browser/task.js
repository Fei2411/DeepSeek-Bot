// One goal in, one answer out. The plugin runs the ref tools itself and returns
// the step list, so a Bot can hand off a whole web task and still check what happened.
import { completeDeepseek } from './deepseek.js'
import { runToolLoop } from './loop.js'
import { systemPrompt as refsPrompt, toolDefs as refTools } from './refs.js'

const driverTools = (session) => refTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args) => tool.execute(args, { session, botId: session.botId, profileDir: session.userDataDir }),
  }))

export async function runTask({ session, goal, complete = completeDeepseek, maxSteps = 8 }) {
  const result = await runToolLoop({
    tools: driverTools(session),
    complete,
    goal,
    system: refsPrompt,
    maxSteps,
  })
  const steps = result.trace.map(step => `${step.name} ${JSON.stringify(step.args)}`).join('\n')
  const text = [
    result.answer || '(no answer)',
    '',
    result.stopped === 'max-steps' ? `Stopped after ${result.steps} steps.` : `Finished in ${result.steps} steps.`,
    'Steps:',
    steps || '(none)',
  ].join('\n')
  return { ...result, text }
}

export const id = 'task'
export const label = 'Whole task'
export const systemPrompt = 'Call browser_task once with the user\'s web goal. The tool runs the browser and returns the answer plus the steps it took. Posting, uploading, downloading, and deleting may need approval; deletes require a second confirmed click after checking the snapshot. Payments, logins, and captchas go to the user via browser_handoff. If an action result is unknown, check with browser_snapshot and never repeat it blindly. Do not browse with any other tool.'

export const toolDefs = [
  {
    name: 'browser_task',
    needsBrowser: true,
    description: 'Run a whole web task in this Bot\'s browser: open pages, read them, click, and type. Returns the answer and the steps. Login, payment, and captcha are handed to the user.',
    parameters: {
      goal: { type: 'string', required: true, description: 'What to do on the web, including the address when you know it' },
    },
    async execute(args, ctx) {
      const result = await runTask({
        session: ctx.session,
        goal: String(args.goal ?? ''),
        complete: ctx.complete,
      })
      return { text: result.text }
    },
  },
]

export const tools = toolDefs
