/**
 * Boot adapter — mirrors the phone's boot sequence from app/_layout.tsx
 * using the REAL shared engine. Desktop differences: no Expo push, the
 * shell's /moch-config.json handshake adopts the supervised local gateway,
 * remote pairing arrives via a pasted hermes://connect link.
 *
 * Beacons: with MOCH_DEV=1 every boot step POSTs to the shell's /dbg
 * endpoint (desktop/.dbg.log) — the webview has no devtools console, and
 * this is the one channel that reports what the UI actually did.
 */
import {
  loadSavedConfig,
  connect,
  connConfig,
  connectionState,
  everConnected,
  type ConnConfig,
} from '../../../../app/src/lib/gateway'
import { desktopShell, seedDesktopLocalConnection } from '../../../../app/src/lib/desktopLocal'
import { syncBackendIdentity } from '../../../../app/src/lib/backendIdentity'
import { loadOutbox } from '../../../../app/src/lib/chat'
import { loadAttention } from '../../../../app/src/lib/attention'
import { loadDrafts } from '../../../../app/src/lib/drafts'
import { loadSendQueue } from '../../../../app/src/lib/sendQueue'

export { connConfig, connectionState, everConnected, desktopShell }

declare const beacon: (msg: string) => void

let booted = false

/** Idempotent: the app calls this once from main.tsx before first render. */
export async function bootDesktop(): Promise<void> {
  if (booted) return
  booted = true
  const stored = await loadSavedConfig()
  beacon('step: saved=' + (stored ? stored.host : 'none'))
  const saved: ConnConfig | null = (await seedDesktopLocalConnection(stored)) ?? stored
  beacon('step: seeded=' + (saved ? saved.host : 'none'))
  if (saved) {
    try {
      await syncBackendIdentity(saved)
      beacon('step: identity ok')
    } catch (e) {
      beacon('step: identity threw ' + (e instanceof Error ? e.message : ''))
    }
  }
  void loadOutbox()
  void loadDrafts()
  void loadSendQueue()
  void loadAttention()
  beacon('step: loaders done')
  if (saved) {
    connConfig.set(saved)
    beacon('step: dialing')
    try {
      await connect(saved)
      beacon('step: connected')
    } catch (e) {
      beacon('step: connect threw ' + (e instanceof Error ? e.message : ''))
    }
  }
  beacon('stage: boot finished, rendering')
}
