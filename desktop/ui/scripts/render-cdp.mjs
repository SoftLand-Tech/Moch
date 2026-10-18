#!/usr/bin/env node
// CDP render driver for verify-ui.sh.
//
// --dump-dom cannot capture this app: chromium freezes a quiet page's timers
// regardless of --timeout, so the shell never finishes booting under it, and
// --virtual-time-budget never elapses against the always-open gateway
// websocket. Driving a real headless chromium over the DevTools protocol
// waits in real time for the ready shell, then captures DOM and screenshot.
//
// Usage: node render-cdp.mjs <url> <out.dom.html> <out.png> [deadlineMs]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, outDom, outPng, deadlineArg] = process.argv.slice(2)
if (!url || !outDom || !outPng) {
  console.error('render-cdp: usage: render-cdp.mjs <url> <out.dom.html> <out.png> [deadlineMs]')
  process.exit(2)
}
const deadlineMs = Number(deadlineArg) || 60_000
// a fresh profile per run: a reused one carries a SingletonLock that makes
// the next chromium exit before announcing its DevTools socket
const profile = mkdtempSync(join(tmpdir(), 'moch-render-'))

const chrome = spawn('chromium', [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profile}`,
  '--window-size=1600,1000', '--hide-scrollbars',
  '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let wsUrl = ''
const wsUrlPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('chromium never announced its DevTools socket')), 15_000)
  const onData = (chunk) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk))
    if (m) { clearTimeout(timer); resolve(m[1]) }
  }
  chrome.stderr.on('data', onData)
  chrome.once('exit', () => reject(new Error('chromium exited before announcing its DevTools socket')))
})

const readyState = `(() => {
  const shellReady = document.querySelector('.rk3-view') !== null
  const splashGone = document.getElementById('boot-splash') === null
  return shellReady && splashGone
})()`

function send(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }))
}

function call(ws, nextId, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.id === nextId) {
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
    ws.addEventListener('message', onMessage)
    send(ws, nextId, method, params)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  wsUrl = await wsUrlPromise
  const browser = new WebSocket(wsUrl)
  await new Promise((res, rej) => { browser.onopen = res; browser.onerror = () => rej(new Error('browser socket failed')) })

  let id = 0
  const { targetId } = await call(browser, ++id, 'Target.createTarget', { url: 'about:blank' })
  const httpBase = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '')
  const { webSocketDebuggerUrl } = await (await fetch(`${httpBase}/json/list`)).json()
    .then((targets) => targets.find((t) => t.id === targetId))
  const page = new WebSocket(webSocketDebuggerUrl)
  await new Promise((res, rej) => { page.onopen = res; page.onerror = () => rej(new Error('page socket failed')) })

  await call(page, ++id, 'Page.enable')
  await call(page, ++id, 'Runtime.enable')
  await call(page, ++id, 'Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await call(page, ++id, 'Page.navigate', { url })

  const start = Date.now()
  let ready = false
  while (Date.now() - start < deadlineMs) {
    await sleep(250)
    const { result, exceptionDetails } = await call(page, ++id, 'Runtime.evaluate', { expression: readyState, returnByValue: true })
    if (exceptionDetails) throw new Error(`readiness probe threw: ${exceptionDetails.text}`)
    if (result.value === true) { ready = true; break }
  }
  if (!ready) throw new Error(`shell not ready after ${deadlineMs}ms`)

  const dom = await call(page, ++id, 'Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
  writeFileSync(outDom, dom.result.value)

  const shot = await call(page, ++id, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'))

  await call(browser, ++id, 'Target.closeTarget', { targetId })
  await call(browser, ++id, 'Browser.close')
  rmSync(profile, { recursive: true, force: true })
  console.log(`render-cdp: ready in ${Date.now() - start}ms, dom ${dom.result.value.length} bytes`)
  process.exit(0)
} catch (err) {
  console.error(`render-cdp: ${err.message}`)
  chrome.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
  process.exit(1)
}
