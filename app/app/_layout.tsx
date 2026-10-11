import React, { useEffect, useState } from 'react'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { View, Text, Pressable, StyleSheet, AppState, Modal } from 'react-native'
import { useStore } from '@nanostores/react'
import * as Linking from 'expo-linking'
import * as SplashScreen from 'expo-splash-screen'
import { initPush, registerPushIfGranted, dismissMochNotifications, lastNotificationResponse, onNotificationResponse, clearLastNotificationResponse, type NotificationTarget } from '../src/lib/push'
import { log } from '../src/lib/log'
import { AnimatedSplash } from '../src/components/AnimatedSplash'
import { AlertDialogHost } from '../src/components/AlertDialog'
import { SessionToasts } from '../src/components/SessionToasts'
import { MochiStage } from '../src/components/Mascot'
import {
  isConnected as isConnectedAtom, connectionState, connConfig, loadSavedConfig,
  connect, gatewayError, retryNow, disconnect, reconnectAttempt, onForeground, redactedUrl,
  servers as serversStore, activeServerId, refreshServers, switchToServer,
  forgetActiveServer, mostRecentServer, onDialConfig, type SavedServer,
  everConnected,
} from '../src/lib/gateway'
import { loadSessions } from '../src/lib/sessionList'
import { refreshRunningAutomations } from '../src/lib/automationsState'
import { hookChatEvents, loadOutbox, switchToSession } from '../src/lib/chat'
import { loadAttention, pendingOpenStoredId, requestOpenSession } from '../src/lib/attention'
import { flushDrafts, loadDrafts } from '../src/lib/drafts'
import { flushSendQueue, loadSendQueue } from '../src/lib/sendQueue'
import { initShareIn, deliverSharedNow, shareInInbox } from '../src/lib/shareIn'
import { syncBackendIdentity } from '../src/lib/backendIdentity'
import { parseConnectUrl } from '../src/lib/pairing'
import { pruneRelayMedia } from '../src/lib/mediaCache'
import { C, loadTheme, useStyles } from '../src/lib/theme'
import { loadActiveBot } from '../src/lib/fleet'

