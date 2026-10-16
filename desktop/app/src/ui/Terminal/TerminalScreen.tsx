/**
 * Terminal screen — a real bash in an xterm.js pane, fed by the PTY bridge
 * inside the supervised runtime process (desktop/runtime.py).
 *
 * Protocol (see runtime.py): server → client binary frames are raw PTY
 * bytes; client → server text frames are keystroke bytes; a text frame
 * `{"type":"resize","cols":C,"rows":R}` resizes the PTY. Ctrl+C and every
 * other control byte are just keystrokes — nothing is special-cased here.
 *
 * The bridge port is a FIXED 9335 (MOCH_PTY_PORT override server-side): the
 * shell's /moch-config.json only forwards wsUrl/token/mode/home/logTail, so
 * the UI has no channel to learn a dynamic port. runtime.py mirrors the
 * actual port into the handshake info as "pty_port" for when the shell
 * starts forwarding it — the UI will prefer cfg.pty_port once it exists.
 *
 * Session lifecycle is a three-state machine: dialing → live → ended, with
 * Reconnect restarting the whole unit (fresh socket, fresh shell).
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import type { ITheme } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'
import { C, themeVersion } from '../../../../../app/src/lib/theme'
import { connConfig } from '../../../../../app/src/lib/gateway'

declare const beacon: (msg: string) => void

const PTY_HOST = '127.0.0.1'
const PTY_PORT = 9335
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace'

type Phase =
  | { state: 'dialing' }
  | { state: 'live' }
  | { state: 'ended'; detail: string }

/** xterm's canvas needs concrete color values, and they must track theme
 * switches — so the tokens come from the live shared C object, rebuilt on
 * themeVersion. No literals here; ANSI-16 falls back to xterm's defaults. */
function xtermTheme(): ITheme {
  return {
    background: C.bg,
    foreground: C.text,
    cursor: C.accent,
    cursorAccent: C.bg,
    selectionBackground: C.accentSoft,
  }
}

function sendResize(ws: WebSocket, cols: number, rows: number): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'resize', cols, rows }))
}

export function TerminalScreen(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>({ state: 'dialing' })
  const [session, setSession] = useState(0)
  const token = useStore(connConfig)?.token ?? ''

  useEffect(() => {
    const wrap = hostRef.current
    if (!wrap) return
    setPhase({ state: 'dialing' })
    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrap)
    try {
      fit.fit()
    } catch {
      /* pane not laid out yet — the ResizeObserver refits */
    }

    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(
        `ws://${PTY_HOST}:${PTY_PORT}/pty?token=${encodeURIComponent(token)}`,
      )
    } catch {
      setPhase({ state: 'ended', detail: 'Could not open the terminal socket.' })
    }
    if (ws) {
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        setPhase({ state: 'live' })
        sendResize(ws as WebSocket, term.cols, term.rows)
        beacon('terminal: session open')
      }
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(ev.data))
        } else if (typeof ev.data === 'string') {
          term.write(ev.data)
        }
      }
      ws.onclose = (ev) => {
        beacon('terminal: closed code=' + ev.code)
        setPhase({
          state: 'ended',
          detail:
            ev.code === 1000
              ? 'Session ended.'
              : 'Lost the PTY bridge on 127.0.0.1:9335.',
        })
      }
      ws.onerror = () => {
        setPhase({
          state: 'ended',
          detail: 'No PTY bridge on 127.0.0.1:9335 — is the runtime running?',
        })
      }
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
      })
    }

    const refit = () => {
      try {
        fit.fit()
        if (ws) sendResize(ws, term.cols, term.rows)
      } catch {
        /* zero-size layout tick — next resize retries */
      }
    }
    const ro = new ResizeObserver(refit)
    ro.observe(wrap)
    const unsubTheme = themeVersion.subscribe(() => {
      term.options.theme = xtermTheme()
    })

    return () => {
      unsubTheme()
      ro.disconnect()
      ws?.close()
      term.dispose()
    }
  }, [session, token])

  const reconnect = useCallback(() => {
    setSession((s) => s + 1)
  }, [])

  const dotClass =
    phase.state === 'live'
      ? ' mos-term__dot--ok'
      : phase.state === 'dialing'
        ? ' mos-term__dot--warn'
        : ' mos-term__dot--err'
  const statusLine =
    phase.state === 'dialing'
      ? 'Connecting to the runtime shell…'
      : phase.state === 'live'
        ? `Live bash — PTY bridge on ${PTY_HOST}:${PTY_PORT}`
        : phase.detail

  return (
    <div className="mos-root">
      <style>{css}</style>
      <header className="mos-head">
        <span className={`mos-term__dot${dotClass}`} aria-hidden />
        <h2>Terminal</h2>
        <span className="mos-sub">{statusLine}</span>
        {phase.state === 'ended' ? (
          <button className="mos-btn mos-spring" onClick={reconnect}>
            Reconnect
          </button>
        ) : null}
      </header>
      <div ref={hostRef} className="mos-termHost" />
    </div>
  )
}

const css = `
/* Local to Terminal: the shared screen frame (desktop.css) covers the rest. */
.mos-termHost { flex: 1; min-height: 0; padding: 8px 10px; }
.mos-term__dot { width: 7px; height: 7px; border-radius: 4px; background: var(--moch-text-faint); flex: none; }
.mos-term__dot--ok { background: var(--moch-green); }
.mos-term__dot--warn { background: var(--moch-amber); }
.mos-term__dot--err { background: var(--moch-red); }
`
