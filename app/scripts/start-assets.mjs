// Writes the generated blocks of the start page in src/start from the plugin's client modules
// in ../ds-bot (read only, as scripts/icon.mjs does):
// - start.html, between <!-- whale --> markers: the Main Bot's whale from characterMarkup('whale',
//   'deepseek'), cut at the tail stock into two copies so the tail can move on its own. The mask
//   is st-eyes, the clips st-tail-cut and st-torso-cut; the fill stays var(--bt-ink-deepseek).
// - start.css, between /* tokens */ markers: the DeepSeek theme's light and dark colors.
// - start.css, between /* springs */ markers: motion.js's springs as linear() curves.
// Usage: node scripts/start-assets.mjs [--check]   (--check exits 1 when a block is stale and
// writes nothing)
import { readFileSync, writeFileSync } from 'node:fs'
import { CHARACTERS, characterMarkup, MASK_ID } from '../../ds-bot/src/client/characters.js'
import { INKS } from '../../ds-bot/src/client/inks.js'
import { allThemes, themeCss } from '../../ds-bot/src/client/themes.js'

const client = new URL('../../ds-bot/src/client/', import.meta.url)
const page = new URL('../src/start/', import.meta.url)

const THEME_TOKENS = ['--bt-main', '--bt-card', '--bt-ink', '--bt-ink-2', '--bt-line', '--bt-line-2', '--bt-hover', '--bt-accent', '--bt-accent-ink']
// The status colors are the same in both modes; the plugin's base sheet defines them.
const BASE_TOKENS = ['--bt-green', '--bt-danger']
const SPRINGS = ['shape', 'tap', 'pop', 'stretch', 'list']

// Wraps the one self-closing element that starts with `start` in <g id>.
function wrap(markup, id, start) {
  const at = markup.indexOf(start)
  if (at < 0 || markup.indexOf(start, at + 1) >= 0) throw new Error(`${id}: expected exactly one match`)
  const stop = markup.indexOf('/>', at) + 2
  return `${markup.slice(0, at)}<g id="${id}">${markup.slice(at, stop)}</g>${markup.slice(stop)}`
}
function group(markup, start) {
  const at = markup.indexOf(start)
  const tags = /<g[\s>]|<\/g>/gu
  tags.lastIndex = at
  let depth = 0
  for (let match = tags.exec(markup); match !== null; match = tags.exec(markup)) {
    depth += match[0] === '</g>' ? -1 : 1
    if (depth === 0) return markup.slice(at, match.index + 4)
  }
  throw new Error('unclosed group')
}

function rig() {
  const whale = CHARACTERS.whale
  const raw = characterMarkup('whale', 'deepseek').replaceAll(MASK_ID, 'st-eyes')
  if (!raw.includes('fill="var(--bt-ink-deepseek)"')) throw new Error('the whale no longer fills with var(--bt-ink-deepseek)')
  const mask = raw.slice(raw.indexOf('<mask'), raw.indexOf('</mask>') + 7)
    .replace('<g class="bt-gaze">', '<g id="gaze" class="bt-gaze">')
    .replace('<g class="bt-eyes" fill="#000">', '<g id="eye-pair" class="bt-eyes" fill="#000">')
  let layers = group(raw, '<g fill-rule="evenodd">')
  layers = wrap(layers, 'w-body', `<path d="${whale.body}"`)
  layers = wrap(layers, 'w-belly', `<path d="${whale.paints[0][0]}"`)
  layers = wrap(layers, 'w-shade', `<path d="${whale.shade}"`)
  layers = wrap(layers, 'w-light', `<path d="${whale.light}"`)
  layers = layers.replace('<g fill-rule="evenodd">', '<g id="whale-layers" fill-rule="evenodd">')
  // The cut runs from the notch behind the upper fluke down through the bottom contour at the
  // pivot (27.9, 61.1), where the tail turns. The tail copy reaches 4 units past the cut under
  // the torso, so tipping the flukes opens no gap; at rest the two copies draw the plain whale.
  const top = [32.45, 52.05]
  const bottom = [23.35, 70.15]
  const pivot = [27.9, 61.1]
  const length = Math.hypot(bottom[0] - top[0], bottom[1] - top[1])
  const normal = [-(bottom[1] - top[1]) / length, (bottom[0] - top[0]) / length]
  const notch = [top[0] - normal[0] * 4, top[1] - normal[1] * 4].map(n => n.toFixed(2))
  const tailCut = `M-100 -100H${top[0]}V${top[1]}L${notch[0]} ${notch[1]}L${pivot[0]} ${pivot[1]}L${bottom[0]} ${bottom[1]}L${bottom[0]} 200H-100Z`
  const torsoCut = `M${top[0]} -100H200V200H-100V${bottom[1]}H${bottom[0]}L${top[0]} ${top[1]}Z`
  return `<svg class="whale-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs>${mask}`
    + `<clipPath id="st-tail-cut" clipPathUnits="userSpaceOnUse"><path d="${tailCut}"/></clipPath>`
    + `<clipPath id="st-torso-cut" clipPathUnits="userSpaceOnUse"><path d="${torsoCut}"/></clipPath>${layers}</defs>`
    + '<g class="bt-b"><g mask="url(#st-eyes)"><g id="tail"><use href="#whale-layers" clip-path="url(#st-tail-cut)"/></g>'
    + '<g id="torso"><use href="#whale-layers" clip-path="url(#st-torso-cut)"/></g></g></g></svg>'
}

