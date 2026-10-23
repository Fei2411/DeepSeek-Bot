import { INKS } from './inks.js'
import { DEFAULT_MASK } from './characters.js'
import { MENTION_ORIGIN } from './text.js'
import { SPRING_SHAPE, SPRING_TAP, SPRING_STRETCH, SPRING_POP, spring } from './motion.js'

// The pill stretches for "Memory updated" on SPRING_STRETCH, and its icon pops on
// SPRING_POP; it closes on SPRING_SHAPE.

// A sidebar skin may seat DSH's footer outlets in a footer of its own; matching the
// outlets keeps that footer on one row whatever the skin names its boxes. The shell's
// own footer is left to the _footArea rules, which lay it out differently.
const SKIN_FOOT = ':is(div,footer):not([class*="_footArea"]):has(> div > [data-slot="sidebar.footer.action"] > .bt-connect-wrap)'

// The base styles split the way the surface groups do. SHELL_CSS carries the marks,
// the Bot sidebar, every overlay, and the shell chrome they reshape; markup shared
// with the overlays (the exchange dialog reuses bubbles, the Secrets page reuses
// question-card fields) stays here so a plain view keeps it styled.
// CONVERSATION_CSS re-skins the shell's own conversation DOM and styles what only
// the conversation renders.
export const SHELL_CSS = `
body{--bt-ink:#141414;--bt-danger:#e02135;--bt-ink-2:rgba(20,20,20,.6);--bt-ink-3:rgba(20,20,20,.36);--bt-bubble:#eeeeee;--bt-sidebar:#f7f7f7;--bt-main:#fcfcfc;--bt-line:rgba(20,20,20,.08);--bt-line-2:rgba(20,20,20,.15);--bt-line-weak:rgba(20,20,20,.1);--bt-hover:rgba(119,119,119,.09);--bt-active:rgba(119,119,119,.17);--bt-card:#ffffff;--bt-accent:#4d6bfe;--bt-green:#00c972;--bt-star:#ff9800;--bt-user:#070707;--bt-user-ink:#fcfcfc;--bt-tag-bg:rgba(20,20,20,.06);--bt-tag-ink:rgba(20,20,20,.56);--bt-knob:#ffffff;-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
/* iOS waits out a double-tap zoom on buttons; the plugin's own controls never zoom. */
:is(.bt-tool,.bt-uaction,.bt-menu button,.bt-menu-item,.bt-icon-btn,.bt-round,.bt-pill,.bt-account,.bt-set-row,.bt-settings-item,.bt-react-strip button,.bt-palette-row,.bt-palette-clear,.bt-tab,.bt-ptab,.bt-ptab-x,.bt-bcard-x,.bt-plus,.bt-q-btn,.bt-q-x,.bt-x,.bt-nc-send,.bt-send,.bt-soft,.bt-mini,.bt-shape,.bt-swatch,.bt-color,.bt-newchat,.bt-task-day,.bt-task-remove,.bt-fb-btn){touch-action:manipulation}
body[data-ds-dark-theme]{--bt-ink:#f2f2f2;--bt-ink-2:rgba(242,242,242,.6);--bt-ink-3:rgba(242,242,242,.36);--bt-bubble:#262626;--bt-sidebar:#1b1b1b;--bt-main:#141414;--bt-line:rgba(255,255,255,.08);--bt-line-2:rgba(255,255,255,.15);--bt-line-weak:rgba(255,255,255,.1);--bt-hover:rgba(160,160,160,.12);--bt-active:rgba(160,160,160,.2);--bt-card:#1f1f1f;--bt-user:#f2f2f2;--bt-user-ink:#141414;--bt-tag-bg:rgba(255,255,255,.09);--bt-tag-ink:rgba(242,242,242,.62)}
${Object.entries(INKS).map(([name, [light]]) => `body{--bt-ink-${name}:${light}}`).join('')}
${Object.entries(INKS).map(([name, [, dark]]) => `body[data-ds-dark-theme]{--bt-ink-${name}:${dark}}`).join('')}
.bt-mark{display:inline-block;flex:none;position:relative;line-height:0}
.bt-mark svg{width:100%;height:100%;overflow:visible}
.bt-mark-img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-mark .bt-b,.bt-mark .bt-eye,.bt-mark .bt-eyes,.bt-mark .bt-gaze{transform-box:fill-box}
.bt-mark .bt-b{transform-origin:50% 100%}
.bt-mark .bt-eye,.bt-mark .bt-eyes{transform-origin:center}
/* Motion levels (Settings → Bots → Animation) set body[data-bt-motion]: quiet moves a
   mark only for its state; normal, the default, adds petting, pokes and eyes that follow
   the pointer; lively adds blinks and fidgets at rest and a question riding on the head. */
body[data-bt-motion=lively] .bt-mark[data-live]:is([data-state=idle],[data-state=alert]) .bt-eye{animation:bt-blink-idle 5s linear infinite;animation-delay:var(--bt-delay,0s)}
body[data-bt-motion=lively] .bt-mark[data-live][data-state=idle]:is([data-fidget=hop],[data-fidget=sway],[data-fidget=stretch]) :is(.bt-b,.bt-mark-img){animation:var(--bt-fidget) 9s ease-in-out var(--bt-fidget-delay,0s) infinite}
body[data-bt-motion=lively] .bt-mark[data-live][data-state=idle][data-fidget=hop]{--bt-fidget:bt-fidget-hop}
body[data-bt-motion=lively] .bt-mark[data-live][data-state=idle][data-fidget=sway]{--bt-fidget:bt-fidget-sway}
body[data-bt-motion=lively] .bt-mark[data-live][data-state=idle][data-fidget=stretch]{--bt-fidget:bt-fidget-stretch}
body[data-bt-motion=lively] .bt-mark[data-live][data-state=idle][data-fidget=look] .bt-eyes{animation:bt-fidget-look 9s ease-in-out var(--bt-fidget-delay,0s) infinite}
@keyframes bt-fidget-hop{0%,8%,100%{transform:none}3%{transform:translateY(-10%) scale(.97,1.04)}5.5%{transform:translateY(0) scale(1.05,.95)}}
@keyframes bt-fidget-sway{0%,10%,100%{transform:none}2.5%{transform:rotate(-8deg)}5%{transform:rotate(7deg)}7.5%{transform:rotate(-3deg)}}
@keyframes bt-fidget-stretch{0%,9%,100%{transform:none}4%{transform:scale(.94,1.08)}7%{transform:scale(1.03,.97)}}
@keyframes bt-fidget-look{0%,22%,100%{transform:none}3%,9%{transform:translateX(-14%)}12%,19%{transform:translateX(14%)}}
body[data-bt-motion=lively] .bt-badge-alert{right:auto;bottom:auto;left:50%;top:calc(var(--bt-size,36px) * -.14);translate:-50% 0;animation:bt-q-ride 1.3s cubic-bezier(.3,.7,.4,1) infinite}
body[data-bt-motion=lively] :is(.bt-row,.bt-tile)>.bt-mark:hover .bt-badge-alert{animation:none}
@keyframes bt-q-ride{0%,55%,100%{transform:translateY(0)}20%{transform:translateY(calc(var(--bt-size,36px) * -.14))}40%{transform:translateY(0)}}
/* Petting: with the pointer on a sidebar avatar or just around it (a ring a fifth of its
   size wide), a resting mark leans into the pointer and keeps nuzzling it, its eyes
   closed in a happy arc, and springs back when the pointer leaves. */
:is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster)::before{content:'';position:absolute;inset:-20%;border-radius:50%}
.bt-mark[data-live] .bt-b,.bt-mark[data-live] .bt-mark-img{transition:rotate .5s cubic-bezier(.34,1.56,.64,1),translate .5s cubic-bezier(.34,1.56,.64,1),scale .3s ease-out}
.bt-mark[data-live] .bt-eye{transition:scale .14s ease-in}
.bt-mark[data-live] .bt-eye-happy{transition:opacity .12s ease-out}
body:not([data-bt-motion=quiet]) :is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster):hover .bt-mark[data-live]:is([data-state=idle],[data-state=alert]):not(.bt-mark-poke) :is(.bt-b,.bt-mark-img){rotate:8deg;translate:5% -1%;animation:bt-nuzzle .78s ease-in-out .32s infinite}
body:not([data-bt-motion=quiet]) :is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster):hover .bt-mark[data-live]:is([data-state=idle],[data-state=alert]) .bt-eye{scale:1 0;animation:none}
body:not([data-bt-motion=quiet]) :is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster):hover .bt-mark[data-live]:is([data-state=idle],[data-state=alert]) .bt-eye-happy{opacity:1;transition-delay:.1s}
@keyframes bt-nuzzle{50%{rotate:14deg;translate:8% -3%;scale:1.03 .97}}
.bt-mark[data-gaze] .bt-b{translate:calc(var(--bt-gx,0) * 5%) calc(var(--bt-gy,0) * 4%);transition:translate .18s ease-out}
.bt-mark[data-gaze] .bt-gaze{transform:translate(calc(var(--bt-gx,0) * 12%),calc(var(--bt-gy,0) * 11%));transition:transform .18s ease-out}
body[data-bt-motion=quiet] .bt-mark[data-gaze] .bt-b{translate:none}
body[data-bt-motion=quiet] .bt-mark[data-gaze] .bt-gaze{transform:none}
.bt-mark[data-state=thinking] .bt-b{animation:bt-ponder 2.2s ease-in-out infinite}
.bt-mark[data-state=thinking] .bt-eyes{animation:bt-squint 2.2s ease-in-out infinite}
.bt-mark[data-state=searching] .bt-b{animation:bt-seek 1s ease-in-out infinite}
.bt-mark[data-state=searching] .bt-eyes{animation:bt-scan 1.6s ease-in-out infinite}
.bt-mark[data-state=working] .bt-b{animation:bt-bob 1.6s ease-in-out infinite}
.bt-mark[data-state=working]:is([data-shape=star],[data-shape=hex],[data-shape=plus],[data-shape=gem],[data-shape=magnet],[data-shape=ring]) .bt-b{animation:bt-wiggle 1.4s ease-in-out infinite;transform-origin:50% 50%}
.bt-mark[data-state=working]:is([data-shape=gumdrop],[data-shape=peanut],[data-shape=cushion],[data-shape=squircle],[data-shape=moon],[data-shape=wave]) .bt-b{animation:bt-squash 1.2s ease-in-out infinite}
.bt-mark[data-state=working] .bt-eye{animation:bt-blink 2.4s ease-in-out infinite}
.bt-mark[data-state=sending] .bt-b{animation:bt-dash 1.1s cubic-bezier(.4,0,.2,1) infinite}
/* Waiting for teammates to hand back work circles like coordinating them. */
.bt-mark:is([data-state=orbit],[data-state=waiting]) .bt-b{animation:bt-sway 2.6s ease-in-out infinite;transform-origin:50% 50%}
.bt-mark:is([data-state=orbit],[data-state=waiting]) .bt-eyes{animation:bt-roll 2.6s linear infinite}
/* A question for you hops twice when it arrives and the badge keeps it in view after;
   a lively mark keeps hopping. */
.bt-mark[data-state=alert] .bt-b{animation:bt-hop 1.3s cubic-bezier(.3,.7,.4,1) 2}
.bt-mark[data-shape=image]:not([data-state=idle]) .bt-mark-img{animation:bt-bob 1.6s ease-in-out infinite}
.bt-mark[data-shape=image][data-state=alert] .bt-mark-img{animation:bt-hop 1.3s cubic-bezier(.3,.7,.4,1) 2}
body[data-bt-motion=lively] .bt-mark[data-state=alert] :is(.bt-b,.bt-mark-img){animation-iteration-count:infinite}
.bt-mark[data-state=done] .bt-b{animation:bt-done 1.8s linear 1}
.bt-mark[data-shape=image][data-state=done] .bt-mark-img{animation:bt-done 1.8s linear 1;transform-origin:50% 100%}
@keyframes bt-done{0%{transform:none;animation-timing-function:cubic-bezier(.4,0,.2,1)}13.3%{transform:scale(1.12,.88);animation-timing-function:cubic-bezier(.4,0,.2,1)}25.6%{transform:scale(.93,1.09);animation-timing-function:cubic-bezier(.4,0,.2,1)}37.8%{transform:scale(1.04,.97);animation-timing-function:cubic-bezier(.4,0,.2,1)}51.1%,100%{transform:none}}
.bt-mark-poke .bt-b{animation:bt-poke .8s cubic-bezier(.3,.7,.4,1) 1!important;transform-origin:50% 60%!important}
.bt-mark-poke .bt-mark-img{animation:bt-poke-img .6s ease-out 1!important}
.bt-mark[data-poke]{cursor:pointer}
body[data-bt-motion=quiet] .bt-mark-poke :is(.bt-b,.bt-mark-img){animation:none!important}
body[data-bt-motion=quiet] .bt-mark[data-poke]{cursor:default}
@keyframes bt-bob{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-4%) rotate(-5deg)}65%{transform:translateY(0) rotate(4deg)}}
@keyframes bt-wiggle{0%,100%{transform:rotate(0) scale(1)}25%{transform:rotate(-12deg) scale(1.04)}75%{transform:rotate(12deg) scale(1.04)}}
@keyframes bt-squash{0%,100%{transform:scale(1,1)}30%{transform:scale(1.08,.9)}55%{transform:translateY(-4%) scale(.94,1.08)}80%{transform:scale(1.02,.98)}}
@keyframes bt-ponder{0%,100%{transform:translateY(0) rotate(4deg)}50%{transform:translateY(-3%) rotate(7deg)}}
@keyframes bt-squint{0%,100%{transform:translate(0,-4%) scaleY(.7)}50%{transform:translate(5%,-5%) scaleY(.78)}}
@keyframes bt-seek{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5%) rotate(-1deg)}}
@keyframes bt-scan{0%,100%{transform:translateX(-12%)}50%{transform:translateX(12%)}}
@keyframes bt-dash{0%,100%{transform:translateX(0) rotate(0)}35%{transform:translateX(9%) rotate(7deg)}55%{transform:translateX(-2%) rotate(-3deg)}}
@keyframes bt-sway{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}
@keyframes bt-roll{0%,100%{transform:translate(12%,0)}25%{transform:translate(0,9%)}50%{transform:translate(-12%,0)}75%{transform:translate(0,-9%)}}
@keyframes bt-hop{0%,55%,100%{transform:translateY(0) scale(1,1)}20%{transform:translateY(-14%) scale(.96,1.05)}40%{transform:translateY(0) scale(1.06,.94)}}
@keyframes bt-poke{0%{transform:none}55%{transform:translateY(-16%) rotate(360deg)}78%{transform:translateY(0) scale(1.08,.92) rotate(360deg)}100%{transform:rotate(360deg)}}
@keyframes bt-poke-img{0%,100%{transform:scale(1)}40%{transform:scale(1.14) rotate(-6deg)}}
/* Idle clip: two .26s blinks (lid to 3%, then a 6% overshoot) at 1.48s and 3.46s. */
@keyframes bt-blink-idle{0%,29.6%,35%,69.2%,74.6%,100%{transform:scaleY(1)}32.2%,71.8%{transform:scaleY(.03)}33.8%,73.4%{transform:scaleY(1.06)}}
@keyframes bt-blink{0%,42%,50%,100%{transform:scaleY(1)}46%{transform:scaleY(.03)}48%{transform:scaleY(1.06)}}
@media (prefers-reduced-motion:reduce){.bt-mark *{animation:none!important;transition:none!important}}
.bt-badge{position:absolute;right:0;bottom:0;width:12px;height:12px;border-radius:50%;corner-shape:round;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-badge-admin{background:color-mix(in srgb,var(--bt-star) 82%,var(--bt-sidebar))}
.bt-badge-admin svg{width:7px;height:7px}
.bt-badge-main{right:calc(var(--bt-size,36px) * -.07);bottom:calc(var(--bt-size,36px) * -.07);width:clamp(14px,calc(var(--bt-size,36px) * .36),22px);height:clamp(14px,calc(var(--bt-size,36px) * .36),22px);border-radius:0;box-shadow:none}
.bt-badge-main svg{width:100%;height:100%;overflow:visible}
.bt-badge-main path{fill:var(--bt-star);stroke:var(--bt-sidebar);stroke-width:2.6;stroke-linejoin:round;paint-order:stroke}
.bt-badge-alert{background:color-mix(in srgb,var(--bt-accent) 78%,var(--bt-sidebar));color:var(--bt-accent-ink,#fff);font-size:8.5px;line-height:12px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-badge-working{background:color-mix(in srgb,var(--bt-green) 82%,var(--bt-sidebar));width:8px;height:8px;right:1px;bottom:1px}
.bt-cluster{position:relative;display:inline-block;flex:none;line-height:0}
.bt-cluster>*{position:absolute}
.bt-cluster-more,.bt-cluster-you{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:var(--bt-active);color:var(--bt-ink-3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-weight:500;line-height:1;font-variant-numeric:tabular-nums}
.bt-cluster-you{background:color-mix(in srgb,var(--bt-ink) 12%,transparent)}
.bt-stack{display:inline-flex;align-items:center;flex:none;line-height:0}
.bt-stack>*+*{margin-left:calc(var(--bt-stack-size) * -.3)}
.bt-stack-more{font-size:11px;line-height:16px;color:var(--bt-ink-3);margin-left:3px!important}

.bt-side{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;gap:2px;padding:0 12px 8px 0;color:var(--bt-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-side-top{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:6px 5px 0 0}
.bt-brand{display:inline-flex;align-items:center;gap:6px;margin-right:auto;padding:4px 8px 4px 4px;border:0;border-radius:8px;background:none;cursor:pointer;font-family:inherit;font-size:15px;line-height:20px;font-weight:600;letter-spacing:-.01em;color:var(--bt-ink);white-space:nowrap}
.bt-brand-whale{display:inline-flex;color:var(--bt-accent)}
.bt-round{width:36px;height:36px;border-radius:50%;border:1px solid var(--bt-line);background:var(--bt-main);color:var(--bt-ink);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background-color .12s ease,transform .12s ease}
.bt-round:hover{background:var(--bt-hover)}
.bt-round:active{transform:scale(.94)}
.bt-list{display:flex;flex-direction:column;gap:3px;overflow-y:auto;min-height:0;flex:1 1 auto}
.bt-tile-wrap{display:flex;justify-content:center;padding:20px 0 15px}
.bt-tile{display:flex;flex-direction:column;align-items:center;gap:4px;width:95px;padding:6px 8px 4px;border-radius:12px;border:0;background:transparent;color:var(--bt-ink);cursor:pointer;font-family:inherit;transition:background-color .12s ease}
.bt-tile:hover{background:var(--bt-hover)}
.bt-tile[aria-current=page]{background:var(--bt-active)}
.bt-tile-name{font-size:13px;line-height:18px;font-weight:400;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-chip{font-size:11px;line-height:16px;padding:1px 4px;border-radius:4px;background:var(--bt-hover);border:1px solid var(--bt-line);color:var(--bt-ink-2);white-space:nowrap;max-width:84px;overflow:hidden;text-overflow:ellipsis}
.bt-row{display:flex;align-items:center;gap:8px;min-height:54px;padding:8px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer;width:100%;box-sizing:border-box;font-family:inherit;transition:background-color .12s ease}
.bt-row:hover{background:var(--bt-hover)}
.bt-row[aria-current=page]{background:var(--bt-active)}
.bt-row-body{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.bt-row-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:14px;line-height:20px;font-weight:400}
.bt-row-title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-tag{flex:none;max-width:96px;font-size:12px;line-height:16px;font-weight:400;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-row-preview{font-size:13px;line-height:18px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-unread{width:8px;height:8px;border-radius:50%;background:var(--bt-accent);flex:none;margin-right:2px;animation:bt-fade .13s cubic-bezier(.22,1,.36,1)}
.bt-unread-wait{background:var(--bt-star)}
.bt-rail{align-items:center;padding:0 0 8px}
.bt-rail .bt-row{justify-content:center;padding:6px 0;min-height:44px}
.bt-side-foot{display:flex;padding-top:8px}
.bt-connect{flex:1;height:36px;border-radius:999px;border:1px solid var(--bt-line);background:var(--bt-main);color:var(--bt-ink);font-family:inherit;font-size:14px;line-height:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background-color .12s ease}
.bt-connect:hover{background:var(--bt-hover)}
.bt-connect svg{flex:none;width:15px;height:15px}
.bt-connect-wrap{position:relative;display:flex;flex:1 1 auto;min-width:0}

.bt-head{position:relative;display:flex;justify-content:center;align-items:center;height:40px;flex:none;pointer-events:none}
.bt-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;height:40px;padding:7.5px 13.5px 7.5px 7.5px;border-radius:999px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);color:var(--bt-ink);font-family:inherit;font-size:14px;line-height:20px;cursor:pointer;max-width:70%;box-sizing:border-box;transition:background-color .12s ease,transform ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-pill:hover{background:color-mix(in srgb,var(--bt-main),#777 9%)}
.bt-pill:active{transform:scale(.965)}
.bt-pill-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.bt-pill-mem{flex:none;display:inline-flex;width:0;margin-left:-8px;overflow:hidden;transition:${spring(SPRING_SHAPE, 'width', 'margin-left')}}
.bt-pill[data-memory=updated] .bt-pill-mem{width:var(--bt-mem-w);margin-left:0;transition:${spring(SPRING_STRETCH, 'width', 'margin-left')}}
.bt-pill-mem-in{flex:none;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:var(--bt-ink-2);font-size:13px;font-weight:500;opacity:0;filter:blur(6px);transform:translateX(-8px);transition:opacity .14s ease,filter .18s ease,${spring(SPRING_SHAPE, 'transform')}}
.bt-pill-mem-in::before{content:"";flex:none;width:1px;height:14px;margin-right:4px;background:var(--bt-line-2)}
.bt-pill[data-memory=updated] .bt-pill-mem-in{opacity:1;filter:none;transform:none;transition-delay:70ms}
.bt-pill-mem-ico{flex:none;display:inline-flex;width:16px;height:16px;color:var(--bt-accent)}
.bt-pill-mem-ico svg{width:16px;height:16px}
.bt-pill[data-memory=updated] .bt-pill-mem-ico{animation:bt-mem-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} 90ms both}
@keyframes bt-mem-pop{from{transform:scale(.4) rotate(-14deg)}to{transform:none}}
.bt-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){.bt-pill-mem,.bt-pill-mem-in{transition:none!important}.bt-pill-mem-in{filter:none;transform:none}.bt-pill[data-memory=updated] .bt-pill-mem-ico{animation:none}}
.bt-swap{color:var(--bt-ink-3);font-size:12px}
.bt-pill-go{flex:none;display:inline-flex;align-items:center;justify-content:flex-end;width:0;margin-left:-8px;overflow:hidden;opacity:0;filter:blur(6px);transform:translateX(-6px);color:var(--bt-ink-2);transition:width ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},margin-left ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},transform ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},opacity .18s ease,filter .18s ease}
.bt-pill-go svg{flex:none;transition:transform ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-pill:hover .bt-pill-go,.bt-pill:focus-visible .bt-pill-go,.bt-pill[aria-expanded=true] .bt-pill-go{width:18px;margin-left:0;opacity:1;filter:none;transform:none}
.bt-pill[aria-expanded=true] .bt-pill-go svg{transform:rotate(180deg)}
.bt-pill[data-memory=updated]:is(:hover,:focus-visible,[aria-expanded=true]) .bt-pill-go{width:0;margin-left:-8px;opacity:0;filter:blur(6px);transform:translateX(-6px)}
@media (prefers-reduced-motion:reduce){.bt-pill,.bt-pill-go,.bt-pill-go svg{transition:none!important}.bt-pill-go{filter:none}.bt-pill:active{transform:none}}

/* The width settings: the share of the column a bubble may take, and the flat text. */
body{--bt-msg-w:.8;--bt-flat-w:1}
.bt-astack{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:0}
.bt-bubble{max-width:min(calc(var(--bt-msg-w) * 100%),calc(100% - 82px));background:var(--bt-bubble);color:var(--bt-ink);border-radius:18px;padding:7px 12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(var(--dsh-content-font-size,14px) + 8px);box-sizing:border-box;overflow-wrap:anywhere}
.bt-msg:not(:first-child)>.bt-msg-line>.bt-bubble{border-start-start-radius:6px}
.bt-msg:not(:last-child)>.bt-msg-line>.bt-bubble{border-end-start-radius:6px}
.bt-bubble [class*="_markdown"]>*+*{margin-top:10px}
.bt-bubble [class*="_markdown"]{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-bubble p{margin:0}
.bt-bubble p + p{margin-top:6px}
.bt-bubble ul,.bt-bubble ol{margin:4px 0;padding-left:20px}
.bt-bubble a[href^="${MENTION_ORIGIN}"]{text-decoration:none;font-weight:400;cursor:pointer;white-space:nowrap}
.bt-bubble a[href^="${MENTION_ORIGIN}"]::before{content:"";display:inline-block;width:16px;height:16px;margin-right:3px;vertical-align:-3px;background:currentColor;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}
.bt-group-msg{display:flex;flex-direction:column;gap:4px;margin:16px 0 0}
.bt-group-msg:first-child{margin-top:0}
.bt-lead{flex:none;display:flex;margin-bottom:1px}
button.bt-lead{border:0;background:none;padding:0;cursor:pointer}
/* Rows without the avatar start where the bubble beside it starts: 22px avatar + 8px gap. */
.bt-astack[data-lead]>.bt-msg:not(:last-child)>.bt-msg-line,.bt-astack[data-lead] .bt-reacts{margin-left:30px}
.bt-group-name{font-size:12px;line-height:16px;font-weight:500;margin-left:42px}
.bt-group-name:has(>.bt-lead){display:flex;align-items:center;margin:0 0 2px;font-size:13px;line-height:22px;font-weight:600;color:var(--bt-ink)}
.bt-group-name>.bt-lead{margin:0 8px 0 0}
.bt-group-time,.bt-group-took{margin-left:6px;font-size:11px;line-height:16px;font-weight:400;color:var(--bt-ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-x{border:0;background:none;color:var(--bt-ink-2);cursor:pointer;width:24px;height:24px;border-radius:6px;font-size:16px;line-height:24px;padding:0;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-x:hover{background:var(--bt-hover);color:var(--bt-ink)}

.bt-q{margin:0 auto 8px;width:100%;max-width:var(--dsh-chat-content-width,748px);display:flex;flex-direction:column;gap:12px;--bt-q-edge:color-mix(in srgb,var(--bt-ink) 10%,transparent);--bt-q-rule:color-mix(in srgb,var(--bt-ink) 8%,transparent);--bt-q-rule-2:color-mix(in srgb,var(--bt-ink) 5%,transparent);background:var(--bt-card);box-shadow:0 1px 3px rgba(20,20,20,.04),inset 0 0 0 1px var(--bt-q-edge);border-radius:16px;padding:14px 16px;box-sizing:border-box;color:var(--bt-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
body[data-ds-dark-theme] .bt-q{--bt-q-edge:rgba(255,255,255,.16);--bt-q-rule:rgba(255,255,255,.12);--bt-q-rule-2:rgba(255,255,255,.08)}
@keyframes bt-q-in{from{transform:translateY(10px) scale(.97)}}
.bt-q-settled{animation:none}
.bt-q-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-q-text{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
.bt-q-title{margin:0;font-size:15px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.bt-q-detail{font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-q-x{flex:none;width:20px;height:20px;border:0;padding:0;border-radius:6px;background:none;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-q-x svg{width:14px;height:14px}
.bt-q-x:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-q-x:focus-visible,.bt-q-opt:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-q-list{display:flex;flex-direction:column;gap:1px;min-width:0;box-sizing:border-box;margin:0 -8px}
.bt-q-opt{position:relative;display:flex;align-items:flex-start;gap:16px;width:100%;min-width:0;box-sizing:border-box;margin:0;border:0;border-radius:12px;background:transparent;padding:10px 8px;font:inherit;color:var(--bt-ink);text-align:start;cursor:pointer;transition:background-color .12s ease}
.bt-q:not(.bt-q-raised)>.bt-q-head:has(+.bt-q-list){padding-bottom:12px;border-bottom:1px solid var(--bt-q-rule)}
.bt-q:not(.bt-q-raised)>.bt-q-head+.bt-q-list{margin-top:-6px}
.bt-q-opt+.bt-q-opt::before{content:"";position:absolute;left:calc(var(--bt-key,24px) + 24px);right:8px;top:-1px;height:1px;background:var(--bt-q-rule-2);transition:opacity .12s ease;pointer-events:none}
button.bt-q-opt:hover::before,button.bt-q-opt:hover+.bt-q-opt::before,.bt-q-opt[aria-pressed=true]::before,.bt-q-opt[aria-pressed=true]+.bt-q-opt::before{opacity:0}
.bt-q-raised .bt-q-opt::before{display:none}
button.bt-q-opt:hover{background:var(--bt-hover)}
button.bt-q-opt:active{background:var(--bt-active)}
.bt-q-opt[aria-pressed=true]{background:var(--bt-active)}
.bt-q:not(.bt-q-raised) :is(button.bt-q-opt:hover,.bt-q-opt[aria-pressed=true]) .bt-key{background:var(--bt-card);color:var(--bt-ink)}
.bt-key{flex:none;box-sizing:border-box;width:var(--bt-key,24px);height:var(--bt-key,24px);border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:12px;line-height:var(--bt-key,24px);font-weight:500;text-align:center;font-variant-numeric:tabular-nums;transition:background-color .12s ease,color .12s ease}
.bt-q-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;padding-top:2px}
/* With a description the key spans the two text lines less 2px above and below. */
.bt-q-opt:has(.bt-q-desc){--bt-key:34px}
.bt-q-opt:has(.bt-q-desc) .bt-key{margin-top:2px;border-radius:10px;font-size:13px}
.bt-q-opt:has(.bt-q-desc) .bt-q-body{padding-top:0}
.bt-q-label{font-size:14px;line-height:20px;font-weight:500;white-space:normal;overflow-wrap:anywhere}
.bt-q-desc{font-size:12px;line-height:17px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-q-check{flex:none;display:inline-flex;align-items:center;color:var(--bt-ink-2);animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-q-settled .bt-q-check{animation:none}
.bt-q-check svg{width:16px;height:16px}
.bt-q-settled .bt-key{opacity:.4}
.bt-q-settled .bt-q-label{color:color-mix(in srgb,var(--bt-ink) 45%,transparent)}
.bt-q-dismissed .bt-q-title{color:var(--bt-ink-2)}
.bt-q.bt-q-settled{gap:6px;padding:12px 16px}
.bt-q-settled .bt-q-title{font-size:14px;line-height:20px;font-weight:500}
.bt-q.bt-q-settled>.bt-q-head:has(+.bt-q-list){padding-bottom:0;border-bottom:0}
.bt-q.bt-q-settled>.bt-q-head+.bt-q-list{margin-top:0}
.bt-q-settled .bt-q-opt{padding:4px 8px}
.bt-q-badge{flex:none;height:20px;padding:0 7px;border-radius:999px;border:1px dotted var(--bt-line-2);color:var(--bt-ink-2);font-size:12px;line-height:18px;box-sizing:border-box}
.bt-q-custom{display:flex;align-items:flex-start;gap:8px;width:100%;min-width:0}
.bt-q-field{flex:1 1 0;min-width:0;display:flex;box-sizing:border-box;min-height:32px;padding:5px 11px;border-radius:8px;border:.5px solid var(--bt-line-2);background:none;cursor:text;transition:border-color .12s ease}
.bt-q-field:focus-within{border-color:color-mix(in srgb,var(--bt-ink) 30%,transparent)}
.bt-q-input{flex:1;width:100%;min-width:0;max-height:120px;margin:0;padding:0;border:0;outline:none;background:transparent;color:var(--bt-ink);font:inherit;font-size:14px;line-height:20px;resize:none;overflow-y:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-q-input:not(:placeholder-shown){field-sizing:content}
.bt-q-input::placeholder{color:var(--bt-ink-3)}
.bt-q-submit,.bt-q-btn{flex:none;height:36px;padding:0 14px;border:0;border-radius:999px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:opacity .12s ease,background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-q-submit{background:var(--bt-accent);color:var(--bt-accent-ink,#fff);animation:bt-q-submit-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing} backwards,bt-veil-in .16s ease-out backwards}
@keyframes bt-q-submit-in{from{transform:translateX(8px) scale(.9)}}
.bt-q-submit:hover:not(:disabled){opacity:.86}
.bt-q-submit:disabled{opacity:.4;cursor:default}
.bt-q-btn{background:var(--bt-hover);color:var(--bt-ink)}
.bt-q-btn:hover{background:var(--bt-active)}
.bt-q-foot{display:flex;justify-content:flex-end;gap:8px}
.bt-q-raised{width:calc(var(--dsh-chat-content-width,748px) - 32px);max-width:calc(100% - 32px);gap:0;padding:0;box-shadow:0 2px 8px rgba(20,20,20,.035),inset 0 0 0 .5px color-mix(in srgb,var(--bt-ink) 5%,transparent)}
.bt-q-raised .bt-q-head{padding:14px 16px 4px 20px}
.bt-q-raised .bt-q-head:last-child{padding-bottom:16px}
.bt-q-raised .bt-q-list{gap:1px;margin:0;padding:8px}
.bt-q-raised .bt-q-opt{gap:4px;padding:7px;border-radius:16px;color:var(--bt-ink-2)}
.bt-q-raised button.bt-q-opt:hover{color:var(--bt-ink)}
.bt-q-raised .bt-q-opt[aria-pressed=true]{background:transparent;color:var(--bt-ink)}
.bt-q-raised .bt-q-opt[aria-pressed=true]:hover{background:var(--bt-hover)}
.bt-q-raised .bt-q-opt[aria-pressed=true] .bt-key,.bt-q-ownrow:focus-within .bt-key,.bt-q-ownrow[data-filled] .bt-key{background:var(--bt-user);color:var(--bt-user-ink)}
.bt-q-raised .bt-q-body{padding:2px 6px 0}
.bt-q-raised .bt-q-desc{color:color-mix(in srgb,var(--bt-ink) 61%,transparent)}
.bt-q-ownrow{cursor:text}
.bt-q-ownrow .bt-q-input{color:var(--bt-ink)}
.bt-q-raised .bt-q-foot{padding:0 8px 8px}
@media (prefers-reduced-motion:reduce){.bt-q{animation:bt-fade .12s ease-out backwards}.bt-q-settled{animation:none}.bt-q-submit{animation:none}}

.bt-newchat{flex:1;display:flex;flex-direction:column;min-width:0;position:relative;animation:bt-veil-in .18s ease-out}
.bt-to{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:48px;padding:6px 12px;border-bottom:1px solid var(--bt-line);font-size:14px;box-sizing:border-box}
.bt-to-label{color:var(--bt-ink-2)}
.bt-to input{flex:1;min-width:120px;border:0;outline:none;background:none;color:var(--bt-ink);font-size:14px;height:26px}
.bt-token{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 6px 0 4px;border-radius:999px;background:var(--bt-hover);font-size:13px;animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-token button{border:0;background:none;color:var(--bt-ink-2);cursor:pointer;padding:0 2px}
.bt-admin-star{flex:none;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;corner-shape:round;background:color-mix(in srgb,var(--bt-star) 82%,var(--bt-sidebar));vertical-align:-1px}
.bt-to-star{display:inline-flex;margin-right:-2px;animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-to .bt-to-create{flex:none;height:28px;padding:0 12px;font-size:13px;animation:bt-q-submit-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out}
.bt-drop{position:absolute;top:48px;left:32px;width:min(550px,calc(100% - 64px));display:flex;flex-direction:column;padding:6px;max-height:min(420px,60vh);overflow-y:auto;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:12px;box-shadow:0 6px 20px -4px rgba(0,0,0,.12);box-sizing:border-box;z-index:1;transform-origin:24px 0;animation:bt-pop-drop ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .14s ease-out}
.bt-option{display:flex;align-items:center;gap:10px;border:0;background:none;border-radius:8px;padding:7px 8px;min-height:36px;box-sizing:border-box;font-size:13px;line-height:18px;color:var(--bt-ink);cursor:pointer;text-align:left;width:100%}
.bt-option[aria-selected=true]{background:var(--bt-active)}
.bt-drop-list>.bt-option:not([aria-selected=true]):hover{background:var(--bt-hover)}
.bt-option-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-option-hint{font-size:11px;color:var(--bt-ink-2);flex:none;animation:bt-veil-in .16s ease-out}
.bt-option-icon{width:22px;height:22px;border-radius:50%;background:var(--bt-hover);color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;flex:none}
.bt-hint{padding:14px;text-align:center;font-size:13px;color:var(--bt-ink-2)}
.bt-nc-spacer{flex:1}
.bt-nc-compose{padding:0 16px 14px;display:flex;justify-content:center}
.bt-nc-card{display:flex;align-items:flex-end;gap:6px;width:100%;max-width:var(--dsh-chat-content-width,748px);min-height:44px;padding:4px 6px;border-radius:22px;border:1px solid var(--bt-line-2);background:var(--bt-main);box-shadow:0 2px 8px -2px rgba(0,0,0,.06);box-sizing:border-box}
.bt-nc-plus{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2);background:var(--bt-hover);flex:none}
.bt-nc-card textarea{flex:1;resize:none;border:0;outline:none;background:none;color:var(--bt-ink);font:inherit;font-size:14px;line-height:20px;padding:7px 4px;min-height:34px;max-height:140px;box-sizing:border-box}
.bt-nc-send{width:34px;height:34px;border-radius:50%;border:0;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.bt-nc-send:disabled{opacity:.3;cursor:default}
.bt-create{flex:1;display:flex;flex-direction:column;min-width:0}
.bt-create-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:48px;padding:6px 12px;border-bottom:1px solid var(--bt-line);box-sizing:border-box}
.bt-create-gap{width:28px}
.bt-create-title{font-size:14px;line-height:20px;font-weight:500}
.bt-create-body{flex:1;overflow-y:auto;padding:28px 16px 32px;display:flex;justify-content:center}
.bt-create-card{width:100%;max-width:400px;display:flex;flex-direction:column;gap:18px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} both,bt-veil-in .22s ease-out both}
.bt-create-preview{display:flex;flex-direction:column;align-items:center;gap:10px}
.bt-create-pop{display:inline-flex;animation:bt-create-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} both}
@keyframes bt-create-pop{from{transform:scale(.72);opacity:.4}}
.bt-create-name{font-size:17px;line-height:24px;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-create-step{font-size:12px;line-height:16px;color:var(--bt-ink-2);margin-bottom:-10px}
.bt-create-looks{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-create-lookbar{justify-content:center}
.bt-create-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.bt-create-go{height:36px;padding:0 20px}
@media (prefers-reduced-motion:reduce){.bt-create-card,.bt-create-pop{animation:none}}
.bt-send{height:40px;min-width:40px;border-radius:999px;border:0;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:14px;padding:0 14px;cursor:pointer;flex:none;white-space:nowrap}
.bt-send:disabled{opacity:.35;cursor:default}
.bt-error{padding:0 14px 10px;color:var(--bt-danger);font-size:12px}

/* Side panels keep their content clear of the Windows caption buttons. A host may set the
   chrome top to 0 so that dialog masks also cover the caption band; the panel then reaches
   the top edge, its own surface under the buttons, and the band over it still drags the
   window. Where the chrome top already clears the title bar the band is 0. */
html[data-windows-titlebar]:not([data-fullscreen]) :is(.bt-pane,.bt-panel){--bt-caption-band:calc(var(--dsh-windows-titlebar-height,0px) - var(--dsh-frame-chrome-top,0px));padding-top:var(--bt-caption-band)}
html[data-windows-titlebar]:not([data-fullscreen]) :is(.bt-pane,.bt-panel)::before{content:"";position:absolute;top:0;left:0;right:0;height:var(--bt-caption-band);-webkit-app-region:drag}
.bt-pane{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;z-index:45;pointer-events:auto;background:var(--bt-main);color:var(--bt-ink);display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-dialog{flex:1;display:flex;flex-direction:column;min-width:0}
.bt-dialog .bt-head{height:62px}
.bt-dialog-log{flex:1;overflow-y:auto;padding:8px 16px 20px;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;box-sizing:border-box}
.bt-dialog-foot{display:flex;justify-content:center;padding:10px 10px 16px}
.bt-exchange{animation:bt-sheet-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} both,bt-veil-in .24s ease-out both}
.bt-exchange[data-leaving]{animation:bt-sheet-out .22s cubic-bezier(.4,0,1,1) forwards;pointer-events:none}
@keyframes bt-sheet-in{from{transform:translateY(24px)}}
@keyframes bt-sheet-out{to{opacity:0;transform:translateY(16px);filter:blur(4px)}}
.bt-exchange .bt-dialog{position:relative}
.bt-exchange .bt-dialog-log{max-width:none;margin:0;padding:39px max(16px,calc((100% - 960px)/2)) 116px;scrollbar-width:thin}
.bt-exchange .bt-tools{display:none}
.bt-fold{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;margin-top:4px;white-space:normal}
.bt-fold-note{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
[data-folded] .bt-fold-body{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 40px),transparent)}
.bt-ubody .bt-fold .bt-more,.bt-ububble .bt-fold .bt-more,.bt-ubody .bt-fold-note,.bt-ububble .bt-fold-note{color:inherit;opacity:.7}
.bt-ubody .bt-fold .bt-more:hover,.bt-ububble .bt-fold .bt-more:hover{opacity:1}
.bt-exchange .bt-dialog-foot{position:absolute;left:0;right:0;bottom:0;height:76px;box-sizing:border-box;align-items:flex-end;padding:0 0 28px;background:var(--bt-main);z-index:3;animation:bt-foot-in .3s cubic-bezier(.22,1,.36,1) .3s both}
.bt-exchange .bt-dialog-foot::before{content:"";position:absolute;left:0;right:0;bottom:100%;height:40px;background:linear-gradient(to top,var(--bt-main),transparent);pointer-events:none}
.bt-exchange[data-leaving] .bt-dialog-foot{animation:bt-foot-out .22s cubic-bezier(.4,0,1,1) forwards}
@keyframes bt-foot-in{from{opacity:0;transform:translateY(6px)}}
@keyframes bt-foot-out{to{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.bt-exchange,.bt-exchange .bt-dialog-foot{animation-duration:.01s}}
.bt-soft{height:36px;border-radius:999px;border:0;background:var(--bt-hover);color:var(--bt-ink);padding:0 16px;font-size:14px;cursor:pointer;flex:none;white-space:nowrap}
.bt-soft:hover{background:var(--bt-active)}
.bt-time{display:block;text-align:center;font-size:12px;line-height:16px;color:var(--bt-ink-2);padding:6px 0}

.bt-panel{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;width:var(--bt-panel-w,320px);pointer-events:auto;z-index:40;background:var(--bt-main);border-left:.5px solid var(--bt-line-2);display:flex;flex-direction:column;color:var(--bt-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-sizing:border-box;animation:bt-pane-in .3s cubic-bezier(.2,0,0,1);transition:width ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-panel[data-leaving]{transform:translateX(100%);transition:transform .3s cubic-bezier(.2,0,0,1);pointer-events:none}
.bt-panel[data-instant]{transition:none}
@keyframes bt-pane-in{from{transform:translateX(100%)}}
[class*="_centerCol"]{transition:margin-right ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-panel-grip{position:absolute;left:-5px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:3;touch-action:none}
.bt-panel-grip:hover,.bt-panel[data-dragging] .bt-panel-grip{background:linear-gradient(to right,transparent 4px,var(--bt-line-2) 4px,var(--bt-line-2) 6px,transparent 6px)}
.bt-drag-shield{position:fixed;inset:0;z-index:45;cursor:col-resize}
.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column}
.bt-drawer-top{display:flex;justify-content:flex-end;gap:8px;padding:12px 17px 6px 12px}
.bt-drawer-id{display:flex;flex-direction:column;align-items:center;padding:14px 16px 0}
.bt-drawer-id>.bt-mark,.bt-drawer-id>.bt-cluster,.bt-drawer-id>.bt-pile{margin-bottom:16px}
.bt-pile{display:flex;align-items:center;justify-content:center;line-height:0}
.bt-pile-face{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:50%;background:var(--bt-main);box-shadow:0 0 0 3px var(--bt-main);animation:bt-pile-in .36s cubic-bezier(.34,1.56,.64,1) backwards}
.bt-pile-face+.bt-pile-face{margin-left:-10px}
.bt-pile-more{background:var(--bt-hover);color:var(--bt-ink-2);font-size:13px;line-height:1;font-weight:500;font-variant-numeric:tabular-nums}
@keyframes bt-pile-in{from{opacity:0;transform:translateY(6px) scale(.85)}}
@media (prefers-reduced-motion:reduce){.bt-pile-face{animation:none}}
.bt-drawer-name{font-size:17px;line-height:24px;font-weight:500;border:0;background:none;color:inherit;cursor:text;padding:0 6px;border-radius:6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-drawer-name:hover{background:var(--bt-hover)}
.bt-drawer-name-input{font-size:17px;line-height:24px;text-align:center;border:.5px solid var(--bt-line-2);border-radius:6px;padding:0 6px;background:var(--bt-main);color:var(--bt-ink);outline:none;font-weight:500}
.bt-drawer-role{font-size:12px;line-height:16px;color:var(--bt-ink-3);margin-top:6px;text-align:center}
.bt-tabs{position:relative;display:flex;justify-content:center;gap:2px;margin:16px 16px 0}
.bt-tab{position:relative;z-index:1;border:0;background:none;border-radius:9999px;padding:4px 8px;font-size:13px;line-height:20px;color:var(--bt-ink-2);cursor:pointer;white-space:nowrap}
.bt-tab:hover{color:var(--bt-ink)}
.bt-tab[aria-selected=true]{background:var(--bt-hover);color:var(--bt-ink)}
.bt-tabs>.bt-thumb{top:0;bottom:0;border-radius:9999px;background:var(--bt-hover)}
.bt-tabs[data-glide] .bt-tab[aria-selected=true]{background:transparent}
.bt-drawer-body{flex:1;overflow-y:auto;padding:20px 16px 16px;font-size:13px;line-height:18px;display:flex;flex-direction:column;gap:16px}
.bt-empty{text-align:center;color:var(--bt-ink-3);font-size:13px;line-height:18px;padding:8px 12px}
.bt-section-title{font-size:12px;color:var(--bt-ink-2);margin-bottom:6px}
.bt-muted{color:var(--bt-ink-2)}
.bt-swatches{display:flex;flex-wrap:wrap;gap:6px}
.bt-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px var(--bt-line-2)}
.bt-swatch[aria-pressed=true]{border-color:var(--bt-ink)}
.bt-textarea{width:100%;box-sizing:border-box;min-height:120px;border:1px solid var(--bt-line);border-radius:8px;padding:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;resize:vertical}
.bt-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bt-kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:20px;color:var(--bt-ink-2)}
.bt-kv span:last-child{color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-run-stats{display:flex;flex-wrap:wrap;justify-content:center;gap:0 6px;margin-top:-6px;font-size:12px;line-height:18px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-run-sep{color:var(--bt-ink-3)}
.bt-danger{color:var(--bt-danger)}

/* Bot settings: fields, the avatar editor popover, and the details-pane sub-view. */
.bt-field{display:flex;flex-direction:column;gap:6px}
.bt-field-label{font-size:13px;line-height:18px;font-weight:500}
.bt-input{width:100%;box-sizing:border-box;height:36px;border:1px solid var(--bt-line);border-radius:8px;padding:0 10px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;outline:none}
.bt-input:focus{border-color:var(--bt-line-2)}
.bt-input-area{height:auto;min-height:96px;padding:8px 10px;line-height:18px;resize:vertical}
.bt-note{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-soft-sm{height:28px;padding:0 12px;font-size:12px}
.bt-set-avatar{display:flex;justify-content:center;padding:4px 0}
.bt-avatar-anchor{position:relative}
.bt-avatar-trigger{position:relative;width:64px;height:64px;border:0;border-radius:50%;background:none;cursor:pointer;padding:0}
.bt-avatar-pencil{position:absolute;right:-2px;bottom:-2px;width:22px;height:22px;border-radius:50%;background:var(--bt-main);border:1px solid var(--bt-line-2);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.bt-avedit{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:300px;background:var(--bt-main);border:1px solid var(--bt-line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:10px;z-index:70;display:flex;flex-direction:column;gap:10px;color:var(--bt-ink);transform-origin:top center;animation:bt-pop-drop ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out}
.bt-bs .bt-avedit{transform-origin:32px 0}
.bt-avedit-top{display:flex;align-items:center;justify-content:space-between}
.bt-avedit-tabs{position:relative;display:flex;gap:2px;background:var(--bt-hover);border-radius:999px;padding:2px}
.bt-avedit-tab{position:relative;z-index:1;border:0;background:none;border-radius:999px;padding:3px 10px;font-size:12px;line-height:16px;color:var(--bt-ink-2);cursor:pointer}
.bt-avedit-tab[aria-selected=true]{background:var(--bt-main);color:var(--bt-ink)}
.bt-avedit-tabs>.bt-thumb{top:2px;bottom:2px;border-radius:999px;background:var(--bt-main);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.bt-avedit-tabs[data-glide] .bt-avedit-tab[aria-selected=true]{background:transparent}
.bt-avedit-reset{color:var(--bt-ink-3)}
.bt-avedit-reset:hover{color:var(--bt-ink)}
.bt-shapes{display:flex;flex-direction:column;gap:2px}
.bt-shape-row{display:grid;grid-template-columns:repeat(6,1fr);gap:2px}
.bt-shape{position:relative;aspect-ratio:1;border:0;border-radius:8px;background:none;color:var(--bt-ink);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.bt-shape:hover{background:var(--bt-hover)}
.bt-shape .bt-ring{position:absolute;left:50%;top:50%;width:36px;height:36px;translate:-50% -50%;overflow:visible;opacity:0;scale:.82;pointer-events:none;transition:opacity .14s ease,${spring(SPRING_POP, 'scale')}}
.bt-shape[aria-pressed=true] .bt-ring{opacity:1;scale:1}
.bt-colors{display:flex;justify-content:space-between}
.bt-color{width:22px;height:22px;border-radius:50%;border:2px solid transparent;padding:2px;background:none;cursor:pointer;box-sizing:border-box;transition:border-color .14s ease,${spring(SPRING_TAP, 'scale')}}
.bt-color[aria-pressed=true] span{animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-color span{display:block;width:100%;height:100%;border-radius:50%}
.bt-color[aria-pressed=true]{border-color:var(--bt-ink)}
.bt-dropzone{border:1.5px dashed var(--bt-line-2);border-radius:10px;padding:18px 12px;display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--bt-ink-2);font-size:12px;line-height:16px;text-align:center}
.bt-dropzone[data-over]{border-color:var(--bt-accent);color:var(--bt-ink)}
.bt-dropzone img{width:64px;height:64px;border-radius:50%;object-fit:cover}
.bt-set-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bt-about{white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.bt-about[data-open]{display:block;-webkit-line-clamp:unset}
.bt-more{border:0;background:none;color:var(--bt-ink-3);font-size:12px;line-height:16px;cursor:pointer;padding:2px 0}
.bt-more:hover{color:var(--bt-ink)}
.bt-subhead{display:flex;align-items:center;gap:4px;padding:10px 12px 4px}
.bt-subhead-title{flex:1;font-size:15px;line-height:24px;font-weight:600;padding-left:4px}
.bt-icon-btn{width:28px;height:28px;border-radius:50%;border:0;background:none;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.bt-icon-btn:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-set-body{gap:20px}
.bt-drawer-model{display:flex;flex-direction:column}
.bt-drawer-model .bt-note{margin-top:6px}
.bt-drawer-permission{display:flex;flex-direction:column}
.bt-seg button.bt-perm-danger,.bt-seg button.bt-perm-danger[aria-pressed=true],.bt-kv span.bt-perm-danger{color:var(--bt-danger)}

/* Settings dialog: a 198px page list beside the page. */
.bt-settings-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:60;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-scrim{position:absolute;inset:0;background:rgba(0,0,0,.32);animation:bt-fade .22s ease-out}
body[data-ds-dark-theme] .bt-scrim{background:rgba(0,0,0,.5)}
.bt-settings{--bt-set-w:min(1100px,calc(100vw - 48px));--bt-set-h:min(780px,calc(100vh - 2*max(32px,var(--dsh-frame-overlay-top,32px))));position:relative;width:var(--bt-set-w);height:var(--bt-set-h);background:var(--bt-main);border-radius:16px;border:.5px solid var(--bt-line-2);box-shadow:0 24px 80px rgba(0,0,0,.24);display:flex;overflow:hidden;color:var(--bt-ink);animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
:is(.bt-settings-layer,.bt-mem-layer)[data-leaving]{pointer-events:none}
:is(.bt-settings-layer,.bt-mem-layer)[data-leaving] .bt-scrim{opacity:0;transition:opacity .16s ease-in}
:is(.bt-settings-layer,.bt-mem-layer)[data-leaving]>[role=dialog]{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
@keyframes bt-dialog-rise{from{transform:translateY(12px) scale(.96)}}
@keyframes bt-dialog-sink{to{opacity:0;transform:translateY(6px) scale(.975);filter:blur(3px)}}
@media (prefers-reduced-motion:reduce){.bt-settings,.bt-scrim,.bt-settings-page>*{animation:bt-fade .12s ease-out!important}}
.bt-settings-nav{position:relative;width:198px;flex:none;padding:16px 8px;border-right:.5px solid var(--bt-line);display:flex;flex-direction:column;gap:2px;background:var(--bt-sidebar);box-sizing:border-box}
.bt-settings-item{position:relative;z-index:1;display:flex;align-items:center;gap:8px;padding:6px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left;transition:background-color .12s ease,color .12s ease}
.bt-settings-item:hover{color:var(--bt-ink);background:var(--bt-hover)}
.bt-settings-item[aria-current=page]{background:var(--bt-active);color:var(--bt-ink)}
.bt-settings-nav>.bt-thumb{left:8px;right:8px;border-radius:8px;background:var(--bt-active)}
.bt-settings-nav[data-glide] .bt-settings-item[aria-current=page]{background:transparent}
.bt-settings-shell{margin-top:auto}
/* Usage while another page is open: out of the flow, so it keeps its layout, and not
   rendered. */
.bt-settings-usage[data-off]{position:absolute;top:0;left:198px;width:calc(var(--bt-set-w) - 198px);height:100%;box-sizing:border-box;content-visibility:hidden;pointer-events:none}
.bt-settings-main{flex:none;display:flex;flex-direction:column;min-width:0;width:calc(var(--bt-set-w) - 198px);height:var(--bt-set-h)}
.bt-settings-head{display:flex;align-items:center;gap:6px;padding:16px 56px 4px 20px}
.bt-settings-head h2{margin:0;font-size:15px;line-height:24px;font-weight:600;animation:bt-veil-in .2s ease-out}
.bt-settings-head>.bt-icon-btn{animation:bt-back-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out}
@keyframes bt-back-in{from{translate:6px 0;scale:.8}}
.bt-settings-scroll{flex:1;overflow-y:auto;padding:12px 20px 24px;display:flex;flex-direction:column;gap:20px;scrollbar-width:thin}
.bt-settings-page>:not(.bt-us){animation:bt-page-up ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .22s ease-out backwards}
.bt-settings-page[data-move=in]>:not(.bt-us){animation-name:bt-page-in,bt-veil-in}
.bt-settings-page[data-move=out]>:not(.bt-us){animation-name:bt-page-out,bt-veil-in}
.bt-settings-page>:nth-child(2){animation-delay:30ms}
.bt-settings-page>:nth-child(3){animation-delay:60ms}
.bt-settings-page>:nth-child(4){animation-delay:90ms}
.bt-settings-page>:nth-child(n+5){animation-delay:120ms}
@keyframes bt-page-up{from{transform:translateY(10px)}}
@keyframes bt-page-in{from{transform:translateX(18px)}}
@keyframes bt-page-out{from{transform:translateX(-18px)}}
.bt-settings-close{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:0;background:var(--bt-hover);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.bt-settings-close:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-settings-form{display:flex;flex-direction:column;gap:16px}
.bt-set-section h3{font-size:13px;line-height:18px;font-weight:600;margin:0 0 8px;padding:0 4px}
.bt-set-card{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);display:flex;flex-direction:column}
.bt-set-card>*+*{border-top:.5px solid var(--bt-line)}
.bt-set-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;text-align:left;width:100%;box-sizing:border-box;border-radius:0}
button.bt-set-row{cursor:pointer}
button.bt-set-row:hover{background:var(--bt-hover)}
.bt-set-card>.bt-set-row+.bt-set-row{border-top:.5px solid var(--bt-line)}
.bt-set-row:first-child{border-top-left-radius:12px;border-top-right-radius:12px}
.bt-set-row:last-child{border-bottom-left-radius:12px;border-bottom-right-radius:12px}
.bt-set-copy{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-set-hint{font-size:12px;line-height:16px;color:color-mix(in srgb,var(--bt-ink-2) 50%,var(--bt-ink-3))}
.bt-set-control{flex:none;display:flex;align-items:center;gap:6px}
.bt-set-places .bt-set-control{flex:0 1 auto;max-width:50%;min-width:0}
.bt-set-places .bt-set-hint{overflow-wrap:anywhere}
.bt-set-value{font-size:13px;color:var(--bt-ink-2);text-align:right}
.bt-set-bot{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.bt-browser-note{margin:0;padding:10px 12px;color:var(--bt-ink-2);font-size:12px;line-height:17px}
.bt-browser-grant{display:flex;align-items:center;gap:12px;padding:10px 12px}
.bt-browser-grant+.bt-browser-grant{border-top:.5px solid var(--bt-line)}
.bt-browser-grant-who{display:flex;align-items:center;gap:8px;flex:0 0 150px;min-width:0;font-size:13px}
.bt-browser-grant-who>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-browser-grant-meta{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.bt-browser-grant-site{font-size:13px;overflow-wrap:anywhere}
.bt-browser-grant-kinds{display:flex;gap:4px;flex-wrap:wrap}
.bt-browser-grant-expired{opacity:.5}
.bt-browser-action-list,.bt-browser-duration{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bt-browser-action-choice{display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}
.bt-browser-duration-choice{border:1px solid var(--bt-line);border-radius:8px;padding:5px 8px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-browser-duration-choice[aria-pressed=true]{background:var(--bt-hover);color:var(--bt-ink)}
.bt-browser-form>.bt-set-row>.bt-set-control{flex:1;min-width:0}
.bt-browser-form>.bt-set-row+.bt-set-row{border-top:.5px solid var(--bt-line)}
.bt-browser-site{max-width:320px}
.bt-browser-form-foot{display:flex;justify-content:flex-end;padding:10px 12px;border-top:.5px solid var(--bt-line)}
@media(max-width:700px){.bt-browser-grant{flex-wrap:wrap}.bt-browser-grant-who{flex:1}.bt-browser-grant-meta{order:3;flex:1 0 100%}}
.bt-set-paste{flex-direction:column;align-items:stretch;gap:8px}
.bt-chevron{color:var(--bt-ink-3);display:inline-flex;flex:none}

/* Settings → Connectors. */
.bt-connector{display:flex;flex-direction:column;gap:10px;padding:12px}
.bt-connector-head{display:flex;align-items:center;gap:12px;min-width:0}
.bt-connector-mark{flex:none;width:36px;height:36px;border-radius:10px;background:var(--bt-card);border:.5px solid var(--bt-line);display:flex;align-items:center;justify-content:center;color:var(--bt-ink)}
.bt-connector-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-connector-name{font-size:14px;line-height:20px;font-weight:500}
.bt-connector-status{font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-connector[data-state=ready] .bt-connector-status{color:var(--bt-ink-2)}
.bt-connector[data-state=error] .bt-connector-status{color:var(--bt-danger);white-space:normal}
.bt-connector-actions{flex:none;display:flex;gap:6px}
.bt-connector-form{display:flex;flex-direction:column;gap:8px;padding-left:48px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-connector-form-row{display:flex;align-items:center;gap:6px}
.bt-connector-link{flex:1;font-size:12px;color:var(--bt-ink-2)}
.bt-connector-error{padding-left:48px;font-size:12px;line-height:16px;color:var(--bt-danger)}

/* Shell chrome reshaped for the team view. Selectors use stable data attributes where the
   shell offers them and CSS-module name suffixes elsewhere. */
[class*="_newSession"],nav[class*="_panelList"],[class*="_logoRow"]>[class*="_brand"],[class*="_logoRow"]:not(:has([class*="_toggle"])){display:none!important}
/* The shell's sidebar switch stays where the shell puts it whenever the sidebar is
   collapsed: on the rail, or fixed in a Windows title bar, where it also stays while
   the sidebar is open. Elsewhere an open sidebar uses the team's own top row. */
html:not([data-windows-titlebar]) :not([class*="_collapsed"])>[class*="_logoRow"]{display:none!important}
html[data-windows-titlebar] :not([class*="_collapsed"])>[class*="_logoRow"]{height:0!important;margin:0!important}
html[data-windows-titlebar] .bt-side-collapse,html[data-platform=darwin] .bt-side-collapse{display:none}
/* The footer ends in the Bot row: the whale's settings seat, then Connect plugins. Every
   other plugin's entry takes a whole row above it, in the shell's order, so none of them
   squeezes the Bot row. */
[class*="_footArea"]{grid-template-columns:auto minmax(0,1fr);grid-auto-flow:row dense;align-items:center;gap:4px 9px;padding:8px 6px 6px!important}
/* DSH hides the footer of a collapsed sidebar under a Windows title bar; the grid
   stays out of that one place. */
html:not([data-windows-titlebar]) [class*="_footArea"],:not([class*="_collapsed"])>[class*="_footArea"]{display:grid!important}
[class*="_footArea"]>[class*="_footerActions"],[class*="_footArea"]>[class*="_footerActions"]>div{display:contents!important}
[class*="_footArea"]>[class*="_footerActions"]>div>*{grid-column:1/-1}
[class*="_footArea"]>[class*="_footerActions"]>div>.bt-connect-wrap{grid-column:2;order:1}
[class*="_footArea"]>[class*="_settingsArea"]{grid-column:1;order:1;width:auto!important}
[class*="_footArea"] button[aria-label="Settings"]{width:auto!important;padding:0!important;background:none!important;border-radius:50%!important;height:auto!important}
${SKIN_FOOT}{display:flex!important;flex-direction:row!important;align-items:center!important;gap:9px!important}
${SKIN_FOOT}>div:has(> [data-slot="sidebar.footer.action"]){display:flex!important;align-items:center!important;flex:1 1 auto!important;min-width:0!important}
${SKIN_FOOT}>div:has(> [data-slot="sidebar.settings"]){order:-1!important;flex:none!important;width:auto!important}
[class*="_widthHandle"]{display:none!important}

.bt-voice-pane{flex-direction:column;align-items:center;justify-content:center;animation:bt-fade .2s ease-out}
.bt-voice-stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;max-width:560px;text-align:center}
.bt-voice-orb{position:relative;width:200px;height:200px;display:grid;place-items:center;margin-bottom:8px}
.bt-voice-ring{position:absolute;inset:34px;border-radius:50%;background:var(--bt-hover);transform:scale(calc(1 + var(--bt-level,0) * .55));transition:transform .08s linear}
.bt-voice-ring-2{inset:14px;background:none;box-shadow:inset 0 0 0 1px var(--bt-line-2);transform:scale(calc(.94 + var(--bt-level,0) * .3));opacity:.8}
.bt-voice-stage[data-phase=thinking] .bt-voice-ring{animation:bt-voice-breathe 1.6s ease-in-out infinite}
.bt-voice-stage[data-phase=speaking] .bt-voice-ring{animation:bt-voice-speak .9s ease-in-out infinite}
@keyframes bt-voice-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
@keyframes bt-voice-speak{0%,100%{transform:scale(1.04)}30%{transform:scale(1.2)}60%{transform:scale(1.1)}}
.bt-voice-orb>.bt-mark{position:relative}
.bt-voice-name{font-size:16px;line-height:22px;font-weight:500}
.bt-voice-status{font-size:13px;line-height:18px;color:var(--bt-ink-2);min-height:18px}
.bt-voice-caption{min-height:44px;font-size:15px;line-height:22px;color:var(--bt-ink);animation:bt-blur-in .25s ease-out;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.bt-voice-note{font-size:12px;color:var(--bt-danger)}
.bt-voice-setup{height:32px;padding:0 14px;border-radius:16px;border:0;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .15s ease}
.bt-voice-setup:hover{background:var(--bt-active)}
.bt-voice-bar{display:flex;gap:16px;padding:0 0 32px}
.bt-voice-btn{position:relative;width:52px;height:52px;border-radius:50%;border:0;background:var(--bt-hover);color:var(--bt-ink);display:grid;place-items:center;cursor:pointer;transition:background-color .15s ease,transform .12s ease}
.bt-voice-btn:hover{background:var(--bt-active)}
.bt-voice-btn:active{transform:scale(.94)}
.bt-voice-btn[aria-pressed=true]{background:var(--bt-user);color:var(--bt-user-ink)}
.bt-voice-slash{position:absolute;width:24px;height:2px;border-radius:1px;background:currentColor;transform:rotate(-45deg)}
.bt-voice-end{background:#ff3e51;color:#fff}
.bt-voice-end:hover{background:#e02135}
@keyframes bt-fade{from{opacity:0}to{opacity:1}}
@keyframes bt-blur-in{from{opacity:0;filter:blur(2px)}to{opacity:1;filter:blur(0)}}
@media (prefers-reduced-motion:reduce){.bt-voice-pane,.bt-voice-caption,.bt-voice-ring{animation:none!important}}
/* A bubble takes the set share of the column, as the user's does; 82px stays free for
   the hover toolbar beside it: a 6px margin and three 24px tools 2px apart. */
.bt-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:min(calc(var(--bt-msg-w) * 100%),calc(100% - 82px))}
/* The bubble's row: reactions hang below it, so the hover toolbar (and a group
   sender's avatar) line up with the bubble alone. */
.bt-msg-line{position:relative;display:flex;align-items:flex-end;gap:8px;max-width:100%}
.bt-msg-line>.bt-bubble{max-width:none;min-width:0}
/* The same bubble width as beside an avatar column: the share of (100% - 30px), plus the 30px. */
.bt-astack[data-lead]>.bt-msg{max-width:min(calc(var(--bt-msg-w) * (100% - 30px) + 30px),calc(100% - 52px))}
.bt-tools{position:absolute;top:50%;left:100%;margin-left:6px;transform:translateY(-50%);display:flex;gap:2px;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
.bt-tools::after{content:"";position:absolute;top:-8px;bottom:-8px;right:100%;width:128px;z-index:-1}
.bt-msg:hover>.bt-msg-line>.bt-tools,.bt-msg:focus-within>.bt-msg-line>.bt-tools,.bt-tools[data-open]{opacity:1;visibility:visible}
/* The flat layout: a Bot's text has no bubble and takes its own share of the column
   (the whole of it unless set). The toolbar floats over the message's top right. */
body[data-bt-layout=flat] .bt-astack{align-items:stretch;gap:10px}
body[data-bt-layout=flat] .bt-msg,body[data-bt-layout=flat] .bt-astack[data-lead]>.bt-msg{align-items:stretch;max-width:calc(var(--bt-flat-w) * 100%)}
body[data-bt-layout=flat] .bt-bubble{background:none;padding:0;border-radius:0}
body[data-bt-layout=flat] .bt-tools{top:-14px;right:0;left:auto;margin-left:0;transform:none;padding:2px;border-radius:999px;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2),0 4px 14px rgba(0,0,0,.14)}
body[data-bt-layout=flat] .bt-tools::after{display:none}
.bt-tool{width:24px;height:24px;border:0;padding:0;border-radius:6px;background:none;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-tool:hover,.bt-tool[aria-expanded=true]{background:var(--bt-hover);color:var(--bt-ink)}
.bt-tool:active{background:var(--bt-active)}
.bt-tool:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-react-strip{position:fixed;z-index:60;pointer-events:auto;display:flex;gap:2px;padding:4px;border-radius:999px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.08),0 4px 6px -4px rgba(0,0,0,.06);transform:translate(-50%,-100%);transform-origin:bottom center;animation:bt-pop-lift ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .14s ease-out}
.bt-react-strip button{width:32px;height:32px;border:0;border-radius:50%;background:none;font-size:18px;line-height:1;cursor:pointer;transition:background-color .12s ease,${spring(SPRING_POP, 'transform')};animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-react-strip button:nth-child(2){animation-delay:20ms}
.bt-react-strip button:nth-child(3){animation-delay:40ms}
.bt-react-strip button:nth-child(4){animation-delay:60ms}
.bt-react-strip button:nth-child(n+5){animation-delay:80ms}
.bt-react-strip button:hover{background:var(--bt-hover);transform:scale(1.15)}
.bt-react-strip button:active{transform:scale(.92)}
.bt-reacts{display:flex;gap:4px;margin-top:4px}
.bt-react{height:22px;min-width:30px;padding:0 6px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);font-size:13px;line-height:20px;cursor:pointer;animation:bt-react-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing};transition:background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-react:hover{background:var(--bt-hover)}
.bt-react:active{scale:.92}
@keyframes bt-react-pop{from{transform:scale(.6);opacity:0}}
.bt-bubble a[href^="${MENTION_ORIGIN}"] svg{display:none}
.bt-you{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bt-ink) 5%,var(--bt-sidebar));color:var(--bt-ink-2);box-shadow:inset 0 0 0 1px var(--bt-line);transition:background-color .12s ease}
button:hover .bt-you{background:color-mix(in srgb,var(--bt-ink) 9%,var(--bt-sidebar))}
.bt-you-wrap{display:inline-flex;padding:0}
.bt-connect-foot{width:100%;height:36px}

.bt-menu{position:fixed;pointer-events:auto;z-index:60;min-width:200px;padding:6px;border-radius:12px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1),0 0 0 1px rgba(228,228,228,.04);display:flex;flex-direction:column;gap:2px;transform-origin:var(--bt-origin,top left);animation:bt-pop-drop ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .14s ease-out;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-sizing:border-box}
.bt-menu button{display:flex;align-items:center;gap:4px;width:100%;min-height:30px;text-align:left;border:0;background:none;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;line-height:18px;color:var(--bt-ink);cursor:pointer;box-sizing:border-box}
.bt-menu button:hover{background:var(--bt-hover)}
.bt-menu button svg{flex:none;width:16px;height:16px;margin:0 1px}
.bt-menu .bt-danger{color:var(--bt-danger)}
.bt-menu-sep{height:.5px;flex:none;background:var(--bt-line-2);margin:4px 8px}
.bt-menu-up{--bt-origin:bottom left;animation-name:bt-pop-lift,bt-veil-in}
.bt-menu[data-leaving]{pointer-events:none;animation:bt-pop-out .12s cubic-bezier(.4,0,1,1) forwards}
.bt-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-menu-hint{flex:none;color:var(--bt-ink-3);font-size:12px;font-variant-numeric:tabular-nums}
.bt-palette-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:70;pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.46);animation:bt-fade .22s ease-out}
.bt-palette{position:absolute;top:50%;left:50%;width:min(560px,92vw);transform:translate(-50%,-50%);display:flex;flex-direction:column;border-radius:12px;background:var(--bt-main);border:1px solid var(--bt-line-2);box-shadow:0 24px 48px -12px rgba(0,0,0,.25);overflow:hidden;color:var(--bt-ink);animation:bt-palette-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-palette-layer[data-leaving]{pointer-events:none}
.bt-palette-layer[data-leaving] .bt-backdrop{opacity:0;transition:opacity .16s ease-in}
.bt-palette-layer[data-leaving] .bt-palette{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
@keyframes bt-palette-in{from{translate:0 -10px;scale:.96}}
.bt-palette-head{display:flex;align-items:center;gap:4px;padding:14px 10px 14px 14px;border-bottom:.5px solid var(--bt-line-2)}
.bt-palette-glyph{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;color:var(--bt-ink-3);margin-right:4px}
.bt-palette-head input{flex:1;min-width:0;border:0;outline:none;background:none;color:var(--bt-ink);font:inherit;font-size:15px;line-height:22px;padding:0}
.bt-palette-head input::placeholder{color:var(--bt-ink-3)}
.bt-palette-clear{width:18px;height:18px;border:0;padding:0;border-radius:6px;background:none;color:var(--bt-ink-3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-palette-clear:hover{color:var(--bt-ink)}
.bt-palette-clear svg{width:12px;height:12px}
.bt-palette-list{position:relative;height:402px;height:min(402px,54vh);height:min(402px,54dvh);overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px;box-sizing:border-box}
.bt-palette-list>.bt-thumb,.bt-drop-list>.bt-thumb{left:0;right:0;border-radius:8px;background:var(--bt-active)}
.bt-palette-list>.bt-thumb{left:8px;right:8px}
:is(.bt-palette-list,.bt-drop-list)[data-glide] [aria-selected=true]{background:transparent}
:is(.bt-palette-row,.bt-palette-section,.bt-drop-list>.bt-option){position:relative;z-index:1}
.bt-palette-section{padding:8px 8px 4px;font-size:12px;line-height:16px;color:var(--bt-ink-3);flex:none}
.bt-palette-section:first-of-type{padding-top:0}
.bt-palette-row{flex:none;display:flex;align-items:center;gap:8px;height:49px;padding:6px 10px 6px 8px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box;width:100%}
.bt-palette-row[aria-selected=true]{background:var(--bt-active)}
.bt-palette-lead{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center}
.bt-palette-cmd{width:24px;height:24px;border-radius:50%;background:var(--bt-hover);display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2)}
.bt-palette-cmd svg{width:14px;height:14px}
.bt-palette-agent{width:24px;height:24px;border-radius:50%;background:var(--bt-hover);display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink)}
.bt-palette-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-palette-title{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-palette-sub{font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-palette-badge{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-palette-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:0 16px;text-align:center;animation:bt-veil-in .22s ease-out}
.bt-palette-empty-icon{color:var(--bt-line-2)}
.bt-palette-empty-icon svg{width:32px;height:32px}
.bt-palette-empty-label{font-size:14px;font-weight:500;color:var(--bt-ink-2)}
.bt-palette-empty-hint{font-size:13px;line-height:16px;color:var(--bt-ink-3)}
@media (prefers-reduced-motion:reduce){.bt-palette{animation:bt-fade .1s ease-out}}
.bt-account-menu{width:224px}
.bt-account{flex:none;width:36px;height:36px;border:0;padding:0;background:none;border-radius:50%;cursor:pointer;display:inline-flex}
.bt-account:hover .bt-you,.bt-account[aria-expanded=true] .bt-you{background:color-mix(in srgb,var(--bt-ink) 9%,var(--bt-sidebar))}
/* Popover keyframes move translate and scale, which compose with a transform the popover
   already has. */
@keyframes bt-pop-drop{from{translate:0 -4px;scale:.96}}
@keyframes bt-pop-lift{from{translate:0 4px;scale:.96}}
@keyframes bt-pop-out{to{opacity:0;scale:.97;filter:blur(2px)}}
@keyframes bt-veil-in{from{opacity:0;filter:blur(6px)}}
@keyframes bt-check-pop{from{opacity:0;scale:.4}}
@media (prefers-reduced-motion:reduce){.bt-menu,.bt-avedit,.bt-react-strip{animation:bt-fade .1s ease-out}.bt-react-strip button,.bt-q-check,.bt-color[aria-pressed=true] span{animation:none}}
.bt-brand:hover{background:var(--bt-hover)}
.bt-drop-list{position:relative;display:flex;flex-direction:column;gap:2px}
.bt-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.bt-pick{display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 2px 6px;border-radius:10px;border:1px solid transparent;background:none;color:var(--bt-ink);cursor:pointer;font:inherit;font-size:11px;line-height:14px;min-width:0}
.bt-pick:hover{background:var(--bt-hover)}
.bt-pick[aria-pressed=true]{border-color:var(--bt-line-2);background:var(--bt-hover)}
.bt-pick>span:last-child:not(.bt-mark){max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-pick:hover .bt-mark[data-state=idle] .bt-eye{animation:bt-blink .5s linear 1}
.bt-select{width:100%;height:34px;box-sizing:border-box;border-radius:8px;border:1px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);padding:0 8px;font:inherit;font-size:13px}
.bt-note{font-size:12px;line-height:16px;color:var(--bt-ink-2);margin-top:6px}
.bt-swatch-sep{width:1px;height:22px;background:var(--bt-line-2);margin:0 2px}
.bt-swatch-custom{position:relative;overflow:hidden;background:conic-gradient(#ff3e51,#ffaf38,#00c972,#1cc3b0,#2a92fe,#a97efe,#ff5eb1,#ff3e51);box-sizing:border-box}
.bt-swatch-custom[data-on=true]{border-color:var(--bt-ink)}
.bt-swatch-custom input{position:absolute;inset:-4px;width:calc(100% + 8px);height:calc(100% + 8px);opacity:0;cursor:pointer;border:0;padding:0}
.bt-swatch-default{background:linear-gradient(135deg,var(--bt-card) 0 46%,var(--bt-line-2) 46% 54%,var(--bt-card) 54%);box-shadow:inset 0 0 0 1px var(--bt-line-2)}
.bt-states{display:flex;flex-wrap:wrap;gap:4px}
.bt-state{border:1px solid var(--bt-line);background:none;border-radius:999px;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;color:var(--bt-ink-2);cursor:pointer}
.bt-state:hover{color:var(--bt-ink)}
.bt-state[aria-pressed=true]{background:var(--bt-active);border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-theme-chip{position:relative;width:46px;height:30px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--bt-line-2);background:linear-gradient(90deg,var(--ls) 0 36%,var(--lb) 36%);overflow:hidden}
.bt-theme-chip i{position:absolute;right:7px;bottom:7px;width:10px;height:10px;border-radius:50%;background:var(--la)}
body[data-ds-dark-theme] .bt-theme-chip{background:linear-gradient(90deg,var(--ds) 0 36%,var(--db) 36%)}
body[data-ds-dark-theme] .bt-theme-chip i{background:var(--da)}
.bt-tabs{flex-wrap:wrap}
.bt-soft:disabled{opacity:.4;cursor:default}
.bt-group-role{margin-left:6px;font-size:11px;line-height:14px;padding:1px 5px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);vertical-align:1px}
.bt-mini{flex:none;border:0;background:none;border-radius:6px;padding:2px 6px;font:inherit;font-size:12px;line-height:18px;color:var(--bt-ink-2);cursor:pointer}
.bt-mini:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-add{color:var(--bt-ink-2);margin-top:2px}
.bt-add:hover,.bt-addlist .bt-option:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-addlist{display:flex;flex-direction:column;margin-top:4px;padding:4px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);animation:bt-rise .16s ease-out}
.bt-seg{position:relative;display:flex;gap:2px;padding:2px;border-radius:10px;background:var(--bt-hover)}
.bt-motion-seg,.bt-look-seg{width:216px}
/* A range input: the track fills with the accent up to the thumb (--bt-fill). */
.bt-range{display:flex;align-items:center;gap:10px;width:216px}
.bt-range input{flex:1;min-width:0;height:20px;margin:0;background:none;-webkit-appearance:none;appearance:none;cursor:pointer}
.bt-range input::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--bt-accent) var(--bt-fill),var(--bt-active) var(--bt-fill))}
.bt-range input::-moz-range-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--bt-accent) var(--bt-fill),var(--bt-active) var(--bt-fill))}
.bt-range input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border:0;border-radius:50%;corner-shape:round;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2),0 1px 3px rgba(0,0,0,.08);transition:${spring(SPRING_TAP, 'scale')}}
.bt-range input::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2),0 1px 3px rgba(0,0,0,.08)}
.bt-range input:active::-webkit-slider-thumb{scale:1.15}
.bt-range input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:999px}
.bt-range output{flex:none;width:38px;text-align:right;font-size:13px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-seg button{position:relative;z-index:1;flex:1;height:30px;border:0;border-radius:8px;background:none;font:inherit;font-size:13px;color:var(--bt-ink-2);cursor:pointer;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease,${spring(SPRING_TAP, 'scale')}}
.bt-seg button[aria-pressed=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.bt-seg button:disabled{opacity:.4;cursor:default}
.bt-seg button:active:not(:disabled){scale:.96}
.bt-seg>.bt-thumb{top:2px;bottom:2px;border-radius:8px;background:var(--bt-card);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.bt-seg[data-glide] button[aria-pressed=true]{background:transparent;box-shadow:none}
@keyframes bt-rise{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.bt-addlist{animation:none}}

/* Memory dialog: a summary of every entry, the entries behind the menu, "Ask or update" below. */
.bt-mem-row{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 8px 0 10px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;box-sizing:border-box;transition:background-color .12s ease}
.bt-mem-row:hover{background:var(--bt-hover)}
.bt-mem-row>svg{flex:none;color:var(--bt-ink-2)}
.bt-mem-row-copy{flex:1;text-align:left}
.bt-mem-row-go{display:inline-flex;align-items:center;gap:2px;color:var(--bt-ink-3);font-size:12px;flex:none;white-space:nowrap}
.bt-mem-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:61;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-mem-scrim{animation:bt-fade .2s ease-out}
.bt-mem{position:relative;width:min(680px,calc(100vw - 48px));height:min(760px,calc(100vh - 2*max(32px,var(--dsh-frame-overlay-top,32px))));background:var(--bt-main);border-radius:20px;border:.5px solid var(--bt-line-2);box-shadow:0 24px 80px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;color:var(--bt-ink);animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-mem-head{position:relative;display:flex;align-items:center;gap:8px;height:60px;flex:none;padding:0 14px 0 24px;border-bottom:.5px solid var(--bt-line);box-sizing:border-box}
.bt-mem-head .bt-icon-btn{width:32px;height:32px;flex:none}
.bt-mem-head [aria-haspopup] svg{width:18px;height:18px;stroke-width:2.6}
.bt-mem-head>.bt-icon-btn:first-child{margin-left:-10px}
.bt-mem-head h2{margin:0;font-size:17px;line-height:24px;font-weight:600;white-space:nowrap}
.bt-mem-status{font-size:13px;line-height:18px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-variant-numeric:tabular-nums}
.bt-mem-head-gap{flex:1}
.bt-mem-menu{position:absolute;top:52px;right:50px;min-width:220px;--bt-origin:top right}
.bt-mem-menu button:disabled{opacity:.4;cursor:default;background:none}
.bt-mem-body{flex:1;overflow-y:auto;padding:22px 28px 24px;scrollbar-width:thin;display:flex;flex-direction:column;gap:12px}
.bt-mem-summary{transition:opacity .3s ease}
.bt-mem-summary[data-stale]{opacity:.55}
.bt-mem-summary h3{margin:20px 0 6px;font-size:17px;line-height:26px;font-weight:600}
.bt-mem-summary h3:first-child{margin-top:0}
.bt-mem-summary p{margin:0;font-size:15px;line-height:26px}
.bt-mem-summary>*{animation:bt-mem-line .45s cubic-bezier(.16,1,.3,1) both}
.bt-mem-summary>:nth-child(2){animation-delay:.03s}
.bt-mem-summary>:nth-child(3){animation-delay:.06s}
.bt-mem-summary>:nth-child(4){animation-delay:.09s}
.bt-mem-summary>:nth-child(5){animation-delay:.12s}
.bt-mem-summary>:nth-child(6){animation-delay:.15s}
.bt-mem-summary>:nth-child(n+7){animation-delay:.18s}
@keyframes bt-mem-line{from{opacity:0;transform:translateY(4px)}}
.bt-mem-skel{display:flex;flex-direction:column;gap:24px}
.bt-mem-skel-block{display:flex;flex-direction:column;gap:10px}
.bt-mem-skel-block span{display:block;height:12px;border-radius:6px;background:linear-gradient(90deg,var(--bt-hover) 25%,var(--bt-active) 50%,var(--bt-hover) 75%);background-size:200% 100%;animation:bt-mem-skel 1.4s ease-in-out infinite}
.bt-mem-skel-block .bt-mem-skel-head{width:30%;height:16px;margin-bottom:2px}
@keyframes bt-mem-skel{from{background-position:150% 0}to{background-position:-50% 0}}
.bt-mem-skel-label{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-mem-empty{margin:auto;max-width:400px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:24px 0;animation:bt-mem-line .45s cubic-bezier(.16,1,.3,1) both}
.bt-mem-empty-mark{width:48px;height:48px;border-radius:50%;background:var(--bt-hover);display:flex;align-items:center;justify-content:center;color:var(--bt-ink-2);margin-bottom:4px}
.bt-mem-empty-mark svg{width:22px;height:22px}
.bt-mem-empty-title{font-size:15px;line-height:22px;font-weight:600}
.bt-mem-empty-text{font-size:13px;line-height:20px;color:var(--bt-ink-2)}
.bt-mem-failed{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:var(--bt-hover);font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-mem-failed>span{flex:1;min-width:0;overflow-wrap:anywhere}
.bt-mem-entries{display:flex;flex-direction:column;gap:28px;animation:bt-page-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .22s ease-out}
.bt-mem-section-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.bt-mem-section-head h3{margin:0;font-size:15px;line-height:22px;font-weight:600}
.bt-mem-section-head span{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-mem-section-head .bt-mem-size{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-mem-topic{font-size:12px;line-height:16px;color:var(--bt-ink-2);margin:14px 0 2px 4px;font-weight:500}
.bt-mem-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.bt-mem-entry{display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:.5px solid var(--bt-line);transition:opacity .2s ease}
.bt-mem-entry[data-busy]{opacity:.4}
.bt-mem-entry-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-mem-entry-text{font-size:14px;line-height:20px;overflow-wrap:anywhere}
.bt-mem-entry-meta{font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-mem-remove{flex:none;height:28px;min-width:28px;border-radius:999px;border:0;background:none;color:var(--bt-ink-3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0 6px;font:inherit;font-size:12px;opacity:0;transition:opacity .12s ease,background-color .12s ease,color .12s ease}
.bt-mem-entry:hover .bt-mem-remove,.bt-mem-remove:focus-visible,.bt-mem-remove[data-confirm]{opacity:1}
.bt-mem-remove:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-mem-remove[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--bt-danger);padding:0 10px}
@media (hover:none){.bt-mem-remove{opacity:1}}
.bt-mem-none{font-size:13px;line-height:18px;color:var(--bt-ink-3);padding:8px 4px}
.bt-mem-foot{flex:none;padding:8px 20px 20px;display:flex;flex-direction:column;gap:10px}
.bt-mem-reply{border-radius:16px;background:var(--bt-hover);padding:8px 8px 12px 16px;display:flex;flex-direction:column;gap:6px;max-height:36vh;max-height:36dvh;overflow-y:auto;scrollbar-width:thin;transform-origin:50% 100%;animation:bt-pop-lift ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-mem-reply-head{display:flex;align-items:center;gap:8px;min-height:24px}
.bt-mem-reply-asked{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-mem-reply .bt-icon-btn{width:24px;height:24px;flex:none}
.bt-mem-reply-text{font-size:14px;line-height:21px;padding-right:8px;overflow-wrap:anywhere}
.bt-mem-changes{list-style:none;margin:2px 0 0;padding:0 8px 0 0;display:flex;flex-direction:column;gap:4px}
.bt-mem-changes li{display:flex;align-items:flex-start;gap:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-mem-changes li svg{flex:none;margin-top:1px;color:var(--bt-danger);animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} .12s backwards}
.bt-mem-changes li[data-ok] svg{color:var(--bt-green)}
.bt-mem-ask{display:flex;align-items:center;gap:8px;height:52px;padding:0 8px 0 22px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-card);box-shadow:0 4px 16px rgba(0,0,0,.06);box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease}
.bt-mem-ask:focus-within{border-color:var(--bt-ink-3);box-shadow:0 4px 20px rgba(0,0,0,.1)}
.bt-mem-input{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--bt-ink);font:inherit;font-size:15px;line-height:22px;padding:0}
.bt-mem-input::placeholder{color:var(--bt-ink-3)}
.bt-mem-send{flex:none;width:36px;height:36px;border-radius:50%;border:0;background:var(--bt-ink);color:var(--bt-main);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:opacity .15s ease,${spring(SPRING_TAP, 'scale')}}
.bt-mem-send:disabled{opacity:.22;cursor:default}
.bt-mem-send:not(:disabled):active{scale:.92}
.bt-mem-send>*{animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-mem-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;box-sizing:border-box;animation:bt-mem-spin .7s linear infinite}
@keyframes bt-mem-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){.bt-mem{width:100vw;height:100%;border-radius:0;border:0}.bt-mem-body{padding:18px 18px 20px}.bt-mem-foot{padding:8px 12px 12px}}
@media (prefers-reduced-motion:reduce){.bt-mem,.bt-mem-scrim,.bt-mem-summary>*,.bt-mem-empty,.bt-mem-reply,.bt-mem-skel-block span,.bt-mem-entries,.bt-mem-send>*,.bt-mem-changes li svg{animation:none}}

.bt-thumb{position:absolute;left:0;top:0;z-index:0;pointer-events:none;transition:opacity .14s ease}
.bt-thumb[data-hidden]{opacity:0}
[data-morph]{overflow:hidden!important}
.bt-veil{animation:bt-veil-in .22s ease-out}
.bt-with-icon{display:inline-flex;align-items:center;gap:4px}
.bt-with-icon svg{width:14px;height:14px}
.bt-tag-admin{display:inline-flex;align-items:center;gap:4px}
.bt-create-inline{padding:18px 16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-create-inline .bt-create-card{max-width:none}
.bt-panel-view>[data-move=in]{animation:bt-page-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-panel-view>[data-move=out]{animation:bt-page-out ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-panel-view>:is([data-move=in],[data-move=out]):nth-child(2){animation-delay:25ms}
.bt-panel-view>:is([data-move=in],[data-move=out]):nth-child(n+3){animation-delay:50ms}
.bt-panel-view>.bt-drawer-body[data-move=tab]{animation:bt-veil-in .2s ease-out}
.bt-drawer-name-input{animation:bt-veil-in .16s ease-out}
.bt-pop-in{display:inline-flex;animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
:is(.bt-soft,.bt-send,.bt-icon-btn,.bt-settings-close,.bt-mini,.bt-tab,.bt-nc-send,.bt-avedit-tab,.bt-shape,.bt-pick,.bt-swatch,.bt-palette-clear){transition:background-color .12s ease,color .12s ease,border-color .12s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
:is(.bt-icon-btn,.bt-settings-close,.bt-nc-send,.bt-shape,.bt-swatch,.bt-color,.bt-x,.bt-q-x,.bt-palette-clear):active:not(:disabled){scale:.9}
:is(.bt-soft,.bt-send,.bt-mini,.bt-tab,.bt-avedit-tab,.bt-pick,.bt-q-submit,.bt-q-btn):active:not(:disabled){scale:.96}
@media (prefers-reduced-motion:reduce){.bt-thumb{transition:none}.bt-panel-view>[data-move],.bt-drawer-name-input,.bt-veil,.bt-pop-in,.bt-token,.bt-drop,.bt-newchat,.bt-option-hint,.bt-connector-form,.bt-settings-head>*{animation:none}}
/* Phone-width viewports: the settings dialog takes the whole screen, its page
   list becomes a horizontal strip across the top, and fixed-width pages wrap
   or scroll instead of overflowing. These rules sit at the end of the sheet:
   the base column widths below would otherwise win the cascade back. */
@media (max-width:640px){
  .bt-settings-layer{align-items:stretch;justify-content:stretch}
  .bt-settings{--bt-set-w:100vw;--bt-set-h:100vh;width:100vw;height:100vh;height:100dvh;border-radius:0;border-width:0;flex-direction:column}
  /* Right padding is not honored inside a scrolling flex row; a transparent
     right border keeps the last tab clear of the close button. */
  .bt-settings-nav{width:100%;flex:none;flex-direction:row;align-items:center;overflow-x:auto;padding:8px;border:0;border-right:52px solid transparent;border-bottom:.5px solid var(--bt-line);scrollbar-width:thin;box-sizing:border-box}
  .bt-settings-item{flex:none}
  .bt-settings-shell{margin-top:0;margin-left:auto;flex:none}
  .bt-settings-main{width:100%;flex:1;min-height:0;height:auto}
  .bt-settings-usage[data-off]{left:0;width:100%}
  .bt-settings-scroll{overflow-x:clip}
  .bt-set-row{flex-direction:column;align-items:stretch;gap:8px}
  .bt-set-row>.bt-set-copy{width:100%}
  .bt-avedit{width:min(300px,calc(100vw - 32px))}
  .bt-shape-row{grid-template-columns:repeat(4,1fr)}
}
/* Follow the visible viewport, not the layout one: dvh where the browser knows
   it (the earlier vh value is the fallback), and safe-area padding where
   full-screen layers and bottom regions meet the device's own bars. */
.bt-settings{--bt-set-h:min(780px,calc(100dvh - 2*max(32px,var(--dsh-frame-overlay-top,32px))))}
.bt-mem{height:min(760px,calc(100dvh - 2*max(32px,var(--dsh-frame-overlay-top,32px))))}
.bt-settings-layer,.bt-mem-layer,.bt-palette-layer{padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.bt-panel{padding-bottom:env(safe-area-inset-bottom,0px)}
.bt-settings-scroll{padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}
.bt-voice-bar{padding-bottom:calc(32px + env(safe-area-inset-bottom,0px))}
.bt-exchange .bt-dialog-foot{padding-bottom:calc(28px + env(safe-area-inset-bottom,0px))}
/* iOS zooms the whole page on focused inputs under 16px. */
@media (max-width:640px) and (pointer:coarse){
  .bt-input,.bt-bs-input,.bt-browser-address input,.bt-folder-input,.bt-secret-input,.bt-q-input,.bt-to input,.bt-palette-head input,.bt-mem-input{font-size:16px}
}
`

