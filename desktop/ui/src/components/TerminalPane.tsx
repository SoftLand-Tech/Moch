/**
 * Terminal pane — a real host PTY in an xterm.js surface, shared by the
 * Stage dock (compact) and the full Terminal view. Spawns against the
 * gateway workspace once `workspaceDir` is available (null while the
 * runtime boots → "waiting for the workspace…" placeholder). While mounted
 * the pane owns exactly one PTY; the StrictMode-safe disposer in
 * ptyClient guarantees no leaked shell processes across remounts.
 */
import { useEffect, useRef } from 'react'
import { useStore } from '@nanostores/react'
import { Eraser, RotateCcw } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import '../styles/terminal.css'
import { mountPty, type PtyHandle } from '../lib/ptyClient'
import { workspaceDir } from '../lib/gateway'

/** A sane TERM for color + keybinding support even in the Stage dock. */
const DEFAULT_ENV: Record<string, string> = { TERM: 'xterm-256color' }

export interface TerminalPaneProps {
  compact?: boolean
  /** Spawn cwd override; defaults to the gateway workspace. */
  cwd?: string
  shell?: string
  /** Extra env (view adds MOCH=1 so the shell greets). */
  env?: Record<string, string>
  /** Only the visible pane in the view's tab stack receives focus. */
  active?: boolean
  /** Bump to kill + respawn this pane's session. */
  restartNonce?: number
}

export default function TerminalPane({ compact, cwd, shell, env, active = true, restartNonce = 0 }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<PtyHandle | null>(null)
  const spawnedCwdRef = useRef<string | null>(null)
  const lastNonceRef = useRef<number | null>(null)
  const workspace = useStore(workspaceDir)
  const effectiveCwd = cwd ?? workspace
  const envWithDefaults = env ? { ...DEFAULT_ENV, ...env } : DEFAULT_ENV

  // Spawn (or re-spawn under a changed cwd) exactly one session per pane.
  useEffect(() => {
    const el = hostRef.current
    if (!el || !effectiveCwd) return

    const existing = handleRef.current
    if (existing) {
      if (spawnedCwdRef.current !== effectiveCwd) {
        spawnedCwdRef.current = effectiveCwd
        void existing.restart()
      }
      return
    }

    const handle = mountPty(el, { cwd: effectiveCwd, shell, cols: 80, rows: 24, env: envWithDefaults })
    handleRef.current = handle
    spawnedCwdRef.current = effectiveCwd
    return () => {
      handleRef.current = null
      spawnedCwdRef.current = null
      handle.dispose() // idempotent — kills the PTY, unwires events, disposes xterm
    }
    // envWithDefaults/shell are stable per call site (module constants upstream)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCwd, shell])

  // External "restart" nudges from the view's focus-head button.
  useEffect(() => {
    if (lastNonceRef.current === null) {
      lastNonceRef.current = restartNonce // first observation — nothing to do
      return
    }
    if (restartNonce !== lastNonceRef.current) {
      lastNonceRef.current = restartNonce
      if (restartNonce > 0) void handleRef.current?.restart()
    }
  }, [restartNonce])

  // Focus follows tab selection.
  useEffect(() => {
    if (active) handleRef.current?.focus()
  }, [active])

  return (
    <div className={`term${compact ? ' compact' : ''}`}>
      <div ref={hostRef} className="term-host" />
      {!effectiveCwd && (
        <div className="term-waiting">
          <div className="spinner" />
          <span>waiting for the workspace…</span>
        </div>
      )}
      <div className="term-actions">
        <button className="term-btn" onClick={() => void handleRef.current?.restart()} title="Kill and respawn this shell">
          <RotateCcw size={12} /> restart
        </button>
        <button className="term-btn" onClick={() => handleRef.current?.clear()} title="Clear the viewport">
          <Eraser size={12} /> clear
        </button>
      </div>
    </div>
  )
}
