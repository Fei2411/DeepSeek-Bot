// The whale director: turns start snapshots into whale motion. The whale's place is the
// progress: it swims from stop to stop, leaves a resting ring at each stop it leaves, and keeps
// the hidden stage list (.station data-state, aria-current) for the live region and screen
// readers. start.js reads stage() to choose the whale's line.
// Layers (start.html): .whale-x legs > .whale-gaze pointer > .whale scale > .whale-move
// one-shots > .whale-loop CSS state loops > svg (#tail, #eye-pair, #gaze, .bt-eye).
// One-shots run on WAAPI and end with commitStyles() + cancel(); loops are CSS keyed on
// html[data-whale] and html[data-tail]. Every await is raced against a timer, because a
// hidden document stops ticking animations.
const root = document.documentElement
const rm = matchMedia('(prefers-reduced-motion: reduce)')
const tierNow = () => root.dataset.motion || 'normal'
// html[data-tier] is the tier the CSS reads; it follows data-motion (the snapshot's tier).
const syncTier = () => { if (root.dataset.tier !== tierNow()) root.dataset.tier = tierNow() }
syncTier()
new MutationObserver(syncTier).observe(root, { attributes: true, attributeFilter: ['data-motion'] })
export const reduced = () => rm.matches
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cs = el => getComputedStyle(el)
const clamp = v => Math.max(-1, Math.min(1, v))
const IDENTITY = /^(none|1|0px|0px 0px|matrix\(1, 0, 0, 1, 0, 0\))$/u
const CLEAR = ['transform', 'scale', 'translate']
const OUT = 'cubic-bezier(.4,0,.2,1)'
const HOP = 'cubic-bezier(.3,.7,.4,1)'
const PHASES = ['data', 'engine', 'team']
// An active station and a state loop each hold at least 400 ms; the margin covers the frame
// on which the change is painted.
const HOLD = 420
// The greeting's fade-in (.16 s, start.css) and hold (1.5 s, start.js): the whale sets off from
// the first stop no earlier.
const GREET_MS = 1660
// 「进去吧」 is on screen at least this long before the celebration starts; the page says when it
// went up (readyLine), and the director waits for that at most READY_CAP.
const READY_MS = 300
const READY_CAP = 600
// Hops land at .55 of their 1.3 s cycle; the lively tier spaces further hops out, never closer.
const HOP_MS = 1300
const LANDED = 0.55 * HOP_MS
const MORE_HOPS = [2600, 5200]
const HOP_EVERY = 9000
// Acts that only open, fold or copy something on the card; every other card button answers it.
const LOCAL = new Set(['toggleDetails', 'toggleMore', 'toggleModels', 'copyDetails'])
// Waits get calmer on the card's own clock: rates and blink gaps after 30 s and after 90 s.
const calmer = ms => (ms >= 90000 ? [0.6, 2] : ms >= 30000 ? [0.8, 1.4] : [1, 1])

const springs = {}
export function spring(name) {
  if (!springs[name]) {
    const style = cs(root)
    springs[name] = { duration: parseFloat(style.getPropertyValue(`--spring-${name}-ms`)) || 420, easing: style.getPropertyValue(`--spring-${name}`).trim() || 'ease-out' }
  }
  return springs[name]
}

