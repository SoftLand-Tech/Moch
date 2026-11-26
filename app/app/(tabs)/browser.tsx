import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
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
import { ScreenShell } from '../../src/components/ScreenShell'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { Card, Elev, Field, HeaderButton, PrimaryBtn, Txt } from '../../src/components/ui'
import { useDir, useT } from '../../src/lib/strings'
import {
  ensureBrowserRelay,
  browserTabs,
  activeTabId,
  relayStatus,
  handoffRequestAtom,
  addTab,
  closeTab,
  switchTab,
  updateTab,
  syncActiveUrl,
  refreshTabTargetIds,
} from '../../src/lib/browserRelay'
import {
  browserTaskAtom,
  dismissBrowserTask,
  startBrowserTask,
  stopBrowserTask,
  takeoverBrowserTask,
  type BrowserTaskState,
} from '../../src/lib/browserTask'

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
 *  - Ask Moch starts a background quick task pinned to this tab (see
 *    lib/browserTask.ts) — the screen never navigates away and the active chat
 *    stays untouched. The compact strip under the Ask row owns Stop / Take
 *    over; the global BrowserHandoffPrompt owns tool-triggered handoffs.
 *
 * Redesign pass: the chrome is the mockup's screen 6 — tab-chip strip with a
 * round "+", 26px history/reload controls over a mono URL field, an
 * "Ask Moch" toggle that reveals the accent-rimmed Ask row, the accent
 * load-progress line, and the WebView pool framed in an m-card. Relay
 * boot/error states render as cards INSIDE that viewport so the mockup's
 * booting screen keeps the chrome visible. All prior behavior is unchanged:
 * speed-pass hydration, ref-based reload, history + hardware Back, haptics,
 * URL-bar focus ergonomics, and the memoized TabChip/TabPage memo boundary
 * that keeps store ticks and keystrokes out of the WebView pool. The URL bar
 * and Ask row are top-anchored; BUG-133's kbPad on the pool container is the
 * pool's single keyboard owner.
 */

const HOME_URL = 'https://www.google.com'

/** C3: FIXED all session (anti-bot consistency — never rewrite mid-session). */
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

type WVRef = React.ComponentRef<typeof WebView> | null

