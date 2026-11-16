/**
 * Thinker selection (ONBOARDING-V2): whose brain answers a chat.
 *
 * - `moch`     — the embedded hermes runtime on this phone (everything works).
 * - `opencode` — an OpenCode server running inside the Moch Linux guest; chat
 *                works, hermes-only surfaces (bots/crew/rooms/automations/
 *                browser) are hidden. OpenCode is designed to be useful without
 *                a subscription thanks to its free models; we never fake a
 *                provider.
 *
 * The choice is persisted and read by the chat transport. Switching is
 * explicit: a chat created under one thinker is never silently answered by the
 * other.
 */
import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from './log'
import { linuxExec } from './mochiRuntime'

export type Thinker = 'moch' | 'opencode'

const THINKER_KEY = 'hermes.thinker.v1'

export const thinkerAtom = atom<Thinker>('moch')

export async function loadThinker(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(THINKER_KEY)
    if (saved === 'moch' || saved === 'opencode') thinkerAtom.set(saved)
  } catch {
    // default moch
  }
}

export async function setThinker(t: Thinker): Promise<void> {
  thinkerAtom.set(t)
  try {
    await AsyncStorage.setItem(THINKER_KEY, t)
  } catch {
    // apply for this run
  }
}

import { File, Directory, Paths } from 'expo-file-system'
import { opencodePassword, OC_PORT } from './opencodeSecret'

export { opencodePassword }

/**
 * OpenCode in the guest. 127.0.0.1 + a fixed port; the password is generated
 * once (opencodeSecret.ts, shared with the transport) and persisted so a
 * restart of the app re-attaches instead of leaking a new server per launch.
 */
const OC_MODEL_KEY = 'hermes.opencode.model.v1'

export const opencodeModelAtom = atom<string>('')

export async function loadOpencodeModel(): Promise<void> {
  try {
    const m = await AsyncStorage.getItem(OC_MODEL_KEY)
    if (m) opencodeModelAtom.set(m)
  } catch {}
}

export async function setOpencodeModel(model: string): Promise<void> {
  opencodeModelAtom.set(model)
  try { await AsyncStorage.setItem(OC_MODEL_KEY, model) } catch {}
}

export interface GuestRunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/** Run one shell command inside the Moch Linux guest. */
export async function guestRun(command: string, timeoutMs = 60_000): Promise<GuestRunResult> {
  const r = await linuxExec(command, Math.max(1, Math.min(3600, Math.ceil(timeoutMs / 1000))))
  if (!r) return { ok: false, code: -1, stdout: '', stderr: 'guest bridge unavailable' }
  return { ok: !!r.ok, code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ?? '') }
}

/** True when the guest has a working opencode binary. */
export async function opencodeInstalled(): Promise<boolean> {
  const r = await guestRun('command -v opencode >/dev/null 2>&1 && opencode --version 2>/dev/null | head -1')
  return r.ok && r.stdout.trim().length > 0
}

/**
 * Install OpenCode inside the guest.
 *
 * Downloaded ON THE ANDROID SIDE straight into the guest's /tmp (through the
 * app's own filesystem — Chaquopy HOME and Expo Paths.document are the same
 * app-internal dir), then untarred in the guest. A freshly bootstrapped
 * rootfs has NO curl/wget, so the guest can never fetch it itself — and the
 * OpenCode choice must not depend on apt.
 */
export async function installOpencode(onProgress?: (pct: number) => void): Promise<GuestRunResult> {
  const hermesDir = new Directory(Paths.document, '.hermes')
  const rootfs = new Directory(new Directory(hermesDir, 'linux'), 'rootfs')
  if (!rootfs.exists) {
    return { ok: false, code: 1, stdout: '', stderr: 'The Linux guest is not installed — install it in the previous step first.' }
  }
  const tmpDir = new Directory(rootfs, 'tmp')
  if (!tmpDir.exists) {
    return { ok: false, code: 1, stdout: '', stderr: 'The Linux guest looks broken (/tmp is missing) — reinstall it from the previous step.' }
  }
  const dest = new File(tmpDir, 'opencode-arm64.tgz')
  try {
    if (dest.exists) dest.delete()
    const task = File.createDownloadTask(
      'https://opencode.ai/update/api/latest/cli/opencode/opencode-linux-arm64.tar.gz',
      dest,
      {
        onProgress: (p) => {
          if (p.totalBytes > 0) onProgress?.(Math.min(99, Math.round((p.bytesWritten / p.totalBytes) * 100)))
        },
      },
    )
    const file = await task.downloadAsync()
    if (!file) throw new Error('download stalled')
  } catch (e) {
    return { ok: false, code: 1, stdout: '', stderr: `Downloading OpenCode failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Untar in the guest, then verify — the only shell the guest must run.
  const r = await guestRun(
    [
      'set -e',
      'mkdir -p /usr/local/bin',
      'tar xzf /tmp/opencode-arm64.tgz -C /usr/local/bin opencode',
      'chmod +x /usr/local/bin/opencode',
      'rm -f /tmp/opencode-arm64.tgz',
      'opencode --version',
    ].join(' && '),
    240_000,
  )
  try { if (dest.exists) dest.delete() } catch {}
  return r
}

/** Health probe against the guest server, done FROM THE PHONE (RN fetch): proot
 * shares the phone's network namespace so the guest's loopback IS the phone's,
 * and a fresh rootfs has no curl to probe with. */
async function ocHealthy(timeoutMs = 5000): Promise<boolean> {
  try {
    const auth = `Basic ${globalThis.btoa(`opencode:${await opencodePassword()}`)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${OC_PORT}/api/info`, {
      headers: { Authorization: auth },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Start (or re-attach to) the guest OpenCode server. Idempotent: a live,
 * healthy server is reused, so the wizard can call this after install without
 * spawning duplicates. Health is polled from the phone — no guest curl.
 */
export async function startOpencodeServer(): Promise<GuestRunResult> {
  const pw = await opencodePassword()
  if (await ocHealthy()) return { ok: true, code: 0, stdout: 'already running', stderr: '' }
  const started = await guestRun(
    'if ! pgrep -f "opencode serve" >/dev/null 2>&1; then ' +
      `cd /root && OPENCODE_PASSWORD=${pw} nohup opencode serve --hostname 127.0.0.1 --port ${OC_PORT} >/root/opencode.log 2>&1 & echo started; ` +
      'else echo already; fi',
    30_000,
  )
  if (!started.ok) {
    return { ok: false, code: 1, stdout: '', stderr: started.stderr || 'Could not start the OpenCode server.' }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await ocHealthy()) return { ok: true, code: 0, stdout: 'ready', stderr: '' }
  }
  const tail = await guestRun('tail -n 20 /root/opencode.log 2>/dev/null', 15_000)
  return {
    ok: false,
    code: 1,
    stdout: '',
    stderr: tail.stdout.trim() || 'The OpenCode server did not answer on the phone — try again, or reinstall it.',
  }
}

/** Stop the guest server (switching back to Moch). Best-effort. */
export async function stopOpencodeServer(): Promise<void> {
  await guestRun('pkill -f "opencode serve" >/dev/null 2>&1 || true', 30_000)
}

export function opencodeBaseUrl(): string {
  return `http://127.0.0.1:${OC_PORT}`
}

/** Log one line without leaking the password. */
export function logOpencode(msg: string): void {
  log('info', 'opencode', msg)
}