// Keep the native splash up until the animated overlay is committed on top
// of the app — global scope, un-awaited, per the SDK 57 docs.
SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const s = useStyles(makeS)
  const state = useStore(connectionState)
  const cfg = useStore(connConfig)
  const err = useStore(gatewayError)
  const attempt = useStore(reconnectAttempt)
  const online = useStore(isConnectedAtom)
  // BUGFIX (launch crash: "Rendered more hooks than the previous render"):
  // this subscription MUST run on every render. It used to sit below the
  // `if (!cfg)` early return, so the first render (saved config still
  // loading, cfg === null) skipped it — and the moment connConfig
  // hydrated, the next render ran one hook MORE than the last → fatal
  // React invariant, app dead at cold open for every paired user.
  const everOpen = useStore(everConnected)
  const [linkMsg, setLinkMsg] = useState<string | null>(null)
  const [showServers, setShowServers] = useState(false)
  const savedServers = useStore(serversStore)
  const activeId = useStore(activeServerId)
  const pendingOpen = useStore(pendingOpenStoredId)
  const sharedIn = useStore(shareInInbox)
  const [splashGone, setSplashGone] = useState(false)
  // Rendered as the stable last sibling of both layout branches, so the
  // branch switch (saved config loading in) never remounts it mid-animation.
  const splash = !splashGone ? <AnimatedSplash onDone={() => setSplashGone(true)} /> : null

  const forgetAndFallBack = async () => {
    disconnect()
    const remaining = await forgetActiveServer()
    const next = mostRecentServer(remaining)
    if (next) {
      try { await switchToServer(next.id); return } catch {}
    }
    router.replace('/')
  }

  useEffect(() => {
    // First commit has the overlay (a pixel-match of the native splash) on
    // top — safe to drop the native one now. iOS gets the fade; web no-ops.
    try {
      SplashScreen.setOptions({ fade: true, duration: 300 })
      SplashScreen.hide()
    } catch {}
    hookChatEvents()
    // Every dial re-checks the backend identity (re-pair via deep link,
    // saved-server switch, reconnect). The boot path below additionally
    // syncs BEFORE the cache loaders run, so a first boot against a newly
    // paired machine can't hydrate the previous machine's caches.
    const offDial = onDialConfig(syncBackendIdentity)
    void loadTheme()
    void loadActiveBot()
    // Captured, not fired-and-forgotten: the boot IIFE below awaits this
    // BEFORE its first dial. initPush restores the saved push token into the
    // atom, and dial→wsUrl() reads it — without the await, the first dial of
    // a launch can race ahead of the restore and carry no &push=.
    const pushReady = initPush()
    void refreshServers()
    // Remote push, SILENT at boot: returning users (permission already
    // granted) re-register their token on the next dial; fresh installs are
    // asked on their FIRST MESSAGE instead (armPushOnFirstSend in chat.ts) —
    // never a cold-app permission demand.
    let tokenKicked = false
    // No self-unsubscribe inside: nanostores fires the listener synchronously
    // on subscribe, and a remount while already connected (Fast Refresh)
    // would call `offToken` before the const is initialized. The flag makes
    // later firings no-ops instead.
    const offToken = isConnectedAtom.subscribe((online) => {
      if (!online || tokenKicked) return
      tokenKicked = true
      void registerPushIfGranted()
    })
    // The app starts in hand — knocks still sitting in the tray from the last
    // session are stale (push.ts sweeps only ours).
    void dismissMochNotifications()
    // Cold-start relay-media prune (>7 days, then oldest-first past 200 MB) —
    // background, one-shot, and images are expo-image's cache's business.
    void pruneRelayMedia()
    let cancelled = false
    ;(async () => {
      await pushReady // token restored before the first dial's wsUrl() runs
      const saved = await loadSavedConfig()
      // Scope the device caches to this backend BEFORE they hydrate: a
      // missing/different fingerprint purges once, then the loaders below
      // read a clean slate.
      if (saved) {
        try { await syncBackendIdentity(saved) } catch {}
      }
      if (cancelled) return
      void loadOutbox()
      void loadDrafts()
      void loadSendQueue()
      void loadAttention()
      if (saved) {
        // Seed the UI with the saved pairing BEFORE the dial lands: the tabs
        // render instantly (chat shows its connecting state) instead of the
        // bare boot screen, and no saved computer ever needs re-pairing to
        // look connected — the last connected one is simply resumed.
        connConfig.set(saved)
        try { await connect(saved) } catch {}
      }
    })()

    const handleUrl = async (url: string | null) => {
      if (!url || !url.startsWith('hermes://')) return
      // In-app routes (knock taps land here — see CronKnockNotifier).
      if (url.startsWith('hermes://automations')) {
        router.push('/(tabs)/automations')
        return
      }
      if (url.startsWith('hermes://chat')) {
        router.push('/(tabs)/chat')
        return
      }
      try {
        const p = parseConnectUrl(url)
        await connect({ host: p.host, token: p.token, tls: p.tls, name: p.name })
        router.replace('/(tabs)/chat')
      } catch (e) {
        setLinkMsg(e instanceof Error ? e.message : 'Bad pairing link')
      }
    }
    void Linking.getInitialURL().then((u) => { if (!cancelled && u) void handleUrl(u) })
    const sub = Linking.addEventListener('url', (ev) => { void handleUrl(ev.url) })

    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        onForeground()
        // Back in hand — tray knocks we sent while the user was away are
        // stale now that the chat surface is reachable again.
        void dismissMochNotifications()
        // A share received while backgrounded may have missed the native
        // event (the process was suspended) — re-pull on foreground.
        deliverSharedNow()
      } else if (s === 'background') {
        // BUG-035: the queue/draft writes are debounced ~400ms and Android
        // can freeze the process right after backgrounding with no further
        // JS callback — a just-typed draft or just-queued message would be
        // lost. Flush the pending writes NOW, while there's still a tick.
        void flushSendQueue().catch(() => {})
        void flushDrafts().catch(() => {})
      }
    })

    // BUG-055: ONE centralized 60s poller for the whole app — the per-shell
    // intervals scaled with mounted tabs (up to ~7 pollers, since
    // expo-router tabs stay mounted after first visit).
    const pollId = setInterval(() => {
      if (isConnectedAtom.get()) {
        void loadSessions()
        void refreshRunningAutomations()
      }
    }, 60_000)

    // "Ask Moch" share target: cold-start pull (a share captured in
    // MainActivity.onCreate) + the MochShareIn nudge. Routing happens in the
    // sharedIn effect below (and per-pull via the callback) so a share always
    // lands the user on the composer, however it was delivered.
    const routeToChat = () => { try { router.navigate('/(tabs)/chat') } catch {} }
    const offShare = initShareIn(routeToChat)

    // Notification tap → the chat it is about (covers killed-state launch
    // too). Routed through push.ts so expo-notifications is never in this
    // file's static import graph — see the note in push.ts.
    const openFromNotification = (t: NotificationTarget) => {
      try { router.navigate('/(tabs)/chat') } catch {}
      if (t.storedId) requestOpenSession(t.storedId)
    }
    void lastNotificationResponse().then((r) => {
      if (cancelled || !r) return
      openFromNotification(r)
      // Consume the replayed tap so the next normal launch doesn't re-route.
      void clearLastNotificationResponse()
    })
    const removeNotifSub = onNotificationResponse(openFromNotification)

    return () => {
      cancelled = true
      offDial()
      offToken()
      sub.remove()
      appSub.remove()
      clearInterval(pollId)
      offShare()
      removeNotifSub?.()
    }
  }, [])

  // Consume a deep-link target (toast tap / notification tap) once the
  // gateway is connected — switching needs a live RPC. Stale targets (the
  // connection never came up within a minute) are dropped so an old tap
  // can't yank the user out of a chat much later.
  useEffect(() => {
    if (!pendingOpen || !online) return
    pendingOpenStoredId.set(null)
    if (Date.now() - pendingOpen.at > 60_000) {
      // BUG-029: a stale tap used to be dropped SILENTLY — the user tapped a
      // notification and nothing happened, with no hint why.
      setLinkMsg("That chat couldn't be opened — the connection took too long. Try the notification again.")
      return
    }
    try { router.navigate('/(tabs)/chat') } catch {}
    void switchToSession(pendingOpen.storedId).catch(() => {})
  }, [pendingOpen, online, router])

  // A share waiting in the inbox routes to the chat tab whose composer will
  // consume it (chat.tsx). Covers every delivery path: cold-start pull,
  // event nudge, foreground re-pull.
  useEffect(() => {
    if (!sharedIn) return
    try { router.navigate('/(tabs)/chat') } catch {}
  }, [sharedIn, router])

  if (!cfg) {
    return (
      <>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }} />
        {linkMsg ? (
          <View style={s.toast}><Text style={s.toastText}>{linkMsg}</Text></View>
        ) : null}
      </View>
      <AlertDialogHost />
      {splash}
      </>
    )
  }

  const failed = !online && (state === 'error' || state === 'closed')
  const connecting = !online && state === 'connecting'
  // BUG-005: the full-screen veil only owns the screen BEFORE the first
  // successful connect of this run (boot / boot-failure). Once the app has
  // been connected, a mid-session drop must degrade to the chat screen's
  // own banner — cached history, drafts and the queue strip stay usable
  // instead of hiding behind an opaque overlay.
  // (useStore(everConnected) moved up to the unconditional hook block — see
  // BUGFIX note there. No hook may ever live below the !cfg early return.)
  const bootStruggling = !everOpen

  return (
    <KeyboardProvider>
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.text,
          contentStyle: { backgroundColor: C.bg },
          headerTitleStyle: { color: C.text, fontWeight: '700' },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="add-computer" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="bot" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="setup" options={{ headerShown: false, presentation: 'modal' }} />
      </Stack>
      {!online && state !== 'idle' && bootStruggling ? (
        <View style={s.overlay}>
          {/* Mochi inside the veil — made VISIBLE so the connecting/offline
              states actually show. The overlay instance mounts cold per
              disconnect (~200-500ms low-end), so the status text below lands
              first and Mochi fades in a beat later. Connecting uses the
              patient waiting loop (rock + wandering gaze) — the connecting
              pose itself ships static, so waiting IS the loading animation.
              BUG-005: boot-only — once this run has connected, outages
              degrade to the chat screen's banner instead of this overlay. */}
          <MochiStage state={connecting ? 'mochi-waiting' : 'mochi-offline'} size={168} />
          {failed ? (
            <>
              <Text style={s.errTitle}>Connection failed</Text>
              <Text style={s.errDetail}>
                {cfg ? redactedUrl(cfg) : ''}
                {attempt > 0 ? `\nRetry #${attempt} — auto-retrying…` : ''}
                {err ? `\n${err.slice(0, 300)}` : ''}
              </Text>
              <View style={s.btnRow}>
                <Pressable style={({ pressed }) => [s.btn, pressed && s.pressed]} onPress={() => { void retryNow().catch(() => {}) }}>
                  <Text style={s.btnText}>Retry</Text>
                </Pressable>
                {savedServers.length > 1 ? (
                  <Pressable style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]} onPress={() => setShowServers(true)}>
                    <Text style={s.ghostText}>Computers…</Text>
                  </Pressable>
                ) : null}
              </View>
              <Pressable style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]} onPress={() => { void forgetAndFallBack() }}>
                <Text style={s.ghostText}>Forget this computer</Text>
              </Pressable>
            </>
          ) : connecting ? (
            <>
              <Text style={s.connecting}>Connecting to your agent…{attempt > 0 ? ` (try ${attempt + 1})` : ''}</Text>
              <Pressable style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]} onPress={() => { disconnect() }}>
                <Text style={s.ghostText}>Cancel</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
      {linkMsg ? (
        <View style={s.toast}><Text style={s.toastText}>{linkMsg}</Text></View>
      ) : null}

      <Modal visible={showServers} transparent animationType="fade" onRequestClose={() => setShowServers(false)}>
        <View style={s.pickerScrim}>
          <View style={s.pickerCard}>
            <Text style={s.pickerTitle}>Your computers</Text>
            {savedServers.length === 0 ? (
              <Text style={s.pickerEmpty}>No other computers saved.</Text>
            ) : (
              savedServers.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt).map((sv) => (
                <Pressable
                  key={sv.id}
                  style={({ pressed }) => [s.pickerRow, sv.id === activeId && s.pickerRowActive, pressed && s.pressed]}
                  onPress={() => { setShowServers(false); void switchToServer(sv.id).catch(() => {}) }}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to ${sv.name}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.pickerName} numberOfLines={1}>{sv.name}</Text>
                    <Text style={s.pickerHost} numberOfLines={1}>{sv.tls ? 'WSS' : 'WS'} · {sv.host}</Text>
                  </View>
                  {sv.id === activeId ? <Text style={s.pickerActive}>current</Text> : null}
                </Pressable>
              ))
            )}
            <Pressable style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]} onPress={() => setShowServers(false)}>
              <Text style={s.ghostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Attention toasts — above every screen, under nothing but the
          (transient) splash. Tapping one deep-links to its chat. */}
      <SessionToasts />
      {/* Themed dialogs (showAlert) — one host for the whole app. */}
      <AlertDialogHost />
    </View>
    {splash}
    </KeyboardProvider>
  )
}