export default function Browser() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
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
  const task = useStore(browserTaskAtom)
  const handoff = useStore(handoffRequestAtom)
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

  // The quick task's prompt names ONE tab, while the relay's browser tools
  // follow the ACTIVE tab. If the user switches/closes that tab, stop instead
  // of letting the agent edit a different page than the task asked about.
  useEffect(() => {
    if (!task || !activeId || task.tabId === activeId) return
    if (task.status === 'starting' || task.status === 'running') {
      void stopBrowserTask()
    }
  }, [activeId, task])

  // ── Load progress (Chrome-style 2dp bar under the URL row) ───────────────
  const loadProgress = useSharedValue(0)
  const barVisible = useSharedValue(0)
  // Mockup: the track is always there and the accent fill sits at 100% when
  // idle. Real load events drive the width while a page is in flight; the
  // pass-through/fade values below are unchanged from the speed pass.
  const barStyle = useAnimatedStyle(() => ({
    width: `${Math.round((barVisible.value > 0 ? Math.max(loadProgress.value, 0.08) : 1) * 100)}%`,
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
      setAskOpen(false)
      // Background quick task: createSession + a pinned sendPrompt. This never
      // touches the active chat, the share inbox, or navigation — the user
      // stays on THIS page while the agent drives the same tab.
      void startBrowserTask(task, { id: active.id, url, title }).catch(() => {})
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
    <ScreenShell title={t('browser.title')}>
      {/* Speed pass: the shell's top bar already applies the top inset
          (ScreenShell) — this wrapper adds none, so there is no double
          status-bar band and no stacked bottom inset fighting the pool's
          kbPad (BUG-133's verified avoidance stays the single owner). */}
      <SafeAreaView style={s.safe} edges={[]}>
        <View style={s.root}>
          {/* TabChips strip — real tabs + the mockup's round "+" button. */}
          <View style={[s.tabStrip, { flexDirection: dir.row }]}>
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              style={s.tabScroll}
              contentContainerStyle={[s.tabRow, { flexDirection: dir.row }]}
            >
              {tabs.map((tab) => (
                <TabChip
                  key={tab.id}
                  id={tab.id}
                  title={tab.title}
                  url={tab.url}
                  loading={tab.ready === false}
                  on={tab.id === activeId}
                  onOpen={openTab}
                  onClose={removeTab}
                />
              ))}
            </ScrollView>
            <Pressable
              style={s.newTab}
              onPress={newTab}
              accessibilityRole="button"
              accessibilityLabel={t('browser.newTab')}
            >
              <Icon name="add" size={13} color={C.text} />
            </Pressable>
          </View>

          {/* URL row (owns its draft — keystrokes stay off the pool) */}
          <UrlRow
            url={active ? liveUrls.current[active.id] ?? active.url : ''}
            canBack={canBack}
            canFwd={canFwd}
            askOpen={askOpen}
            onBack={pageBack}
            onFwd={pageFwd}
            onReload={reload}
            onSubmit={submitUrl}
            onAsk={() => setAskOpen((v) => !v)}
          />

          {/* Chrome-style load progress (active tab only); booting shows the
              mockup's 38% resting fill. */}
          <View style={s.progressTrack} pointerEvents="none">
            {booting ? (
              <View style={[s.progressFill, s.progressBoot]} />
            ) : (
              <Animated.View style={[s.progressFill, barStyle]} />
            )}
          </View>

          {askOpen && <AskRow onAsk={askMoch} />}
          {task ? <BrowserTaskStrip task={task} handoff={handoff} /> : null}

          {/* Viewport — boot/error card states OR the real WebView pool.
              Every tab stays mounted; inactive tabs render 1px, opaque and
              untouchable so their renderer keeps producing frames for CDP
              (screenshots/screencast need a live surface). */}
          <Animated.View style={[s.viewport, kbPad]}>
            {booting ? (
              <Card style={s.stateCard}>
                <Txt size={13} weight="700" color={C.accent} center>
                  {t('browser.booting.title')}
                </Txt>
                <Txt size={11.5} color={C.textDim} center style={s.stateSub}>
                  {t('browser.booting.sub')}
                </Txt>
              </Card>
            ) : relayBad ? (
              <Card style={s.stateCard}>
                <Icon name="warning-outline" size={30} color={C.red} />
                <Txt size={13} weight="700" color={C.red} center style={s.stateSub}>
                  {t('browser.error.title')}
                </Txt>
                <Txt size={11.5} color={C.textDim} center style={s.stateSub} numberOfLines={3}>
                  {status?.lastError ?? t('browser.error.unknown')}
                </Txt>
                {/* BUG-118: tap-to-retry, the ScreenShell reconnect-control pattern. */}
                <PrimaryBtn
                  label={t('common.retry')}
                  onPress={retryBoot}
                  accessibilityLabel={t('common.retry')}
                  small
                  style={s.retryBtn}
                />
              </Card>
            ) : (
              <View style={s.frame}>
                {tabs.map((tab) => (
                  <TabPage
                    key={`${tab.id}:${renderKeys[tab.id] ?? 0}`}
                    url={tab.url}
                    on={tab.id === activeId}
                    h={getHandlers(tab.id)}
                  />
                ))}
              </View>
            )}
          </Animated.View>
        </View>
      </SafeAreaView>
    </ScreenShell>
  )
}

// ── TabChip — memoized tab-strip chip (SPEED_REPORT A2-18 pattern) ──────────

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
  const t = useT()
  const dir = useDir()
  return (
    <Pressable
      onPress={() => onOpen(id)}
      style={[s.tab, { flexDirection: dir.row }, on && s.tabOn]}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={t('browser.tabLabel', { title: title || url })}
    >
      <Txt size={11} weight="700" color={on ? C.accent : C.textDim} numberOfLines={1} style={s.tabText}>
        {loading ? '… ' : ''}{title || url}
      </Txt>
      <Pressable
        hitSlop={8}
        onPress={() => onClose(id)}
        accessibilityRole="button"
        accessibilityLabel={t('browser.closeTab')}
      >
        <Icon name="close" size={10} color={on ? C.accent : C.textFaint} />
      </Pressable>
    </Pressable>
  )
})

// ── UrlRow — address bar + history controls (owns its draft state) ──────────

