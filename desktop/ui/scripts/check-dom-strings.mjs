#!/usr/bin/env node
// DOM audit for the i18n acceptance bar: every user-facing string RENDERED to
// the DOM must come from the strings catalog (or the documented allowlist
// below). Static source scans cannot see through data flow, so this drives a
// real headless chromium over CDP through the booted shell (verify-ui.sh's
// stack or any MOCH_KEEP=1 leftover), tours every view + the palette + the
// settings overlay in EN and AR, collects leaf text and the
// placeholder/title/alt/aria-label attributes, and matches each against the
// catalogs with {placeholders} interpolated.
//
// Usage: node scripts/check-dom-strings.mjs <url>
//
// Allowlist categories (each entry names why it can never be catalog copy):
//   data         gateway/runtime data (bot names, versions, prompts, paths)
//   proper-noun  brand words shown identically in both locales
//   code         protocol literals and code identifiers
//   data-surface a DOM region whose content is PTY/agent output, not UI copy
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = process.argv[2]
if (!url) {
  console.error('check-dom-strings: usage: check-dom-strings.mjs <url>')
  process.exit(2)
}
const UI_ROOT = process.cwd().endsWith('/scripts') ? '..' : '.'

// ── catalogs ────────────────────────────────────────────────────────────────
async function loadCatalogs() {
  const bundled = await build({
    entryPoints: [join(UI_ROOT, 'src/lib/strings.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  let code = bundled.outputFiles[0].text
  code += '\nexport { EN as __en, AR as __ar }\n'
  const dir = mkdtempSync(join(homedir(), '.cache', 'moch-verify', 'cat-'))
  const js = join(dir, 'module.mjs')
  writeFileSync(js, code)
  const mod = await import(pathToFileURL(js).href)
  rmSync(dir, { recursive: true, force: true })
  return { en: mod.__en, ar: mod.__ar }
}
const { en: EN, ar: AR } = await loadCatalogs()

// ── allowlist ───────────────────────────────────────────────────────────────
// Category predicates, each deciding its language in one pass. The regex
// forms of these nested quantifiers, (^word+ whitespace*)*$, and
// backtracked catastrophically on long prose that fails them: one
// hundred-char view description burned a core for twelve seconds inside a
// single leaf, starving the event loop so no per-call or per-view deadline
// could ever fire, which is what wedged the tour mid-run.
const isDigit = (ch) => ch >= '0' && ch <= '9'
const isArabicDigit = (ch) => ch >= '\u0660' && ch <= '\u0669'
const isSpace = (ch) => ' \t\n\v\f\r\u00a0'.includes(ch)
const isWordChar = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch) || ch === '_' || ch === '.' || ch === '-' || ch === '/' || ch === '@' || ch === ':'
const isSeparatorDot = (ch) => ch === '·' || ch === '…'
const PATTERN_ALLOWLIST = [
  {
    why: 'data: pure numbers, times, symbols',
    test: (s) => [...s].every((ch) => isDigit(ch) || isArabicDigit(ch) || isSpace(ch) || ':.,%·+×÷—–-/'.includes(ch)),
  },
  {
    why: 'data/code: paths, urls, identifiers, versions (no prose)',
    test: (s) => {
      if (!s || !isWordChar(s[0])) return false
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (isSeparatorDot(ch)) {
          if (i === s.length - 1 || isSeparatorDot(s[i + 1])) return false
        } else if (!isWordChar(ch) && ch !== ',') return false
      }
      return true
    },
  },
  {
    why: 'data: calendar timestamps formatted from run ledgers',
    test: (s) =>
      /^(?:[A-Za-z]{3} )?\d{1,2}, \d{1,2}:\d{2} (?:AM|PM)$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^\d{1,2}:\d{2} [صم]$/.test(s)
      || /^\d{1,2} \S+، \d{1,2}:\d{2} [صم]$/.test(s),
  },
  {
    why: 'data/code: dotted fragments',
    test: (s) => {
      let i = 0
      while (i < s.length) {
        let j = i
        while (j < s.length && isWordChar(s[j])) j++
        if (j === i) break
        i = j
        while (i < s.length && isSpace(s[i])) i++
      }
      const rest = s.slice(i)
      return rest === '' || (rest.length === 1 && isSeparatorDot(rest))
    },
  },
]
// Exact strings, matched after entity/whitespace normalization.
const EXACT_ALLOWLIST = [
  { s: 'Moch', why: 'proper-noun: the wordmark, identical in both locales' },
  { s: 'EN', why: 'code: the locale button label' },
  { s: 'العربية', why: 'proper-noun: the Arabic locale writes its own name' },
  { s: 'Language / اللغة', why: 'proper-noun: bilingual section title by design' },
  { s: 'SOUL.md', why: 'code: a file name' },
  { s: 'about:blank', why: 'code: the blank page url' },
  { s: '?', why: 'code: the unknown-marker' },
  { s: '⌄', why: 'code: the model picker dropdown chevron' },
  { s: '⧉ copy', why: 'code: message-foot action, icon glyph and label in one span' },
  { s: '♪ listen', why: 'code: message-foot action, icon glyph and label in one span' },
  { s: '✎ save as skill', why: 'code: message-foot action, icon glyph and label in one span' },
  { s: '↻ retry', why: 'code: message-foot action, icon glyph and label in one span' },
  { s: '…', why: 'code: the pending breadcrumb' },
  { s: 'unknown', why: 'data: fallback while the runtime has not answered yet' },
  { s: 'Moch Desktop 0.1.0', why: 'proper-noun: product name + version' },
]
// DOM subtrees whose text is runtime data, never UI copy: PTY output (the
// compact context-panel terminal hosts xterm under .term-host; the full
// terminal view wraps the same host in .term-stack), the roster avatar
// monogram (the bot's own name sliced to two characters), and transcript
// message bodies (the bot's speech; overlays like ask cards render as
// siblings of .msg and stay collected).
const DATA_SURFACES = ['.term-host', '.term-stack', '.rk-avatar', '.msg', '.bp-canvas', 'script', 'style', 'pre']

// ── matcher ─────────────────────────────────────────────────────────────────
const norm = (s) => s.replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&apos;/g, "'").trim()
// A leaf resolves through the catalog when some value's static parts appear
// in it in order, each placeholder filling up to GAP characters in between,
// bounded by non-letter edges. The regex form of this question, unanchored
// patterns with lazy gaps, shares the allowlist's backtracking hazard on
// adversarial leaves, so this is also a scan: greedy earliest occurrence of
// each part inside its window, which is complete for ordered window
// matching because each first occurrence leaves the most room for every
// part that follows.
const GAP = 40
const isLetter = (ch) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '\u0600' && ch <= '\u06FF')
const CATALOG_ENTRIES = []
for (const catalog of [EN, AR]) {
  for (const value of Object.values(catalog)) {
    const parts = String(value).split(/\{[^}]+\}/).filter((p) => p !== '')
    if (!parts.length) continue
    CATALOG_ENTRIES.push({ parts, longest: parts.reduce((a, b) => (b.length > a.length ? b : a)) })
  }
}
// A part edge needs its non-letter guard only when the part itself ends (or
// begins) with a letter: "Next {when}" interpolates a date that can start
// with a month name, and the trailing space already draws the boundary.
const edgedOn = (entry) => {
  const first = entry.parts[0]
  const last = entry.parts[entry.parts.length - 1]
  return { start: isLetter(first[0]), end: isLetter(last[last.length - 1]) }
}
const allowedExact = new Set(EXACT_ALLOWLIST.map((e) => norm(e.s)))
function isAllowed(s) {
  const t = norm(s)
  if (!t || allowedExact.has(t)) return true
  return PATTERN_ALLOWLIST.some((p) => p.test(t))
}
function inCatalog(s) {
  const t = norm(s)
  return CATALOG_ENTRIES.some((e) => {
    if (!t.includes(e.longest)) return false
    let start = -1
    let end = -1
    let maxGap = 0
    for (const p of e.parts) {
      const idx = t.indexOf(p, end < 0 ? 0 : end)
      if (idx < 0 || (end >= 0 && idx - end > maxGap)) return false
      if (start < 0) start = idx
      end = idx + p.length
      maxGap = GAP
    }
    const guard = edgedOn(e)
    const before = start > 0 ? t[start - 1] : ''
    const after = end < t.length ? t[end] : ''
    return !(guard.start && isLetter(before)) && !(guard.end && isLetter(after))
  })
}

