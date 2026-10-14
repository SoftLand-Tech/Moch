/* Headless-Chromium tab screenshots via CDP (design evidence pack).
 * Run: node .shots.cjs <static-port>   (app must be running) */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const WebSocket = require('../app/node_modules/ws')

const PORT = process.argv[2] || '33839'
const CDP = 9333
const OUT = path.join(__dirname, 'docs-shots')

async function getJson(url) {
  const res = await fetch(url)
  return res.json()
}

function send(ws, id, method, params = {}) {
  return new Promise((resolve) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw)
      if (m.id === id) { ws.off('message', onMsg); resolve(m.result) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const chrome = execFile('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${CDP}`, '--window-size=480,900', '--user-data-dir=/home/mamoun/ai/learning/Moch/worktrees/desktop-tauri/desktop/.chrome-profile',
    'about:blank',
  ])
  await new Promise((r) => setTimeout(r, 6000))

  const targets = await getJson(`http://127.0.0.1:${CDP}/json/list`)
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((r) => (ws.on('open', r)))

  let id = 0
  const call = (m, p) => send(ws, ++id, m, p)
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await new Promise((r) => setTimeout(r, 6000)) // gateway connect + tab render

  const tabs = ['chat', 'bots', 'crew', 'automations', 'skills', 'models', 'run']
  for (let i = 0; i < tabs.length; i++) {
    await call('Runtime.evaluate', { expression: `document.querySelectorAll('.tab')[${i}]?.click()` })
    await new Promise((r) => setTimeout(r, 1200))
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, `${tabs[i]}.png`), Buffer.from(shot.data, 'base64'))
    console.log('shot:', tabs[i])
  }
  ws.close()
  chrome.kill()
}

main().catch((e) => { console.error(e); process.exit(1) })