export const CONVERSATION_CSS = `
.bt-think{font-size:13px;line-height:18px;color:var(--bt-ink-2);margin:2px 0 4px;max-width:calc(var(--bt-msg-w) * 100%)}
body[data-bt-layout=flat] .bt-think{max-width:calc(var(--bt-flat-w) * 100%)}
.bt-think summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px}
.bt-think summary::-webkit-details-marker{display:none}
.bt-think-time{font-variant-numeric:tabular-nums;white-space:nowrap}
/* Five lines of the 18px line height; the rest scrolls inside the box. */
.bt-think-text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px;padding-left:10px;border-left:2px solid var(--bt-line-2);max-height:90px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;outline:none}
.bt-think-text:focus-visible{border-left-color:var(--bt-ink-2)}
.bt-think-text[data-fade=top]{mask-image:linear-gradient(to bottom,transparent,#000 18px)}
.bt-think-text[data-fade=bottom]{mask-image:linear-gradient(to top,transparent,#000 18px)}
.bt-think-text[data-fade=both]{mask-image:linear-gradient(to bottom,transparent,#000 18px,#000 calc(100% - 18px),transparent)}
.bt-event{display:flex;justify-content:center;align-items:center;gap:2px;min-height:24px;margin:2px 0;font-size:12px;line-height:16px;color:var(--bt-ink-2);flex-wrap:wrap}
.bt-event>span{padding:0 2px}
.bt-event button:not(.bt-soft){border:0;background:none;color:inherit;font:inherit;display:inline-flex;align-items:center;gap:4px;cursor:pointer;height:24px;padding:4px 6px 4px 4px;border-radius:999px;box-sizing:border-box;transition:background-color .12s ease}
.bt-event button:not(.bt-soft):hover{background:var(--bt-hover)}
.bt-event button:not(.bt-soft):active{background:var(--bt-active)}
.bt-event .bt-soft{margin-left:6px}
.bt-event button.bt-event-whole{min-width:0;max-width:100%;padding:4px 6px 4px 8px}
.bt-event-whole>*{flex:none}
.bt-event-whole>span:first-child{margin-right:2px}
/* One button cannot wrap like separate parts, so a long name is cut to fit the chat. */
.bt-event-whole>.bt-event-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-time-sep{display:flex;justify-content:center;align-items:center;height:28px;margin:14px 0 8px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap}
[class*="_scroll"]>[class*="_column"]::before{content:var(--bt-first-sep,none);display:block;flex:none;height:28px;margin:17px 0 12px;font-size:12px;line-height:28px;text-align:center;color:var(--bt-ink-2);white-space:nowrap}
.bt-activity{display:flex;align-items:center;gap:10px;margin:8px 0 4px 2px;font-size:14px;color:var(--bt-ink-2)}
.bt-group-replies{display:contents}
/* A Bot chat is flat in every work-details mode, without changing the user's mode
   (it is a DSH-wide setting): step groups lose their header and stay open, and what a
   mode folds away in a finished turn stays shown. TurnProcessCell also opens that
   fold; these rules cover the first frame before it does. */
[data-step-process]>div:first-child{display:none!important}
[data-step-process]>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
:is([data-step-process],[data-turn-process-hidden])[hidden]{content-visibility:visible!important}
[class*="_flowItem"]:has(> [data-slot="conversation.chat.node"]:empty){display:none!important}
[class*="_header"]:has(.bt-head){border-bottom-color:transparent!important;box-shadow:none!important}
/* The transcript runs under a floating header pill. */
header[class*="_header"]:has(.bt-head){position:absolute!important;top:0;left:0;right:0;z-index:8;display:flex!important;padding:10px 0 0!important;background:transparent!important;pointer-events:none;justify-content:center}
header[class*="_header"]:has(.bt-head)::before{content:"";position:absolute;inset:0 0 auto;height:calc(60px + env(safe-area-inset-top,0px));background:linear-gradient(to bottom,var(--bt-main),color-mix(in srgb,var(--bt-main) 0%,transparent));pointer-events:none;z-index:-1}
header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"]{position:absolute;left:12px;top:10px;pointer-events:auto}
header[class*="_header"] .bt-head{flex:1 1 auto;width:100%}
[class*="_body"]:has(> [class*="_scrollBody"]){--dsh-chat-content-width:min(960px,100%)}
/* The shell writes the column's width on the conversation root at every resize, only to
   derive the content width that the rule above replaces. Inherited, each write restyled
   the whole conversation: once a frame while the details panel glides, most in a long
   group chat. Kept on the root alone, a write restyles one element. */
@property --dsh-conversation-column-width{syntax:"*";inherits:false}
@property --dsh-chat-user-width{syntax:"*";inherits:false}
/* DSH's turn tail keeps what plugins put in it (delivered files, the Bot's separators),
   without its copy and branch row; a tail with nothing in it takes no room. */
[data-turn-tail]>:not([data-slot="conversation.chat.turnTail"]){display:none!important}
[class*="_flowItem"][data-chat-flow-kind="turn-tail"]:not(:has([data-slot="conversation.chat.turnTail"]:not(:empty))){display:none!important}
/* Every team Session belongs to a Bot or a group, so a blank one is an empty chat, not
   the shell's new-session hero: no headline, no workspace or mode picker, and the
   composer stays docked at the bottom. */
[data-content-phase=hero] [class*="_scrollBody"]{justify-content:flex-end!important}
[data-content-phase=hero] [class*="_composerHero"]{align-self:stretch!important;width:auto!important;padding-bottom:0!important}
[data-content-phase=hero] [class*="_composerHero"]>[class$="_root"],[data-content-phase=hero] [class*="_heroWorkspaceRow"]{display:none!important}
[data-content-phase=hero] [class*="_composerHero"] [class*="_input"]{min-height:0!important}
/* The right sides give back the scrollbar gutter so both edges sit 16px from the column. */
[class*="_scroll"]:has(> [class*="_column"]){padding:calc(60px + env(safe-area-inset-top,0px)) calc(11px + env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) calc(16px + env(safe-area-inset-left,0px))!important}
/* The shell's running status only hosts the activity row (.bt-typing). */
[data-chat-running]{display:block!important;width:100%;min-height:0!important;margin:0!important;padding:0!important}
[data-chat-running]>span:not([role=status]){display:none!important}
[data-chat-running]:has(> .bt-typing){margin-top:var(--dsh-chat-flow-gap,12px)!important}
.bt-typing{display:flex;align-items:center;gap:12px;height:36px;min-width:0;padding-inline-start:8px;transform-origin:0 50%;animation:bt-typing-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing} backwards}
.bt-typing[data-exiting]{animation:bt-typing-out .14s cubic-bezier(.22,1,.36,1) forwards}
.bt-typing>.bt-mark,.bt-typing>.bt-cluster{flex-shrink:0}
.bt-typing>.bt-mark{cursor:pointer;transition:filter .16s ease-out}
.bt-typing>.bt-mark:hover{filter:drop-shadow(0 2px 4px rgba(0,0,0,.18))}
.bt-typing>.bt-mark .bt-eyes{transition:scale .28s cubic-bezier(.4,.06,.18,1)}
.bt-typing>.bt-mark:hover .bt-eyes{scale:1.18}
.bt-typing-text{display:flex;align-items:center;flex:1 1 auto;min-width:0;animation:bt-typing-label .22s ease-out .2s backwards}
.bt-typing-label{display:inline-flex;align-items:center;gap:6px;min-width:0;animation:bt-typing-label .22s ease-out backwards}
.bt-typing-label>.bt-shimmer{font-size:14px;line-height:22px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-typing-time{flex-shrink:0;margin-left:6px;font-size:12px;line-height:22px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
@keyframes bt-typing-in{from{opacity:0;transform:scale(.9)}}
@keyframes bt-typing-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.92);filter:blur(3px)}}
@keyframes bt-typing-label{from{opacity:0;filter:blur(5px);transform:translateY(3px)}}
/* Shimmer: a stepped sweep clipped to the text. */
.bt-shimmer{color:transparent;background:linear-gradient(90deg,var(--bt-shimmer-base) 0%,var(--bt-shimmer-base) 25%,var(--bt-ink) 60%,var(--bt-shimmer-base) 75%,var(--bt-shimmer-base) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;animation:bt-shimmer 2.2s steps(60) infinite;--bt-shimmer-base:color-mix(in srgb,var(--bt-ink) 40%,transparent)}
@keyframes bt-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
/* New rows slide up; a reply that replaces the activity row grows out of its corner. */
[data-bt-enter="new"]{animation:bt-row-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
[data-bt-enter="after-collapse"]{transform-origin:0 100%;animation:bt-row-after .24s cubic-bezier(.23,1,.32,1) .38s backwards}
@keyframes bt-row-in{from{transform:translateY(12px)}to{transform:none}}
@keyframes bt-row-after{0%{opacity:0;transform:translateY(12px) scale(.94)}55%{opacity:1}100%{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
.bt-typing,.bt-typing[data-exiting]{animation-name:bt-fade-in;animation-duration:.12s;transform:none}
.bt-typing[data-exiting]{animation-name:bt-fade-out}
.bt-typing-text,.bt-typing-label{animation-name:bt-fade-in;animation-delay:0s}
.bt-shimmer{animation:none;background:none;color:var(--bt-ink-2)}
[data-bt-enter="new"]{animation:none}
[data-bt-enter="after-collapse"]{animation:bt-fade-in .12s ease-out}
}
@keyframes bt-fade-in{from{opacity:0}to{opacity:1}}
@keyframes bt-fade-out{from{opacity:1}to{opacity:0}}
[data-composer-card]{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;align-items:center!important;gap:0!important;min-height:44px!important;border-radius:22px!important;padding:7.5px!important;box-sizing:border-box;background:var(--bt-main)!important;border:.5px solid var(--bt-line-2)!important;box-shadow:0 2px 8px -1px rgba(0,0,0,.05),0 1px 2px rgba(0,0,0,.03),0 0 0 1px rgba(228,228,228,.04)!important;transition:border-color .15s ease,background-color .15s ease,${spring(SPRING_SHAPE, 'border-radius')}!important}
[data-composer-card]:hover,[data-composer-card]:focus-within{border-color:color-mix(in srgb,var(--bt-ink) 30%,transparent)!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] *),[data-composer-card]:has([data-composer-input] br + *),[data-composer-card]:has([data-composer-input] > :nth-child(2)){border-radius:18px!important}
[class*="_root"]:has(> [data-composer-card]){padding:0 11px 13px 16px!important}
[class*="_root"]:has(> [data-composer-card])>[data-composer-card]{max-width:min(992px,100%)!important}
[data-composer-card]>[class*="_row"]{display:contents!important}
[data-composer-card] [class*="_tools"]{order:1!important;flex:none!important;align-self:flex-end!important;margin:0!important}
[data-composer-card]>[data-input-scroll]{order:2!important;flex:1 1 0!important;min-width:0!important;padding:0 8px!important;margin:0!important}
[data-composer-card] [class*="_trailing"]{order:3!important;flex:none!important;align-self:flex-end!important;margin:0!important}
[data-composer-card]>[data-slot="conversation.input.attachments"]{order:0!important;flex-basis:100%!important}
[data-composer-card] [data-composer-input]{min-height:24px!important;padding:2px 0!important}
[data-composer-card] [data-composer-placeholder]{left:0!important;top:2px!important}
[data-composer-placeholder]{font-size:0!important;line-height:0!important}
/* The name sits on ::before so that ::after stays free for other composer skins. */
[data-composer-placeholder]::before{content:var(--bt-placeholder,"Message")!important;display:block!important;font-size:14px!important;line-height:24px!important;color:color-mix(in srgb,var(--bt-ink) 36%,transparent)!important}
/* The team's "+" (ComposerPlus) takes the seat of the shell's command-menu button. */
[data-composer-card] button[class*="_add"]{display:none!important}
.bt-plus{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bt-ink) 5%,transparent);box-shadow:inset 0 0 0 .5px var(--bt-line);color:var(--bt-ink-2);cursor:pointer;transition:background-color .15s ease,color .15s ease,${spring(SPRING_TAP, 'scale')}}
.bt-plus:hover,.bt-plus[aria-expanded=true]{background:color-mix(in srgb,var(--bt-ink) 10%,transparent);color:var(--bt-ink)}
.bt-plus:active{scale:.9}
.bt-plus svg{width:14px;height:14px;transition:${spring(SPRING_POP, 'rotate')}}
.bt-plus[aria-expanded=true] svg{rotate:45deg}
.bt-plus-menu{min-width:180px}
[data-composer-card] [class*="_tools"]{gap:0!important}
[data-composer-card] [class*="_modes"]:empty{display:none!important}
[data-composer-card] [class*="_activity"]:not(:has([data-slot] > *)){display:none!important}
[data-composer-card] [class*="_trailing"]{gap:8px!important}
/* No display here: DSH hides these controls with [hidden] while the Bot works. */
[data-composer-card] [class*="_standardControls"]{align-items:center!important;gap:8px!important}
[data-composer-card] button[class*="_primary"]{width:28px!important;height:28px!important;background:var(--bt-accent)!important;color:var(--bt-accent-ink,#fff)!important;border-radius:50%!important;transition:opacity .15s ease,${spring(SPRING_TAP, 'scale')};animation:bt-icon-swap ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
[data-composer-card] button[class*="_primary"]:hover:not(:disabled){opacity:.9}
[data-composer-card] button[class*="_primary"]:active:not(:disabled){scale:.9}
@keyframes bt-icon-swap{from{opacity:0;transform:scale(.5) rotate(-30deg)}}
[data-composer-card] button[class*="_primary"] svg{width:14px;height:14px}
[data-composer-card] button[class*="_primary"]:disabled{display:none!important}
[data-composer-dock]{display:none!important}
.bt-mic,.bt-voice{flex:none;width:28px;height:28px;border-radius:50%;border:0;padding:0;display:inline-grid;place-items:center;cursor:pointer;transition:background-color .15s ease,color .15s ease,${spring(SPRING_TAP, 'scale')}}
.bt-mic{background:color-mix(in srgb,var(--bt-ink) 5%,transparent);box-shadow:inset 0 0 0 .5px var(--bt-line);color:var(--bt-ink-2)}
.bt-mic:hover{background:color-mix(in srgb,var(--bt-ink) 10%,transparent);color:var(--bt-ink)}
.bt-mic[aria-pressed=true]{background:#ff3e51;color:#fff;animation:bt-mic-pulse 1.4s ease-in-out infinite}
@keyframes bt-mic-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,62,81,.35)}50%{box-shadow:0 0 0 5px rgba(255,62,81,0)}}
.bt-voice{display:none;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);animation:bt-icon-swap ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-voice:hover{opacity:.9}
.bt-mic:active,.bt-voice:active{scale:.9}
/* Touch devices never hover: tap-open toolbars (data-open on the message), always
   visible icon buttons and 44px targets replace the hover affordances. */
@media (hover:none){
  .bt-tools{left:auto;right:4px;margin-left:0;border-radius:999px;padding:2px;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2),0 4px 14px rgba(0,0,0,.14)}
  .bt-tools::after{display:none}
  .bt-tool{width:44px;height:44px}
  .bt-menu button,.bt-menu [role=menuitem],.bt-react-strip button{min-height:44px}
  .bt-utools[data-open]{opacity:1;visibility:visible}
  .bt-utools button{width:44px;height:44px}
  [data-chat-flow-kind=user] [class*="_actions"] button{width:44px;height:44px}
}
[data-composer-card]:has(button[class*="_primary"]:disabled) .bt-voice{display:inline-grid}
body[data-bt-room] .bt-voice{display:none!important}
body[data-bt-room] [data-composer-card]:has(button[class*="_primary"]:disabled) .bt-mic:not([aria-pressed=true]){background:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
.bt-mic-note{position:absolute;right:12px;bottom:calc(100% + 8px);padding:5px 10px;border-radius:8px;background:var(--bt-user);color:var(--bt-user-ink);font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none;animation:bt-rise .16s ease-out}
[data-chain-overlay-fallback="conversation.composer"]:has(~ .bt-q){display:block!important;order:2}
.bt-q{order:1}
div:has(> nav [class*="_marks"]){display:none!important}
/* Every user-side bubble (sent, steering mid-turn, not yet admitted, question replies)
   takes its surface and its text from the one --bt-user pair: a skin that repaints
   the host's bubble surface alone would otherwise leave the text unreadable. */
[class*="_userRow"] [class*="_bubble"],[data-chat-flow-kind=question-reply] [class*="_bubble"],[data-chat-flow-kind=command-input] [class*="_bubble"]{background:var(--bt-user)!important;color:var(--bt-user-ink)!important;border-radius:18px!important;padding:7px 12px!important;font-size:var(--dsh-content-font-size,14px)!important;line-height:calc(var(--dsh-content-font-size,14px) + 8px)!important}
[class*="_userRow"] [class*="_bubble"] [class*="_markdown"],[class*="_userRow"] [class*="_bubble"] a{color:inherit}
/* Sent messages get the hover toolbar below; steering and unsent bubbles keep none. */
[class*="_userRow"] [class*="_actions"]{display:none!important}
[data-chat-flow-kind=user] [class*="_userRow"]{flex-direction:row-reverse;align-items:center;justify-content:flex-start}
[data-chat-flow-kind=user] [class*="_actions"]{display:flex!important;height:24px!important;gap:2px!important;opacity:0!important;visibility:hidden;transition:opacity .12s ease,visibility .12s!important;flex:none}
[data-chat-flow-kind=user] [class*="_userRow"]:hover [class*="_actions"],[data-chat-flow-kind=user] [class*="_userRow"]:focus-within [class*="_actions"]{opacity:1!important;visibility:visible}
@media (hover:none){[data-chat-flow-kind=user] [class*="_actions"]{opacity:1!important;visibility:visible}}
[data-chat-flow-kind=user] [class*="_actions"] [class*="_timeStart"]{display:none}
[data-chat-flow-kind=user] [class*="_actions"] button{width:24px;height:24px;border-radius:6px;color:var(--bt-ink-2)}
[data-chat-flow-kind=user] [class*="_actions"] button:hover{background:var(--bt-hover);color:var(--bt-ink)}
[data-chat-flow-kind=user] [class*="_actions"] svg{width:15px;height:15px}
.bt-q-inline{display:flex;margin:4px 0 6px}
[data-chat-flow-kind=assistant-step]+[data-step-process]:has(.bt-q-inline){margin-top:0!important}
[data-chat-flow-kind=question-reply]:has(.bt-q-inline),[data-chat-group-key]:has([data-chat-flow-kind=question-reply] .bt-q-inline),[data-chat-group-key]:has(.bt-q-gone){margin-top:0!important}
.bt-q-inline .bt-q{margin:0;max-width:min(550px,86%);order:0}
.bt-q-dock{width:100%;display:flex;justify-content:center}
.bt-q-dock .bt-q{margin:0 auto 8px}
[class*="_toBottomSlot"]{justify-content:center!important;padding-right:0!important}
[data-conversation-scroll] [class*="_toBottomSlot"]{bottom:calc(var(--dsh-composer-height,152px) + 8px)!important}
[class*="_toBottomSlot"]>button{width:36px!important;height:36px!important;margin-top:-36px!important;background:var(--bt-main)!important;color:var(--bt-ink)!important;box-shadow:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px rgba(0,0,0,.12)!important;animation:bt-tobottom-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out;transition:background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
[class*="_toBottomSlot"]>button:active{scale:.9}
[class*="_toBottomSlot"]>button:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main))!important}
[class*="_toBottomSlot"]>button svg{display:none}
[class*="_toBottomSlot"]>button::before{content:"";width:20px;height:20px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 4v12M5 11l5 5 5-5'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 4v12M5 11l5 5 5-5'/%3E%3C/svg%3E") center/contain no-repeat}
@keyframes bt-tobottom-in{from{translate:0 8px;scale:.8}}
[data-bt-news] [class*="_toBottomSlot"]>button{visibility:hidden!important;pointer-events:none!important}
.bt-news{position:fixed;z-index:30;transform:translateX(-50%);display:inline-flex;align-items:center;overflow:hidden;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);box-shadow:inset 0 0 0 1px rgba(20,20,20,.05),0 1px 3px 0 rgba(0,0,0,.12);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;animation:bt-news-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out}
@keyframes bt-news-in{from{translate:0 8px;scale:.9}}
.bt-news[data-direction=up]{animation-name:bt-news-in-up,bt-veil-in}
@keyframes bt-news-in-up{from{translate:0 -8px;scale:.9}}
.bt-news-jump{display:inline-flex;align-items:center;gap:2px;margin:0;padding:4px 26px 4px 4px;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;white-space:nowrap;cursor:pointer;outline:none}
.bt-news-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}
.bt-news-ico svg{width:16px;height:16px}
.bt-news-x{position:absolute;right:4px;top:50%;z-index:1;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;color:inherit;opacity:.75;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-news-x svg{width:12px;height:12px}
.bt-news-x:hover{opacity:1;background:rgba(20,20,20,.5)}
@media (prefers-reduced-motion:reduce){.bt-news,[class*="_toBottomSlot"]>button{animation:none}}
.bt-new-sep{display:flex;align-items:center;gap:8px;margin:14px 0 8px;padding:2px 0;font-size:11px;line-height:14px;font-weight:500;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-accent);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.bt-new-sep::before,.bt-new-sep::after{content:"";flex:1;height:1px;background:color-mix(in srgb,var(--bt-accent) 20%,transparent)}
.bt-open-new{display:flex;flex-direction:column}
.bt-open-new .bt-new-sep{margin:18px 0 0}
.bt-open-new .bt-time-sep{height:16px;margin:32px 0 2px}
.bt-earlier{display:flex;flex-direction:column;gap:6px}
.bt-earlier-top{display:flex;justify-content:center;align-items:center;height:34px;flex:none}
.bt-earlier-top .bt-soft{height:28px;font-size:12px;padding:0 12px}
.bt-urow{display:flex;justify-content:flex-end}
.bt-ububble{max-width:calc(var(--bt-msg-w) * 100%);background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;font-size:14px;line-height:20px;box-sizing:border-box;overflow-wrap:anywhere}
.bt-ububble [class*="_markdown"],.bt-ububble a{color:inherit!important}
.bt-ububble p{margin:0;line-height:22px}
.bt-uimages{display:block;font-size:12px;opacity:.7}
.bt-utime{margin-top:-4px;font-size:11px;line-height:14px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-earlier .bt-event{margin:4px 0}
.bt-part-line{display:flex;align-items:center;gap:10px;margin:10px 0 6px;font-size:11px;line-height:14px;color:var(--bt-ink-3)}
.bt-part-line::before,.bt-part-line::after{content:"";flex:1;height:1px;background:var(--bt-line)}
/* The dock wrapper also holds the context meter, so it stays hidden until a side question is in it. */
[data-composer-dock]:has(.bt-btw){display:flex!important;flex-direction:column;align-items:center;width:100%;max-width:var(--dsh-composer-card-max-width,748px)}
[data-composer-dock]:has(.bt-btw)>:not([data-slot="conversation.composer.dock"]){display:none!important}
.bt-btw-dock,.bt-btw-stack{display:flex;flex-direction:column;gap:6px;width:100%;max-width:var(--dsh-composer-card-max-width,748px)}
.bt-btw{box-sizing:border-box;width:100%;margin:6px auto;padding:8px 12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink)}
.bt-btw-dock .bt-btw,.bt-btw-stack .bt-btw{margin:0}
.bt-btw-compact{padding:6px 10px}
.bt-btw-head{display:flex;align-items:center;gap:8px;min-width:0}
.bt-btw-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-btw-chevron{flex:none;width:7px;height:7px;border-right:1.5px solid var(--bt-ink-3);border-bottom:1.5px solid var(--bt-ink-3);transform:rotate(-45deg)}
.bt-btw[data-open] .bt-btw-chevron{transform:rotate(45deg)}
.bt-btw-q{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px}
.bt-btw[data-open] .bt-btw-q{white-space:normal}
.bt-btw-time,.bt-btw-status{flex:none;color:var(--bt-ink-3);font-size:11px;line-height:14px;font-variant-numeric:tabular-nums}
.bt-btw-cancel{margin-left:auto}
.bt-btw-cancel:disabled{opacity:.55;cursor:default}
.bt-btw-note{margin:4px 0 0;color:var(--bt-ink-3);font-size:12px;line-height:16px}
.bt-btw-body{margin-top:6px}
.bt-btw-answer{font-size:14px;line-height:20px}
.bt-btw-answer p{margin:0}
.bt-btw-fail{margin:0 0 6px;color:var(--bt-danger);font-size:13px;line-height:18px}
@media (prefers-reduced-motion:reduce){.bt-btw-chevron{transition:none}}
`

