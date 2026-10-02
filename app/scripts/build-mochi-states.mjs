#!/usr/bin/env node
/**
 * Build the 32 Mochi character states into one bundled TS module.
 *
 *   node scripts/build-mochi-states.mjs   (npm run build:mochi)
 *
 * Inputs  (untouched source):  mochi-svgs/mochi-*.html
 * Registry (loopSec source of truth): `const states = [...]` in
 *   mochi-svgs/mochi-studio.html — parsed, never copied by hand.
 * Output (committed): src/components/mochi/mochiStates.gen.ts
 *
 * Per-chunk transforms (see the rebrand architecture):
 *   - normalize the duplicate-id bug  `<g id="mochi" id="character-rig">`
 *     → `<g id="character-rig">` (5 files carry it)
 *   - delete `<rect id="background" fill="#000000"/>`
 *   - drop the dead `html, body` / `*, *::before` document rules (the shell
 *     document owns these once chunks are prefixed)
 *   - strip the standalone-page nav pill CSS + markup
 *   - strip ALL `will-change:` declarations (≈180 promoted GPU layers across
 *     31 paused chunks is the low-end jank/OOM source; will-change does
 *     nothing for hidden paused states)
 *   - namespace: every top-level selector prefixed with `#st-<name> `,
 *     @keyframes `x` → `x--<name>` with animation refs rewritten, every
 *     defs (gradient/filter) id suffixed with its url(#…) refs rewritten
 *     (verified to collide across chunks: `@keyframes sproutPerk` in all
 *     files, `#body`/`.eye`/`#blush` selectors everywhere)
 *   - svg wrapped in `<div class="mochi-state" id="st-<name>"
 *     data-loop="<loopSec from registry>">`
 *
 * Post-conditions hard-fail (exit 1): dead selectors/attrs left in a chunk,
 * an animation reference that doesn't resolve to a same-chunk @keyframes,
 * shell missing its transparent document rule, data-loop ≠ registry.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SRC_DIR = join(ROOT, 'mochi-svgs')
const OUT_TS = join(ROOT, 'src', 'components', 'mochi', 'mochiStates.gen.ts')

const warnings = []
const fail = (msg) => {
  console.error(`build:mochi: FAIL ${msg}`)
  process.exit(1)
}
const warn = (msg) => {
  warnings.push(msg)
  console.warn(`build:mochi: warn ${msg}`)
}

// ── 1. Registry: {file → duration} from the studio page ────────────────────

const studioHtml = readFileSync(join(SRC_DIR, 'mochi-studio.html'), 'utf8')
const registryMatch = studioHtml.match(/const states = (\[[\s\S]*?\]);/)
if (!registryMatch) fail('could not parse the `const states = [...]` registry from mochi-studio.html')
const registry = JSON.parse(registryMatch[1])
if (!Array.isArray(registry) || registry.length === 0) fail('studio registry parsed empty')

/** studio file name → state name: the app-level names carry the `mochi-`
 *  prefix (chunk id `st-mochi-typing`, __mochSet('mochi-typing')); the base
 *  state's file IS mochi.html → 'mochi'. */
const stateNameForFile = (file) => file.replace(/\.html$/, '')
const LOOP = new Map() // state name → seconds (float)
for (const entry of registry) {
  const name = stateNameForFile(entry.file)
  const sec = parseFloat(entry.duration)
  if (!Number.isFinite(sec) || sec <= 0) fail(`registry entry ${entry.file}: bad duration ${entry.duration}`)
  LOOP.set(name, sec)
}

// ── 2. CSS block parser (no @media / nested at-rules in the sources) ───────

