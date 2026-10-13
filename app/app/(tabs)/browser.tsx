import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  AppState,
  BackHandler,
  Platform,
} from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewNavigation } from 'react-native-webview'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import {
  ensureBrowserRelay,
  browserTabs,
  activeTabId,
  relayStatus,
  addTab,
  closeTab,
  switchTab,
  updateTab,
  syncActiveUrl,
  refreshTabTargetIds,
} from '../../src/lib/browserRelay'
import { shareInInbox, normalizeSharedPayload } from '../../src/lib/shareIn'
import { tr } from '../../src/lib/strings'

/**
 * Moch Browser (BUILD-PLAN.md B1) — the visible, multi-tab WebView pool the
 * embedded agent drives over the CDP relay.
 *
 * Contract with the native side:
 *  - Screen mount calls ensureBrowserRelay() FIRST (relay + debug switch),
 *    then mounts one real <WebView> per tab. Tabs stay MOUNTED (1px, opaque,
 *    untouchable) when inactive — detached WebViews stop producing frames
 *    and CDP degrades (research: webview-cdp-report §e.3).
 *  - Every navigation state change syncs the live URL into the relay, whose
 *    /json/list filter makes the agent's "first page target" THIS tab.
 *  - Tab lifecycle is RN-owned: CDP cannot create or focus WebView targets,
 *    and the relay 405s /json/new|close|activate to keep that single owner.
 *  - Ask Moch routes the page into the agent's composer through the same
 *    shareIn inbox the OS share target uses — text lands in the draft,
 *    nothing auto-sends.
 *
 * Speed/native pass (fleet audit, 13 agents — see BROWSER-SPEED-REPORT.md):
 * instant chrome on open (relay hydrate + parallel boot), ref-based reload
 * (no WebView remount — keeps the DevTools target alive), ←/→ + hardware
 * Back page history, a Chrome-style load-progress bar, haptics, URL-bar
 * focus ergonomics, and memoized TabChip/TabPage so store ticks and
 * keystrokes stop re-rendering every WebView. Contracts C1-C5 preserved.
 */

const HOME_URL = 'https://www.google.com'

/** C3: FIXED all session (anti-bot consistency — never rewrite mid-session). */
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

type WVRef = React.ComponentRef<typeof WebView> | null