const UrlRow = memo(function UrlRow({
  url,
  canBack,
  canFwd,
  askOpen,
  onBack,
  onFwd,
  onReload,
  onSubmit,
  onAsk,
}: {
  url: string
  canBack: boolean
  canFwd: boolean
  askOpen: boolean
  onBack: () => void
  onFwd: () => void
  onReload: () => void
  onSubmit: (next: string) => void
  onAsk: () => void
}) {
  const s = useStyles(makeUrlRowS)
  const t = useT()
  const dir = useDir()
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
    <View style={[s.urlRow, { flexDirection: dir.row }]}>
      <HeaderButton
        style={s.navBtn}
        onPress={onBack}
        disabled={!canBack}
        accessibilityLabel={t('browser.goBack')}
      >
        <Icon name={dir.icon.back} size={14} color={canBack ? C.text : C.textFaint} />
      </HeaderButton>
      {/* The mockup row is back + reload; forward appears only when the live
          tab actually has forward history (feature preserved, chrome quiet). */}
      {canFwd ? (
        <HeaderButton
          style={s.navBtn}
          onPress={onFwd}
          accessibilityLabel={t('browser.goForward')}
        >
          <Icon name={dir.icon.forward} size={14} color={C.text} />
        </HeaderButton>
      ) : null}
      <HeaderButton style={s.navBtn} onPress={onReload} accessibilityLabel={t('browser.reload')}>
        <Icon name="refresh" size={13} color={C.text} />
      </HeaderButton>
      <View style={[s.urlWrap, { flexDirection: dir.row }, focused && s.urlWrapFocused]}>
        <TextInput
          ref={inputRef}
          style={s.urlInput}
          value={draft}
          onChangeText={(txt) => setDraft(txt)}
          onSubmitEditing={submit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t('browser.urlPlaceholder')}
          placeholderTextColor={C.textFaint}
          selectionColor={C.accent}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          accessibilityLabel={t('browser.addressBar')}
        />
        {focused && draft.length > 0 && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              setDraft('')
              inputRef.current?.focus()
            }}
            accessibilityRole="button"
            accessibilityLabel={t('browser.clearAddress')}
          >
            <Icon name="close" size={12} color={C.textFaint} />
          </Pressable>
        )}
      </View>
      <Pressable
        style={[s.askToggle, askOpen && s.askToggleOn]}
        onPress={onAsk}
        accessibilityRole="button"
        accessibilityState={{ expanded: askOpen }}
        accessibilityLabel={t('browser.askToggleA11y')}
      >
        <Txt size={10.5} weight="700" color={askOpen ? C.onAccent : C.accent}>
          {t('browser.askToggle')}
        </Txt>
      </Pressable>
    </View>
  )
})

// ── AskRow — the "Ask Moch" composer row (owns its draft state) ─────────────

const AskRow = memo(function AskRow({ onAsk }: { onAsk: (task: string) => void }) {
  const s = useStyles(makeAskS)
  const t = useT()
  const dir = useDir()
  const [draft, setDraft] = useState('')
  const send = useCallback(() => {
    const task = draft.trim()
    if (!task) return
    onAsk(task)
    setDraft('')
  }, [draft, onAsk])
  return (
    <Elev style={[s.askRow, { flexDirection: dir.row }]}>
      <Field
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={send}
        placeholder={t('browser.askPlaceholder')}
        multiline
        style={s.askInput}
        wrapStyle={s.askInputWrap}
        accessibilityLabel={t('browser.askInputA11y')}
      />
      <PrimaryBtn
        label={t('browser.send')}
        onPress={send}
        small
        style={s.askSend}
        textStyle={s.askSendText}
        accessibilityLabel={t('browser.sendA11y')}
      />
    </Elev>
  )
})

// ── BrowserTaskStrip — background quick-task status (Ask Moch) ──────────────

