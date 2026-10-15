/**
 * Desktop-local adoption — the ONE piece of pairing logic the Moch Desktop
 * shell needs from the shared app.
 *
 * Moch Desktop (Tauri) runs the app's OWN local gateway
 * (`desktop/runtime.py`) and serves this UI on a loopback origin. The shell
 * publishes `GET /moch-config.json` there with the live gateway's ws url and
 * token (see `desktop/src-tauri/src/lib.rs`). On a machine whose gateway the
 * shell already supervises there is no QR to scan and no host to type: this
 * module adopts that gateway as the remembered computer named
 * "This computer".
 *
 * Everywhere else this is a no-op: the phone is not `web`, and the plain web
 * build has no such endpoint (the fetch 404s and we return null).
 *
 * Architecture rule (desktop/ARCHITECTURE.md): the desktop tree holds NO
 * protocol or pairing logic — this lives in the shared layer so both
 * platforms share one pairing model.
 */
import { Platform } from 'react-native'
import { atom } from 'nanostores'
import { log } from './log'
import { saveConfig, type ConnConfig } from './gateway'

/** The shell's handshake, exactly as `lib.rs` writes it. */
export interface DesktopLocalConfig {
  wsUrl: string
  token: string
  mode?: string
  home?: string
  logTail?: string
}

/** Non-null once this launch has seen the desktop shell's handshake. */
export const desktopShell = atom<DesktopLocalConfig | null>(null)

/** True for the shell's own supervised gateway — never a remote computer. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h.startsWith('127.0.0.1') || h.startsWith('localhost') || h.startsWith('[::1]') || h.startsWith('::1')
}

/** host + tls from the shell's `ws://host:port/api/ws` url. */
export function dialInfoFromWsUrl(wsUrl: string): { host: string; tls: boolean } | null {
  try {
    const u = new URL(wsUrl)
    if (!u.host) return null
    return { host: u.host, tls: u.protocol === 'wss:' }
  } catch {
    return null
  }
}

/**
 * The shell's handshake, or null when this is not Moch Desktop.
 * Deliberately silent: a 404/failed fetch is the normal phone/web case.
 */
export async function readDesktopLocalConfig(): Promise<DesktopLocalConfig | null> {
  if (Platform.OS !== 'web') return null
  try {
    const res = await fetch('/moch-config.json', { cache: 'no-store' })
    if (!res.ok) return null
    const j = (await res.json()) as Partial<DesktopLocalConfig> | null
    if (!j || typeof j.wsUrl !== 'string' || typeof j.token !== 'string' || !j.token) return null
    return {
      wsUrl: j.wsUrl,
      token: j.token,
      ...(typeof j.mode === 'string' ? { mode: j.mode } : {}),
      ...(typeof j.home === 'string' ? { home: j.home } : {}),
      ...(typeof j.logTail === 'string' ? { logTail: j.logTail } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Adopt the shell's local gateway as the active computer.
 *
 * `stored` is what `loadSavedConfig()` found. The local gateway is adopted
 * when there is nothing paired yet, or when the currently active computer is
 * itself loopback (our own supervised runtime, or an attach target). A
 * REMOTE computer the user paired from this desktop is never hijacked — the
 * local runtime stays available, it just is not forced on top of a choice the
 * user made.
 *
 * Returns the config to boot into, or null when nothing was adopted.
 */
export async function seedDesktopLocalConnection(stored: ConnConfig | null): Promise<ConnConfig | null> {
  const local = await readDesktopLocalConfig()
  if (!local) return null
  desktopShell.set(local)

  const dial = dialInfoFromWsUrl(local.wsUrl)
  if (!dial || !isLoopbackHost(dial.host)) return null

  if (stored && !isLoopbackHost(stored.host)) {
    log('info', 'auth', `desktop shell: keeping paired computer ${stored.host}; local gateway is ${dial.host}`)
    return null
  }
  if (stored && stored.host === dial.host && stored.tls === dial.tls && stored.token === local.token) {
    return stored // already exactly this machine — nothing to write
  }

  const cfg: ConnConfig = {
    host: dial.host,
    token: local.token,
    tls: dial.tls,
    name: stored?.name && isLoopbackHost(stored.host) ? stored.name : 'This computer',
  }
  try {
    await saveConfig(cfg)
    log('info', 'auth', `desktop shell: adopted local gateway ${dial.host}`)
    return cfg
  } catch (err) {
    log('warn', 'auth', `desktop shell: could not adopt local gateway: ${String(err)}`)
    return null
  }
}