export default function Browser() {
  const s = useStyles(makeS)
  // BUG-133: tapping a web-page input (a search box in the page itself) opens
  // the IME over the pool with no inset handling anywhere — react-native-
  // webview has none built-in under edge-to-edge. The chat-pad pattern on
  // the pool container shrinks the page viewport to the keyboard's top edge,
  // so in-page inputs can always be scrolled/scrolled-into view above the keys.
  // The URL bar and Ask-Moch row are top-anchored and stay put.
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  const tabs = useStore(browserTabs)
  const activeId = useStore(activeTabId)
  const status = useStore(relayStatus)
  // Speed pass: hydrate from the store AgentBrowserHost already wrote — when
  // the relay is up (the common case, it boots at app launch), the chrome and
  // the first tab paint on frame 1 instead of behind a spinner. The ensure
  // still runs below; a mid-flight relay death flips relayBad via the store.
  const [booting, setBooting] = useState(() => !(relayStatus.get()?.running ?? false))
  const [askOpen, setAskOpen] = useState(false)
  /** Bumped to remount (recreate) a tab's WebView after a renderer crash. */
  const [renderKeys, setRenderKeys] = useState<Record<string, number>>({})
  /** Real current URL per tab (in-page navigations never rewrite the requested url). */
  const liveUrls = useRef<Record<string, string>>({})
  /** Per-tab WebView refs — reload/goBack/goForward run on the LIVE instance
   * (no remount: a reminted DevTools target id breaks the agent's attach). */
  const wvRefs = useRef<Record<string, WVRef>>({})
  /** Per-tab nav flags (canGoBack/canGoForward) — refs, not state: they feed
   * the URL row buttons + the hardware Back handler without pool re-renders. */
  const navFlags = useRef<Record<string, { canGoBack?: boolean; canGoForward?: boolean }>>({})
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  /** Stable per-tab WebView handler bundles — see getHandlers below. */
  const tabHandlers = useRef(new Map<string, TabPageHandlers>())

  useEffect(() => {
    let cancelled = false
    // Speed pass: the first tab mounts NOW (WebView creation + DNS/TLS run
    // while the relay check resolves in parallel). C2 holds — the agent's
    // attach goes THROUGH the relay, which only answers once ensure resolves.
    if (browserTabs.get().length === 0) addTab(HOME_URL)
    void ensureBrowserRelay().finally(() => {
      if (cancelled) return
      setBooting(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // BUG-118 (BH-000093): a relay that failed at mount left the error branch
  // below as a dead end — no path back short of leaving the screen. Retry
  // re-runs the exact boot dance.
  const retryBoot = useCallback(() => {
    setBooting(true)
    void ensureBrowserRelay().finally(() => setBooting(false))
  }, [])

  // BUG-118: returning to the foreground re-evaluates a known-bad relay —
  // a relay that died while backgrounded (or was stopped in a prior app
  // state) gets one fresh ensure instead of a stale error screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return
      const cur = relayStatus.get()
      if (booting || !cur || cur.running) return
      retryBoot()
    })
    return () => sub.remove()
  }, [booting, retryBoot])

  const active = tabs.find((t) => t.id === activeId) ?? null

  // ── Load progress (Chrome-style 2dp bar under the URL row) ───────────────
  const loadProgress = useSharedValue(0)
  const barVisible = useSharedValue(0)
  const barStyle = useAnimatedStyle(() => ({
    width: `${Math.round(loadProgress.value * 100)}%`,
    opacity: barVisible.value,
  }))
  const resetProgress = useCallback(() => {
    loadProgress.value = 0
    barVisible.value = 0
    // Stable shared-value refs (never re-identity) — listed for the linter.
  }, [loadProgress, barVisible])
  const onProgressEvent = useCallback(
    (tabId: string, raw: number) => {
      // Only the tab the user is LOOKING at drives the bar (the agent can be
      // driving a background tab). Store read at event time, not render time.
      if (tabId !== activeTabId.get()) return
      const p = raw > 1 ? raw / 100 : raw // tolerate both 0..1 and 0..100
      if (p >= 1) {
        loadProgress.value = 1
        barVisible.value = withTiming(0, { duration: 200 })
        loadProgress.value = withDelay(220, withTiming(0, { duration: 16 }))
      } else if (p > 0) {
        barVisible.value = 1
        loadProgress.value = Math.max(p, 0.08)
      }
    },
    [loadProgress, barVisible],
  )

  const syncNavFlags = useCallback((tabId: string) => {
    const f = navFlags.current[tabId]
    setCanBack(!!f?.canGoBack)
    setCanFwd(!!f?.canGoForward)
  }, [])

  const onNavState = useCallback(
    (tabId: string, nav: WebViewNavigation) => {
      const url = nav.url ?? ''
      if (url) liveUrls.current[tabId] = url
      navFlags.current[tabId] = { canGoBack: nav.canGoBack, canGoForward: nav.canGoForward }
      if (tabId === activeTabId.get()) syncNavFlags(tabId)
      updateTab(tabId, {
        title: nav.title?.slice(0, 80) || url,
        ready: nav.loading === false,
      })
      // The relay's filter keys on the LIVE url, not the requested one.
      if (tabId === activeTabId.get() && url) syncActiveUrl(url)
    },
    [syncNavFlags],
  )

  const submitUrl = useCallback(
    (next0: string) => {
      if (!active) return
      let next = next0.trim()
      if (!next) return
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      if (!/^https?:\/\//i.test(next)) {
        next = next.includes('.') && !next.includes(' ')
          ? `https://${next}`
          : `https://www.google.com/search?q=${encodeURIComponent(next)}`
      }
      liveUrls.current[active.id] = next
      updateTab(active.id, { url: next, ready: false })
    },
    [active],
  )

  // Speed pass: reload runs on the LIVE WebView instance. The old key-bump
  // remount recreated the renderer (fresh DevTools target id → agent attach
  // churn) AND reloaded the originally-REQUESTED url, not the live one.
  const reload = useCallback(() => {
    if (!active) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    wvRefs.current[active.id]?.reload()
    updateTab(active.id, { ready: false })
  }, [active])

  const pageBack = useCallback(() => {
    const a = activeTabId.get()
    if (!a || !navFlags.current[a]?.canGoBack) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    wvRefs.current[a]?.goBack()
  }, [])

  const pageFwd = useCallback(() => {
    const a = activeTabId.get()
    if (!a || !navFlags.current[a]?.canGoForward) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    wvRefs.current[a]?.goForward()
  }, [])

  // Native pass: hardware Back = close Ask row → page back → (else) leave
  // the screen to the OS. Sidebar's drawer handler registers only while the
  // drawer is OPEN (Sidebar.tsx) — last-added runs first — so an open drawer
  // still wins back-press without any coordination here.
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (askOpen) {
        setAskOpen(false)
        return true
      }
      const a = activeTabId.get()
      if (a && navFlags.current[a]?.canGoBack) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        wvRefs.current[a]?.goBack()
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [askOpen])

  const openTab = useCallback((id: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    switchTab(id)
    resetProgress()
    syncNavFlags(id)
    const live = liveUrls.current[id]
    if (live) syncActiveUrl(live)
  }, [resetProgress, syncNavFlags])

  const newTab = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    addTab(HOME_URL)
  }, [])

  const removeTab = useCallback((id: string) => {
    void Haptics.selectionAsync()
    delete liveUrls.current[id]
    delete navFlags.current[id]
    delete wvRefs.current[id]
    tabHandlers.current.delete(id)
    closeTab(id)
  }, [])

  const askMoch = useCallback(
    (task0: string) => {
      const task = task0.trim()
      if (!active || !task) return
      const url = liveUrls.current[active.id] ?? active.url
      const title = active.title || url
      const payload = normalizeSharedPayload({
        text: `Open in my browser: ${title}\n${url}\n\n${task}`,
        subject: title,
        files: [],
        skipped: 0,
        at: Date.now(),
      })
      if (!payload) return
      setAskOpen(false)
      shareInInbox.set(payload)
    },
    [active],
  )

  // ── Stable per-tab handlers (memo boundary for the pool) ────────────────
  // Created once per tab id: TabPage's React.memo then skips re-renders for
  // store ticks and keystrokes that don't touch THIS tab (C1 untouched — the
  // WebView element, its key and its mount behavior are byte-identical).
  const getHandlers = useCallback(
    (tabId: string): TabPageHandlers => {
      let h = tabHandlers.current.get(tabId)
      if (!h) {
        h = {
          onNav: (nav) => onNavState(tabId, nav),
          onLoaded: () => {
            updateTab(tabId, { ready: true })
            // Event-driven target re-map (RC-2): a fresh renderer (reload,
            // crash remount, agent-opened tab) registers its DevTools target
            // HERE — whenever it actually commits a load, not at a magic
            // setTimeout that can fire too early on slow devices.
            if (!browserTabs.get().find((t) => t.id === tabId)?.targetId) {
              void refreshTabTargetIds(true)
            }
          },
          onGone: () => {
            setRenderKeys((cur) => ({ ...cur, [tabId]: (cur[tabId] ?? 0) + 1 }))
            // BUG-136: the remounted WebView gets a NEW DevTools target id —
            // re-map the registry now and again once the fresh renderer has
            // registered upstream (belt-and-braces with the onLoadEnd hook).
            void refreshTabTargetIds(true)
            setTimeout(() => void refreshTabTargetIds(true), 1500)
          },
          onProgress: (raw) => onProgressEvent(tabId, raw),
          register: (w) => {
            if (w) wvRefs.current[tabId] = w
            else delete wvRefs.current[tabId]
          },
        }
        tabHandlers.current.set(tabId, h)
      }
      return h
    },
    [onNavState, onProgressEvent],
  )

  const relayBad = status && !status.running

  return (
    <ScreenShell title="Browser">
      {/* Speed pass: the shell's top bar already applies the top inset
          (ScreenShell) — this wrapper adds none, so there is no double
          status-bar band and no stacked bottom inset fighting the pool's
          kbPad (BUG-133's verified avoidance stays the single owner). */}
      <SafeAreaView style={s.safe} edges={[]}>
        {booting ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={s.bootText}>Starting the browser relay…</Text>
          </View>
        ) : relayBad ? (
          <View style={s.center}>
            <Ionicons name="warning-outline" size={34} color={C.red} />
            <Text style={s.bootText}>Browser relay unavailable</Text>
            <Text style={s.errText}>{status?.lastError ?? 'unknown error'}</Text>
            {/* BUG-118: tap-to-retry, the ScreenShell reconnect-control pattern. */}
            <Pressable
              style={({ pressed }) => [s.retryBtn, pressed && s.retryBtnPressed]}
              onPress={retryBoot}
              accessibilityRole="button"
              accessibilityLabel={tr('browser.retry')}
            >
              <Ionicons name="refresh" size={17} color={C.onAccent} />
              <Text style={s.retryText}>{tr('browser.retry')}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.root}>
            {/* Tab strip */}
            <View style={s.tabBar}>
              <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={s.tabScroll}>
                <View style={s.tabRow}>
                  {tabs.map((t) => (
                    <TabChip
                      key={t.id}
                      id={t.id}
                      title={t.title}
                      url={t.url}
                      loading={t.ready === false}
                      on={t.id === activeId}
                      onOpen={openTab}
                      onClose={removeTab}
                    />
                  ))}
                </View>
              </ScrollView>
              <Pressable
                style={s.newTab}
                onPress={newTab}
                accessibilityRole="button"
                accessibilityLabel="New tab"
              >
                <Ionicons name="add" size={20} color={C.text} />
              </Pressable>
            </View>

            {/* URL row (owns its draft — keystrokes stay off the pool) */}
            <UrlRow
              url={active ? liveUrls.current[active.id] ?? active.url : ''}
              canBack={canBack}
              canFwd={canFwd}
              onBack={pageBack}
              onFwd={pageFwd}
              onReload={reload}
              onSubmit={submitUrl}
              onAsk={() => setAskOpen((v) => !v)}
            />

            {/* Chrome-style load progress (active tab only) */}
            <View style={s.progressTrack} pointerEvents="none">
              <Animated.View style={[s.progressFill, barStyle]} />
            </View>

            {askOpen && <AskRow onAsk={askMoch} />}

            {/* WebView pool — every tab stays mounted; inactive tabs render
                1px, opaque and untouchable so their renderer keeps producing
                frames for CDP (screenshots/screencast need a live surface). */}
            <Animated.View style={[s.pool, kbPad]}>
              {tabs.map((t) => (
                <TabPage
                  key={`${t.id}:${renderKeys[t.id] ?? 0}`}
                  url={t.url}
                  on={t.id === activeId}
                  h={getHandlers(t.id)}
                />
              ))}
            </Animated.View>
          </View>
        )}
      </SafeAreaView>
    </ScreenShell>
  )
}

