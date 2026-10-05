import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  PanResponder,
  useWindowDimensions,
} from 'react-native'
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import {
  Sidebar,
  captureProgress,
  clamp01,
  drawerPanelWidth,
  settleTo,
  EDGE_CLAIM,
  DOMINANCE,
  FLICK,
  CANCEL_MS,
  type NavItem,
  type RecentChat,
} from './Sidebar'
import { C, S, useStyles, useShape } from '../lib/theme'
import { runningAutomationCount, refreshRunningAutomations } from '../lib/automationsState'
import { attentionById, rowStatus } from '../lib/attention'
import { isConnected as isConnectedAtom, connectionState, rpc } from '../lib/gateway'
import {
  activeStoredId,
  busyStoredIds,
  pendingStoredIds,
  forgetSession,
  isSessionNotFound,
  newChat,
  switchToSession,
  sessionsById,
} from '../lib/chat'
import { loadCatalog } from '../lib/slash'
import { loadSessions, patchRowTitle, sessionRows, toMs } from '../lib/sessionList'
import { forgetChatMarks, loadChatMarks, toggleArchive, togglePin } from '../lib/chatListState'

/**
 * ChatGPT-style shell: a compact top bar with a hamburger, the screen title,
 * and a status affordance on the right, plus the slide-in sidebar.
 *
 * Replaces the bottom tab bar entirely — navigation now happens through the
 * drawer, so the conversation gets the full height of the screen.
 */