// -------------------------------------------------------------------------

// DSH's ClientModuleSystem claims every <style> without a `data-plugin` for the module
// it is materializing and deletes a module's styles when it unloads. Ours carry our
// module id from the start, so another plugin's claim or teardown never takes them.
const PLUGIN_ID = 'ds-bot'

export function installStyles(text, tag) {
  const style = document.createElement('style')
  style.dataset.dshBot = tag
  style.dataset.plugin = PLUGIN_ID
  style.textContent = text
  document.head.appendChild(style)
  return style
}

// Shell chrome only exposes hashed CSS-module classes (`hem6sG_footArea`,
// `_bubble_12mhf_1`), so the overrides above match on name fragments. Substring
// attribute selectors bypass the style engine's class index, and ~20 of them made
// every style recalc about ten times slower. Rewrite each one into the exact class
// names defined by the loaded stylesheets; keep the substring form when none match.
const FRAGMENT_SELECTOR = /\[class\*="(_[\w-]+)"\]/g
const CLASS_TOKEN = /\.((?:\\.|[\w-])+)/g

function sheetClassNames(sheet) {
  const names = []
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText) for (const match of rule.selectorText.matchAll(CLASS_TOKEN)) names.push(match[1])
      if (rule.cssRules) visit(rule.cssRules)
    }
  }
  try { visit(sheet.cssRules) } catch { /* cross-origin sheet */ }
  return names
}

