/**
 * Dev bridge: a tiny vite plugin that exposes the real runtime state (and
 * browser controls) to a plain-browser preview, so the UI can be exercised
 * end-to-end without the Tauri shell. Active only under `vite dev`.
 */
import type { Plugin } from 'vite'
import { spawn, type Child } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
      // PTY host (real terminals in the preview, via node-pty when present).
      try {
        const pty = require('node-pty') as {
          spawn: (file: string, args: string[], opts: Record<string, unknown>) => { write: (d: string) => void; kill: () => void; resize: (c: number, r: number) => void; onData: (cb: (d: string) => void) => void; onExit: (cb: () => void) => void }
        }
        const sessions = new Map<string, { write: (d: string) => void; kill: () => void; resize: (c: number, r: number) => void }>()
        const sseClients = new Set<{ send: (event: string, data: string) => void }>()
        let nextId = 1

        server.middlewares.use('/dev-bridge/pty/events', (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          const client = {
            send: (event: string, data: string) => {
              try {
                res.write(`event: ${event}\ndata: ${data}\n\n`)
              } catch {
                sseClients.delete(client)
              }
            },
          }
          sseClients.add(client)
          _req.on('close', () => sseClients.delete(client))
          client.send('hello', '1')
        })

        server.middlewares.use('/dev-bridge/pty/spawn', (req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
                cwd?: string; shell?: string; cols?: number; rows?: number; env?: Record<string, string>
              }
              const id = `b${nextId++}`
              const shell = body.shell || process.env.SHELL || '/bin/bash'
              const proc = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: body.cols ?? 80,
                rows: body.rows ?? 24,
                cwd: body.cwd || process.env.HOME,
                env: { ...process.env, ...(body.env ?? {}) },
              })
              proc.onData((d) => {
                for (const c of sseClients) c.send('output', JSON.stringify({ id, data: Buffer.from(d, 'utf-8').toString('base64') }))
              })
              proc.onExit(() => {
                sessions.delete(id)
                for (const c of sseClients) c.send('exit', id)
              })
              sessions.set(id, proc)
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ id }))
            } catch (err) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: String(err) }))
            }
          })
        })

        const jsonBody = (req: import('http').IncomingMessage, cb: (body: Record<string, unknown>) => void): void => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            try {
              cb(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
            } catch {
              res500(req, cb)
            }
          })
        }
        const res500 = (req: import('http').IncomingMessage, cb: (body: Record<string, unknown>) => void) => cb({})

        server.middlewares.use('/dev-bridge/pty/write', (req, res) => {
          jsonBody(req, (body) => {
            const s = sessions.get(String(body.id ?? ''))
            if (s && typeof body.dataB64 === 'string') {
              s.write(Buffer.from(body.dataB64, 'base64').toString('utf-8'))
              res.end(JSON.stringify({ ok: true }))
            } else {
              res.statusCode = 404
              res.end(JSON.stringify({ error: 'no session' }))
            }
          })
        })
        server.middlewares.use('/dev-bridge/pty/resize', (req, res) => {
          jsonBody(req, (body) => {
            const s = sessions.get(String(body.id ?? ''))
            if (s) s.resize(Number(body.cols ?? 80), Number(body.rows ?? 24))
            res.end(JSON.stringify({ ok: true }))
          })
        })
        server.middlewares.use('/dev-bridge/pty/kill', (req, res) => {
          jsonBody(req, (body) => {
            const s = sessions.get(String(body.id ?? ''))
            if (s) {
              s.kill()
              sessions.delete(String(body.id ?? ''))
            }
            res.end(JSON.stringify({ ok: true }))
          })
        })
      } catch {
        // node-pty unavailable — the preview shows the honest spawn error.
      }

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
      server.middlewares.use('/dev-bridge/read-file', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const path = url.searchParams.get('path') ?? ''
        if (!path.startsWith('/')) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'absolute path required' }))
          return
        }
        try {
          const data = fs.readFileSync(path)
          const ext = path.split('.').pop()?.toLowerCase() ?? ''
          const mimes: Record<string, string> = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav',
            webm: 'video/webm', mp4: 'video/mp4', pdf: 'application/pdf', txt: 'text/plain',
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            path,
            mime: mimes[ext] ?? 'application/octet-stream',
            size: data.length,
            dataB64: data.toString('base64'),
            tooLarge: false,
          }))
        } catch (err) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: String(err) }))
        }
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
