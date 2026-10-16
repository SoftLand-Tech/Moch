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
import { invoke, listen } from './tauri'

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
      const spawned = await invoke<string>('pty_spawn', {
        cwd: opts.cwd ?? undefined,
        shell: opts.shell ?? undefined,
        env: opts.env ?? undefined,
        cols,
        rows,
      })
      // Lost a race with dispose()/restart(): kill the orphan immediately.
      if (disposed || gen !== generation) {
        void invoke('pty_kill', { id: spawned }).catch(() => {})
        return
      }
      id = spawned
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
      try { await invoke('pty_kill', { id: old }) } catch { /* already gone */ }
    }
  }

  // ── input: keystrokes → base64 → pty_write ───────────────────────────
  const offData = terminal.onData((data) => {
    const current = id
    if (!current) return
    void invoke('pty_write', { id: current, dataB64: encodeBase64Utf8(data) }).catch(() => {
      // session died mid-keystroke; the exit event paints the notice
    })
  })

  // ── output/exit events, filtered by session id ───────────────────────
  void listen<{ id: string; data: string }>('pty://output', (e) => {
    if (e.payload?.id !== id || !id) return
    terminal.write(decodeBase64Bytes(e.payload.data))
  }).then((un) => {
    if (disposed) un()
    else unlisteners.push(un)
  })
  void listen<string>('pty://exit', (e) => {
    if (e.payload !== id || !id) return
    id = null
    terminal.write(ENDED_MESSAGE)
    for (const cb of exitCallbacks) {
      try { cb() } catch { /* subscriber error must not break the stream */ }
    }
  }).then((un) => {
    if (disposed) un()
    else unlisteners.push(un)
  })

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
      void invoke('pty_resize', { id: current, cols: terminal.cols, rows: terminal.rows }).catch(() => {
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
      void invoke('pty_write', { id: current, dataB64: encodeBase64Utf8(data) }).catch(() => {})
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