/**
 * Root error boundary — expo-router wraps the ROOT LAYOUT itself in its
 * `Try` boundary ONLY when this module exports `ErrorBoundary` (layouts
 * are otherwise excluded). Without this export, ANY render error thrown
 * by RootLayout — like the launch-crashing "Rendered more hooks than the
 * previous render" fixed above — is uncaught: the app dies natively and
 * MIUI shows the crash-report dialog. With it, the same error degrades
 * to this screen and Retry remounts the layout fresh.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
      <StatusBar style="light" />
      <Text style={{ color: C.red, fontSize: 19, fontWeight: '800', marginBottom: 12 }}>Something went wrong</Text>
      <Text style={{ color: C.textDim, fontSize: 13, textAlign: 'center', marginBottom: 24, lineHeight: 19 }}>
        {error?.message ?? 'Unexpected render error'}
      </Text>
      <Pressable
        style={({ pressed }) => [{ backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 }, pressed && { opacity: 0.6 }]}
        onPress={retry}
        accessibilityRole="button"
        accessibilityLabel="Retry"
      >
        <Text style={{ color: C.onAccent, fontSize: 15, fontWeight: '800' }}>Retry</Text>
      </Pressable>
    </View>
  )
}

const makeS = () => StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center', padding: 30 },
  pressed: { opacity: 0.6 },
  errTitle: { color: C.red, fontSize: 19, fontWeight: '800', marginBottom: 12 },
  errDetail: { color: C.textDim, fontSize: 13, textAlign: 'center', marginBottom: 24, lineHeight: 19 },
  btnRow: { flexDirection: 'row', gap: 12 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  btnText: { color: C.onAccent, fontSize: 15, fontWeight: '800' },
  ghostBtn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 22, borderWidth: 1, borderColor: C.border, marginTop: 12 },
  ghostText: { color: C.textDim, fontSize: 15, fontWeight: '600' },
  connecting: { color: C.textDim, marginTop: 2, marginBottom: 8 },
  toast: { position: 'absolute', bottom: 40, left: 20, right: 20, backgroundColor: C.bgElev, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border },
  toastText: { color: C.text, fontSize: 13.5, textAlign: 'center' },
  pickerScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  pickerCard: { width: '100%', maxWidth: 420, backgroundColor: C.bgElev, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: C.border, gap: 8 },
  pickerTitle: { color: C.text, fontSize: 16, fontWeight: '800', marginBottom: 4 },
  pickerEmpty: { color: C.textDim, fontSize: 14, paddingVertical: 10 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.inputBg, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 12, minHeight: 56 },
  pickerRowActive: { borderColor: C.accent },
  pickerName: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  pickerHost: { color: C.textFaint, fontSize: 12, marginTop: 2 },
  pickerActive: { color: C.accent, fontSize: 12, fontWeight: '700' },
})
