/**
 * expo-secure-store shim over localStorage. Desktop caveat, accepted and
 * recorded: the webview origin is loopback-only and single-user, so
 * localStorage is the token store today; the OS keyring via a Tauri
 * plugin replaces this when crates become installable.
 */
const PREFIX = 'moch.secure.'

export async function getItemAsync(key: string): Promise<string | null> {
  return localStorage.getItem(PREFIX + key)
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  localStorage.setItem(PREFIX + key, value)
}

export async function deleteItemAsync(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key)
}

export async function isAvailableAsync(): Promise<boolean> {
  return true
}

export default {
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  isAvailableAsync,
}