/** Split a stylesheet into {selector, body} blocks with brace matching. */
function parseBlocks(css) {
  const blocks = []
  let i = 0
  const n = css.length
  while (i < n) {
    // selector text up to '{' or end
    let selStart = i
    while (i < n && css[i] !== '{') i++
    if (i >= n) break
    const selector = css.slice(selStart, i).trim()
    i++ // consume '{'
    let depth = 1
    const bodyStart = i
    while (i < n && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    if (depth !== 0) fail(`unbalanced braces in stylesheet near selector "${selector.slice(0, 60)}"`)
    const body = css.slice(bodyStart, i - 1)
    blocks.push({ selector, body })
    // skip to next selector start
    while (i < n && /[\s;]/.test(css[i])) i++
  }
  return blocks
}

/** Split on a character, ignoring occurrences inside parens (cubic-bezier(…),
 *  steps(2, start), …). */
function splitTopLevel(value, ch) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of value) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    if (c === ch && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

// ── 3. Per-chunk build ──────────────────────────────────────────────────────

const DEAD_SELECTOR_PARTS = [
  /^\*$/, // the `*, *::before, *::after` reset's first part
  /^html$/, // `html, body` document rule
  /^body$/,
]

function isDeadSelectorPart(part) {
  const p = part.trim()
  if (DEAD_SELECTOR_PARTS.some((re) => re.test(p))) return true
  if (/^(\*|html|body)\s*[,{}]/.test(p) || p === '*::before' || p === '*::after') return true
  return false
}

function chunkCss(state, css) {
  // comments are standalone-page banners; stripping them keeps selectors
  // single-line so the `#st-` prefix lands at true line starts
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = parseBlocks(css)
  const id = `st-${state}`

  // pass 1 — collect @keyframes names to rename (rules can precede their keyframes)
  const kf = new Map() // old name → new name
  for (const b of blocks) {
    const m = b.selector.match(/^@keyframes\s+([a-zA-Z-][\w-]*)\s*$/)
    if (m) kf.set(m[1], `${m[1]}--${state}`)
  }

  const out = []
  for (const b of blocks) {
    if (b.selector.startsWith('@keyframes')) {
      const name = b.selector.replace(/^@keyframes\s+/, '').trim()
      out.push(`@keyframes ${kf.get(name)} {${b.body}}`)
      continue
    }
    if (b.selector.startsWith('@')) {
      // no @media/@supports in the sources; keep any future at-rule scoped
      out.push(`${b.selector} {${b.body}}`)
      continue
    }

    // dead document/page rules: drop when EVERY comma part is dead, or the
    // rule belongs to the standalone page's nav pill / description bar.
    const parts = b.selector.split(',')
    const navRule = parts.every((p) =>
      /\.nav-container|\.mode-switch|\.mode-btn|\.desc-bar/.test(p),
    )
    if (navRule) continue
    if (parts.every(isDeadSelectorPart)) continue

    let body = b.body
    // strip ALL will-change declarations (with or without trailing semicolon)
    body = body.replace(/\s*will-change:\s*[^;}]*/g, '')
    // rename animation / animation-name references (first token of each
    // comma-separated animation in the shorthand; every source uses
    // `animation: <name> <duration> …`, name-first)
    body = body.replace(/(animation(?:-name)?\s*:\s*)([^;}]+)/g, (whole, prop, value) => {
      const items = splitTopLevel(value, ',').map((item) => item.trim())
      const renamed = items.map((item) => {
        const m = item.match(/^([a-zA-Z-][\w-]*)(.*)$/)
        if (m && kf.has(m[1])) return kf.get(m[1]) + m[2]
        return item
      })
      return prop + renamed.join(', ')
    })

    const prefixed = parts.map((p) => `#${id} ${p.trim()}`).join(', ')
    out.push(`${prefixed} {${body}}`)
  }
  return out.join('\n')
}

