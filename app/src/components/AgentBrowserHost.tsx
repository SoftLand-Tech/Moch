/**
 * The agent's own always-on browser tab (BUG-130 follow-up: "browser tools
 * always available").
 *
 * Before this host, the ONLY WebView in the app lived on the Browser screen,
 * so the relay — and with it the browser tools — existed only while that
 * screen was mounted. Every app restart (or MIUI killing the process) took
 * the tools away, and new chats correctly reported "no browser tools" until
 * the user opened the screen again.
 *
 * This host mounts a small offscreen WebView at the app root for the whole
 * process lifetime and boots the relay + gate alongside it:
 *
 *   mount → ensureBrowserRelay() → native CdpRelay.start + webview debugging
 *         → moch.browser_gate.activate (via the module) AND, at Python boot,
 *           hermes_boot's pid-gated arming (the fresh relay.json carries the
 *           live pid, so it matches) → every new session sees the tools.
 *
 * The relay survives chat deletes and navigation — it belongs to the process,
 * not to a session. Only process death ends it, and the next launch re-boots
 * the whole chain automatically. Cost: one extra resident WebView (~tens of
 * MB) — accepted deliberately; it IS the feature.
 *
 * BH-000091 (BUG-110): the boot used to be a one-shot effect whose ref
 * latched BEFORE the await and swallowed failures — one cold-start failure
 * meant no agent tab for the whole process. The boot is now a bounded retry
 * (5 attempts, 1s→16s exponential backoff — the JS mirror of the Kotlin
 * gate-arm loop), re-armed on AppState 'active', and the host SUBSCRIBES to
 * `relayStatus` so a relay booted later (e.g. the user opening the Browser
 * screen) flips this host ready without a restart. The ref stays purely as
 * a concurrency guard.
 *
 * BH-000084 (BUG-116): the WebView now installs `onRenderProcessGone` — a
 * killed renderer remounts the page (the browser.tsx renderKeys pattern),
 * which restores the DevTools page target this host exists to provide.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { useStore } from '@nanostores/react'
import { WebView } from 'react-native-webview'

import { ensureBrowserRelay, relayStatus, syncActiveUrl } from '../lib/browserRelay'
import { log } from '../lib/log'

// Speed pass: about:blank registers as a page DevTools target exactly like
// example.com did, with ZERO network on every cold start (DNS+TLS+HTML fetch
// used to run at each launch just to keep this target alive). CdpRelay hides
// BOTH prefixes from tab listings (lockstep pair — see AGENT_TAB_URL_PREFIXES).
const AGENT_START_URL = 'about:blank'

/** BH-000091: bounded boot retry — attempts and backoff (1s → 16s exponential). */
const BOOT_ATTEMPTS = 5
const BOOT_BACKOFF_FIRST_MS = 1000
const BOOT_BACKOFF_MAX_MS = 16000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function AgentBrowserHost() {
  const [ready, setReady] = useState(false)
  /** Bumped to remount (recreate) the WebView after a renderer crash. */
  const [renderKey, setRenderKey] = useState(0)
  const status = useStore(relayStatus)
  /**
   * Concurrency guard ONLY (BH-000091): must never latch — a failed boot has
   * to stay retryable by the AppState re-arm below.
   */
  const bootInFlight = useRef(false)

  /**
   * The bounded boot: up to BOOT_ATTEMPTS ensureBrowserRelay() calls with
   * exponential backoff, logging every failure. Resolves true once running.
   */
  const bootRelay = useCallback(async (): Promise<boolean> => {
    if (bootInFlight.current) return false
    bootInFlight.current = true
    try {
      let delay = BOOT_BACKOFF_FIRST_MS
      for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
        try {
          const st = await ensureBrowserRelay()
          if (st.running) {
            log('info', 'AgentBrowserHost', `relay up after attempt ${attempt}`)
            setReady(true)
            return true
          }
          log('warn', 'AgentBrowserHost', `boot attempt ${attempt}/${BOOT_ATTEMPTS} failed: ${st.lastError ?? 'not running'}`)
        } catch (e) {
          log('warn', 'AgentBrowserHost', `boot attempt ${attempt}/${BOOT_ATTEMPTS} threw: ${e}`)
        }
        if (attempt < BOOT_ATTEMPTS) await sleep(delay)
        delay = Math.min(delay * 2, BOOT_BACKOFF_MAX_MS)
      }
      log('warn', 'AgentBrowserHost', `gave up after ${BOOT_ATTEMPTS} attempts — re-arms on next foreground or relay boot`)
      return false
    } finally {
      bootInFlight.current = false
    }
  }, [])

  useEffect(() => {
    void bootRelay()
  }, [bootRelay])

  // BH-000091: re-arm on foreground — a boot that failed (or a relay that
  // died) while backgrounded gets a fresh bounded round on return.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return
      const st = relayStatus.get()
      if (st?.running) {
        if (!ready) setReady(true)
        return
      }
      void bootRelay()
    })
    return () => sub.remove()
  }, [bootRelay, ready])

  // BH-000091: SUBSCRIBE to the relay status store — a relay booted AFTER
  // this host gave up (typically the Browser screen's own ensure) flips the
  // host ready on the store update; no restart needed.
  useEffect(() => {
    if (!ready && status?.running) {
      log('info', 'AgentBrowserHost', 'relay booted elsewhere — host ready')
      setReady(true)
    }
  }, [status, ready])

  if (!ready) return null

  return (
    <View style={s.host} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <WebView
        key={renderKey}
        source={{ uri: AGENT_START_URL }}
        style={s.tab}
        webviewDebuggingEnabled
        setSupportMultipleWindows={false}
        // Keep the relay's active-tab filter pointed at THIS tab while the
        // Browser screen is closed; when the screen is open, its own
        // onNavigationStateChange syncs the visible tab and wins (last
        // navigator), which is the tab the user is looking at.
        onNavigationStateChange={(nav) => syncActiveUrl(nav.url)}
        // BH-000084 (BUG-116): the renderer died (OOM kill, crash) — remount
        // the WebView so a fresh DevTools page target exists; the relay
        // re-tunnels to it on the next connect. Mirrors browser.tsx.
        onRenderProcessGone={(ev) => {
          log('warn', 'AgentBrowserHost', `renderer gone (didCrash=${String(ev?.nativeEvent?.didCrash)}) — remounting`)
          setRenderKey((k) => k + 1)
        }}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        allowFileAccess={false}
        userAgent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
      />
    </View>
  )
}

const s = StyleSheet.create({
  // Offscreen but still laid out: `display:'none'` would keep the page from
  // rendering a frame, and CDP needs a live renderer.
  host: {
    position: 'absolute',
    top: -2,
    left: -2,
    width: 2,
    height: 2,
    opacity: 0.01,
    overflow: 'hidden',
  },
  tab: { width: 2, height: 2 },
})