// ── TabChip — memoized tab-strip row (SPEED_REPORT A2-18 pattern) ───────────

const TabChip = memo(function TabChip({
  id,
  title,
  url,
  loading,
  on,
  onOpen,
  onClose,
}: {
  id: string
  title: string
  url: string
  loading: boolean
  on: boolean
  onOpen: (id: string) => void
  onClose: (id: string) => void
}) {
  const s = useStyles(makeTabS)
  return (
    <Pressable
      onPress={() => onOpen(id)}
      style={[s.tab, on && s.tabOn]}
      accessibilityRole="tab"
      accessibilityLabel={`Tab ${title}`}
    >
      <Text numberOfLines={1} style={[s.tabText, on && s.tabTextOn]}>
        {loading ? '… ' : ''}{title || url}
      </Text>
      <Pressable
        hitSlop={8}
        onPress={() => onClose(id)}
        accessibilityRole="button"
        accessibilityLabel="Close tab"
      >
        <Ionicons name="close" size={14} color={on ? C.onAccent : C.textFaint} />
      </Pressable>
    </Pressable>
  )
})

// ── UrlRow — address bar + history controls (owns its draft state) ──────────

const UrlRow = memo(function UrlRow({
  url,
  canBack,
  canFwd,
  onBack,
  onFwd,
  onReload,
  onSubmit,
  onAsk,
}: {
  url: string
  canBack: boolean
  canFwd: boolean
  onBack: () => void
  onFwd: () => void
  onReload: () => void
  onSubmit: (next: string) => void
  onAsk: () => void
}) {
  const s = useStyles(makeUrlRowS)
  const inputRef = useRef<TextInput>(null)
  const [draft, setDraft] = useState(url)
  const [focused, setFocused] = useState(false)
  // Re-seed only on EXTERNAL url changes (navigation) — typing never fights
  // the effect because the seed tracks what the effect last wrote.
  const seed = useRef(url)
  useEffect(() => {
    if (url !== seed.current) {
      seed.current = url
      setDraft(url)
    }
  }, [url])
  const submit = useCallback(() => {
    const next = draft.trim()
    if (!next) return
    onSubmit(next)
    inputRef.current?.blur()
  }, [draft, onSubmit])
  return (
    <View style={s.urlRow}>
      <Pressable
        style={s.urlBtn}
        onPress={onBack}
        disabled={!canBack}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        accessibilityState={{ disabled: !canBack }}
      >
        <Ionicons name="chevron-back" size={20} color={canBack ? C.text : C.textFaint} />
      </Pressable>
      <Pressable
        style={s.urlBtn}
        onPress={onFwd}
        disabled={!canFwd}
        accessibilityRole="button"
        accessibilityLabel="Go forward"
        accessibilityState={{ disabled: !canFwd }}
      >
        <Ionicons name="chevron-forward" size={20} color={canFwd ? C.text : C.textFaint} />
      </Pressable>
      <Pressable style={s.urlBtn} onPress={onReload} accessibilityRole="button" accessibilityLabel="Reload page">
        <Ionicons name="refresh" size={18} color={C.text} />
      </Pressable>
      <View style={s.urlWrap}>
        <TextInput
          ref={inputRef}
          style={s.urlInput}
          value={draft}
          onChangeText={(t) => setDraft(t)}
          onSubmitEditing={submit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search or enter address"
          placeholderTextColor={C.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          accessibilityLabel="Address bar"
        />
        {focused && draft.length > 0 && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              setDraft('')
              inputRef.current?.focus()
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear address"
          >
            <Ionicons name="close" size={15} color={C.textFaint} />
          </Pressable>
        )}
      </View>
      <Pressable
        style={[s.urlBtn, s.askBtn]}
        onPress={onAsk}
        accessibilityRole="button"
        accessibilityLabel="Ask Moch about this page"
      >
        <Ionicons name="sparkles" size={18} color={C.onAccent} />
      </Pressable>
    </View>
  )
})

// ── AskRow — the "Ask Moch" composer row (owns its draft state) ─────────────

const AskRow = memo(function AskRow({ onAsk }: { onAsk: (task: string) => void }) {
  const s = useStyles(makeAskS)
  const [draft, setDraft] = useState('')
  const send = useCallback(() => {
    const task = draft.trim()
    if (!task) return
    onAsk(task)
    setDraft('')
  }, [draft, onAsk])
  return (
    <View style={s.askRow}>
      <TextInput
        style={s.askInput}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={send}
        placeholder="What should Moch do on this page?"
        placeholderTextColor={C.textFaint}
        multiline
        accessibilityLabel="Ask Moch task"
      />
      <Pressable style={s.askGo} onPress={send} accessibilityRole="button" accessibilityLabel="Send task to Moch">
        <Ionicons name="arrow-up" size={20} color={C.onAccent} />
      </Pressable>
    </View>
  )
})

// ── TabPage — one mounted WebView (C1 mechanics byte-identical) ─────────────

interface TabPageHandlers {
  onNav: (nav: WebViewNavigation) => void
  onLoaded: () => void
  onGone: () => void
  onProgress: (raw: number) => void
  register: (w: WVRef) => void
}

const TabPage = memo(function TabPage({
  url,
  on,
  h,
}: {
  url: string
  on: boolean
  h: TabPageHandlers
}) {
  const s = useStyles(makePoolS)
  const src = useMemo(() => ({ uri: url }), [url])
  return (
    <View style={on ? s.pageOn : s.pageOff} pointerEvents={on ? 'auto' : 'none'}>
      <WebView
        ref={h.register}
        source={src}
        webviewDebuggingEnabled
        setSupportMultipleWindows={false}
        onNavigationStateChange={h.onNav}
        onLoadEnd={h.onLoaded}
        onLoadProgress={(e) => h.onProgress(e.nativeEvent.progress)}
        onRenderProcessGone={h.onGone}
        userAgent={UA}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        allowFileAccess={false}
        pullToRefreshEnabled={false}
      />
    </View>
  )
})

// ── Styles ──────────────────────────────────────────────────────────────────

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
    bootText: { color: C.textDim, fontSize: 15, textAlign: 'center' },
    errText: { color: C.red, fontSize: 13, textAlign: 'center' },
    retryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 8,
      paddingHorizontal: 18,
      height: 38,
      borderRadius: 19,
      backgroundColor: C.accent,
    },
    retryBtnPressed: { opacity: 0.75 },
    retryText: { color: C.onAccent, fontSize: 14, fontWeight: '600' },
    root: { flex: 1 },
    tabBar: {
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.borderSoft,
      paddingRight: 4,
    },
    tabScroll: { flex: 1 },
    tabRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
    newTab: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    progressTrack: { height: 2, overflow: 'hidden' },
    progressFill: { height: 2, backgroundColor: C.accent },
    pool: { flex: 1, overflow: 'hidden' },
  })

