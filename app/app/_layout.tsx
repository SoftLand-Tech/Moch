import React, { useCallback, useEffect, useState } from 'react'
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
import { AlertDialogHost, showAlert } from '../src/components/AlertDialog'
import { SessionToasts } from '../src/components/SessionToasts'
import { MochiStage } from '../src/components/Mascot'
import {
  isConnected as isConnectedAtom, connectionState, connConfig, loadSavedConfig,
  connectThisPhone, gatewayError, retryNow, disconnect, reconnectAttempt, onForeground, redactedUrl,
  onDialConfig, everConnected,
} from '../src/lib/gateway'
import { loadSessions, refreshRunningSessions } from '../src/lib/sessionList'
import { refreshRunningAutomations } from '../src/lib/automationsState'
import { hookChatEvents, loadOutbox, switchToSession } from '../src/lib/chat'
import { loadAttention, pendingOpenStoredId, requestOpenSession } from '../src/lib/attention'
import { flushDrafts, loadDrafts } from '../src/lib/drafts'
import { flushSendQueue, loadSendQueue } from '../src/lib/sendQueue'
import { initShareIn, deliverSharedNow, shareInInbox } from '../src/lib/shareIn'
import { loadLocale, tr } from '../src/lib/strings'
import { linkToast } from '../src/lib/linkToast'
import { AgentBrowserHost } from '../src/components/AgentBrowserHost'
import { syncBackendIdentity } from '../src/lib/backendIdentity'
import { pruneRelayMedia } from '../src/lib/mediaCache'
import { C, loadTheme, useStyles } from '../src/lib/theme'
import { loadActiveBot } from '../src/lib/fleet'
import { loadThinker } from '../src/lib/thinker'
import { loadOnboarded } from '../src/lib/aboutMe'

// Keep the native splash up until the animated overlay is committed on top
// of the app — global scope, un-awaited, per the SDK 57 docs.
SplashScreen.preventAutoHideAsync().catch(() => {})

/** GH #109: the pairing/deep-link toast — tap-dismissable (it used to be a
 * passive View nothing could remove), one component for both root branches. */
function LinkToast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.toast, pressed && s.pressed]}
      onPress={onDismiss}
      accessibilityRole="button"
      accessibilityLabel="Dismiss message"
    >
      <Text style={s.toastText}>{msg}</Text>
    </Pressable>
  )
}

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
  const pendingOpen = useStore(pendingOpenStoredId)
  const sharedIn = useStore(shareInInbox)
  const [splashGone, setSplashGone] = useState(false)
  // Rendered as the stable last sibling of both layout branches, so the
  // branch switch (saved config loading in) never remounts it mid-animation.
  const splash = !splashGone ? <AnimatedSplash onDone={() => setSplashGone(true)} /> : null


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
    void loadThinker()
    void loadOnboarded()
    // Captured, not fired-and-forgotten: the boot IIFE below awaits this
    // BEFORE its first dial. initPush restores the saved push token into the
    // atom, and dial→wsUrl() reads it — without the await, the first dial of
    // a launch can race ahead of the restore and carry no &push=.
    const pushReady = initPush()
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
      // Local-only (2026-11-15): the agent is the embedded runtime on this
      // phone. A remote-era config may still be on disk; it is never dialed —
      // `connectThisPhone` always targets the loopback gateway. The cache
      // fingerprint still scopes device state to this backend before hydrate.
      void loadOutbox()
      void loadDrafts()
      void loadSendQueue()
      void loadAttention()
      const saved = await loadSavedConfig().catch(() => null)
      if (saved) {
        try { await syncBackendIdentity(saved) } catch {}
      }
      if (cancelled) return
      try {
        await connectThisPhone()
      } catch {
        // The onboarding screen owns the retry surface; a failed boot leaves
        // connConfig null and renders it there.
      }
    })()

    const handleUrl = async (url: string | null) => {
      // GH #109: a NEW link retires whatever toast the previous one left —
      // linkMsg used to be write-only, so an old failure stuck on screen
      // through every later successful pair.
      setLinkMsg((m) => linkToast(m, { type: 'reset' }))
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
      // Local-only build: `hermes://connect` pairing links are retired. Any
      // other hermes:// link is an in-app route (handled above); an old
      // pairing link gets one honest toast instead of silently nothing.
      setLinkMsg((m) =>
        linkToast(m, {
          type: 'error',
          message: 'Pairing to a computer is no longer supported — this build runs the agent on your phone.',
        }))
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
        // BUG-131 (client half): the gateway-running overlay rides the same
        // 60s poll — session.active_list is what surfaces turns running in
        // sessions this app instance never opened.
        void refreshRunningSessions()
        void refreshRunningAutomations()
      }
    }, 60_000)

    // "Ask Moch" share target: cold-start pull (a share captured in
    // MainActivity.onCreate) + the MochShareIn nudge. Routing happens in the
    // sharedIn effect below (and per-pull via the callback) so a share always
    // lands the user on the composer, however it was delivered.
    const routeToChat = () => { try { router.navigate('/(tabs)/chat') } catch {} }
    const offShare = initShareIn(routeToChat)

    // BUG-116: apply the stored EN/AR choice at boot. Nothing called
    // loadLocale() before, so even a saved preference was ignored and the
    // Arabic catalog could never be selected.
    void loadLocale()

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
      setLinkMsg((m) =>
        linkToast(m, {
          type: 'error',
          message: "That chat couldn't be opened — the connection took too long. Try the notification again.",
        }))
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

  // GH #109: the link/auto-dismiss lifecycle. linkMsg used to be write-only —
  // a pairing failure (or the BUG-029 stale-tap notice) rendered FOREVER,
  // not even tap-dismissable. Auto-dismiss after ~7s; every path (tap, new
  // link, successful connect) funnels through the pure linkToast table.
  useEffect(() => {
    if (!linkMsg) return
    const t = setTimeout(() => setLinkMsg((m) => linkToast(m, { type: 'timeout' })), 7_000)
    return () => clearTimeout(t)
  }, [linkMsg])
  const dismissLinkMsg = useCallback(
    () => setLinkMsg((m) => linkToast(m, { type: 'dismiss' })),
    [],
  )

  if (!cfg) {
    return (
      <>
      {/* Local-only boot (2026-11-15): no config is not "unpaired" anymore —
          it is the first frame before the embedded runtime answers. The
          onboarding screen owns the waiting/retry surface; the runtime is
          starting in the background either way. */}
      <AgentBrowserHost />
      <KeyboardProvider>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }} />
        {linkMsg ? <LinkToast msg={linkMsg} onDismiss={dismissLinkMsg} /> : null}
      </View>
      <AlertDialogHost />
      {splash}
      </KeyboardProvider>
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
    <>
    <AgentBrowserHost />
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
        <Stack.Screen name="bot" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="setup" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="onboarding/thinker" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding/environment" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding/about" options={{ headerShown: false }} />
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
              </View>
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
      {linkMsg ? <LinkToast msg={linkMsg} onDismiss={dismissLinkMsg} /> : null}

      {/* Attention toasts — above every screen, under nothing but the
          (transient) splash. Tapping one deep-links to its chat. */}
      <SessionToasts />
      {/* Themed dialogs (showAlert) — one host for the whole app. */}
      <AlertDialogHost />
    </View>
    {splash}
    </KeyboardProvider>
    </>
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
})
