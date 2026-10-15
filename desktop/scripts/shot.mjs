#!/usr/bin/env node
/**
 * shot.mjs — CDP screenshot + diagnostics driver for the Moch desktop UI.
 *
 * Launches headless Chromium with --remote-debugging-port on a FREE port,
 * connects over the DevTools protocol, renders the target URL at each
 * requested viewport (Emulation.setDeviceMetricsOverride), waits for load +
 * network quiet + a settle delay, and captures a PNG per width.
 *
 * Diagnostics collected per width:
 *   - Runtime.consoleAPICalled  (error + warning)
 *   - Runtime.exceptionThrown   (uncaught errors)
 *   - Log.entryAdded            (browser log, error + warning)
 *   - Network.loadingFailed
 *   - document.body.innerText   (the ground truth of what rendered)
 *   - horizontal layout overflow (documentElement.scrollWidth vs innerWidth)
 *
 * Writes <out>/<W>x<H>.png and <out>/report.json.
 * Exit codes: 0 ok · 2 page failed (blank render / uncaught errors /
 * console errors) · 3 chromium/CDP failure · 124 hard timeout · 1 bad args.
 * Chromium is ALWAYS killed (process group) — no orphan processes.
 *
 * No new npm deps: WebSocket comes from the app checkout's `ws`
 * (../app/node_modules/ws).
 *
 * Usage:
 *   node shot.mjs --url http://127.0.0.1:8099/ --out ../../.tmp/shots \
 *                 --widths 1024x768,1280x840,1440x900,1920x1080 --settle 2500
 * Optional:
 *   --chat                after screenshots, drive one chat turn over CDP
 *                         (type into the composer, press Enter, wait for the
 *                         assistant's streamed text) and record evidence
 *   --timeout <ms>        overall hard timeout (default 240s; 420s with --chat)
 *   --chromium <path>     default /usr/bin/chromium
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { widths: '1024x768,1280x840,1440x900,1920x1080', settle: 2500, chat: false, chromium: '/usr/bin/chromium' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': out.url = argv[++i]; break;
      case '--out': out.out = argv[++i]; break;
      case '--widths': out.widths = argv[++i]; break;
      case '--settle': out.settle = Number(argv[++i]); break;
      case '--timeout': out.timeout = Number(argv[++i]); break;
      case '--chromium': out.chromium = argv[++i]; break;
      case '--chat': out.chat = true; break;
      case '--help': case '-h': out.help = true; break;
      default: fail(1, `unknown argument: ${a}`);
    }
  }
  if (out.help) { console.log(__doc__()); process.exit(0); }
  if (!out.url) fail(1, '--url is required');
  if (!out.out) fail(1, '--out is required');
  out.widths = out.widths.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d+)[x×](\d+)$/.exec(s);
    if (!m) fail(1, `bad width spec '${s}' (want WxH, e.g. 1280x840)`);
    return { spec: `${m[1]}x${m[2]}`, w: Number(m[1]), h: Number(m[2]) };
  });
  if (!out.widths.length) fail(1, '--widths parsed to nothing');
  if (!Number.isFinite(out.settle) || out.settle < 0) fail(1, 'bad --settle');
  // Hard timeout must cover the worst case: per width, load can wait up to
  // 45s + network quiet up to 25s + settle, so keep generous headroom.
  out.timeout = out.timeout ?? (out.chat ? 480_000 : 360_000);
  return out;
}
const __doc__ = () => 'see header comment';
function fail(code, msg) { console.error(`shot: FATAL: ${msg}`); process.exit(code); }

const ARGS = parseArgs(process.argv.slice(2));

// ── chromium lifecycle ──────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const RUNTIME = { chromium: null, userDir: null, killed: false };
function killChromium() {
  if (RUNTIME.killed) return;
  RUNTIME.killed = true;
  const c = RUNTIME.chromium;
  if (c && c.pid) {
    // We spawned detached (own process group): signal the GROUP so
    // crashpad/GPU children die too — no orphans.
    try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (RUNTIME.userDir) {
    try { fs.rmSync(RUNTIME.userDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killChromium(); process.exit(130); });
process.on('exit', killChromium);

async function launchChromium(cdpPort) {
  RUNTIME.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moch-shot-profile-'));
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${RUNTIME.userDir}`,
    'about:blank',
  ];
  const stderrBuf = [];
  const child = spawn(ARGS.chromium, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  RUNTIME.chromium = child;
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; }); // e.g. binary missing (ENOENT)
  child.stderr.on('data', (d) => { stderrBuf.push(d); if (stderrBuf.length > 200) stderrBuf.shift(); });
  RUNTIME.stderrTail = () => Buffer.concat(stderrBuf).toString('utf8').split('\n').slice(-25).join('\n');

  // Wait for the CDP HTTP endpoint to answer (or the process to die).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new ShotError(3, `cannot launch ${ARGS.chromium}: ${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new ShotError(3, `chromium exited early (code ${child.exitCode})\n${RUNTIME.stderrTail()}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new ShotError(3, `chromium CDP endpoint never answered on :${cdpPort}\n${RUNTIME.stderrTail()}`);
}

// ── CDP session ─────────────────────────────────────────────────────────────
const WS_PATH = path.resolve(SCRIPT_DIR, '../../app/node_modules/ws');
let WS;
try { WS = require(WS_PATH); } catch (e) { fail(1, `cannot load ws from ${WS_PATH}: ${e.message}`); }

class ShotError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.on('message', (raw) => this._onMessage(raw.toString('utf8')));
    ws.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new ShotError(3, 'CDP websocket closed'));
      this.pending.clear();
    });
  }
  _onMessage(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`));
      else resolve(m.result);
      return;
    }
    if (m.method && this.handlers.has(m.method)) {
      for (const fn of this.handlers.get(m.method)) fn(m.params);
    }
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ShotError(3, `CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function pageTargetWsUrl(cdpPort) {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  const targets = await r.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new ShotError(3, `no page target on :${cdpPort}`);
  return page.webSocketDebuggerUrl;
}

// ── collectors ──────────────────────────────────────────────────────────────
function makeCollectors() {
  return {
    consoleErrors: [], consoleWarnings: [], exceptions: [],
    logEntries: [], loadingFailed: [], requests: 0,
  };
}

function attachCollectors(cdp, c) {
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    const rec = { type: p.type, text: text.slice(0, 2000), ts: new Date().toISOString() };
    if (p.type === 'error') c.consoleErrors.push(rec);
    else if (p.type === 'warning') c.consoleWarnings.push(rec);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    c.exceptions.push({
      text: String(d.text ?? ''),
      exception: d.exception?.description ?? d.exception?.value ?? null,
      url: d.url ?? null, line: d.lineNumber ?? null, ts: new Date().toISOString(),
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error' || e.level === 'warning') {
      c.logEntries.push({ level: e.level, source: e.source, url: e.url, text: String(e.text ?? '').slice(0, 2000) });
    }
  });
  cdp.on('Network.requestWillBeSent', () => { c.requests++; c.lastRequestAt = Date.now(); });
  cdp.on('Network.loadingFailed', (p) => {
    c.loadingFailed.push({ url: p.requestId, errorText: p.errorText, type: p.type, blocked: p.blockedReason ?? null });
  });
}

// ── page lifecycle helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function navigateAndSettle(cdp, c, { w, h }, url, settleMs) {
  // Fresh collectors per width: console/log state is per-load.
  Object.assign(c, makeCollectors(), { consoleErrors: [], consoleWarnings: [], exceptions: [], logEntries: [], loadingFailed: [] });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });

  let loaded = false;
  const onLoad = () => { loaded = true; };
  cdp.on('Page.loadEventFired', onLoad);

  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw new ShotError(2, `navigation failed: ${nav.errorText} (${url})`);

  const loadDeadline = Date.now() + 45_000;
  while (!loaded && Date.now() < loadDeadline) await sleep(100);
  if (!loaded) {
    // Not fatal: SPAs can be slow; evidence lands in the report either way.
    console.error(`shot: WARN: Page.loadEventFired not seen within 45s for ${url} (continuing)`);
  }

  // Network quiet: zero in-flight requests sustained for QUIET ms.
  let inflight = 0;
  const bump = (d) => () => { inflight += d; c.lastActivity = Date.now(); };
  const onSent = bump(1), onDone = bump(-1);
  cdp.on('Network.requestWillBeSent', onSent);
  cdp.on('Network.loadingFinished', onDone);
  cdp.on('Network.loadingFailed', onDone);
  const QUIET = 1500;
  const quietDeadline = Date.now() + 25_000;
  let quietSince = null;
  while (Date.now() < quietDeadline) {
    if (inflight <= 0) quietSince ??= Date.now(); else quietSince = null;
    if (quietSince && Date.now() - quietSince >= QUIET) break;
    await sleep(150);
  }
  cdp.handlers.get('Network.requestWillBeSent')?.pop();
  cdp.handlers.get('Network.loadingFinished')?.pop();
  cdp.handlers.get('Network.loadingFailed')?.pop();

  await sleep(settleMs);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise,
  });
  if (r.exceptionDetails) {
    throw new Error(`evaluate failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result?.value;
}

const PAGE_PROBE = `(() => {
  const de = document.documentElement;
  const txt = (document.body && document.body.innerText) || '';
  return {
    title: document.title,
    bodyText: txt.slice(0, 20000),
    textLen: txt.trim().length,
    overflow: {
      scrollWidth: de.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: de.scrollHeight,
      innerHeight: window.innerHeight,
      overflowingX: de.scrollWidth > window.innerWidth,
    },
    ariaLabels: Array.from(document.querySelectorAll('[aria-label]'))
      .map(e => e.getAttribute('aria-label')).slice(0, 40),
  };
})()`;

// ── chat driver (--chat) ────────────────────────────────────────────────────
const COMPOSER_SELECTORS = [
  '[aria-label="Message input"]',
  'textarea[placeholder*="Moch"]',
  'input[placeholder*="Moch"]',
  'form textarea', 'form input[type="text"]',
];

async function driveChat(cdp, report) {
  const chat = { attempted: true, steps: [] };
  report.chat = chat;
  const note = (s) => { chat.steps.push(`${new Date().toISOString()} ${s}`); console.error(`shot: chat: ${s}`); };

  const setComposerText = `(() => {
    const sels = ${JSON.stringify(COMPOSER_SELECTORS)};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, 'Reply with exactly: HARNESS-OK-42');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return { found: true, selector: sel, tag: el.tagName, placeholder: el.getAttribute('placeholder') };
    }
    return { found: false };
  })()`;
  const found = await evaluate(cdp, setComposerText);
  if (!found.found) {
    chat.error = 'composer not found — UI is likely on pairing/onboarding (see bodyText evidence)';
    note('composer NOT found; cannot drive a chat turn');
    return chat;
  }
  chat.composer = found;
  note(`composer found via ${found.selector} (<${found.tag}>, placeholder="${found.placeholder}")`);

  const before = await evaluate(cdp, PAGE_PROBE);
  chat.textBefore = (before.bodyText || '').slice(-1500);

  // Press Enter like a keyboard would (RNW web TextInput submits on Enter).
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
  }
  note('Enter dispatched');

  // Wait for the assistant: composer cleared / Stop control / transcript growth.
  const deadline = Date.now() + 150_000;
  let sawBusy = false;
  let lastLen = (before.bodyText || '').length;
  let grew = false;
  while (Date.now() < deadline) {
    await sleep(1500);
    const probe = await evaluate(cdp, PAGE_PROBE);
    const busy = probe.ariaLabels.some((l) => l === 'Stop');
    if (busy && !sawBusy) { sawBusy = true; note('run started (Stop control visible)'); }
    const len = (probe.bodyText || '').length;
    if (len > lastLen + 20) {
      grew = true;
      chat.textAfter = probe.bodyText.slice(-2500);
      note(`transcript grew (+${len - lastLen} chars; busy=${busy})`);
    }
    lastLen = Math.max(lastLen, len);
    if (grew && !busy) { note('run appears finished (Stop control gone, transcript grew)'); break; }
  }
  chat.sawBusy = sawBusy;
  chat.assistantSeen = grew;
  if (!grew) chat.error = chat.error || 'no transcript change observed within timeout';
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ARGS.out, 'chat.png'), Buffer.from(shot.data, 'base64'));
  chat.screenshot = 'chat.png';
  return chat;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  fs.mkdirSync(ARGS.out, { recursive: true });

  const hardTimer = setTimeout(() => {
    console.error(`shot: FATAL: hard timeout (${ARGS.timeout}ms) — killing chromium and writing partial report`);
    killChromium();
    try {
      fs.writeFileSync(path.join(ARGS.out, 'report.json'), JSON.stringify({
        startedAt, url: ARGS.url, hardTimeout: true, verdict: 'timeout',
      }, null, 2));
    } catch { /* ignore */ }
    process.exit(124);
  }, ARGS.timeout);
  hardTimer.ref?.();

  const cdpPort = await freePort();
  console.error(`shot: chromium CDP port ${cdpPort}`);
  await launchChromium(cdpPort);
  console.error('shot: chromium up; connecting to page target');

  const ws = new WS(await pageTargetWsUrl(cdpPort), { maxPayload: 128 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', () => reject(new ShotError(3, 'CDP websocket closed before open')));
    setTimeout(() => reject(new ShotError(3, 'ws open timeout')), 10_000);
  });
  // Keep 'error' handled for the connection's whole life, not just pre-open
  // (an unhandled ws error mid-run would crash the process and orphan
  // chromium's kill path — Cdp's close handler already fails pending calls).
  ws.on('error', (e) => { console.error(`shot: WARN: ws error: ${e.message || e}`); });
  const cdp = new Cdp(ws);
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp.send(`${d}.enable`);

  const collectors = makeCollectors();
  attachCollectors(cdp, collectors);

  const report = {
    startedAt, url: ARGS.url, settleMs: ARGS.settle,
    chromium: { path: ARGS.chromium, cdpPort }, widths: [], global: {},
  };

  let anyRendered = false;
  let fatal = false;
  for (const { spec, w, h } of ARGS.widths) {
    console.error(`shot: ${spec}: navigating + settling …`);
    const w0 = Date.now();
    await navigateAndSettle(cdp, collectors, { w, h }, ARGS.url, ARGS.settle);
    const probe = await evaluate(cdp, PAGE_PROBE);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = `${spec}.png`;
    fs.writeFileSync(path.join(ARGS.out, file), Buffer.from(shot.data, 'base64'));
    const bytes = fs.statSync(path.join(ARGS.out, file)).size;
    const rendered = probe.textLen > 0;
    anyRendered ||= rendered;
    const fatalIssues = collectors.exceptions.length > 0 || collectors.consoleErrors.length > 0;
    if (fatalIssues) fatal = true;
    report.widths.push({
      spec, file, bytes,
      durationMs: Date.now() - w0,
      rendered,
      title: probe.title,
      bodyText: probe.bodyText,
      overflow: probe.overflow,
      ariaLabels: probe.ariaLabels,
      consoleErrors: collectors.consoleErrors,
      consoleWarnings: collectors.consoleWarnings,
      exceptions: collectors.exceptions,
      logEntries: collectors.logEntries,
      loadingFailed: collectors.loadingFailed,
      requestCount: collectors.requests,
      fatalIssues,
    });
    console.error(`shot: ${spec}: ${rendered ? `rendered (${probe.textLen} chars)` : 'BLANK'} · png ${bytes} B · consoleErrors=${collectors.consoleErrors.length} exceptions=${collectors.exceptions.length} overflowX=${probe.overflow.overflowingX}`);
    if (!rendered) fatal = true;
  }

  if (ARGS.chat) {
    try { await driveChat(cdp, report); }
    catch (e) { report.chat = { attempted: true, error: `chat driver failed: ${e.message}` }; }
  }

  report.global = {
    consoleErrors: report.widths.flatMap((w) => w.consoleErrors.map((e) => ({ [w.spec]: e.text }))),
    exceptions: report.widths.flatMap((w) => w.exceptions.map((e) => ({ [w.spec]: e.exception ?? e.text }))),
    logEntries: report.widths.flatMap((w) => w.logEntries.map((e) => ({ [w.spec]: `${e.level}: ${e.text}` }))),
    loadingFailed: report.widths.flatMap((w) => w.loadingFailed.map((e) => ({ [w.spec]: e.errorText }))),
  };
  report.anythingRendered = anyRendered;
  report.verdict = fatal ? 'fail' : 'pass';
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  report.chromiumStderrTail = RUNTIME.stderrTail?.() ?? '';

  fs.writeFileSync(path.join(ARGS.out, 'report.json'), JSON.stringify(report, null, 2));
  cdp.close();
  killChromium();
  clearTimeout(hardTimer);

  const errs = report.global.consoleErrors.length + report.global.exceptions.length;
  console.error(`shot: done in ${report.durationMs}ms — verdict=${report.verdict} (rendered=${anyRendered}, consoleErrors+exceptions=${errs})`);
  console.error(`shot: report: ${path.join(ARGS.out, 'report.json')}`);
  if (fatal) process.exit(2);
}

main().catch((e) => {
  console.error(`shot: FATAL: ${e.stack || e.message}`);
  killChromium();
  process.exit(e.code === 3 ? 3 : 1);
});
