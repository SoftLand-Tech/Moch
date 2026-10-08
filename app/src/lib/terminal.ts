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
} as const

export const TERM_DRAIN_MS = 120
/** Cap the rendered scrollback (chars) so a `cat huge` can't OOM the JS thread. */
export const TERM_TEXT_CAP = 200_000
/** Bytes of base64 the drain loop pulls per tick before yielding. */
export const TERM_TICK_CHUNK_CAP = 40

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

export function b64decodeText(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const sext = [0, 1, 2, 3].map((k) => {
      const ch = clean[i + k] ?? '='
      return ch === '=' ? -1 : B64.indexOf(ch)
    })
    if (sext[0] < 0 || sext[1] < 0) break
    const n = (sext[0] << 18) | (sext[1] << 12) | ((sext[2] < 0 ? 0 : sext[2]) << 6) | (sext[3] < 0 ? 0 : sext[3])
    bytes.push((n >> 16) & 255)
    if (sext[2] >= 0) bytes.push((n >> 8) & 255)
    if (sext[3] >= 0) bytes.push(n & 255)
  }
  // UTF-8 decode with replacement for stray bytes (binary program output).
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i++
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      )
      i += 3
    } else {
      out += '�'
      i++
    }
  }
  return out
}

// ── ANSI ─────────────────────────────────────────────────────────────────────

/** Crude ANSI strip for the v1 RN renderer (xterm replaces this, not the flow). */
export function stripAnsi(s: string): string {
  return (
    s
      // CSI sequences: ESC [ ... final byte
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // OSC sequences: ESC ] ... BEL or ESC \
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CRLF → LF. A lone \r is KEPT: appendCapped interprets it as
      // "reset to line start" so CR-overwrites (progress bars, tab
      // rewrites) replace the current line instead of stacking.
      // NOTE: this is intentionally minimal — full VT100 semantics
      // (cursor moves, EL/ED, …) are the planned xterm.js renderer.
      .replace(/\r\n/g, '\n')
      // leftover control chars except \n \t \r (handled above/by appendCapped)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

// ── Scrollback buffer ────────────────────────────────────────────────────────

/**
 * Append-only capped text buffer shared by the screen and tests.
 *
 * Consumes stripAnsi output. A lone \r (not followed by \n) means
 * "carriage return: back to column 0" — everything up to the last \n is
 * rewritten by the text that follows, so CR-overwrites replace the
 * current line instead of stacking extra lines. Deterministic and
 * streaming-safe per call; full VT100 semantics = the planned xterm.js
 * renderer (see file header).
 */
export function appendCapped(prev: string, add: string, cap = TERM_TEXT_CAP): string {
  if (!add) return prev
  let out = prev
  let overwrote = false
  let buf = ''
  for (const ch of add) {
    if (ch === '\r') {
      // First CR in this chunk drops prev's current (last) line; later
      // CRs just reset what we've accumulated since the last newline.
      if (!overwrote) {
        out = prev.slice(0, prev.lastIndexOf('\n') + 1)
        overwrote = true
      }
      buf = ''
    } else if (ch === '\n') {
      out += buf + '\n'
      buf = ''
    } else {
      buf += ch
    }
  }
  out += buf
  if (out.length <= cap) return out
  // Keep the tail. Never start on a trailing surrogate: back up onto the
  // code point head so the buffer never stores a broken pair.
  let start = out.length - cap
  if (out.charCodeAt(start) >= 0xdc00 && out.charCodeAt(start) <= 0xdfff) start--
  return out.slice(start)
}

/**
 * Render only the tail of the scrollback (BUG-094): the screen re-renders
 * this string on every drain tick, and Android rebuilds the whole
 * TextView layout per change — O(scrollback) renders starve the JS
 * thread. The controller keeps its 200k buffer; the screen shows the
 * last `keep` chars behind a marker.
 */
export const TERM_RENDER_TAIL = 12_000
export const TERM_TRIM_MARKER = '⋯ earlier output trimmed ⋯\n'

export function renderTail(text: string, keep = TERM_RENDER_TAIL): string {
  if (text.length <= keep) return text
  let start = text.length - keep
  // Never start on a trailing surrogate (see appendCapped).
  const c = text.charCodeAt(start)
  if (c >= 0xdc00 && c <= 0xdfff) start--
  // Resume at a line boundary (bounded scan) so the marker doesn't glue
  // onto a partial line.
  const nl = text.lastIndexOf('\n', start)
  if (nl !== -1 && start - nl < 256) start = nl + 1
  return TERM_TRIM_MARKER + text.slice(start)
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

export type TermListener = (snap: { state: TermState; text: string; alive: boolean }) => void

/**
 * Owns one terminal session: start → poll drain → bank text → notify.
 * Construct with fakes in tests; the screen passes the real bridge fns.
 */
export class TerminalController {
  state: TermState = 'idle'
  text = ''
  alive = false
  error: string | null = null
  private native: TermNative
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<TermListener>()
  private draining = false

  constructor(native: TermNative) {
    this.native = native
  }

  onChange(fn: TermListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    const snap = { state: this.state, text: this.text, alive: this.alive }
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
    // Reattach paint: replay the last 64KB so a warm session isn't blank.
    try {
      const rep = await this.native.replay()
      if (rep?.chunk) this.text = appendCapped(this.text, stripAnsi(b64decodeText(rep.chunk)))
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
    }, TERM_DRAIN_MS)
  }

  private stopPoll() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One drain pass — public so tests drive it without timers. */
  async tick(): Promise<void> {
    if (this.state !== 'live' || this.draining) return
    this.draining = true
    try {
      const d = await this.native.drain()
      if (!d) return
      let dirty = false
      const chunks = d.chunks.slice(0, TERM_TICK_CHUNK_CAP)
      for (const c of chunks) {
        const piece = stripAnsi(b64decodeText(c))
        if (piece) {
          this.text = appendCapped(this.text, piece)
          dirty = true
        }
      }
      const wasAlive = this.alive
      this.alive = d.alive
      if (!d.alive && wasAlive) {
        this.state = 'dead'
        this.stopPoll()
      }
      if (dirty || this.alive !== wasAlive) this.emit()
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
