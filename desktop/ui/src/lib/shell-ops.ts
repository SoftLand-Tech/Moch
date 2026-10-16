import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

/** Open a path or URL with the OS default handler. */
export async function openExternal(target: string): Promise<void> {
  try {
    await openUrl(target)
  } catch {
    console.warn('[opener] failed for', target)
  }
}

/** Reveal a file in the system file manager. */
export async function revealPath(path: string): Promise<void> {
  try {
    await invoke('plugin:opener|reveal_item_in_dir', { path })
  } catch {
    await openExternal(path)
  }
}
