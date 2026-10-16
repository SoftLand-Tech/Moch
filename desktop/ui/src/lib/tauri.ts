/**
 * Tauri invoke bridge with a browser-dev fallback.
 *
 * In the packaged app this is just `invoke`. When the UI runs in a plain
 * browser (dev/user-testing track), a dev-bridge plugin serves the runtime
 * state + fake PTY so every surface is clickable against the REAL gateway.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return tauriInvoke<T>(cmd, args)
  return devInvoke<T>(cmd, args)
}

/** Event subscribe that no-ops (returning a disposer) outside Tauri. */
export async function listen<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  if (inTauri) return tauriListen<T>(event, cb)
  return () => undefined
}

// ── browser-dev fallbacks ───────────────────────────────────────────────────

let devState: { port: number; token: string; home: string; workspace: string } | null = null

async function loadDevState(): Promise<void> {
  if (devState) return
  try {
    const res = await fetch('/dev-bridge/runtime-state')
    if (res.ok) devState = await res.json()
  } catch { /* not on the dev server */ }
}

async function devInvoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  await loadDevState()
  switch (cmd) {
    case 'gateway_start':
    case 'gateway_status': {
      if (!devState) throw new Error('dev bridge: runtime state unavailable (is the vite dev-bridge plugin active?)')
      return {
        running: true,
        port: devState.port,
        token: devState.token,
        home: devState.home,
        workspace: devState.workspace,
      } as T
    }
    case 'gateway_restart':
    case 'gateway_stop':
      return true as T
    case 'runtime_setup_hint':
      return null as T
    case 'browser_status': {
      try {
        const res = await fetch('/dev-bridge/browser-status')
        if (res.ok) return (await res.json()) as T
      } catch { /* fallthrough */ }
      return { running: false, port: null, executable: null, profileDir: null } as T
    }
    case 'browser_launch': {
      const res = await fetch('/dev-bridge/browser-launch', { method: 'POST' })
      if (!res.ok) throw new Error('dev bridge: browser launch failed')
      return (await res.json()) as T
    }
    case 'browser_stop':
      return true as T
    case 'pty_spawn':
    case 'pty_write':
    case 'pty_resize':
    case 'pty_kill':
      // PTY is Tauri-only; the browser track shows a notice instead.
      throw new Error('pty unavailable in browser preview — run the desktop app for the terminal')
    default:
      throw new Error(`dev bridge: unknown command ${cmd}`)
  }
}
