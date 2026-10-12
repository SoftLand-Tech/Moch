/**
 * The one door for "show this URL to the user" (BUG-135): every tappable
 * link in the app — chat markdown, command-output cards, terminal hit-test
 * taps — routes through here into a NEW tab of the built-in Browser screen,
 * never the OS browser.
 *
 * expo-router is imported HERE (and only here in this chain): browserRelay
 * must stay node-safe for scripts/test-browser-relay.ts, so the router
 * touch lives in this RN-only leaf, not in the store module.
 */
import { router } from 'expo-router'
import { addTab } from './browserRelay'
import { normalizeTerminalUrl } from './terminal'

/**
 * Sanitize (http/https only — trailing punctuation/angle brackets are
 * trimmed by normalizeTerminalUrl), open a fresh Browser tab with that URL,
 * and navigate to the screen. Invalid input is a no-op (the caller already
 * treated the tap as inert).
 *
 * Known deferred quirk: while the Browser screen is closed, this addTab's
 * syncActiveUrl can race the hidden AgentBrowserHost tab's own sync for the
 * relay's /json/list filter (last writer wins). Harmless — the new tab
 * still mounts with the right URL, and the agent's targeting re-syncs on
 * the screen's next navigation event.
 */
export function openInAppBrowserTab(url: string): void {
  const clean = normalizeTerminalUrl(url)
  if (!clean) return
  addTab(clean)
  try {
    router.navigate('/(tabs)/browser')
  } catch {
    // Router not mounted yet (early launch) — the tab exists in the store;
    // opening the screen manually shows it.
  }
}