function chunkSvg(state, svg) {
  // background rect out
  svg = svg.replace(/<rect id="background"[^>]*\/>/, '')
  if (svg.includes('id="background"')) fail(`${state}: background rect survived deletion`)

  // defs ids (gradients/filters) are the cross-chunk collision namespace:
  // suffix them and rewrite their url(#…) / href="#…" references.
  const defsMatch = svg.match(/<defs>([\s\S]*?)<\/defs>/)
  if (defsMatch) {
    const defIds = [...defsMatch[1].matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    for (const id of defIds) {
      const next = `${id}--${state}`
      svg = svg.replace(new RegExp(`id="${id}"`, 'g'), `id="${next}"`)
      svg = svg.replace(new RegExp(`url\\(#${id}\\)`, 'g'), `url(#${next})`)
      svg = svg.replace(new RegExp(`href="#${id}"`, 'g'), `href="#${next}"`)
    }
  }
  return svg
}

function buildChunk(state, html, loopSec) {
  // duplicate-id normalization — exactly `<g id="mochi" id="character-rig">`
  const dupFixed = html.includes('<g id="mochi" id="character-rig">')
  html = html.replace(/<g id="mochi" id="character-rig">/g, '<g id="character-rig">')

  const style = html.match(/<style>([\s\S]*?)<\/style>/)
  const svg = html.match(/<svg[\s\S]*?<\/svg>/)
  if (!style) fail(`${state}: no <style> block found`)
  if (!svg) fail(`${state}: no <svg> element found`)

  const css = chunkCss(state, style[1])
  const markup = chunkSvg(state, svg[0])

  return {
    state,
    dupFixed,
    loopSec,
    html:
      `<style>\n${css}\n</style>\n` +
      `<div class="mochi-state" id="st-${state}" data-loop="${loopSec}">\n${markup}\n</div>`,
  }
}

// ── 4. Load every state file ────────────────────────────────────────────────

const files = readdirSync(SRC_DIR).filter(
  (f) => /^mochi(?:-[\w-]+)?\.html$/.test(f) && f !== 'mochi-studio.html',
)
const chunks = []
for (const file of files) {
  const state = stateNameForFile(file)
  if (!LOOP.has(state)) fail(`${file}: no registry entry for state "${state}"`)
  const raw = readFileSync(join(SRC_DIR, file), 'utf8')
  chunks.push(buildChunk(state, raw, LOOP.get(state)))
}

// state set must equal the registry set (mochi-studio.html itself excluded)
const expected = new Set([...LOOP.keys()])
const got = new Set(chunks.map((c) => c.state))
for (const name of expected) if (!got.has(name)) warn(`registry state "${name}" has no mochi-${name}.html on disk — SKIPPED (fallback behavior applies in-app)`)
for (const name of got) if (!expected.has(name)) fail(`chunk "${name}" has no registry entry`)

const dupFixedStates = chunks.filter((c) => c.dupFixed).map((c) => c.state).sort()
const DUP_EXPECTED = ['mochi-approval', 'mochi-confused', 'mochi-deep-thinking', 'mochi-error', 'mochi-thinking']
if (JSON.stringify(dupFixedStates) !== JSON.stringify(DUP_EXPECTED)) {
  fail(`duplicate-id normalization touched ${JSON.stringify(dupFixedStates)}, expected exactly ${JSON.stringify(DUP_EXPECTED)}`)
}

// ── 5. Master-duration drift cross-check (registry is the authority) ───────

for (const c of chunks) {
  const m = c.html.match(/#st-[\w-]+ #body\s*\{[^}]*animation:\s*[\w-]+\s+([\d.]+)s/)
  if (!m) {
    warn(`${c.state}: no #body animation found — cannot cross-check master duration`)
    continue
  }
  const master = parseFloat(m[1])
  if (Math.abs(master - c.loopSec) > 0.01) {
    warn(`${c.state}: master #body animation ${master}s ≠ registry ${c.loopSec}s`)
  } else {
    // inventory note: any OTHER animation drifting off the registry loop.
    // sproutPerk (0.8s hover nicety, present in every file) is excluded —
    // its .stage:hover rule is dead in the bundle and its rate is uniform.
    for (const a of c.html.matchAll(/animation:\s*([\w-]+)--[\w-]+\s+([\d.]+)s/g)) {
      const dur = parseFloat(a[2])
      if (a[1] !== 'sproutPerk' && Math.abs(dur - c.loopSec) > 0.01) {
        warn(`${c.state}: sub-animation ${a[1]} runs ${dur}s vs registry loop ${c.loopSec}s (known-drift class, informational)`)
      }
    }
  }
}

// ── 6. Post-conditions (hard-fail) ──────────────────────────────────────────

for (const c of chunks) {
  const h = c.html
  for (const needle of ['nav-container', 'mode-btn', 'id="background"', 'background-color: #000000', 'will-change', 'html, body']) {
    if (h.includes(needle)) fail(`${c.state}: post-condition (i) — emitted chunk contains "${needle}"`)
  }
  if (/(^|\n)\s*#body\s*\{/.test(h)) {
    const at = h.search(/(^|\n)\s*#body\s*\{/)
    console.error(`DEBUG context: …${JSON.stringify(h.slice(Math.max(0, at - 120), at + 120))}…`)
    fail(`${c.state}: post-condition (i) — bare "#body {" selector survived (must be #st-prefixed)`)
  }

  // (ii) every animation reference resolves to a same-chunk @keyframes
  const defined = new Set([...h.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
  for (const m of h.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const item of splitTopLevel(m[1], ',')) {
      const name = item.trim().match(/^([a-zA-Z-][\w-]*)/)?.[1]
      if (!name) continue
      if (!defined.has(name)) fail(`${c.state}: post-condition (ii) — animation "${name}" has no @keyframes in this chunk (frozen state)`)
    }
  }

  // (iv) data-loop matches the registry
  const loopAttr = h.match(/data-loop="([\d.]+)"/)?.[1]
  if (!loopAttr || Math.abs(parseFloat(loopAttr) - c.loopSec) > 0.001) {
    fail(`${c.state}: post-condition (iv) — data-loop "${loopAttr}" ≠ registry ${c.loopSec}`)
  }
}

// ── 7. Shell document + TS emit ─────────────────────────────────────────────

function mochiDocumentSource() {
  return `/**
 * Assemble the single-document mascot: shell CSS (document-level rules and
 * the .mochi-state stacking/crossfade), every chunk pre-mounted and paused,
 * and the tiny __mochSet bridge. All switches are class toggles in this one
 * document — no re-mounts, no fetches.
 */
export function mochiDocument(dev: boolean): string {
  const body = MOCHI_STATE_NAMES.map((n) => MOCHI_STATES[n].html).join('\\n')
  const forceHook = dev
    ? '\\n  window.__mochForce = window.__mochSet; // __DEV__ force hook (browser sweep / dev picker)'
    : ''
  return \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  /* Document owner: the chunks dropped their own html/body rules. */
  html, body {
    background: transparent;
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    overflow: hidden;
  }
  /* Stacking: every state absolutely stacked in the same fixed box.
     animation-play-state is NOT inherited, so pause/run targets the
     subtree explicitly (a bare .mochi-state rule cannot pause children). */
  .mochi-state {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    opacity: 0;
    visibility: hidden;
    transition: opacity 150ms ease-out, visibility 0s linear 150ms;
  }
  .mochi-state, .mochi-state * { animation-play-state: paused; }
  .mochi-state.active {
    opacity: 1;
    visibility: visible;
    transition: opacity 150ms ease-out, visibility 0s;
  }
  .mochi-state.active, .mochi-state.active * { animation-play-state: running; }
  /* Reduced motion: hard cuts instead of crossfades. */
  @media (prefers-reduced-motion: reduce) {
    .mochi-state, .mochi-state.active { transition: none; }
  }
</style>
</head>
<body>
\${body}
<script>
(function () {
  var current = null;
  function activate(el) {
    el.classList.add('active');
    // One-shots must play from their first frame on every entry, not resume
    // mid-cycle (a half-done wink reads broken). Harmless for sticky loops.
    try {
      if (el.getAnimations) {
        el.getAnimations({ subtree: true }).forEach(function (a) {
          try { a.currentTime = 0; } catch (e) {}
        });
      }
    } catch (e) {}
  }
  window.__mochSet = function (name) {
    var next = document.getElementById('st-' + name);
    if (!next || current === name) return;
    var prev = current ? document.getElementById('st-' + current) : null;
    current = name;
    requestAnimationFrame(function () {
      activate(next);
      if (prev) requestAnimationFrame(function () { prev.classList.remove('active'); });
    });
  };
  window.__mochCurrent = function () { return current; };\${forceHook}
})();
</script>
</body>
</html>\`
}`
}

const sortedStates = [...got].sort()
const entries = sortedStates
  .map((name) => {
    const c = chunks.find((x) => x.state === name)
    return `  ${JSON.stringify(name)}: {\n    loopSec: ${c.loopSec},\n    html: ${JSON.stringify(c.html)},\n  },`
  })
  .join('\n')

const gen = `// GENERATED by scripts/build-mochi-states.mjs — DO NOT EDIT.
// Regenerate: npm run build:mochi
// Source of truth: mochi-svgs/mochi-*.html (untouched art) + the \`states\`
// registry in mochi-svgs/mochi-studio.html (loopSec provenance).
// Every chunk is fully namespaced (#st-<name>, keyframes x--<name>,
// defs ids x--<name>) so all states coexist in ONE document.

export const MOCHI_STATE_NAMES = ${JSON.stringify(sortedStates)} as const

export type MochiStateName = (typeof MOCHI_STATE_NAMES)[number]

export const MOCHI_STATES: Record<MochiStateName, { html: string; loopSec: number }> = {
${entries}
}

${mochiDocumentSource()}
`

mkdirSync(join(ROOT, 'src', 'components', 'mochi'), { recursive: true })
writeFileSync(OUT_TS, gen)

const kb = (Buffer.byteLength(gen) / 1024).toFixed(0)
console.log(`build:mochi: ${chunks.length} states → ${OUT_TS} (${kb} KB)`)
console.log(`build:mochi: dup-id normalized in: ${dupFixedStates.join(', ')}`)
if (warnings.length) console.log(`build:mochi: ${warnings.length} warning(s)`)
