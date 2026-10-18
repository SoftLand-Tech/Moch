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
// Regex patterns matched against a whole collected string.
const PATTERN_ALLOWLIST = [
  { re: /^[\d\u0660-\u0669\s:.,%·+×÷—–\/-]*$/, why: 'data: pure numbers, times, symbols' },
  { re: /^[\w.\-\/@:]+([·…]?[\w.\-\/@:,]+)*$/, why: 'data/code: paths, urls, identifiers, versions (no prose)' },
  { re: /^(?:[\w.\-\/@:]+\s*)*[·…]?$/, why: 'data/code: dotted fragments' },
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
  { s: '…', why: 'code: the pending breadcrumb' },
  { s: 'unknown', why: 'data: fallback while the runtime has not answered yet' },
  { s: 'Moch Desktop 0.1.0', why: 'proper-noun: product name + version' },
]
// DOM subtrees whose text is runtime data (PTY output), never UI copy.
const DATA_SURFACES = ['.term-stack', '.bp-canvas', 'script', 'style', 'pre']

// ── matcher ─────────────────────────────────────────────────────────────────
const norm = (s) => s.replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&apos;/g, "'").trim()
const wordGuard = (body) => new RegExp(`(?<![A-Za-z\\u0600-\\u06FF])${body}(?![A-Za-z\\u0600-\\u06FF])`)
const compilers = []
for (const catalog of [EN, AR]) {
  for (const value of Object.values(catalog)) {
    const parts = String(value).split(/\{[^}]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    let body = parts.length > 1 ? parts.map((p, i) => (i === 0 ? p : `${p}${i === parts.length - 1 ? '' : '[\\s\\S]{0,40}?'}`)).join('') : parts[0]
    if (parts.length > 1) body = parts.join('[\\s\\S]{0,40}?')
    try { compilers.push(wordGuard(body)) } catch { compilers.push(new RegExp(`^${body}$`)) }
  }
}
const allowedExact = new Set(EXACT_ALLOWLIST.map((e) => norm(e.s)))
function isAllowed(s) {
  const t = norm(s)
  if (!t || allowedExact.has(t)) return true
  return PATTERN_ALLOWLIST.some((p) => p.re.test(t))
}
function inCatalog(s) {
  const t = norm(s)
  return compilers.some((re) => re.test(t))
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
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  await collect(`${locale}:palette`, violations)
  await evaluate(`document.querySelector('.scrim')?.click()`)
  // settings overlay + its three tabs
  await evaluate(`window.dispatchEvent(new CustomEvent('moch-settings-open', { detail: { section: 'general' } }))`)
  await sleep(400)
  await collect(`${locale}:settings-general`, violations)
  for (const tab of ['models', 'connectors', 'skills']) {
    await evaluate(`([...document.querySelectorAll('.rk-set-nav button')].find(b => b.textContent.includes(${'`'}${tab}${'`'}))?.click()`)
    await sleep(400)
    await collect(`${locale}:settings-${tab}`, violations)
  }
  await evaluate(`document.querySelector('.rk-set-head button, [aria-label]')?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
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
