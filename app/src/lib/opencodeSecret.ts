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