let instant = false
// Plays keyframes; with `instant` (a resumed page) it writes the last frame and returns at once.
export function play(el, frames, opts) {
  if (instant) {
    for (const [key, value] of Object.entries(frames.at(-1))) if (key !== 'offset' && key !== 'easing') el.style[key] = CLEAR.includes(key) && IDENTITY.test(String(value)) ? '' : value
    return { done: Promise.resolve(), cancel() {}, finish() {}, commitStyles() {} }
  }
  const anim = el.animate(frames, { fill: 'forwards', ...opts })
  const count = opts.iterations ?? 1
  anim.done = count === Infinity ? new Promise(() => {}) : Promise.race([anim.finished.catch(() => {}), sleep((opts.delay ?? 0) + (opts.duration ?? 0) * count + 150)])
  return anim
}
// Ends a one-shot at its end state: finish, commit through CSSOM (CSP allows it), cancel.
export function settle(anim, el, commit = true) {
  if (!anim?.effect || anim.playState === 'idle') return
  try { if (anim.playState !== 'finished' && anim.effect.getComputedTiming().iterations !== Infinity) anim.finish() } catch { /* infinite */ }
  if (commit) try { anim.commitStyles() } catch { /* not rendered */ }
  anim.cancel()
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
const scripted = el => el.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))
// Replaces earlier one-shots on el, keeping the pose they have reached this frame (never
// their end state: finishing one mid-flight would teleport the whale).
function drop(el) {
  for (const a of scripted(el)) {
    try { a.commitStyles() } catch { /* not rendered */ }
    a.cancel()
  }
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
function to(el, props, opts) {
  const from = {}
  for (const key of Object.keys(props)) from[key] = cs(el)[key]
  drop(el)
  const anim = play(el, [from, props], opts)
  anim.done.then(() => settle(anim, el))
  return anim
}
const kf = (frames, easing) => frames.map(frame => ({ easing, ...frame }))
export const clamped = easing => easing.replace(/\d+\.\d+/gu, value => String(Math.min(1, Number(value))))

export function createDirector({ start, resume, act, label, announce, onCheck, onActive, onStage, readyLine }) {
  const $ = selector => document.querySelector(selector)
  const x = $('.whale-x'), gazeLayer = $('.whale-gaze'), body = $('.whale'), move = $('.whale-move'), loop = $('.whale-loop')
  const tail = $('#tail'), pair = $('#eye-pair'), lane = $('.lane'), ripple = $('.ripple'), hit = $('.whale-hit')
  const eyes = [...document.querySelectorAll('.bt-eye')], happy = [...document.querySelectorAll('.bt-eye-happy')]
  const stations = [...document.querySelectorAll('.station')]
  const traces = [...document.querySelectorAll('.trace')]
  const first = start === 'first'
  const u = (first ? 88 : 64) / 100
  const t0 = performance.now()
  const entranceMs = resume ? 0 : first ? 560 : 290
  const D = { at: 0, checks: 0, pose: 'enter', loop: '', card: '', slow: 0, bx: 0, by: 0, since: [t0], activeAt: [], loopAt: 0, hop: null, pet: null, poking: false, handed: false, workReady: first, missed: false, sinking: false,
    // Rest on a card: its clock, the lean, the breath, the lively hops; the last glance and press.
    clockKind: '', cardAt: 0, ready: false, readyAt: 0, lean: false, leanDue: false, leanOff: false, leanMine: -1, restMine: -1, breath: null, hopsStopped: false, legging: false, glanceAt: -Infinity, press: null, nodAt: 0 }
  const rnd = Math.random
  let want = { station: 0, view: 'boot', phase: 'data', done: [], card: '', missed: false, celebrate: first, update: '' }
  let token = 0
  let wake = () => {}
  let bumped = new Promise(resolve => { wake = resolve })
  // Timers of the rest on a card belong to one token; a new state drops them all.
  const timers = new Set()
  function later(mine, ms, fn) {
    const id = setTimeout(() => { timers.delete(id); if (mine === token) fn() }, Math.max(0, ms))
    timers.add(id)
  }
  const bump = () => {
    token += 1
    for (const id of timers) clearTimeout(id)
    timers.clear()
    stopBreath()
    unpress()
    wake()
    bumped = new Promise(resolve => { wake = resolve })
  }
  const until = promise => Promise.race([promise, bumped])
  const wait = ms => (instant ? Promise.resolve() : sleep(ms))
  const tier = tierNow
  const playful = () => tier() !== 'quiet' && !reduced()
  const failure = () => want.view === 'failed' || want.view === 'viewFailed' || want.card === 'importFailed'
  const entered = sleep(entranceMs).then(() => { root.dataset.entered = '' })
  // Finished entrance veils are dropped, so later fades of the same blocks stay composited.
  sleep(resume ? 0 : 700).then(() => { root.dataset.settled = '' })
  if (resume) instant = true
  if (!first) setTimeout(() => { D.workReady = true; if (D.started) kick() }, resume ? 0 : 1000)

  // ---- stages: the hidden list, and the rings the whale leaves behind ----
  const changed = () => onStage?.()
  function setStation(i, state) {
    const st = stations[i]
    if (!st || st.dataset.state === state) return
    st.dataset.state = state
    st.querySelector('.sr').textContent = label(`status.state.${state}`)
    if (state === 'active') st.setAttribute('aria-current', 'step')
    else st.removeAttribute('aria-current')
  }
  // A stop the whale leaves keeps a faint ring on the water: it opens like a ripple and settles
  // at the resting opacity of .trace[data-on], then never animates again. The quiet tier and
  // reduced motion only fade it in.
  function leaveTrace(i) {
    const ring = traces[i]
    if (!ring || ring.hasAttribute('data-on')) return
    ring.dataset.on = ''
    if (instant) return
    const rest = Number(cs(ring).opacity)
    const anims = reduced() || !playful()
      ? [play(ring, [{ opacity: 0 }, { opacity: rest }], { duration: reduced() ? 120 : 160, fill: 'none' })]
      : [play(ring, [{ scale: '.5' }, { scale: '1' }], { ...spring('shape'), fill: 'none' }), play(ring, [{ opacity: 0.9 }, { opacity: rest }], { duration: 420, easing: 'ease-out', fill: 'none' })]
    // Dropped once done, so the hand-off's opacity fade of the ring finds no other animation on
    // it and stays on the compositor.
    for (const a of anims) a.done.then(() => a.cancel())
  }
  function popCheck(i) {
    if (D.checks > i) return
    D.checks = i + 1
    setStation(i, 'done')
    // The last stop gets no ring: the whale dives there.
    if (i < 2) leaveTrace(i)
    announce(label('status.sr.done', { phase: label(`status.phase.${PHASES[i]}`) }))
    onCheck?.(i)
  }
  let activeTimer = 0
  function armActive() {
    clearTimeout(activeTimer)
    const i = D.at
    if (!first || D.handed || failure() || i > 2 || D.checks > i || stations[i].dataset.state !== 'pending') return
    if (i < 2 && want.done.includes(PHASES[i])) return
    const now = performance.now()
    const delay = Math.max(0, (D.since[i] ?? now) + 250 - now, t0 + entranceMs - now)
    activeTimer = setTimeout(() => {
      if (D.at !== i || stations[i].dataset.state !== 'pending' || failure() || (i < 2 && want.done.includes(PHASES[i]))) return
      setStation(i, 'active')
      D.activeAt[i] = performance.now()
      announce(label('status.sr.active', { phase: label(`status.phase.${PHASES[i]}`) }))
      onActive?.(i)
      changed()
    }, instant ? 0 : delay)
  }
  function place() {
    hit.style.setProperty('--hx', `${168 + D.at * 192}px`)
    ripple.style.setProperty('--rx', `${180 + D.at * 192}px`)
  }

  // ---- loops ----
  const capture = () => ({ loop: cs(loop).transform, tail: cs(tail).transform, pair: cs(pair).transform, eyes: eyes.map(eye => cs(eye).transform) })
  // Every pose change starts here and then slides .whale-loop from where it is, lean included.
  const stopLoop = () => { delete root.dataset.whale; delete root.dataset.tail; D.loop = ''; D.lean = false; clearTimeout(D.wander) }
  function slide(el, from, target, opts) {
    drop(el)
    if (from === 'none' && target === 'none') return null
    const anim = play(el, [{ transform: from }, { transform: target }], opts)
    anim.done.then(() => settle(anim, el))
    return anim
  }
  function release(pose, opts) {
    slide(loop, pose.loop, 'none', opts)
    slide(tail, pose.tail, 'none', opts)
    slide(pair, pose.pair, 'none', opts)
    eyes.forEach((eye, k) => slide(eye, pose.eyes[k], 'none', opts))
  }
  const START = { searching: { loop: 'rotate(-4deg)', pair: 'translateX(-12%)' }, pondering: { loop: 'rotate(4deg)', eye: 'translate(0,-4%) scaleY(.7)' } }
  async function startLoop(name) {
    const tailName = first && tier() !== 'quiet' ? ({ working: 'beat', sending: 'dash' }[name] ?? '') : ''
    if (D.loop === name) return
    const mine = token
    const pose = capture()
    stopLoop()
    if (!reduced()) {
      const shape = spring('shape')
      const begin = START[name] ?? {}
      slide(loop, pose.loop, begin.loop ?? 'none', shape)
      slide(pair, pose.pair, begin.pair ?? 'none', { duration: 240, easing: 'ease-out' })
      slide(tail, pose.tail, 'none', { duration: 240, easing: 'ease-out' })
      eyes.forEach((eye, k) => slide(eye, pose.eyes[k], begin.eye ?? 'none', { duration: 240, easing: 'ease-out' }))
      await until(wait(shape.duration))
      if (mine !== token) return
    }
    // The slides end on the loop's first frame, so dropping them in the same task as the
    // switch shows no jump.
    for (const el of [loop, pair, tail, ...eyes]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform') }
    root.dataset.whale = name
    if (tailName) root.dataset.tail = tailName
    D.loop = name
    D.loopAt = performance.now()
    if (D.slow === 1) calm()
    if (name === 'working') wanderLater()
  }
  // While it works at the second stop, the whale glances left or right now and then (§3, the
  // small reactions): every 5 to 9 s, a 600 ms look to one side at random, over the bob. Not in
  // the quiet tier, with reduced motion or while thinking, and not while the eyes follow the
  // pointer or a control, or look at the user.
  // Only the second stop of a first start: later and moving starts, and the copying cards, use
  // the working loop too.
  const wandering = () => first && D.at === 1 && !D.card && playful() && D.loop === 'working' && D.slow < 2
  function wanderLater() {
    clearTimeout(D.wander)
    if (!wandering()) return
    D.wander = setTimeout(() => { wander(); wanderLater() }, 5000 + 4000 * rnd())
  }
  function wander() {
    if (!wandering() || D.gazeHold || D.pet || D.poking || D.hop || D.handed || document.hidden) return
    if (pointer || (focused && focused === document.activeElement)) return
    const side = `translateX(${rnd() < 0.5 ? -14 : 14}%)`
    D.wanderAnim = play(pair, kf([{ transform: 'none' }, { transform: side, offset: 0.25 }, { transform: side, offset: 0.7 }, { transform: 'none' }], 'ease-in-out'), { duration: 600, fill: 'none' })
  }
  // A look at the user takes the eyes back from a glance to the side first.
  function unwander() {
    const a = D.wanderAnim
    if (!a) return
    D.wanderAnim = null
    if (a.playState !== 'running') return
    const from = cs(pair).transform
    a.cancel()
    if (from !== 'none') slide(pair, from, 'none', { duration: 120, easing: 'ease-out' })
  }
  // Calmer, never faster (S6): every running whale animation at .85, no phase jump.
  function calm() {
    for (const el of [loop, tail, pair, move, ...eyes]) for (const a of el.getAnimations()) if (a.playbackRate === 1) a.updatePlaybackRate(0.85)
  }
  // The 10 s glance and the return glance share one budget: at most one every 20 s.
  async function glance(poses = ['loop']) {
    const now = performance.now()
    if (!playful() || !poses.includes(D.pose) || D.gazeHold || now - D.glanceAt < 20000) return
    D.glanceAt = now
    D.gazeHold = true
    unwander()
    setGaze(0, -0.3)
    for (const eye of eyes) play(eye, kf([{ transform: 'none' }, { transform: 'scaleY(.03)', offset: 1 / 3 }, { transform: 'scaleY(.03)', offset: 5 / 9 }, { transform: 'none' }], 'ease-in-out'), { duration: 360, fill: 'none' })
    await sleep(600)
    D.gazeHold = false
    applyGaze()
  }

  // ---- one-shots ----
  function nod() {
    if (!playful() || instant || ['down', 'lift', 'dive'].includes(D.pose) || D.pet || D.poking || D.hop) return
    // One answer nods once, whichever listener asks first.
    if (performance.now() - D.nodAt < 150) return
    D.nodAt = performance.now()
    const a = play(move, [{ transform: 'none' }, { transform: 'translateY(2px) rotate(3deg)' }], { ...spring('tap'), fill: 'forwards' })
    setTimeout(() => {
      if (D.pet || D.hop || D.poking) return
      const from = cs(move).transform
      a.cancel()
      const b = play(move, [{ transform: from }, { transform: 'none' }], spring('shape'))
      b.done.then(() => settle(b, move))
    }, 160)
    const keep = [D.bx, D.by]
    setBase(keep[0], 0.6)
    setTimeout(() => { if (D.by === 0.6) setBase(keep[0], keep[1]) }, 300)
  }
  function hop(count) {
    const lift = `translateY(${(-8.1 * u).toFixed(2)}px) scale(.96,1.05)`
    const frames = kf([{ offset: 0, transform: 'none' }, { offset: 0.2, transform: lift }, { offset: 0.4, transform: 'translateY(0) scale(1.06,.94)' }, { offset: 0.55, transform: 'none' }, { offset: 1, transform: 'none' }], HOP)
    drop(move)
    return play(move, frames, { duration: HOP_MS, iterations: count, fill: 'none' })
  }
  function stopHop() {
    const a = D.hop
    if (!a) return
    D.hop = null
    const from = cs(move).transform
    a.cancel()
    if (from !== 'none') slide(move, from, 'none', spring('shape'))
  }
  function happyEyes(on, ms = 140) {
    eyes.forEach(eye => to(eye, { transform: on ? 'scaleY(0)' : 'none' }, { duration: ms, easing: on ? 'ease-in' : 'ease-out' }))
    happy.forEach(arc => to(arc, { opacity: on ? '1' : '0' }, { duration: 120, delay: on ? 100 : 0, easing: 'ease-out' }))
  }
  function petStart() {
    if (!playful() || !['alert', 'rest'].includes(D.pose) || D.pet || D.poking || D.handed) return
    stopHop()
    D.hopsStopped = true
    leanOut()
    const lean = `translate(${(4.6 * u).toFixed(2)}px, ${(-0.58 * u).toFixed(2)}px) rotate(8deg)`
    const nuzzle = `translate(${(7.4 * u).toFixed(2)}px, ${(-1.74 * u).toFixed(2)}px) rotate(14deg) scale(1.03, .97)`
    const a = to(move, { transform: lean }, spring('pop'))
    const b = play(move, [{ transform: lean }, { transform: nuzzle, offset: 0.5 }, { transform: lean }], { duration: 780, delay: 320, iterations: Infinity, easing: 'ease-in-out', fill: 'none' })
    happyEyes(true)
    D.pet = [a, b]
  }
  function petEnd() {
    if (!D.pet) return
    const from = cs(move).transform
    for (const a of D.pet) a.cancel()
    D.pet = null
    slide(move, from, 'none', spring('pop'))
    happyEyes(false)
    leanIn()
  }
  async function poke() {
    if (!first || !playful() || D.poking || D.pet || D.hop || D.handed || ['down', 'lift', 'dive', 'sunk', 'enter'].includes(D.pose)) return
    D.poking = true
    drop(move)
    move.style.transformOrigin = '50% 60%'
    const a = play(move, kf([{ transform: 'none' }, { transform: `translateY(${(-9.3 * u).toFixed(2)}px) rotate(360deg)`, offset: 0.55 }, { transform: 'translateY(0) scale(1.08,.92) rotate(360deg)', offset: 0.78 }, { transform: 'rotate(360deg)' }], HOP), { duration: 800, fill: 'none' })
    await a.done
    a.cancel()
    move.style.removeProperty('transform-origin')
    D.poking = false
  }
  function lookAround() {
    if (!playful()) return
    const side = v => `translateX(${v}%)`
    play(pair, kf([{ transform: 'none' }, { transform: side(-14), offset: 0.15 }, { transform: side(-14), offset: 0.4 }, { transform: side(14), offset: 0.55 }, { transform: side(14), offset: 0.85 }, { transform: 'none' }], 'ease-in-out'), { duration: 900, fill: 'none' })
  }
  function sendRipple() {
    if (!playful()) return
    play(ripple, [{ scale: '.5' }, { scale: '1.6' }], { ...spring('shape'), fill: 'none' })
    play(ripple, [{ opacity: 0.9 }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'none' })
  }

  // ---- rest on a card: lean, breath, blinks, lively hops (none in quiet, reduced or failure) ----
  const stirs = () => playful() && !failure()
  const px = v => (v * u / 0.88).toFixed(2)
  // Nose 2.5° down toward the sheet, 1.5 px forward, 1 px up (at 88 px), on .whale-loop, which
  // no loop uses while a card waits, so hops, nods and petting compose on top of it.
  const LEAN = () => `translate(${px(1.5)}px, ${px(-1)}px) rotate(2.5deg)`
  function leanAt(mine, ms) {
    D.leanDue = false
    D.leanOff = false
    D.leanMine = mine
    if (!stirs()) return
    if (instant) { D.leanDue = true; leanIn(); return }
    later(mine, ms, () => { D.leanDue = true; leanIn() })
  }
  function leanIn() {
    if (D.lean || !D.leanDue || D.leanOff || D.leanMine !== token || D.pet || D.handed || !stirs() || !['alert', 'rest'].includes(D.pose)) return
    D.lean = true
    to(loop, { transform: LEAN() }, spring('shape'))
  }
  function leanOut() {
    if (!D.lean) return
    D.lean = false
    to(loop, { transform: 'none' }, spring('shape'))
  }
  function breathe(mine) {
    if (D.breath || instant || !stirs() || D.pose !== 'rest') return
    // Compositor-only: the scale property on an HTML wrapper that nothing else scales.
    const a = gazeLayer.animate(kf([{ scale: '1' }, { scale: '1.008 1.018', offset: 0.45 }, { scale: '1' }], 'ease-in-out'), { duration: 4200, iterations: Infinity })
    D.breath = a
    const age = performance.now() - D.cardAt
    a.updatePlaybackRate(calmer(age)[0])
    const slower = () => { const rate = calmer(performance.now() - D.cardAt)[0]; if (D.breath === a && rate < a.playbackRate) a.updatePlaybackRate(rate) }
    for (const at of [30000, 90000]) if (age < at) later(mine, at - age, slower)
  }
  function stopBreath() {
    const a = D.breath
    if (!a) return
    D.breath = null
    const from = cs(gazeLayer).scale
    a.cancel()
    if (!reduced() && from !== 'none' && from !== '1') play(gazeLayer, [{ scale: from }, { scale: '1' }], { duration: 240, easing: 'ease-out', fill: 'none' })
  }
  const canBlink = () => stirs() && D.pose === 'rest' && !D.pet && !D.hop && !D.poking && !D.gazeHold && !D.handed && !root.dataset.eyes && !document.hidden && eyes.every(eye => !eye.style.transform && scripted(eye).length === 0)
  function blink() {
    if (!canBlink()) return
    for (const eye of eyes) {
      const a = play(eye, kf([{ transform: 'none' }, { transform: 'scaleY(.03)', offset: 0.48 }, { transform: 'scaleY(1.06)', offset: 0.78 }, { transform: 'none' }], 'ease-in-out'), { duration: 270, fill: 'none' })
      a.done.then(() => a.cancel())
    }
  }
  function blinkLater(mine, firstOne) {
    const gap = firstOne ? 1400 + 800 * rnd() : (3200 + 3600 * rnd()) * calmer(performance.now() - D.cardAt)[1]
    const double = rnd() < 0.2
    later(mine, gap, () => {
      blink()
      if (double) later(mine, 340, blink)
      blinkLater(mine, false)
    })
  }
  function resting(mine) {
    D.restMine = mine
    if (!stirs()) return
    later(mine, 600, () => breathe(mine))
    blinkLater(mine, true)
  }
  // Lively: after the two hops (starts 0 and 1.3 s), more at +2.6 s, +5.2 s, then every 9 s.
  function moreHops(mine, began) {
    let at = began + HOP_MS
    let k = 0
    const next = () => {
      at += MORE_HOPS[k] ?? HOP_EVERY
      k += 1
      later(mine, at - performance.now(), () => {
        if (D.hopsStopped || D.pose !== 'rest' || !stirs()) return
        if (D.pet || D.poking || D.hop) { next(); return }
        const a = hop(1)
        D.hop = a
        a.done.then(() => { if (D.hop === a) { D.hop = null; a.cancel() } })
        next()
      })
    }
    next()
  }

  // ---- poses ----
  async function leg(i, queued, ms) {
    D.legging = true
    changed()
    try { await swim(i, queued, ms) } finally { D.legging = false; changed() }
  }
  async function swim(i, queued, ms) {
    clearTimeout(activeTimer)
    petEnd()
    stopHop()
    const x0 = i * 192
    const x1 = x0 + 192
    const shape = spring('shape')
    const glideMs = ms || shape.duration
    if (reduced() || instant) {
      // Reduced motion: the whale never travels; the lane cross-fades and the ring fades in.
      if (!instant) await play(lane, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'none' }).done
      x.style.translate = `${x1}px 0`
      popCheck(i)
      D.at = i + 1
      place()
      if (!instant) await play(lane, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'none' }).done
      return
    }
    const pose = capture()
    stopLoop()
    release(pose, { duration: queued ? 160 : 120, easing: 'ease-out' })
    if (!queued) {
      to(body, { scale: '1.04 .96' }, { duration: 120, easing: OUT })
      to(move, { transform: 'translateX(-3px)' }, { duration: 120, easing: OUT })
      await sleep(120)
    }
    const timing = { duration: glideMs, easing: shape.easing }
    drop(x)
    // The glide is SPRING_SHAPE clamped at the target: its 2 % overshoot would settle back
    // leftwards, and the whale never swims backwards. Tilt and scale keep the full spring.
    const glide = play(x, [{ translate: `${x0}px 0` }, { translate: `${x1}px 0` }], { duration: glideMs, easing: clamped(shape.easing) })
    to(body, { scale: '1' }, timing)
    drop(move)
    const tilt = play(move, [{ transform: `${queued ? '' : 'translateX(-3px) '}rotate(-4deg)` }, { transform: 'none' }], timing)
    if (playful()) {
      const strokes = play(tail, [{ transform: 'none' }, { transform: 'rotate(10deg)' }, { transform: 'rotate(-10deg)' }, { transform: 'none' }], { duration: 200, iterations: 2, easing: 'ease-in-out', fill: 'none' })
      strokes.done.then(() => strokes.cancel())
      const gz = $('#gaze')
      const base = cs(gz).transform
      const lag = play(gz, [{ transform: `translateX(-1.5px)${base === 'none' ? '' : ` ${base}`}` }, { transform: base }], { duration: shape.duration, delay: 80, easing: shape.easing, fill: 'backwards' })
      lag.done.then(() => lag.cancel())
    }
    setTimeout(() => popCheck(i), 90)
    await glide.done
    settle(glide, x)
    settle(tilt, move)
    D.at = i + 1
    place()
  }
  async function runLegs(flush) {
    let ran = 0
    while (D.at < want.station) {
      const i = D.at
      if (!ran && !flush) {
        // The whale greets before it sets off (§4): on a first start it leaves the first stop
        // only once the greeting has been readable, in the next stage's loop meanwhile. The
        // data stage is usually done before the page has painted, and the whale would
        // otherwise be gone as it surfaced.
        const greeted = first && i === 0 && !resume && want.view === 'boot' ? t0 + GREET_MS : 0
        if (greeted > performance.now()) await phaseLoop()
        const holdTo = Math.max(D.activeAt[i] ? D.activeAt[i] + HOLD : 0, D.loopAt ? D.loopAt + HOLD : 0, greeted)
        if (holdTo > performance.now()) await wait(holdTo - performance.now())
      }
      await leg(i, ran > 0 || flush, flush ? Math.min(420, Math.floor(600 / (want.station - i))) : 0)
      ran += 1
    }
    if (!ran) return
    D.loopAt = 0
    armActive()
    if (!flush && D.at <= 2 && !(D.at < 2 && want.done.includes(PHASES[D.at]))) nod()
  }
  // A failed stage is only marked in the hidden list: the whale's pose says it, nothing is drawn.
  function failStation() {
    if (!first) return
    const i = want.view === 'viewFailed' ? 2 : Math.min(D.at, Math.max(0, PHASES.indexOf(want.phase)))
    clearTimeout(activeTimer)
    if (D.checks > i) return
    D.failed = i
    setStation(i, 'failed')
  }
  async function goDown() {
    if (['down', 'lift'].includes(D.pose)) return
    stopHop()
    petEnd()
    D.pose = 'down'
    D.card = ''
    D.clockKind = ''
    // A failed import leaves the phases as they were; only a failed start crosses a station.
    if (want.view === 'failed' || want.view === 'viewFailed') failStation()
    const pose = capture()
    stopLoop()
    setBase(0.2, 0.6)
    if (reduced()) { root.dataset.eyes = 'heavy'; return }
    const shape = spring('shape')
    release(pose, shape)
    eyes.forEach((eye, k) => slide(eye, pose.eyes[k], 'translateY(1.5px) scaleY(.55)', shape))
    to(body, { scale: '1' }, shape)
    await until(to(move, { transform: 'translateY(4px) rotate(4deg)' }, shape).done)
  }
  async function lift() {
    if (D.pose !== 'down') return
    D.pose = 'lift'
    setBase(0.4, -0.4)
    if (reduced()) return
    const shape = spring('shape')
    eyes.forEach(eye => to(eye, { transform: 'translateY(1px) scaleY(.8)' }, shape))
    await until(to(move, { transform: 'translateY(2px)' }, shape).done)
  }
  async function shakeOff() {
    D.pose = 'loop'
    delete root.dataset.eyes
    setBase(0, 0)
    if (D.failed !== undefined) {
      const i = D.failed
      D.failed = undefined
      setStation(i, 'pending')
      armActive()
      changed()
    }
    if (reduced()) { for (const el of [move, ...eyes]) el.style.removeProperty('transform'); return }
    const shape = spring('shape')
    to(move, { transform: 'none' }, shape)
    eyes.forEach(eye => to(eye, { transform: 'none' }, shape))
    drop(body)
    const s = play(body, kf([{ scale: '1' }, { scale: '.94 1.08', offset: 0.4 }, { scale: '1.03 .97', offset: 0.75 }, { scale: '1' }], OUT), { duration: 800 })
    await s.done
    settle(s, body)
  }
  async function resetRun() {
    // A new folder or a blank team: sink, fade the rings, resurface at the first stop. The
    // whale's line and the hint go quiet while it is under (stage().sinking).
    D.sinking = true
    changed()
    petEnd()
    stopHop()
    const pose = capture()
    stopLoop()
    const fadeOut = el => play(el, [{ opacity: Number(cs(el).opacity) }, { opacity: 0 }], { duration: 160 })
    if (!reduced()) {
      release(pose, spring('shape'))
      to(move, { transform: 'translateY(64px)' }, spring('shape'))
      play(move, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })
      await wait(spring('shape').duration)
    } else await fadeOut(lane).done
    const rings = traces.filter(ring => ring.hasAttribute('data-on'))
    const outs = rings.map(fadeOut)
    await Promise.all(outs.map(a => a.done))
    for (let i = 0; i < 3; i += 1) setStation(i, 'pending')
    D.at = 0
    D.checks = 0
    D.failed = undefined
    D.since = [performance.now()]
    D.activeAt = []
    delete root.dataset.eyes
    for (const el of [x, move, body, lane, ...eyes]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('translate'); el.style.removeProperty('opacity'); el.style.removeProperty('scale') }
    for (const ring of rings) { delete ring.dataset.on; for (const a of scripted(ring)) a.cancel(); ring.style.removeProperty('opacity'); ring.style.removeProperty('scale') }
    place()
    D.sinking = false
    changed()
    D.pose = 'loop'
    setBase(0, 0)
    if (!reduced()) {
      const up = play(move, [{ transform: 'translateY(64px) rotate(-12deg)' }, { transform: 'none' }], { ...spring('stretch'), fill: 'none' })
      await up.done
    }
    armActive()
  }
  // Another state on the same card (a leg, a retry that missed): the rest starts over.
  function restAgain(mine) {
    if (D.pose === 'alert' && !D.hop) D.pose = 'rest'
    if (D.pose !== 'rest' || D.restMine === mine) return
    leanAt(mine, 0)
    resting(mine)
  }
  async function cardPose() {
    const kind = want.view === 'watchdog' ? 'watchdog' : want.card
    const mine = token
    if (kind === D.card && !(want.missed && !D.missed)) { restAgain(mine); return }
    const previous = D.card
    D.card = kind
    if (kind !== D.clockKind) { D.clockKind = kind; D.cardAt = performance.now(); D.hopsStopped = false }
    if (kind === 'missing' && want.missed && !D.missed) {
      D.missed = true
      if (previous === 'missing') { lookAround(); restAgain(mine); return }
    }
    if (kind !== 'missing') D.missed = false
    if (kind === 'copying' || kind === 'newerUpdating') { stopHop(); D.pose = 'loop'; setBase(0, 0); await startLoop('working'); return }
    if (kind === 'importFailed') return goDown()
    stopHop()
    const pose = capture()
    stopLoop()
    if (!reduced()) release(pose, spring('shape'))
    setBase(0.2, 0.6)
    // Cards the user caused (picked, rejected, the stop confirmation) do not hop; they lean in
    // as the morph starts (the content veils in 70 ms later).
    const count = { recommend: 2, missing: 2, import: 2, newer: 2, watchdog: 2, importSpace: 1 }[kind] ?? 0
    if (!count || reduced()) { D.pose = 'rest'; leanAt(mine, 70); resting(mine); return }
    D.pose = 'alert'
    const began = performance.now()
    const a = hop(count)
    D.hop = a
    leanAt(mine, (count - 1) * HOP_MS + LANDED)
    await until(a.done)
    if (D.hop === a) stopHop()
    if (mine !== token) return
    D.pose = 'rest'
    resting(mine)
    if (tier() === 'lively' && count === 2) moreHops(mine, began)
  }
  async function phaseLoop() {
    stopHop()
    petEnd()
    D.card = ''
    D.clockKind = ''
    D.missed = false
    D.pose = 'loop'
    setBase(0, 0)
    if (reduced()) root.dataset.eyes = D.slow >= 2 ? 'squint' : ''
    const name = D.slow >= 2 ? 'pondering' : !first ? (D.workReady ? 'working' : '') : ({ data: 'searching', engine: 'working', team: 'sending' }[want.phase] ?? '')
    if (name) await startLoop(name)
    else if (D.loop || D.lean) { const pose = capture(); stopLoop(); release(pose, { duration: 240, easing: 'ease-out' }) }
  }
  async function handoff() {
    if (D.handed) return
    clearTimeout(activeTimer)
    stopHop()
    petEnd()
    if (first) {
      // The whale says 「进去吧」 (start.js reads stage().ready) as soon as the team is ready; a
      // leg still to swim and the last stop's hold run while it is on screen, and the
      // celebration waits until it has been there READY_MS.
      if (!D.ready) { D.ready = true; D.readyAt = performance.now(); changed() }
      await runLegs(true)
      // An active stage stays at least 400 ms before it is done (no flash of 'in progress').
      const shownAt = stations[2].dataset.state === 'active' ? D.activeAt[2] ?? 0 : 0
      if (shownAt && performance.now() < shownAt + HOLD) await wait(shownAt + HOLD - performance.now())
      if (!instant) {
        const said = await Promise.race([readyLine ? readyLine() : Promise.resolve(D.readyAt), sleep(READY_CAP).then(() => performance.now())])
        if (said + READY_MS > performance.now()) await sleep(said + READY_MS - performance.now())
      }
    }
    D.handed = true
    D.pose = 'dive'
    applyGaze()
    const celebrate = want.celebrate
    const begin = performance.now()
    const at = ms => sleep(Math.max(0, begin + ms - performance.now()))
    if (first) popCheck(2)
    const pose = capture()
    stopLoop()
    if (reduced()) {
      // Reduced: the content fades over .12 s; the celebration is only the ^ ^ eyes.
      if (celebrate && tier() !== 'quiet') root.dataset.eyes = 'happy'
      await at(first ? 300 : 0)
      root.dataset.exit = 'caption all lane'
      await at((first ? 300 : 0) + 120)
      act('handoffShow')
      await at((first ? 300 : 0) + 140)
      act('handoffDone')
      return
    }
    release(pose, { duration: 200, easing: 'ease-out' })
    if (first) {
      const diveAt = celebrate ? 460 : 300
      if (celebrate) {
        drop(body)
        play(body, kf([{ scale: '1' }, { scale: '1.12 .88', offset: 240 / 460 }, { scale: '.93 1.09' }], OUT), { duration: 460 })
        if (playful()) { happyEyes(true); play(tail, [{ transform: 'none' }, { transform: 'rotate(12deg)' }, { transform: 'none' }], { duration: 400, easing: 'ease-in-out', fill: 'none' }) }
      }
      await at(160)
      root.dataset.exit = 'caption'
      await at(diveAt)
      root.dataset.exit = 'caption all'
      dive(18, DEEP(), 24, spring('shape'))
      await at(diveAt + 100)
      sendRipple()
      await at(diveAt + 160)
      act('handoffShow')
      await at(diveAt + 420)
      act('handoffDone')
      return
    }
    let lead = 0
    if (celebrate) {
      lead = 920
      drop(body)
      play(body, kf([{ scale: '1' }, { scale: '1.12 .88', offset: 240 / 920 }, { scale: '.93 1.09', offset: 460 / 920 }, { scale: '1.04 .97', offset: 680 / 920 }, { scale: '1' }], OUT), { duration: 920 })
      if (playful()) happyEyes(true)
      root.dataset.exit = 'caption'
      await at(lead)
    }
    root.dataset.exit = 'caption all'
    dive(12, DEEP(), 18, spring('tap'))
    await at(lead + 120)
    act('handoffShow')
    await at(lead + 290)
    act('handoffDone')
  }
  // 1.25 x the whale's height: fully under the waterline within about 200 ms, so the window
  // can grow around an empty sheet.
  const DEEP = () => Math.round(125 * u)
  function dive(dx, dy, deg, curve) {
    to(body, { scale: '1' }, curve)
    to(move, { transform: `translate(${dx}px, ${dy}px) rotate(${deg}deg)` }, curve)
    if (playful() && first) play(tail, [{ transform: 'none' }, { transform: 'rotate(-12deg)', offset: 0.48 }, { transform: 'none' }], { duration: 420, easing: 'ease-out', fill: 'none' })
  }

  // ---- pointer and keyboard focus ----
  let pointer = null
  let focused = null
  let keyboard = false
  let frame = 0
  function setGaze(gx, gy) {
    x.style.setProperty('--gx', gx.toFixed(3))
    x.style.setProperty('--gy', gy.toFixed(3))
  }
  // The eyes look at the pointer, or at a control that keyboard focus reached, until the next
  // pointer move. The whale's hit box moves with the stations, so it is measured each time.
  function applyGaze() {
    frame = 0
    if (reduced()) return setGaze(0, 0)
    let gx = D.bx
    let gy = D.by
    const control = focused && focused === document.activeElement && focused.checkVisibility() ? focused.getBoundingClientRect() : null
    const target = control ? { x: control.left + control.width / 2, y: control.top + control.height / 2 } : pointer
    if (target && playful() && !D.gazeHold && !D.handed && !failure() && !['down', 'lift', 'dive'].includes(D.pose)) {
      const rect = hit.getBoundingClientRect()
      gx = clamp((target.x - (rect.left + rect.width / 2)) / 160)
      gy = clamp((target.y - (rect.top + rect.height / 2)) / 160)
    }
    setGaze(gx, gy)
  }
  function setBase(bx, by) { D.bx = bx; D.by = by; applyGaze() }
  window.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY }; focused = null; frame ||= requestAnimationFrame(applyGaze) }, { passive: true })
  root.addEventListener('pointerleave', () => { pointer = null; applyGaze() })
  hit.addEventListener('pointerenter', petStart)
  hit.addEventListener('pointerleave', petEnd)
  hit.addEventListener('click', poke)
  // Keyboard focus only: the card's own focus move after a pointer answer is not followed.
  window.addEventListener('keydown', () => { keyboard = true }, true)
  window.addEventListener('pointerdown', () => { keyboard = false }, true)
  document.addEventListener('focusin', (event) => {
    const el = event.target
    if (!keyboard || !el.matches?.('button, input[type=checkbox]') || !el.closest('.sheet, .caption') || !el.matches(':focus-visible')) return
    focused = el
    applyGaze()
  })

  // ---- answering a card: press anticipation, nod, lean released ----
  const answering = target => { const button = target?.closest?.('.card button[data-act]'); return button && !LOCAL.has(button.dataset.act) ? button : null }
  function unpress() {
    const button = D.press
    if (!button) return
    D.press = null
    button.removeEventListener('pointerleave', unpress)
    to(body, { scale: '1' }, spring('tap'))
  }
  document.addEventListener('pointerdown', (event) => {
    const button = answering(event.target)
    if (!button || event.button !== 0 || instant || !stirs() || D.handed || D.legging || ['down', 'lift', 'dive', 'sunk', 'enter'].includes(D.pose)) return
    unpress()
    D.press = button
    button.addEventListener('pointerleave', unpress)
    to(body, { scale: '1.03 .97' }, { duration: 120, easing: OUT })
  })
  document.addEventListener('pointercancel', unpress)
  // A press that ends without a click (the button went away under it) springs back too.
  document.addEventListener('pointerup', () => { if (D.press) setTimeout(unpress, 0) })
  // Capture phase: this runs before start.js sends the act, so a state that the act brings
  // drops the lean's return timer with the old token. The act itself is never delayed.
  document.addEventListener('click', (event) => {
    const button = answering(event.target)
    if (!button) return
    unpress()
    if (!stirs()) return
    const mine = token
    D.hopsStopped = true
    D.leanOff = true
    leanOut()
    // A card that stays (a model picked on the import card, logs opened) leans in again.
    later(mine, 1000, () => { D.leanOff = false; leanIn() })
    nod()
  }, true)

  // ---- coming back to the window: one glance at the user ----
  let blurAt = 0
  let hiddenAt = 0
  function returnGlance(since) {
    if (!since || performance.now() - since < 5000) return
    if (!stirs() || D.legging || D.handed || D.hop || D.pet || D.poking) return
    glance(['loop', 'rest'])
  }
  window.addEventListener('blur', () => { blurAt = performance.now() })
  window.addEventListener('focus', () => { returnGlance(blurAt); blurAt = 0 })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = performance.now(); return }
    returnGlance(hiddenAt)
    hiddenAt = 0
  })

  // ---- reconcile ----
  async function step() {
    await entered
    if (want.view === 'handoff') return handoff()
    if (D.pose === 'enter') { D.pose = 'loop'; place(); armActive() }
    if (D.over || want.station < D.checks) { D.over = false; await resetRun() }
    if (!failure() && ['down', 'lift', 'redo'].includes(D.pose)) await shakeOff()
    await runLegs(false)
    if (want.view === 'handoff') return handoff()
    if (failure()) {
      if (D.pose === 'redo') D.pose = 'loop'
      await goDown()
      if (['available', 'downloading', 'installing'].includes(want.update)) await lift()
      else if (want.update === 'failed' && D.pose === 'lift') { D.pose = 'loop'; await goDown() }
      return
    }
    if (want.view === 'card' || want.view === 'watchdog') return cardPose()
    return phaseLoop()
  }
  let pumping = false
  let again = false
  function kick() {
    again = true
    if (pumping) return
    pumping = true
    ;(async () => {
      try {
        while (again) { again = false; await step(); instant = false }
      } catch (error) { console.error(error) } finally { pumping = false; instant = false }
    })()
  }

  return {
    // Where the whale is, for its line: the stop it is at (0-2), the stage shown active there (or
    // -1), whether it is swimming to the next stop, and whether it has said 「进去吧」.
    stage: () => ({ at: D.at, active: stations.findIndex(st => st.dataset.state === 'active'), legging: D.legging, ready: D.ready, sinking: D.sinking }),
    update(s) {
      const done = s.done ?? []
      const now = performance.now()
      if (done.includes('data') && !want.done.includes('data')) D.since[1] = now
      if (done.includes('engine') && !want.done.includes('engine')) D.since[2] = now
      let station = 0
      if (first && done.includes('data')) station = done.includes('engine') ? 2 : 1
      const next = { station, view: s.view, phase: s.phase, done, card: s.card?.kind ?? '', missed: Boolean(s.card?.missedRetry), celebrate: Boolean(s.celebrate), update: s.update?.state ?? '' }
      // Stages taken back mean a start in another folder: the whale starts over even when the
      // next snapshot, a moment later, has the first stage done again.
      if (D.started && station < want.station) D.over = true
      const changed = !D.started || ['station', 'view', 'phase', 'card', 'missed', 'update'].some(key => next[key] !== want[key])
      want = next
      D.started = true
      if (changed) { bump(); kick() }
    },
    slow(level) {
      if (level === D.slow) return
      const previous = D.slow
      D.slow = level
      if (level === 0) {
        D.glanced = false
        for (const el of [loop, tail, pair, move, ...eyes]) for (const a of el.getAnimations()) if (a.playbackRate !== 1) a.updatePlaybackRate(1)
      }
      if (level === 1) { calm(); if (!D.glanced) { D.glanced = true; glance() } }
      if (level === 2 || previous === 2) { bump(); kick() }
    },
    nod,
    // Live switch of reduced motion or of the tier: running one-shots jump to their end.
    refresh() {
      stopBreath()
      D.press = null
      for (const el of [x, body, move, loop, tail, pair, lane, ripple, ...traces, ...eyes, ...happy]) for (const a of scripted(el)) settle(a, el)
      D.hop = null
      D.pet = null
      D.lean = false
      if (reduced()) {
        for (const el of [gazeLayer, body, move, loop, ...eyes, ...happy]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('scale'); el.style.removeProperty('opacity') }
        root.dataset.eyes = ['down', 'lift'].includes(D.pose) ? 'heavy' : D.slow >= 2 ? 'squint' : ''
        applyGaze()
        return
      }
      delete root.dataset.eyes
      if (['down', 'lift'].includes(D.pose)) D.pose = 'redo'
      D.loop = ''
      D.card = ''
      bump()
      kick()
    },
  }
}
