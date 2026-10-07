import { atom, computed, type Store } from 'nanostores'
import type { MediaKind } from './media'

/**
 * Per-cache-key load state for media fetched through mediaCache.ts (audio,
 * files, and the image data-URL fallback). Images streamed straight into
 * expo-image don't go through here — its own disk cache owns them.
 *
 * Nanostore-only, no react-native imports: scripts/ can load this module.
 * Components subscribe per key so one download's progress ticks never
 * re-render the whole list.
 */

export type MediaLoadState =
  | { status: 'idle' }
  | { status: 'loading'; received: number; total: number | null }
  | { status: 'ready'; uri: string }
  | { status: 'error'; message: string; kind?: MediaKind }

export const mediaState = atom<Record<string, MediaLoadState>>({})

export function mediaStateFor(key: string): MediaLoadState {
  return mediaState.get()[key] ?? { status: 'idle' }
}

export function setMediaState(key: string, state: MediaLoadState): void {
  mediaState.set({ ...mediaState.get(), [key]: state })
}

export function clearMediaState(key: string): void {
  const cur = mediaState.get()
  if (!cur[key]) return
  const next = { ...cur }
  delete next[key]
  mediaState.set(next)
}

/** BUG-031: drop every per-key state on a backend switch — the wiped cache
 *  makes them all stale. The per-key computed stores react to this atom. */
export function resetMediaState(): void {
  mediaState.set({})
}

// Per-key computed stores: components subscribe to ONE cache key, so one
// download's progress ticks never re-render anyone else's chips.
const keyStores = new Map<string, Store<MediaLoadState>>()

export function mediaStateForKey(key: string): Store<MediaLoadState> {
  let store = keyStores.get(key)
  if (!store) {
    store = computed(mediaState, (map) => map[key] ?? ({ status: 'idle' } as MediaLoadState))
    keyStores.set(key, store)
  }
  return store
}
