/**
 * ptyClient — one real host PTY per mount.
 *
 * Owns the whole lifecycle of a single terminal session: the xterm.js
 * Terminal, the @xterm/addon-fit FitAddon, the Tauri `pty_spawn` session and
 * the `pty://output` / `pty://exit` event wiring. The disposer (and
 * `restart()`) is idempotent so React StrictMode's double-mounted effects
 * can never leak two shell processes per visible terminal.
 *
 * Binary safety: shell output can be arbitrary bytes, so both directions go
 * through base64 with proper UTF-8 handling — INPUT is TextEncoder → bytes →
 * btoa over a latin1 binary string, OUTPUT is atob → Uint8Array handed to
 * terminal.write() directly (xterm accepts Uint8Array, no string decoding
 * round-trip that could mangle multibyte sequences).
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { invoke, listen, inTauri } from './tauri'
import { atom } from 'nanostores'

/** Live terminal sessions (for the titlebar Code card). */
export const terminalLive = atom(0)

/** UTF-8-safe base64 encode: text → bytes → btoa(binary string). */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Base64 → raw bytes (no text decoding — the PTY stream is binary). */
export function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface PtyMountOptions {
  cwd?: string
  shell?: string
  cols: number
  rows: number
  env?: Record<string, string>
}

export interface PtyHandle {
  readonly terminal: Terminal
  /** Session id of the live PTY, or null between restarts / after exit. */
  readonly sessionId: string | null
  /** Kill + respawn the shell inside the same terminal element. */
  restart(): Promise<void>
  /** Clear the viewport (keeps scrollback per xterm semantics). */
  clear(): void
  focus(): void
  /** Feed text into the PTY as if typed (used by paste helpers). */
  send(data: string): void
  /** Subscribe to session exit (natural or killed). Returns unsubscriber. */
  onExit(cb: () => void): () => void
  /** Idempotent: kill PTY, unwire events, dispose the xterm instance. */
  dispose(): void
}

/** Painted when the child exits — dim grey, spec'd by the terminal brief. */
const ENDED_MESSAGE = '\r\n\x1b[90m[session ended]\x1b[0m '


// ── transport seam ─────────────────────────────────────────────────────
// Tauri: the Rust pty_* commands + pty:// events. Preview: the dev-bridge's
// real PTYs (node-pty) over HTTP + SSE — same shapes, same behavior.

interface PtyTransport {
  spawn(opts: { cwd?: string; shell?: string; cols: number; rows: number; env?: Record<string, string> }): Promise<string>
  write(id: string, dataB64: string): Promise<unknown>
  resize(id: string, cols: number, rows: number): Promise<unknown>
  kill(id: string): Promise<unknown>
  onOutput(cb: (id: string, dataB64: string) => void): () => void
  onExit(cb: (id: string) => void): () => void
}

const tauriPty: PtyTransport = {
  async spawn(o) {
    return invoke<string>('pty_spawn', o)
  },
  write(id, dataB64) {
    return invoke('pty_write', { id, dataB64 })
  },
  resize(id, cols, rows) {
    return invoke('pty_resize', { id, cols, rows })
  },
  kill(id) {
    return invoke('pty_kill', { id })
  },
  onOutput(cb) {
    let un: (() => void) | null = null
    let stopped = false
    void listen<{ id: string; data: string }>('pty://output', (e) => {
      if (e.payload) cb(e.payload.id, e.payload.data)
    }).then((u) => { if (stopped) u(); else un = u })
    return () => { stopped = true; un?.() }
  },
  onExit(cb) {
    let un: (() => void) | null = null
    let stopped = false
    void listen<string>('pty://exit', (e) => {
      if (typeof e.payload === 'string') cb(e.payload)
    }).then((u) => { if (stopped) u(); else un = u })
    return () => { stopped = true; un?.() }
  },
}

