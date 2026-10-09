/**
 * Interactive terminal core — node-safe pure logic + a thin controller.
 *
 * Same contract as shareIn.ts: no react-native imports at module scope, the
 * native bridge loads lazily behind an injectable seam, so
 * scripts/test-terminal.ts runs this in plain node with fakes.
 *
 * v1 renders in React Native (stripped ANSI); the xterm WebView upgrade swaps
 * only the renderer — this controller's byte flow (base64 chunks in, text or
 * raw chunks out) stays unchanged.
 */

/** Raw bytes the shell understands (sent as-is, base64'd at the edge). */
export const TERM_KEYS = {
  ENTER: '\r',
  TAB: '\t',
  ESC: '\x1b',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PGUP: '\x1b[5~',
  PGDN: '\x1b[6~',
} as const

/** Ctrl+arrow/readline sequences (CSI 1;5~… — the modifier form terminals send). */
export const TERM_CTRL_KEYS = {
  UP: '\x1b[1;5A',
  DOWN: '\x1b[1;5B',
  LEFT: '\x1b[1;5D',
  RIGHT: '\x1b[1;5C',
  HOME: '\x1b[1;5H',
  END: '\x1b[1;5F',
} as const

export const TERM_DRAIN_MS = 120
/** Poll cadence while the terminal screen is mounted (BUG-098: 120ms is most of the keystroke-to-photon floor). */
export const TERM_DRAIN_FAST_MS = 50
/** Bytes of base64 the drain loop pulls per tick before yielding. */
export const TERM_TICK_CHUNK_CAP = 40
/** Cap of the RAW replay bank in base64 chars (~196KB of PTY bytes) — refills a freshly reloaded xterm. */
export const TERM_RAW_BANK_B64_CAP = 262_144

// ── Composer field mapping (BUG-095) ────────────────────────────────────────

/**
 * The hidden composer field is NEVER empty: its value is a zero-width
 * space + the logical text. GBoard deletes via
 * InputConnection.deleteSurroundingText, which produces NO onChangeText
 * on a truly empty field — the classic dead backspace after Enter. With
 * the sentinel there is always one deletable char, so every backspace
 * produces a change event; the sentinel itself is never sent to the PTY
 * (bytes are only ever derived here).
 */
export const FIELD_SENTINEL = '\u200b'

export type FieldChange =
  | { type: 'append'; text: string } // forward text
  | { type: 'delete'; count: number } // forward count DELs
  | { type: 'rewrite'; count: number; text: string } // forward count DELs + text
  | { type: 'noop' } // no PTY bytes, logical text unchanged
  | { type: 'resync' } // IME dropped the sentinel / stale composing: send NOTHING, restore field

export function mapFieldChange(prevLogical: string, raw: string): FieldChange {
  if (raw.startsWith(FIELD_SENTINEL)) {
    const next = raw.slice(1)
    if (next === prevLogical) return { type: 'noop' }
    if (next.startsWith(prevLogical)) return { type: 'append', text: next.slice(prevLogical.length) }
    if (prevLogical.startsWith(next)) return { type: 'delete', count: prevLogical.length - next.length }
    return { type: 'rewrite', count: prevLogical.length, text: next }
  }
  // Sentinel gone: the IME deleted it (backspace past field start) — but
  // only trust that when the field came back EMPTY. Anything else is an
  // IME rewriting the field without the sentinel (hostile autocorrect);
  // re-anchor silently rather than guess bytes.
  if (raw === '' && prevLogical === '') return { type: 'delete', count: 1 }
  return { type: 'resync' }
}

export interface FieldState {
  /** Logical composer text (sentinel excluded). */
  logical: string
  /** Backspace key events sent to the PTY that are awaiting their change event. */
  pendingKeys: number
}

/**
 * Pure composer state machine (BUG-095): maps one onChangeText payload
 * against the previous field state, pairing the change with any key-event
 * DEL already sent (Android dispatches onKeyPress BEFORE the text change,
 * so empty-field backspaces legitimately produce both channels — pairing
 * by counting keeps exactly one DEL per press without wall-clock windows).
 * Any non-delete change invalidates pending pairs.
 */
export function applyFieldChange(prev: FieldState, raw: string): { bytes: string; next: FieldState } {
  const r = mapFieldChange(prev.logical, raw)
  let logical = prev.logical
  let bytes = ''
  let pendingKeys = prev.pendingKeys
  switch (r.type) {
    case 'append':
      logical = prev.logical + r.text
      bytes = r.text
      pendingKeys = 0
      break
    case 'delete':
      logical = prev.logical.slice(0, Math.max(0, prev.logical.length - r.count))
      if (pendingKeys > 0) {
        pendingKeys -= 1
      } else {
        bytes = '\x7f'.repeat(r.count)
      }
      break
    case 'rewrite':
      logical = r.text
      bytes = (pendingKeys > 0 ? '' : '\x7f'.repeat(r.count)) + r.text
      if (pendingKeys > 0) pendingKeys -= 1
      break
    case 'noop':
    case 'resync':
      pendingKeys = 0
      break
  }
  return { bytes, next: { logical, pendingKeys } }
}

// ── base64 (dependency-free: node Buffer AND Hermes-safe) ───────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function b64encodeText(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1
    const n = (a << 16) | ((b < 0 ? 0 : b) << 8) | (c < 0 ? 0 : c)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b < 0 ? '=' : B64[(n >> 6) & 63]) + (c < 0 ? '=' : B64[n & 63])
  }
  return out
}

// ── Controller ───────────────────────────────────────────────────────────────