const makeTabS = () =>
  StyleSheet.create({
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: 170,
      paddingHorizontal: 10,
      height: 34,
      borderRadius: 10,
      backgroundColor: C.bgCard,
    },
    tabOn: { backgroundColor: C.accent },
    tabText: { color: C.textDim, fontSize: 13, maxWidth: 120 },
    tabTextOn: { color: C.onAccent, fontWeight: '600' },
  })

const makeUrlRowS = () =>
  StyleSheet.create({
    urlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 6,
    },
    urlBtn: { width: 30, height: 32, alignItems: 'center', justifyContent: 'center' },
    askBtn: { backgroundColor: C.accent, borderRadius: 16 },
    urlWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      height: 36,
      borderRadius: 18,
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.borderSoft,
      paddingLeft: 14,
      paddingRight: 8,
    },
    urlInput: { flex: 1, height: 36, color: C.text, fontSize: 14 },
  })

const makeAskS = () =>
  StyleSheet.create({
    askRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 10,
      paddingBottom: 6,
    },
    askInput: {
      flex: 1,
      minHeight: 38,
      maxHeight: 110,
      borderRadius: 12,
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.accentSoft,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: C.text,
      fontSize: 14,
    },
    askGo: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  })

const makePoolS = () =>
  StyleSheet.create({
    pageOn: { flex: 1, backgroundColor: C.bg },
    pageOff: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
      overflow: 'hidden',
    },
  })