const rules = css => [...css.matchAll(/\{([^}]*)\}/gu)].map(([, body]) => new Map(body.split(';').filter(Boolean).map(item => item.split(/:(.*)/su).slice(0, 2))))
function pick(vars, names, from) {
  return names.map((name) => {
    if (!vars.has(name)) throw new Error(`${from} no longer sets ${name}`)
    return `${name}:${vars.get(name)}`
  }).join(';')
}

function tokens() {
  const [light, dark] = rules(themeCss(allThemes().deepseek))
  const base = readFileSync(new URL('styles.js', client), 'utf8').match(/^body\{(--bt-[^}]*)\}$/mu)
  if (!base) throw new Error('styles.js: the base body rule was not found')
  const [ink, inkDark] = INKS.deepseek
  return [
    '/* Generated from the DeepSeek theme in ds-bot/src/client/themes.js, inks.js and styles.js by scripts/start-assets.mjs; do not edit. */',
    `:root{color-scheme:light dark;${pick(light, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${ink};${pick(rules(`{${base[1]}}`)[0], BASE_TOKENS, 'styles.js')}}`,
    `@media (prefers-color-scheme:dark){:root{${pick(dark, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${inkDark}}}`,
  ]
}

// motion.js imports React for its hooks; its springs are plain arithmetic, so the module runs
// here with the React names stubbed out.
async function motion() {
  const source = readFileSync(new URL('motion.js', client), 'utf8')
  const imports = source.match(/^import .*$/gmu) ?? []
  const react = imports.length === 1 ? imports[0].match(/^import \{([^}]*)\} from 'react'\r?$/u) : null
  if (!react) throw new Error('motion.js: expected its only import to be from react')
  const stub = `const {${react[1].replaceAll(' as ', ': ')}} = {}`
  return import(`data:text/javascript,${encodeURIComponent(source.replace(imports[0], stub))}`)
}

async function springs() {
  const curves = await motion()
  return [
    '/* Generated from ds-bot/src/client/motion.js by scripts/start-assets.mjs; do not edit. */',
    ':root {',
    ...SPRINGS.flatMap((name) => {
      const curve = curves[`SPRING_${name.toUpperCase()}`]
      if (!curve) throw new Error(`motion.js no longer exports SPRING_${name.toUpperCase()}`)
      return [`  --spring-${name}: ${curve.easing};`, `  --spring-${name}-ms: ${curve.duration}ms;`]
    }),
    '}',
  ]
}

// Replaces what lies between the two markers; a block of lines takes the file's own line ends,
// which git may have turned into CRLF on checkout.
function between(text, open, close, block) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = Array.isArray(block) ? `${eol}${block.join(eol)}${eol}` : block
  const a = text.indexOf(open)
  const b = text.indexOf(close, a + open.length)
  if (a < 0 || b < 0) throw new Error(`markers ${open} ${close} not found`)
  return `${text.slice(0, a + open.length)}${body}${text.slice(b)}`
}

const files = {
  'start.html': html => between(html, '<!-- whale -->', '<!-- /whale -->', rig()),
  'start.css': async css => between(between(css, '/* tokens */', '/* /tokens */', tokens()), '/* springs */', '/* /springs */', await springs()),
}
const check = process.argv.includes('--check')
const stale = []
for (const [name, generate] of Object.entries(files)) {
  const file = new URL(name, page)
  const text = readFileSync(file, 'utf8')
  const next = await generate(text)
  if (next === text) continue
  stale.push(name)
  if (!check) writeFileSync(file, next)
}
if (check && stale.length) {
  console.error(`start page: stale generated blocks in ${stale.join(', ')}; run node scripts/start-assets.mjs`)
  process.exit(1)
}
console.log(check ? 'start page: generated blocks are current' : stale.length ? `start page: wrote ${stale.join(', ')}` : 'start page: nothing to write')