const bridgePty: PtyTransport = (() => {
  let es: EventSource | null = null
  const outputCbs = new Set<(id: string, b64: string) => void>()
  const exitCbs = new Set<(id: string) => void>()
  function ensureEvents(): void {
    if (es) return
    es = new EventSource('/dev-bridge/pty/events')
    es.addEventListener('output', (ev) => {
      try {
        const p = JSON.parse((ev as MessageEvent).data) as { id: string; data: string }
        for (const cb of outputCbs) cb(p.id, p.data)
      } catch { /* malformed frame */ }
    })
    es.addEventListener('exit', (ev) => {
      const raw = (ev as MessageEvent).data
      for (const cb of exitCbs) cb(String(raw))
    })
    es.onerror = () => {
      es?.close()
      es = null
    }
  }
  async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`/dev-bridge/pty/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`pty bridge ${path} -> HTTP ${res.status}`)
    return res.json()
  }
  return {
    async spawn(o) {
      ensureEvents()
      const r = (await post('spawn', o)) as { id: string }
      return r.id
    },
    write(id, dataB64) {
      return post('write', { id, dataB64 })
    },
    resize(id, cols, rows) {
      return post('resize', { id, cols, rows })
    },
    kill(id) {
      return post('kill', { id })
    },
    onOutput(cb) {
      ensureEvents()
      outputCbs.add(cb)
      return () => { outputCbs.delete(cb) }
    },
    onExit(cb) {
      ensureEvents()
      exitCbs.add(cb)
      return () => { exitCbs.delete(cb) }
    },
  }
})()

const pty: PtyTransport = inTauri ? tauriPty : bridgePty

export function mountPty(el: HTMLElement, opts: PtyMountOptions): PtyHandle {
  const fit = new FitAddon()
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 12.5,
    fontFamily: 'var(--font-mono), "JetBrains Mono", "Fira Code", monospace',
    allowProposedApi: true,
    scrollback: 5000,
    theme: {
      background: '#0d0a18',
      foreground: '#e8e6f0',
      cursor: '#f79236',
      selectionBackground: 'rgba(247,146,54,0.25)',
    },
  })
  terminal.loadAddon(fit)
  terminal.open(el)

  let id: string | null = null
  let disposed = false
  /** Bumped on every stop/dispose so a late `pty_spawn` resolve is detected. */
  let generation = 0
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  const unlisteners: UnlistenFn[] = []
  const exitCallbacks = new Set<() => void>()

  // ── session lifecycle ────────────────────────────────────────────────
  async function start(): Promise<void> {
    if (disposed) return
    const gen = ++generation
    // Fit to the real element first so the PTY starts at the true size
    // (guarded: a display:none tab has no measurable size — keep the
    // caller-provided fallback dims then).
    const measurable = el.clientWidth > 0 && el.clientHeight > 0
    if (measurable) {
      try { fit.fit() } catch { /* fonts not ready yet — resize observer retries */ }
    }
    const cols = measurable ? terminal.cols : Math.max(2, opts.cols)
    const rows = measurable ? terminal.rows : Math.max(2, opts.rows)
    try {
      const spawned = await pty.spawn({
        cwd: opts.cwd ?? undefined,
        shell: opts.shell ?? undefined,
        env: opts.env ?? undefined,
        cols,
        rows,
      })
      // Lost a race with dispose()/restart(): kill the orphan immediately.
      if (disposed || gen !== generation) {
        void pty.kill(spawned).catch(() => {})
        return
      }
      id = spawned
      terminalLive.set(terminalLive.get() + 1)
    } catch (err) {
      if (disposed || gen !== generation) return
      terminal.write(`\r\n\x1b[31m[pty spawn failed: ${String(err)}]\x1b[0m `)
      return
    }
  }

  async function stop(kill: boolean): Promise<void> {
    generation++
    const old = id
    id = null
    if (old && kill) {
      try { await pty.kill(old) } catch { /* already gone */ }
    }
  }

  // ── input: keystrokes → base64 → pty_write ───────────────────────────
  const offData = terminal.onData((data) => {
    const current = id
    if (!current) return
    void pty.write(current, encodeBase64Utf8(data)).catch(() => {
      // session died mid-keystroke; the exit event paints the notice
    })
  })

  // ── output/exit events, filtered by session id ───────────────────────
  unlisteners.push(pty.onOutput((outId, dataB64) => {
    if (outId !== id || !id) return
    terminal.write(decodeBase64Bytes(dataB64))
  }))
  unlisteners.push(pty.onExit((exitId) => {
    if (exitId !== id || !id) return
    id = null
    terminalLive.set(Math.max(0, terminalLive.get() - 1))
    terminal.write(ENDED_MESSAGE)
    for (const cb of exitCallbacks) {
      try { cb() } catch { /* subscriber error must not break the stream */ }
    }
  }))

  // ── resize: debounced fit → pty_resize ───────────────────────────────
  const observer = new ResizeObserver(() => {
    if (disposed) return
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return
      try { fit.fit() } catch { /* transient measure failure */ }
      const current = id
      if (!current) return
      void pty.resize(current, terminal.cols, terminal.rows).catch(() => {
        // session ended — nothing to resize
      })
    }, 150)
  })
  observer.observe(el)

  void start()

  return {
    terminal,
    get sessionId() { return id },
    async restart() {
      if (disposed) return
      await stop(true)
      if (disposed) return
      await start()
    },
    clear() { terminal.clear() },
    focus() { terminal.focus() },
    send(data: string) {
      const current = id
      if (!current) return
      void pty.write(current, encodeBase64Utf8(data)).catch(() => {})
    },
    onExit(cb: () => void) {
      exitCallbacks.add(cb)
      return () => { exitCallbacks.delete(cb) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      const old = id
      id = null
      if (old) void invoke('pty_kill', { id: old }).catch(() => {})
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      observer.disconnect()
      offData.dispose()
      for (const un of unlisteners.splice(0)) un()
      terminal.dispose()
    },
  }
}