export type TermState = 'idle' | 'starting' | 'live' | 'dead'

export interface TermNative {
  start(cols: number, rows: number): Promise<{ ok: boolean; alreadyRunning: boolean; error?: string } | null>
  write(dataB64: string): Promise<boolean>
  drain(): Promise<{ chunks: string[]; alive: boolean } | null>
  replay(): Promise<{ chunk: string; alive: boolean } | null>
  resize(cols: number, rows: number): Promise<boolean>
  kill(): Promise<boolean>
}

export type TermListener = (snap: { state: TermState; alive: boolean }) => void

export interface TerminalOptions {
  /** Poll cadence while live (BUG-098: the screen passes 50ms). */
  drainMs?: number
  /**
   * RAW output channel (BUG-097): called per drain chunk and once with the
   * replay chunk on start — base64 PTY bytes, never decoded or stripped.
   * The screen forwards each to xterm (atob → Uint8Array → write).
   */
  onChunk?: (b64: string) => void
}

/**
 * Owns one terminal session: start → poll drain → notify.
 * Construct with fakes in tests; the screen passes the real bridge fns.
 *
 * BUG-097: the screen renders through xterm.js, which needs RAW PTY bytes
 * (erases, cursor moves, colors are the point). `rawBank` keeps the last
 * TERM_RAW_BANK_B64_CAP of base64 for replaying into a freshly (re)loaded
 * xterm.
 */
export class TerminalController {
  state: TermState = 'idle'
  alive = false
  error: string | null = null
  /** Raw base64 bank of recent PTY bytes — refills a freshly (re)loaded xterm (BUG-097). */
  rawBank = ''
  private native: TermNative
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<TermListener>()
  private draining = false
  private drainMs: number
  private onChunk: ((b64: string) => void) | null

  constructor(native: TermNative, opts: TerminalOptions = {}) {
    this.native = native
    this.drainMs = opts.drainMs ?? TERM_DRAIN_MS
    this.onChunk = opts.onChunk ?? null
  }

  onChange(fn: TermListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    const snap = { state: this.state, alive: this.alive }
    this.listeners.forEach((fn) => {
      try {
        fn(snap)
      } catch {
        /* listener failure is inert */
      }
    })
  }

  async start(cols = 80, rows = 24): Promise<boolean> {
    if (this.state === 'starting' || this.state === 'live') return this.state === 'live'
    this.state = 'starting'
    this.error = null
    this.rawBank = ''
    this.emit()
    let res: { ok: boolean; alreadyRunning: boolean; error?: string } | null = null
    try {
      res = await this.native.start(cols, rows)
    } catch {
      res = null
    }
    if (!res || !res.ok) {
      this.state = 'dead'
      this.error = res?.error ?? 'terminal failed to start'
      this.emit()
      return false
    }
    // Reattach paint: bank the RAW replay so a fresh xterm can be refilled,
    // and hand the same bytes to the live renderer.
    try {
      const rep = await this.native.replay()
      if (rep?.chunk) {
        this.rawBank = rep.chunk.length > TERM_RAW_BANK_B64_CAP ? rep.chunk.slice(rep.chunk.length - TERM_RAW_BANK_B64_CAP) : rep.chunk
        this.onChunk?.(this.rawBank)
      }
      this.alive = rep?.alive ?? true
    } catch {
      this.alive = true
    }
    if (!this.alive) {
      // The shell was already dead before the first drain (crashed between
      // start and replay) — report dead instead of a zombie live session.
      this.state = 'dead'
      this.emit()
      return false
    }
    this.state = 'live'
    this.emit()
    this.beginPoll()
    return true
  }

  private beginPoll() {
    this.stopPoll()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.drainMs)
  }

  private stopPoll() {
    clearInterval(this.timer)
    this.timer = null
  }

  /** One drain pass — public so tests drive it without timers. */
  async tick(): Promise<void> {
    if (this.state !== 'live' || this.draining) return
    this.draining = true
    try {
      const d = await this.native.drain()
      if (!d) return
      const chunks = d.chunks.slice(0, TERM_TICK_CHUNK_CAP)
      for (const c of chunks) {
        if (!c) continue
        // Raw bytes flow to the renderer untouched (erases and cursor moves
        // are the point — BUG-097). Each chunk is independently padded
        // base64 of whole bytes, so the bank concatenation stays valid.
        this.rawBank += c
        if (this.rawBank.length > TERM_RAW_BANK_B64_CAP) {
          // Trim on a 4-char boundary so the bank stays valid base64.
          let cut = this.rawBank.length - TERM_RAW_BANK_B64_CAP
          cut += (4 - (cut % 4)) % 4
          this.rawBank = this.rawBank.slice(cut)
        }
        this.onChunk?.(c)
      }
      const wasAlive = this.alive
      this.alive = d.alive
      if (!d.alive && wasAlive) {
        this.state = 'dead'
        this.stopPoll()
      }
      if (this.alive !== wasAlive) this.emit()
    } finally {
      this.draining = false
    }
  }

  async send(raw: string): Promise<boolean> {
    if (this.state !== 'live') return false
    try {
      return await this.native.write(b64encodeText(raw))
    } catch {
      return false
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    try {
      await this.native.resize(cols, rows)
    } catch {
      /* best effort */
    }
  }

  async kill(): Promise<void> {
    this.stopPoll()
    try {
      await this.native.kill()
    } catch {
      /* best effort */
    }
    this.state = 'dead'
    this.alive = false
    this.emit()
  }

  destroy() {
    this.stopPoll()
    this.listeners.clear()
  }
}