function compileFragmentSelectors(text, names) {
  const compiled = new Map()
  return text.replace(FRAGMENT_SELECTOR, (whole, fragment) => {
    if (!compiled.has(fragment)) {
      const exact = []
      for (const name of names) if (name.includes(fragment)) exact.push(`.${name}`)
      compiled.set(fragment, exact.length ? `:is(${exact.join(',')})` : whole)
    }
    return compiled.get(fragment)
  })
}

export function installCompiledStyles(text, tag) {
  const style = installStyles('', tag)
  let disposed = false
  const cache = new WeakMap()
  const render = () => {
    if (disposed) return
    // A tag removed out from under us (not by the module system, which owns it) goes back.
    if (!style.isConnected) document.head.appendChild(style)
    const names = new Set()
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode?.dataset?.dshBot) continue
      let list = cache.get(sheet)
      if (!list) { list = sheetClassNames(sheet); cache.set(sheet, list) }
      for (const name of list) names.add(name)
    }
    const next = compileFragmentSelectors(text, names)
    if (style.textContent !== next) style.textContent = next
  }
  render()
  // Lazily loaded shell features append their own sheets later.
  let timer
  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 120) }
  const onLoad = (event) => { if (event.target instanceof HTMLLinkElement) schedule() }
  // Our own sheets name no shell classes, so adding one (the panel's first open adds the
  // chat column's rule) recompiles nothing. Our own node coming out is a removal to undo,
  // which render sees without a recompile.
  const shell = node => node.dataset?.dshBot === undefined
  const observer = new MutationObserver((records) => {
    if (records.some(record => [...record.removedNodes].includes(style))) render()
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(shell))) schedule()
  })
  observer.observe(document.head, { childList: true })
  document.addEventListener('load', onLoad, true)
  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('load', onLoad, true)
    clearTimeout(timer)
    style.remove()
  }
}
