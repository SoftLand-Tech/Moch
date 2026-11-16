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

/**
 * OpenCode in the guest. 127.0.0.1 + a fixed port; the password is generated
 * once and persisted so a restart of the app re-attaches instead of leaking a
 * new server per launch.
 */
const OC_PORT = 4096
const OC_PASSWORD_KEY = 'hermes.opencode.password.v1'
const OC_MODEL_KEY = 'hermes.opencode.model.v1'

export const opencodeModelAtom = atom<string>('')

function randomPassword(): string {
  const bytes = new Uint8Array(24)
  // globalThis.crypto is available in Hermes (and web); fall back to Math.
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function opencodePassword(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(OC_PASSWORD_KEY)
    if (saved) return saved
  } catch {}
  const pw = randomPassword()
  try { await AsyncStorage.setItem(OC_PASSWORD_KEY, pw) } catch {}
  return pw
}

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
 * Install OpenCode inside the guest from the official static build. ARM64 is
 * what the phone's Ubuntu rootfs runs; the tar contains a single binary.
 */
export async function installOpencode(): Promise<GuestRunResult> {
  return guestRun(
    [
      'set -e',
      'mkdir -p /usr/local/bin',
      'curl -fsSL https://opencode.ai/update/api/latest/cli/opencode/opencode-linux-arm64.tar.gz -o /tmp/opencode.tgz',
      'tar xzf /tmp/opencode.tgz -C /usr/local/bin opencode',
      'chmod +x /usr/local/bin/opencode',
      'opencode --version',
    ].join(' && '),
    180_000,
  )
}

/**
 * Start (or re-attach to) the guest OpenCode server. Idempotent: a live server
 * on the port is reused, so the wizard can call this after install without
 * spawning duplicates.
 */
export async function startOpencodeServer(): Promise<GuestRunResult> {
  const pw = await opencodePassword()
  const cmd = [
    'set -e',
    'if ! curl -fsS -u "opencode:' + pw + '" http://127.0.0.1:' + OC_PORT + '/api/info >/dev/null 2>&1; then',
    '  if ! pgrep -f "opencode serve" >/dev/null 2>&1; then',
    '    cd /root && OPENCODE_PASSWORD=' + pw + ' nohup opencode serve --hostname 127.0.0.1 --port ' + OC_PORT + ' >/root/opencode.log 2>&1 &',
    '    for i in $(seq 1 30); do curl -fsS -u "opencode:' + pw + '" http://127.0.0.1:' + OC_PORT + '/api/info >/dev/null 2>&1 && break; sleep 1; done',
    '  fi',
    'fi',
    'curl -fsS -u "opencode:' + pw + '" http://127.0.0.1:' + OC_PORT + '/api/info',
  ].join('\n')
  return guestRun(cmd, 120_000)
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