const BrowserTaskStrip = memo(function BrowserTaskStrip({
  task,
  handoff,
}: {
  task: BrowserTaskState
  handoff: { reason: string } | null
}) {
  const s = useStyles(makeTaskS)
  const t = useT()
  const dir = useDir()
  const busy = task.status === 'starting' || task.status === 'running'
  const pending = !!handoff
  const label =
    pending && busy
      ? t('browser.task.handoff')
      : t(`browser.task.${task.status}`)
  const localError = task.errorKey ? t(task.errorKey) : task.error
  const detail =
    pending && busy && handoff?.reason
      ? handoff.reason
      : localError
        ? localError
        : task.task
  const dot =
    task.status === 'running'
      ? C.accent
      : task.status === 'done'
        ? C.green
        : task.status === 'failed'
          ? C.red
          : task.status === 'user'
            ? C.accent
            : C.textFaint
  return (
    <View
      style={[s.strip, { flexDirection: dir.row }, pending && busy && s.stripAlert]}
      accessibilityLabel={t('browser.task.status')}
    >
      <View style={[s.dot, { backgroundColor: dot }]} />
      <View style={s.textWrap}>
        <Txt size={10.5} weight="700" color={task.status === 'failed' ? C.red : C.text} numberOfLines={1}>
          {label}
        </Txt>
        <Txt size={9.5} color={C.textFaint} numberOfLines={1}>
          {detail}
        </Txt>
      </View>
      {busy ? (
        <View style={[s.actions, { flexDirection: dir.row }]}>
          <Pressable
            hitSlop={8}
            onPress={() => void stopBrowserTask()}
            accessibilityRole="button"
            accessibilityLabel={t('browser.task.stop')}
          >
            <Txt size={10} weight="700" color={C.textDim}>
              {t('browser.task.stop')}
            </Txt>
          </Pressable>
          <Pressable
            onPress={() => void takeoverBrowserTask()}
            style={[s.takeOver, pending && s.takeOverPrimary]}
            accessibilityRole="button"
            accessibilityLabel={t('browser.task.takeOver')}
          >
            <Txt size={10} weight="800" color={pending ? C.onAccent : C.accent}>
              {t('browser.task.takeOver')}
            </Txt>
          </Pressable>
        </View>
      ) : (
        <Pressable
          hitSlop={8}
          onPress={dismissBrowserTask}
          accessibilityRole="button"
          accessibilityLabel={t('browser.task.dismiss')}
        >
          <Icon name="close" size={11} color={C.textFaint} />
        </Pressable>
      )}
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
    root: { flex: 1 },
    // TabChips strip (mockup: 0 12 6, gap 5, centered; round 24px + at the end)
    tabStrip: {
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingBottom: 6,
    },
    tabScroll: { flexGrow: 0, flexShrink: 1, minWidth: 0 },
    tabRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    newTab: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.bgCard,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    // Load progress (mockup: 2px track, borderSoft, radius 99, margin 0 12 6)
    progressTrack: {
      height: 2,
      marginHorizontal: 12,
      marginBottom: 6,
      borderRadius: 99,
      backgroundColor: C.borderSoft,
      overflow: 'hidden',
    },
    progressFill: { height: 2, backgroundColor: C.accent },
    progressBoot: { width: '38%' },
    // WebView viewport — mockup app-scroll padding-top 2 + m-card framing.
    viewport: { flex: 1, paddingTop: 2 },
    frame: {
      flex: 1,
      marginHorizontal: 14,
      marginBottom: 10,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.bgCard,
      overflow: 'hidden',
    },
    stateCard: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 36,
      paddingHorizontal: 16,
      marginHorizontal: 14,
      marginTop: 8,
    },
    stateSub: { marginTop: 4 },
    retryBtn: { marginTop: 14, paddingHorizontal: 16 },
  })

const makeTabS = () =>
  StyleSheet.create({
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      maxWidth: 170,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.bgCard,
    },
    tabOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
    tabText: { maxWidth: 120 },
  })

const makeUrlRowS = () =>
  StyleSheet.create({
    // Mockup: 0 12 6, gap 5, centered row.
    urlRow: {
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingBottom: 6,
    },
    // shell-icon-btn at 26px (mockup overrides width/height only).
    navBtn: { width: 26, height: 26, borderRadius: 10 },
    // Mono URL field: inputBg, border, radius 9, 10.5 textDim, single line.
    urlWrap: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: C.inputBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 9,
      paddingVertical: 5,
      paddingHorizontal: 8,
    },
    urlWrapFocused: { borderColor: C.accent },
    urlInput: {
      flex: 1,
      minWidth: 0,
      padding: 0,
      color: C.textDim,
      fontSize: 10.5,
      fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }),
      writingDirection: 'ltr',
      textAlign: 'left',
    },
    // "Ask Moch" toggle: accent border; accent bg when open.
    askToggle: {
      borderWidth: 1,
      borderColor: C.accent,
      backgroundColor: C.accentSoft,
      borderRadius: 9,
      paddingVertical: 5,
      paddingHorizontal: 8,
      flexShrink: 0,
    },
    askToggleOn: { backgroundColor: C.accent },
  })

const makeAskS = () =>
  StyleSheet.create({
    // Mockup: margin 0 12 8, padding 7, bgElev, accent border, radius 11.
    askRow: {
      marginHorizontal: 12,
      marginBottom: 8,
      padding: 7,
      borderColor: C.accent,
      borderRadius: 11,
      alignItems: 'center',
      gap: 6,
    },
    askInputWrap: { flex: 1, borderRadius: 11 },
    askInput: {
      minHeight: 28,
      maxHeight: 110,
      fontSize: 11.5,
      paddingVertical: 5,
      paddingHorizontal: 8,
    },
    askSend: { minHeight: 28, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 11 },
    askSendText: { fontSize: 11 },
  })

const makeTaskS = () =>
  StyleSheet.create({
    strip: {
      marginHorizontal: 12,
      marginBottom: 8,
      paddingVertical: 6,
      paddingHorizontal: 9,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.bgCard,
      alignItems: 'center',
      gap: 7,
    },
    stripAlert: { borderColor: C.accent, backgroundColor: C.accentSoft },
    dot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
    textWrap: { flex: 1, minWidth: 0 },
    actions: { alignItems: 'center', gap: 8, flexShrink: 0 },
    takeOver: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: C.accent,
      backgroundColor: C.accentSoft,
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    takeOverPrimary: { backgroundColor: C.accent, borderColor: C.accent },
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