// ── CDP plumbing (same contract as render-cdp.mjs) ─────────────────────────
const verifyRoot = join(homedir(), '.cache', 'moch-verify')
mkdirSync(verifyRoot, { recursive: true })
const run = mkdtempSync(join(verifyRoot, 'audit-'))
const chrome = spawn('chromium', [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${join(run, 'profile')}`,
  '--window-size=1600,1000', '--hide-scrollbars',
  '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: run }, detached: true })
async function teardown(exitCode) {
  try { process.kill(-chrome.pid, 'SIGKILL') } catch { chrome.kill('SIGKILL') }
  await new Promise((resolve) => { chrome.once('exit', resolve); setTimeout(resolve, 2000) })
  rmSync(run, { recursive: true, force: true })
  if (exitCode !== undefined) process.exit(exitCode)
}
process.once('SIGINT', () => { teardown(130) })
process.once('SIGTERM', () => { teardown(143) })
let stderrBuf = ''
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('chromium never announced its DevTools socket')), 15_000)
  chrome.stderr.on('data', (chunk) => {
    // the announce line can split across chunks; match against the buffer
    stderrBuf += String(chunk)
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuf)
    if (m) { clearTimeout(timer); resolve(m[1]) }
  })
  chrome.once('exit', () => reject(new Error('chromium exited early')))
})
async function openSocket(addr, what) {
  const ws = new WebSocket(addr)
  const timer = setTimeout(() => { try { ws.close() } catch { /* already closed */ } }, 10_000)
  await new Promise((res, rej) => {
    ws.onopen = () => { clearTimeout(timer); res() }
    ws.onerror = () => { clearTimeout(timer); rej(new Error(what)) }
  })
  return ws
}
const browser = await openSocket(wsUrl, 'browser socket failed')
let id = 0
function call(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    // A navigation can destroy the execution context while an evaluate is
    // in flight; its response never arrives, so every call carries its own
    // deadline and the polls around navigation treat a rejection as "not
    // ready yet" instead of hanging.
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      reject(new Error(`${method}: timed out`))
    }, 15_000)
    const onMessage = (event) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.id === mid) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const { targetId } = await call(browser, 'Target.createTarget', { url: 'about:blank' })
const httpBase = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '')
const { webSocketDebuggerUrl } = (await (await fetch(`${httpBase}/json/list`)).json()).find((t) => t.id === targetId)
const page = await openSocket(webSocketDebuggerUrl, 'page socket failed')
await call(page, 'Page.enable')
await call(page, 'Runtime.enable')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function evaluate(expression) {
  const { result, exceptionDetails } = await call(page, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(`evaluate threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`)
  return result.value
}

const readyState = `(() => document.querySelector('.rk3-view') !== null && document.getElementById('boot-splash') === null)()`
async function waitReady(deadlineMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    await sleep(250)
    try { if (await evaluate(readyState)) return } catch { /* context mid-swap */ }
  }
  throw new Error('shell not ready in time')
}

// ── the tour ────────────────────────────────────────────────────────────────
const VIEWS = ['chat', 'fleet', 'crew', 'inbox', 'browser', 'terminal', 'automations', 'history', 'workflows']
const COLLECT = `(() => {
  const skip = new Set(${JSON.stringify(DATA_SURFACES)})
  const out = []
  const isData = (el) => { for (const s of skip) if (el.closest(s)) return true; return false }
  // querySelectorAll snapshots before iteration: a live TreeWalker over a
  // DOM that React re-renders mid-walk can loop forever and wedge the tab
  const els = [...document.querySelectorAll('*')]
  for (const el of els.slice(0, 8000)) {
    if (isData(el)) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'canvas') continue
    for (const attr of ['placeholder', 'title', 'alt', 'aria-label']) {
      const v = el.getAttribute?.(attr)
      if (v) out.push({ where: attr, text: v })
    }
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')
    if (ownText.trim()) out.push({ where: tag, text: ownText })
  }
  return out
})()`

async function collect(label, violations) {
  await sleep(300)
  // a view that stalls the protocol must surface as a loud failure, not a
  // silent hang, so the collection carries its own deadline
  const found = await Promise.race([
    evaluate(COLLECT),
    sleep(20_000).then(() => { throw new Error(`collect timed out on ${label}`) }),
  ])
  for (const { where, text } of found) {
    const t = norm(text)
    if (!t || isAllowed(t) || inCatalog(t)) continue
    violations.push({ surface: label, where, text: t.slice(0, 120) })
  }
}
async function go(v) {
  await evaluate(`window.dispatchEvent(new CustomEvent('moch-navigate', { detail: ${JSON.stringify(v)} }))`)
  await sleep(400)
}
const violations = []
await call(page, 'Page.navigate', { url })
await waitReady()
for (const locale of ['en', 'ar']) {
  // set storage and navigate in separate CDP calls: a reload inside evaluate
  // destroys the execution context and the response never arrives
  await evaluate(`localStorage.setItem('moch.desktop.locale.v1', ${JSON.stringify(locale)})`)
  await call(page, 'Page.navigate', { url })
  await waitReady()
  for (const v of VIEWS) {
    try {
      await go(v)
      await collect(`${locale}:${v}`, violations)
    } catch (err) {
      violations.push({ surface: `${locale}:${v}`, where: 'audit', text: `COLLECTION FAILED: ${err.message}` })
    }
  }
  // command palette over the shell
  try {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
    await collect(`${locale}:palette`, violations)
    await evaluate(`document.querySelector('.scrim')?.click()`)
  } catch (err) {
    violations.push({ surface: `${locale}:palette`, where: 'audit', text: `COLLECTION FAILED: ${err.message}` })
  }
  // settings overlay + its three tabs
  try {
    await evaluate(`window.dispatchEvent(new CustomEvent('moch-settings-open', { detail: { section: 'general' } }))`)
    await sleep(400)
    await collect(`${locale}:settings-general`, violations)
    // nav labels are translated, so click by tab position, not by label text
    for (const [i, tab] of ['models', 'connectors', 'skills'].entries()) {
      await evaluate(`document.querySelectorAll('.rk-set-nav button[role="tab"]')[${i + 1}]?.click()`)
      await sleep(400)
      await collect(`${locale}:settings-${tab}`, violations)
    }
    await evaluate(`document.querySelector('.rk-set-me button')?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  } catch (err) {
    violations.push({ surface: `${locale}:settings`, where: 'audit', text: `COLLECTION FAILED: ${err.message}` })
  }
}

await call(browser, 'Target.closeTarget', { targetId })
await call(browser, 'Browser.close')

if (violations.length) {
  console.error(`check-dom-strings: ${violations.length} rendered string(s) outside the catalog:`)
  const seen = new Set()
  for (const v of violations) {
    const key = `${v.surface}|${v.text}`
    if (seen.has(key)) continue
    seen.add(key)
    console.error(`  [${v.surface}] (${v.where}) ${JSON.stringify(v.text)}`)
  }
  console.error('route them through tr() or document them in the allowlist in scripts/check-dom-strings.mjs')
  await teardown(1)
}
console.log(`check-dom-strings: clean — every rendered string resolves through the catalog or the documented allowlist (${Object.keys(EN).length} EN keys)`)
await teardown(0)