export function ScreenShell({
  title,
  children,
  right,
  showBrand,
  onSearch,
}: {
  title: string
  children: React.ReactNode
  right?: React.ReactNode
  showBrand?: boolean
  onSearch?: () => void
}) {
  const S = useShape()
  const s = useStyles(makeS)
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const online = useStore(isConnectedAtom)
  // Tri-state: while the dial is in flight the app is neither connected nor
  // offline — flashing the dead-cloud icon for the ~1s connect window (or
  // longer on mobile data) read as "offline" to users mid-open.
  const connState = useStore(connectionState)
  const connecting = connState === 'connecting'

  const pending = useStore(pendingStoredIds)
  const busy = useStore(busyStoredIds)
  const attention = useStore(attentionById)
  const current = useStore(activeStoredId)
  const all = useStore(sessionsById)
  const rows = useStore(sessionRows)

  // ── Swipe anywhere to open the drawer ────────────────────────────────────
  // The drawer's progress (0 closed → 1 open) lives here so this gesture and
  // the Sidebar's own edge-strip/panel drags drive one Animated.Value. The
  // catch strip inside Sidebar stays 28dp on purpose (a wider box-only strip
  // would swallow chat taps), so the OPEN drag is claimed here on the screen
  // root instead: non-capture, so descendant scrollables keep their gestures
  // (the vertical transcript, horizontal chip strips — they're asked first),
  // and a horizontal-dominant rightward drag anywhere else finger-tracks the
  // panel. Starting mid-screen also sidesteps the Android back-gesture edge
  // zone. The panel follows 1:1 and settles by distance + flick velocity.
  const { width } = useWindowDimensions()
  const drawerAnim = useRef(new Animated.Value(0)).current
  const panelWidth = drawerPanelWidth(width)
  const panelWidthRef = useRef(panelWidth)
  panelWidthRef.current = panelWidth
  const openRef = useRef(open)
  openRef.current = open
  const dragProgress = useRef(0)
  const moveSeen = useRef(false)
  // Flips on the first touch anywhere (see the capture observer below) so the
  // drawer's panel subtree is already mounted — and paid for — before a drag
  // starts moving it.
  const [primed, setPrimed] = useState(false)
  const openPan = useMemo(() => {
    const settle = (_e: GestureResponderEvent, g: PanResponderGestureState) => {
      // Fixed-duration legs on both outcomes: the release glide is the SAME
      // animation as the hamburger open (and its close counterpart), just
      // starting from wherever the drag stopped — one consistent motion.
      if (g.vx > FLICK || dragProgress.current > 0.5) setOpen(true)
      else settleTo(drawerAnim, 0, CANCEL_MS)
    }
    return PanResponder.create({
      // Capture-phase touch-DOWN observer that never claims (returns false):
      // its only job is priming. Mounting the drawer at touch-down means the
      // SectionList mount cost lands while nothing is animating — mounting it
      // mid-drag froze the first swipe (a visible "cut off, then continue").
      onStartShouldSetPanResponderCapture: () => {
        setPrimed(true)
        return false
      },
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !openRef.current && g.dx > EDGE_CLAIM && g.dx > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => captureProgress(drawerAnim, dragProgress, moveSeen),
      onPanResponderMove: (_e, g) => {
        const p = clamp01(g.dx / panelWidthRef.current)
        dragProgress.current = p
        moveSeen.current = true
        drawerAnim.setValue(p)
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    })
  }, [drawerAnim])

  // The drawer's chat list comes from the gateway, so it has to be fetched.
  React.useEffect(() => {
    if (!online) return
    void loadSessions()
    void refreshRunningAutomations()
    // Refresh whenever the connection comes back.
  }, [online])

  // Keep it fresh: a new message lands, a title gets set.
  React.useEffect(() => {
    const id = setInterval(() => {
      if (online) {
        void loadSessions()
        void refreshRunningAutomations()
      }
    }, 60_000)
    return () => clearInterval(id)
  }, [online])

  React.useEffect(() => {
    void loadCatalog().catch(() => {})
  }, [])

  // Pin/archive marks are app-local; restore them once at startup.
  React.useEffect(() => {
    void loadChatMarks()
  }, [])

  const runningAuto = useStore(runningAutomationCount)

  const nav = useMemo<NavItem[]>(() => [
    { key: 'chat', label: 'Chat', icon: 'chatbubble-outline' },
    { key: 'automations', label: 'Automations', icon: 'timer-outline', mochis: runningAuto },
    { key: 'skills', label: 'Skills', icon: 'sparkles-outline' },
    { key: 'connectors', label: 'Connectors', icon: 'extension-puzzle-outline' },
    { key: 'agent', label: 'Models', icon: 'cube-outline' },
    { key: 'settings', label: 'Settings', icon: 'settings-outline' },
  ], [runningAuto])

  const recent = useMemo<RecentChat[]>(() => {
    // The server list is the source of truth: it covers every stored
    // conversation, and `started_at` is a real timestamp. Falling back to the
    // in-memory store (for a chat created before the first fetch landed) is
    // ordered by creation time, never by the per-session `lastSeq`.
    const statusOf = (id: string) => rowStatus(busy.includes(id), attention[id])
    const fromServer = rows.map((r) => ({
      id: r.id,
      title: r.title || r.preview?.slice(0, 60) || 'Untitled',
      ts: toMs(r.started_at),
      status: statusOf(r.id),
      active: r.id === current,
    }))

    const seen = new Set(fromServer.map((c) => c.id))
    const locals = Object.values(all)
      // `new:` pseudo ids are the optimistic new-chat window's stand-ins —
      // never drawer rows (their create may still fail).
      .filter((s) => s.storedId && !s.storedId.startsWith('new:') && !seen.has(s.storedId))
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
      .map((s) => ({
        id: s.storedId,
        title: s.title || 'New chat',
        ts: s.createdAtMs ?? 0,
        status: statusOf(s.storedId),
        active: s.storedId === current,
      }))

    // Uncapped: the sidebar's own search filters this list, and server rows
    // are bounded by the session.list fetch anyway.
    return [...locals, ...fromServer]
  }, [rows, all, busy, attention, current])

  const go = useCallback(
    (key: string) => {
      const route =
        key === 'chat'
          ? '/(tabs)/chat'
          : key === 'automations'
            ? '/(tabs)/automations'
            : key === 'skills'
              ? '/(tabs)/skills'
              : key === 'connectors'
                ? '/(tabs)/connectors'
                : key === 'agent'
                  ? '/(tabs)/agent'
                  : '/(tabs)/settings'
      // navigate, never push: `/(tabs)` is a single route on the root stack,
      // so push mounts a whole fresh copy of every tab screen each tap —
      // navigate just switches the tab inside the instance we already have.
      router.navigate(route as never)
    },
    [router],
  )

  const startNew = useCallback(() => {
    // Navigate first — and the content swap is synchronous inside newChat
    // (a placeholder chat takes the screen in the same tick), with the
    // session.create RPC backgrounded behind it.
    router.navigate('/(tabs)/chat')
    void newChat().catch(() => {
      // The chat screen's retry banner surfaces the failure.
    })
  }, [router])

  const openChat = useCallback(
    (storedId: string) => {
      // Navigate first — and the content swap is synchronous inside
      // switchToSession (in-memory entry reuse, or a placeholder seeded from
      // the row + cached transcript), with the session.resume RPC
      // backgrounded behind it. Same shape as the notification deep-link in
      // app/_layout.tsx.
      router.navigate('/(tabs)/chat')
      void switchToSession(storedId).catch(() => {
        // The chat screen's retry banner surfaces the error.
      })
    },
    [router],
  )

  // ── Per-chat actions (surfaced by the sidebar's long-press / ⋯ menu) ──────
  // Each returns an error message for the dialog, or null on success —
  // react-native-web's Alert.alert is a no-op, so errors must render in-app.

  const liveIdOf = useCallback(
    (storedId: string) => Object.values(sessionsById.get()).find((s) => s.storedId === storedId)?.id,
    [],
  )

  const handlePinToggle = useCallback((id: string) => togglePin(id), [])
  const handleArchiveToggle = useCallback((id: string) => toggleArchive(id), [])

  const handleRename = useCallback(async (storedId: string, title: string) => {
    try {
      // `session.title` with an explicit title writes user-provenance; the
      // auto-titler never overwrites those, so a manual rename sticks.
      await rpc('session.title', { session_id: storedId, title })
      patchRowTitle([storedId], title)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Rename failed'
    }
  }, [])

  const handleDelete = useCallback(async (storedId: string) => {
    try {
      // The gateway refuses to delete the ACTIVE session: detach the UI into
      // a fresh chat first, then tear the old runtime down so the delete lands.
      if (activeStoredId.get() === storedId) await newChat()
      const live = liveIdOf(storedId)
      if (live) {
        try {
          await rpc('session.close', { session_id: live })
        } catch {
          // Best effort — a dead socket or an already-closed session must not
          // block the delete itself.
        }
      }
      try {
        await rpc('session.delete', { session_id: storedId })
      } catch (err) {
        // 'Session not found' means the backend already lost it (serve
        // reinstall / purge / re-pair to another machine) — the delete's goal
        // is achieved, so clean up locally instead of failing the row. Any
        // other error still surfaces.
        if (!isSessionNotFound(err)) throw err
      }
      if (live) await forgetSession(live)
      // Drop the row so the drawer updates without waiting for a poll.
      sessionRows.set(sessionRows.get().filter((r) => r.id !== storedId))
      forgetChatMarks(storedId)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Delete failed'
    }
  }, [liveIdOf])

  return (
    <View style={s.root} {...openPan.panHandlers}>
      {S.trayHeader ? (
        // Mocheme tray — one row: the title floats dead-center (absolutely
        // positioned, inset by the measured controls width so it can never
        // run under the model chip; onSearch deliberately has no tray
        // affordance — search lives in the drawer's Chats tab).
        // The card starts BELOW the status bar (marginTop carries the inset);
        // padding the inset inside the card used to paint a tall empty head
        // above the buttons — the "top padding too much" bug.
        <View style={[s.topBarTray, { marginTop: insets.top + 6, paddingTop: 6 }]}>
          <View
            pointerEvents="none"
            style={[s.trayTitleAbs, { top: 6, bottom: 6, paddingHorizontal: 64 }]}
          >
            <View style={s.trayTitleWrap}>
              {showBrand ? <Text style={s.trayBrand}>Moch</Text> : null}
              <Text style={s.trayTitle} numberOfLines={1}>
                {title}
              </Text>
            </View>
          </View>
          <View style={s.trayControls}>
            <Pressable
              style={({ pressed }) => [s.trayCircle, pressed && s.circlePressed]}
              onPress={() => setOpen(true)}
              hitSlop={8}
              accessibilityLabel="Open menu"
            >
              <Icon name="menu" size={20} color={C.text} />
            </Pressable>
            <View style={s.traySpacer} />
            <View style={s.trayRight}>
              {right}
              <Pressable
                style={s.trayCircle}
                hitSlop={8}
                accessibilityLabel={online ? 'Connected' : connecting ? 'Connecting' : 'Not connected'}
              >
                <Icon
                  name={online ? 'radio-button-on' : connecting ? 'ellipse-outline' : 'cloud-offline-outline'}
                  size={18}
                  color={online ? C.greenSoft : C.textFaint}
                />
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View style={[s.topBar, { paddingTop: insets.top + 6 }]}>
          <Pressable
            style={({ pressed }) => [s.circle, pressed && s.circlePressed]}
            onPress={() => setOpen(true)}
            hitSlop={8}
            accessibilityLabel="Open menu"
          >
            <Icon name="menu" size={20} color={C.text} />
          </Pressable>

          <View style={s.titleWrap}>
            {showBrand ? <Text style={s.brand}>Moch</Text> : null}
            <Text style={[s.title, showBrand && s.titleDim]} numberOfLines={1}>
              {title}
            </Text>
          </View>

          {onSearch ? (
            <Pressable
              style={({ pressed }) => [s.circle, pressed && s.circlePressed]}
              onPress={onSearch}
              hitSlop={8}
              accessibilityLabel="Search chats"
            >
              <Icon name="search" size={18} color={C.text} />
            </Pressable>
          ) : null}
          {right}
          <Pressable
            style={s.circle}
            hitSlop={8}
            accessibilityLabel={online ? 'Connected' : connecting ? 'Connecting' : 'Not connected'}
          >
            <Icon
              name={online ? 'radio-button-on' : connecting ? 'ellipse-outline' : 'cloud-offline-outline'}
              size={18}
              color={online ? C.greenSoft : C.textFaint}
            />
          </Pressable>
        </View>
      )}

      <View style={s.body}>{children}</View>

      <Sidebar
        open={open}
        progress={drawerAnim}
        primed={primed}
        onOpen={() => {
          // Always re-read on open: the list is cheap, and it means a chat
          // created on another surface (or by a cron job) shows up without
          // waiting for the background poll.
          void loadSessions()
        }}
        onClose={() => setOpen(false)}
        onRequestOpen={() => setOpen(true)}
        nav={nav}
        recent={recent}
        onNav={go}
        onNewChat={startNew}
        onOpenChat={openChat}
        onPinToggle={handlePinToggle}
        onArchiveToggle={handleArchiveToggle}
        onRename={handleRename}
        onDelete={handleDelete}
        footer={
          pending.length > 0 ? (
            <View style={s.footerNote}>
              <Icon name="alert-circle" size={14} color={C.amber} />
              <Text style={s.footerText}>
                {pending.length} conversation{pending.length > 1 ? 's' : ''} waiting on you
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  )
}

const makeS = () => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  // Relay keeps today's bare bar; Mocheme's tray is its own block (topBarTray).
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  // Mocheme tray card — taller than the old bar: the title owns a centered
  // line and the controls row sits beneath it.
  topBarTray: {
    marginHorizontal: 10,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingBottom: 8,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  trayTitleAbs: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  // stretch to the inset width so a long title ellipsizes its tail (start
  // visible + '…') instead of overflowing both ends and getting mid-clipped.
  trayTitleWrap: { alignSelf: 'stretch', alignItems: 'center' },
  trayBrand: { color: C.textFaint, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 1 },
  trayTitle: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  trayControls: { flexDirection: 'row', alignItems: 'center' },
  trayRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  traySpacer: { flex: 1 },
  trayCircle: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.borderSoft,
  },
  circle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgCard,
  },
  circlePressed: { opacity: 0.55 },
  titleWrap: { flex: 1, paddingHorizontal: 4 },
  brand: { color: C.text, fontSize: 17, fontWeight: '700' },
  title: { color: C.text, fontSize: 16, fontWeight: '600' },
  titleDim: { fontSize: 13, color: C.textFaint, fontWeight: '500' },
  body: { flex: 1 },
  footerNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 6 },
  footerText: { color: C.textDim, fontSize: 12.5, flex: 1 },
})
