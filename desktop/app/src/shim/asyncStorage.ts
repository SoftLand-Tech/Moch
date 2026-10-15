/**
 * AsyncStorage shim over localStorage — lets the REAL shared engine
 * (app/src/lib/chat.ts) run unmodified in the desktop bundle. Same async
 * surface the engine calls; keys are namespaced to keep the desktop
 * webview origin's storage self-contained.
 */
const PREFIX = 'moch.'

export async function getItem(key: string): Promise<string | null> {
  return localStorage.getItem(PREFIX + key)
}

export async function setItem(key: string, value: string): Promise<void> {
  localStorage.setItem(PREFIX + key, value)
}

export async function removeItem(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key)
}

export async function multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
  return keys.map((k) => [k, localStorage.getItem(PREFIX + k)] as [string, string | null])
}

export async function multiRemove(keys: string[]): Promise<void> {
  for (const k of keys) localStorage.removeItem(PREFIX + k)
}

export async function getAllKeys(): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length))
  }
  return out
}

export default {
  getItem,
  setItem,
  removeItem,
  multiGet,
  multiRemove,
  getAllKeys,
}
