/**
 * Dev bridge: a tiny vite plugin that exposes the real runtime state (and
 * browser controls) to a plain-browser preview, so the UI can be exercised
 * end-to-end without the Tauri shell. Active only under `vite dev`.
 */
import type { Plugin } from 'vite'
import { spawn, type Child } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

const STATE_FILE = process.env.MOCH_DESKTOP_STATE_DIR
  ? `${process.env.MOCH_DESKTOP_STATE_DIR}/desktop-runtime.json`
  : null

function readState(): { port: number; token: string; home: string; workspace: string } | null {
  if (!STATE_FILE) return null
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(300, '127.0.0.1', port) // placeholder, replaced below
    sock.destroy()
    resolve(false)
  })
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1', timeout: 400 }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
  })
}

function which(name: string): string | null {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(':')) {
    const candidate = `${dir}/${name}`
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* keep looking */ }
  }
  return null
}

let browserProc: Child | null = null
let browserPort: number | null = null

async function launchBrowser(): Promise<{ running: boolean; port: number | null }> {
  if (browserPort && (await checkPort(browserPort))) {
    return { running: true, port: browserPort }
  }
  const bin = which('chromium') ?? which('chromium-browser') ?? which('google-chrome-stable')
  if (!bin) throw new Error('no chromium found')
  const port = await freePort()
  const profile = `${process.env.MOCH_DESKTOP_STATE_DIR ?? '/tmp'}/chromium-profile`
  fs.mkdirSync(profile, { recursive: true })
  browserProc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1200',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await checkPort(port)) {
      browserPort = port
      return { running: true, port }
    }
  }
  throw new Error('chromium CDP port never came up')
}

export function devBridge(): Plugin {
  return {
    name: 'moch-dev-bridge',
    configureServer(server) {
      // Gateway REST proxy: the page can't fetch the gateway directly (CORS).
      // Token comes from the runtime state file; the method rides x-dev-method
      // so the outer request is a plain POST/GET.
      server.middlewares.use('/dev-bridge/gw', (req, res, next) => {
        if (!STATE_FILE) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'no state file' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const path = url.searchParams.get('path') ?? '/'
        const method = (req.headers['x-dev-method'] as string | undefined) ?? (req.method ?? 'GET')
        const state = readState()
        if (!state) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'runtime state unavailable' }))
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const body = chunks.length ? Buffer.concat(chunks) : undefined
          fetch(`http://127.0.0.1:${state.port}${path}`, {
            method,
            headers: {
              'X-Hermes-Session-Token': state.token,
              ...(body ? { 'Content-Type': (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream' } : {}),
            },
            body,
          })
            .then(async (up) => {
              res.statusCode = up.status
              const buf = Buffer.from(await up.arrayBuffer())
              res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/octet-stream')
              res.end(buf)
            })
            .catch((err) => {
              res.statusCode = 502
              res.end(JSON.stringify({ error: String(err) }))
            })
        })
      })
      server.middlewares.use('/dev-bridge/cdp', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const port = Number(url.searchParams.get('port') ?? 0)
        const method = (url.searchParams.get('method') ?? 'GET').toUpperCase() === 'PUT' ? 'PUT' : 'GET'
        const path = url.searchParams.get('path') ?? '/json/version'
        if (!port) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'port required' }))
          return
        }
        fetch(`http://127.0.0.1:${port}${path}`, { method })
          .then(async (up) => {
            res.statusCode = up.status
            res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/json')
            res.end(await up.text())
          })
          .catch((err) => {
            res.statusCode = 502
            res.end(JSON.stringify({ error: String(err) }))
          })
      })
      server.middlewares.use('/dev-bridge/runtime-state', (_req, res) => {
        const state = readState()
        if (!state) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'runtime state file not found — is the gateway running?' }))
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(state))
      })
      server.middlewares.use('/dev-bridge/browser-status', async (_req, res) => {
        if (browserPort && (await checkPort(browserPort))) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ running: true, port: browserPort }))
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ running: false, port: null }))
        }
      })
      server.middlewares.use('/dev-bridge/browser-launch', async (_req, res) => {
        try {
          const status = await launchBrowser()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ running: status.running, port: status.port, executable: which('chromium'), profileDir: null }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}
