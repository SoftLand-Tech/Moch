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
 */
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'

import { ensureBrowserRelay, syncActiveUrl } from '../lib/browserRelay'

const AGENT_START_URL = 'https://example.com/'

export function AgentBrowserHost() {
  const [ready, setReady] = useState(false)
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void ensureBrowserRelay()
      .then((st) => {
        if (st.running) setReady(true)
      })
      .catch(() => {})
  }, [])

  if (!ready) return null

  return (
    <View style={s.host} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <WebView
        source={{ uri: AGENT_START_URL }}
        style={s.tab}
        webviewDebuggingEnabled
        setSupportMultipleWindows={false}
        // Keep the relay's active-tab filter pointed at THIS tab while the
        // Browser screen is closed; when the screen is open, its own
        // onNavigationStateChange syncs the visible tab and wins (last
        // navigator), which is the tab the user is looking at.
        onNavigationStateChange={(nav) => syncActiveUrl(nav.url)}
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
