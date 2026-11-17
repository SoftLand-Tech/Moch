/**
 * The OpenCode server password + port (OPENCODE-MODE).
 *
 * Its own module because both the transport (opencodeClient.ts) and the
 * lifecycle helpers (thinker.ts) need it — a shared import here keeps those
 * two from importing each other.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export const OC_PORT = 4096
const OC_PASSWORD_KEY = 'hermes.opencode.password.v1'

function randomPassword(): string {
  const bytes = new Uint8Array(24)
  // globalThis.crypto is available in Hermes (and web); fall back to Math.
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The persisted server password — generated once, reused across launches. */
export async function opencodePassword(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(OC_PASSWORD_KEY)
    if (saved) return saved
  } catch {}
  const pw = randomPassword()
  try { await AsyncStorage.setItem(OC_PASSWORD_KEY, pw) } catch {}
  return pw
}

// Hermes has no guaranteed btoa global — use a tiny ASCII encoder for the
// Basic auth header (username + password are ASCII hex). Shared by the
// transport and the health probe so they can never differ.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function b64ascii(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i) & 0xff
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) & 0xff : 0
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) & 0xff : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < input.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < input.length ? B64[c & 63] : '='
  }
  return out
}

export function opencodeBasicAuth(password: string): string {
  return `Basic ${b64ascii(`${OC_USER}:${password}`)}`
}

const OC_USER = 'opencode'
