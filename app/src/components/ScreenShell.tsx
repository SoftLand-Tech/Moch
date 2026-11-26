import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Keyboard,
  PanResponder,
  useWindowDimensions,
} from 'react-native'
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native'
import { Icon } from './Icon'
import { HeaderButton } from './ui'
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
import { isConnected as isConnectedAtom, connectionState, retryNow, rpc } from '../lib/gateway'
import {
  activeProjectIdAtom,
  buildSessionOwnerIndex,
  identityAtom,
  inboxNavItem,
  loadIdentity,
  projectIdForSession,
  projectSessionIdsAtom,
  projectsAtom,
  refreshProjects,
  setActiveProject,
  setIdentity,
} from '../lib/workspace'
import type { Identity } from '../lib/workspace'
import { tr, localeAtom, useDir } from '../lib/strings'
import {
  activeStoredId,
  busyStoredKey,
  pendingCount,
  pendingStoredIds,
  forgetSession,
  isServerOnlySession,
  isSessionNotFound,
  newChat,
  patchSession,
  resumeShared,
  switchToSession,
  sessionsById,
  sessionsSummaryKey,
} from '../lib/chat'
import { loadCatalog } from '../lib/slash'
import { isBotSessionRow, loadLastActive, loadSessions, lastActiveByStoredId, lastActiveFor, patchRowTitle, refreshRunningSessions, sessionRows, toMs } from '../lib/sessionList'
import { forgetChatMarks, loadChatMarks, toggleArchive, togglePin } from '../lib/chatListState'
import { inboxCount } from '../lib/inbox'
import { openBotChat } from '../lib/botChat'
import { fleetProfiles, refreshFleet } from '../lib/fleet'
import { showAlert } from './AlertDialog'

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
  const dir = useDir()
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Opening the drawer abandons any IME that is already up (chat composer,
  // terminal, etc.). Keyboard.dismiss() blurs the focused input, so focus
  // leaves the composer instead of lingering behind the scrim; closing the
  // drawer dismisses the sidebar's own search/underlying keyboard too. Every
  // open/close path routes through these two callbacks.
  const openDrawer = useCallback(() => {
    Keyboard.dismiss()
    setOpen(true)
  }, [])
  const closeDrawer = useCallback(() => {
    Keyboard.dismiss()
    setOpen(false)
  }, [])
  const online = useStore(isConnectedAtom)
  // Tri-state: while the dial is in flight the app is neither connected nor
  // offline — flashing the dead-cloud icon for the ~1s connect window (or
  // longer on mobile data) read as "offline" to users mid-open.
  const connState = useStore(connectionState)
  const connecting = connState === 'connecting'
  // Measured width of the tray's right control cluster — the title's safe
  // inset (see trayTitleAbs below). Ref-latched: the cluster's layout is
  // stable once laid out, so setState only fires on a real width change,
  // never per render.

  // Shell subscriptions are flush-stable by construction (see the summary-key
  // computeds in lib/chat): during a streaming turn this component must NOT
  // re-render per 33ms message flush — the hamburger tap, the edge swipe, and
  // new-chat all wait on this same JS thread. Numbers and strings bail on
  // Object.is; the session map itself is ref-read (below), not subscribed.
  const pendingN = useStore(pendingCount)
  const busyKey = useStore(busyStoredKey)
  const busy = useMemo(() => (busyKey ? busyKey.split(',') : []), [busyKey])
  const attention = useStore(attentionById)
  // BUG-085: chats with an unanswered question keep their amber row dot even
  // after being opened (opening clears the event-driven mark).
  const pendingStored = useStore(pendingStoredIds)
  const current = useStore(activeStoredId)
  const summaryKey = useStore(sessionsSummaryKey)
  // Ref-read map: the latest sessionsById lands here synchronously on every
  // set(), but only a summary-string CHANGE re-renders the shell. The `recent`
  // memo below still sees fresh data whenever a real re-render happens.
  const sessionsRef = useRef(sessionsById.get())
  React.useEffect(
    () => sessionsById.listen((m) => { sessionsRef.current = m }),
    [],
  )
  const all = sessionsRef.current
  const rows = useStore(sessionRows)
  // Revive-to-top overlay: subscribing (not just ref-reading) means a bump —
  // send, or a message.start/complete for a background chat — recomputes the
  // drawer's `recent` immediately.
  const lastActiveMap = useStore(lastActiveByStoredId)

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
      if ((dir.rtl ? g.vx < -FLICK : g.vx > FLICK) || dragProgress.current > 0.5) openDrawer()
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
      // The drawer docks LEFT in LTR and RIGHT in Arabic, so the open drag is
      // rightward only in LTR and leftward only in RTL (the Sidebar's own edge
      // strip and panel drags mirror with it, off this same progress value).
      onMoveShouldSetPanResponder: (_e, g) =>
        !openRef.current &&
        (dir.rtl ? g.dx < -EDGE_CLAIM : g.dx > EDGE_CLAIM) &&
        Math.abs(g.dx) > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => {
        // The drawer is opening: drop any composer IME now, not only on
        // release, so the panel never finger-tracks over a focused keyboard.
        Keyboard.dismiss()
        captureProgress(drawerAnim, dragProgress, moveSeen)
      },
      onPanResponderMove: (_e, g) => {
        const p = clamp01((dir.rtl ? -g.dx : g.dx) / panelWidthRef.current)
        dragProgress.current = p
        moveSeen.current = true
        drawerAnim.setValue(p)
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    })
  }, [drawerAnim, dir.rtl, openDrawer])

  // The drawer's chat list comes from the gateway, so it has to be fetched.
  React.useEffect(() => {
    if (!online) return
    void loadSessions()
    void refreshRunningAutomations()
    // Refresh whenever the connection comes back.
  }, [online])

  // BUG-055: the 60s list/automations poll moved to the ROOT layout — one
  // interval for the whole app instead of one per mounted tab shell (tabs
  // stay mounted after first visit, so this used to become ~7 pollers).

  React.useEffect(() => {
    void loadCatalog().catch(() => {})
  }, [])

  // Pin/archive marks are app-local; restore them once at startup.
  React.useEffect(() => {
    void loadChatMarks()
    // Revive-to-top: local last-activity bumps survive restart, so the
    // drawer can bubble recently-used old chats before the first fetch.
    void loadLastActive()
  }, [])

  // Locale switches must re-render the drawer's copy (nav labels are tr()).
  const locale = useStore(localeAtom)
  const runningAuto = useStore(runningAutomationCount)

  // ── UI-1: identity (Sessions | Bots) + project rail ──────────────────────
  const identity = useStore(identityAtom)
  const projects = useStore(projectsAtom)
  const activeProjectId = useStore(activeProjectIdAtom)
  // Bots mode's roster: `profiles.list` rows (the Fleet screen keeps this warm;
  // the drawer refreshes it on open).
  const profiles = useStore(fleetProfiles)
  // Membership map from projects.tree — session.list rows carry no cwd or
  // project id on the current gateway, so this is what makes the filter real.
  const projectSessionIds = useStore(projectSessionIdsAtom)
  // Restore the persisted identity once; refresh the project tree on mount and
  // whenever the connection comes back (offline keeps the last tree).
  React.useEffect(() => {
    void loadIdentity()
  }, [])
  React.useEffect(() => {
    if (online) void refreshProjects()
  }, [online])
  // Inbox badge (slice C's module). It exists now, so this is a plain
  // subscription; the badge is a count of `ask` items only.
  const inboxN = useStore(inboxCount)

  const handleIdentity = useCallback((i: Identity) => {
    void setIdentity(i)
    if (i === 'sessions') void refreshProjects()
  }, [])

  const handleProject = useCallback((id: string | null) => {
    void setActiveProject(id)
  }, [])

  // "New project" lives in the drawer's ProjectList (its own dialog); the
  // shell only needs to re-read the tree + sessions after one is created.
  const handleNewProject = useCallback(() => {
    void refreshProjects()
    void loadSessions()
  }, [])

  // ── Drawer nav (ChatGPT-style): top block + Settings docked at the bottom ─
  // The Chats screen stays reachable via the chat header's search icon; the
  // drawer's own grouped chat list is the richer surface. Fleet/Crew are
  // hidden from the drawer (bots are profiles now, not a separate board) —
  // their routes and screens stay put for deep links and legacy surfaces.
  const topNav = useMemo<NavItem[]>(() => {
    // `locale` is read so tr() copy refreshes on a language switch.
    void locale
    return [
      { key: 'chat', label: tr('sidebar.chats'), icon: 'chatbubble-outline' },
      // Slice C's row definition (workspace.inboxNavItem) — one owner.
      inboxNavItem(inboxN),
      { key: 'browser', label: tr('sidebar.browser'), icon: 'globe-outline' },
      { key: 'terminal', label: tr('sidebar.terminal'), icon: 'terminal-outline' },
      { key: 'automations', label: tr('sidebar.automations'), icon: 'timer-outline', mochis: runningAuto },
      { key: 'library', label: tr('sidebar.library'), icon: 'library-outline', activeFor: 'connectors' },
    ]
  }, [runningAuto, inboxN, locale])

  const bottomNav = useMemo<NavItem[]>(() => {
    void locale
    return [{ key: 'settings', label: tr('sidebar.settings'), icon: 'settings-outline' }]
  }, [locale])

  const recent = useMemo<RecentChat[]>(() => {
    // The server list is the source of truth: it covers every stored
    // conversation, and `started_at` is a real timestamp. Falling back to the
    // in-memory store (for a chat created before the first fetch landed) is
    // ordered by creation time, never by the per-session `lastSeq`.
    // BUG-085: unanswered questions keep the amber dot even after the chat
    // was opened (opening clears the event-driven mark; the question still
    // blocks) — derived from pendingBySession, the source of truth.
    void locale // tr() copy below re-reads on a language switch
    const statusOf = (id: string) => rowStatus(busy.includes(id), attention[id], pendingStored.includes(id))

    // Bots and Sessions are different things (Bot Mode, BOT-MODE.md): bots
    // are profiles with ONE canonical Bot Chat each, reached through the
    // Bots roster — never through this list. The shared store already drops
    // bot rows (lib/sessionList), and `isBotSessionRow` (lib/sessionRowMeta)
    // is applied again here so a row that reaches this memo by any other
    // path still cannot render. In Bots identity this list is not rendered
    // at all (the roster is), so server rows contribute nothing either way.

    // Project-scoped sessions (Concept #3): when a named project is chosen on
    // the rail, show ONLY sessions belonging to that project; when Personal
    // (`activeProjectId == null`) is chosen, show ONLY sessions not assigned
    // to any named project.
    const selected = activeProjectId == null ? null : projects.find((p) => p.id === activeProjectId) ?? null
    const ownerIndex = buildSessionOwnerIndex(projectSessionIds)

    const inProject = (r: { id?: string; project_id?: string; cwd?: string }) => {
      const owner = projectIdForSession(r, ownerIndex)
      if (!selected) return owner === null || owner === undefined
      return owner === selected.id
    }

    const fromServer = rows
      .filter((r) => identity !== 'bots' && !isBotSessionRow(r))
      .filter(inProject)
      .map((r) => {
      const title = r.title || r.preview?.slice(0, 60) || tr('sidebar.untitled')
      return {
      id: r.id,
      title,
      // Revive-to-top: started_at is creation time only, so a revived old
      // chat never bubbled. The local bump (bumpSessionActivity, in
      // sessionList) overlays the real last activity — max() of the two,
      // so groupChats buckets a revived chat into "Today" and sorts it
      // first. Server refreshes stay authoritative for content.
      ts: Math.max(toMs(r.started_at), lastActiveMap[r.id] ?? 0),
      status: statusOf(r.id),
      active: r.id === current,
      }
    })

    const seen = new Set(fromServer.map((c) => c.id))
    // In-memory entries are the OTHER half of the list — and the half the
    // bot leak actually came through. Server rows are filtered above, but a
    // Bot Chat OPENED this run lives in `sessionsById` (opening it is what
    // puts it there), carries no profile column, and its title is the
    // canonical "Bot Chat" — so unfiltered locals rendered one identical
    // "Bot Chat" row per bot the user had opened, right inside Sessions.
    // The markers that identify them, in order:
    //  1. lib/chat's server-only registry — every bot chat (and bot task
    //     session) is registered there with its owning profile the moment
    //     it opens (`trackServerOnlySession` in lib/botChat / chat).
    //  2. The canonical title itself, via the shared classifier — catches
    //     an entry whose registration was lost (e.g. a restored transcript).
    // Also deduped by stored id: two live handles for one stored chat
    // (resume + boot paint) must render ONE row, not twins.
    const localSeen = new Set<string>()
    const locals = Object.values(all)
      // `new:` pseudo ids are the optimistic new-chat window's stand-ins —
      // never drawer rows (their create may still fail).
      .filter((s) => s.storedId && !s.storedId.startsWith('new:') && !seen.has(s.storedId))
      .filter((s) => {
        if (localSeen.has(s.storedId)) return false
        localSeen.add(s.storedId)
        return true
      })
      .filter((s) => !isServerOnlySession(s.storedId) && !isBotSessionRow({ title: s.title }))
      .filter((s) => inProject({ id: s.storedId }))
      // In Bots identity the drawer renders the roster, not this list.
      .filter(() => identity !== 'bots')
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
      .map((s) => ({
        id: s.storedId,
        title: s.title || tr('sidebar.newChat'),
        ts: Math.max(s.createdAtMs ?? 0, lastActiveFor(s.storedId)),
        status: statusOf(s.storedId),
        active: s.storedId === current,
      }))

    // Uncapped: the sidebar's own search filters this list, and server rows
    // are bounded by the session.list fetch anyway.
    return [...locals, ...fromServer]
  }, [rows, all, busy, attention, current, pendingStored, lastActiveMap, identity, activeProjectId, projects, projectSessionIds, locale])

  // ── [12] per-project recent chats for the drawer's expandable rows ────────
  // Same `session.list` rows the `recent` memo renders, but NOT project-
  // filtered (the mini-lists must fill for every project, whatever is active)
  // and without the in-memory locals (they carry no project metadata yet —
  // they'd read as belonging to nothing, so they stay out instead of lying).
  // Same title/status/ts language as `recent`, so a mini-list row and its
  // full-list counterpart can never disagree. No new RPCs.
  const projectChats = useMemo<Record<string, RecentChat[]>>(() => {
    void locale
    const statusOf = (id: string) => rowStatus(busy.includes(id), attention[id], pendingStored.includes(id))
    const ownerIndex = buildSessionOwnerIndex(projectSessionIds)
    const out: Record<string, RecentChat[]> = {}
    for (const r of rows) {
      // Bots are not project sessions (same shared classifier as `recent`):
      // bot-profile rows and canonical Bot Chats never appear here.
      if (isBotSessionRow(r)) continue
      const pid = projectIdForSession(r, ownerIndex)
      if (!pid) continue // null = Home bucket, undefined = unclassified
      const title = r.title || r.preview?.slice(0, 60) || tr('sidebar.untitled')
      const chat: RecentChat = {
        id: r.id,
        title,
        ts: Math.max(toMs(r.started_at), lastActiveMap[r.id] ?? 0),
        status: statusOf(r.id),
        active: r.id === current,
      }
      const arr = out[pid]
      if (arr) arr.push(chat)
      else out[pid] = [chat]
    }
    for (const pid of Object.keys(out)) out[pid].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    return out
  }, [rows, busy, attention, current, pendingStored, lastActiveMap, projectSessionIds, locale])

  // [12] "More" under a project's mini-list: activate the project and open the
  // Chats screen, which filters its rows on the active project.
  const openProjectChats = useCallback(
    (id: string) => {
      void setActiveProject(id)
      router.navigate('/(tabs)/sessions')
    },
    [router],
  )

  const go = useCallback(
    (key: string) => {
      // Skills and Models now live inside Settings (AGENT section); the Chats
      // screen is reachable from the chat header's search icon.
      const route =
        key === 'chat'
          ? '/(tabs)/chat'
          : key === 'inbox'
            ? '/(tabs)/inbox'
            : key === 'library'
              ? '/(tabs)/connectors'
              : key === 'browser'
                ? '/(tabs)/browser'
                : key === 'terminal'
                  ? '/(tabs)/terminal'
                  : key === 'automations'
                    ? '/(tabs)/automations'
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

  // ── Bots mode: open a bot's canonical Bot Chat ───────────────────────────
  // `openBotChat` owns the whole identity story (exact-title lookup, create-
  // if-absent, single-flight, adopt-on-race, profile-scoped resume) and
  // switches the screen itself via the shared resume. The extra navigate is
  // the belt-and-braces the other hand-offs use, so the tab is already up
  // while the RPC runs.
  //
  // EVERY bot row is a bot — `Moch` (the launch profile) included: it owns its
  // own canonical Bot Chat exactly like a named bot. Ordinary chat history
  // lives on the Sessions surface, not here.
  const openBot = useCallback(
    (profile: string) => {
      router.navigate('/(tabs)/chat')
      void openBotChat(profile).catch((e) => {
        // Same failure language as app/bot.tsx's hand-off.
        showAlert(tr('bot.chat.failed', { why: e instanceof Error ? e.message : String(e) }))
      })
    },
    [router],
  )

  const newBot = useCallback(() => {
    router.navigate('/(tabs)/fleet' as never)
  }, [router])

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
      // BUG-006: session.title is a LIVE-session method — the row's stored
      // id 4001s ("session not found") and the title never lands anywhere.
      // Resolve the live handle first (minting one via a quiet resume when
      // the chat isn't tracked), then patch BOTH surfaces: the list row and
      // the in-memory entry the open chat's header reads.
      // `session.title` with an explicit title writes user-provenance; the
      // auto-titler never overwrites those, so a manual rename sticks.
      let live = liveIdOf(storedId)
      if (!live) live = (await resumeShared(storedId)).sessionId
      await rpc('session.title', { session_id: live, title })
      patchRowTitle([storedId], title)
      patchSession(live, { title })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : tr('common.renameFailed')
    }
  }, [liveIdOf])

  const handleDelete = useCallback(async (storedId: string) => {
    try {
      // BUG-030: the UI detaches only AFTER a successful delete — the old
      // order (newChat() first) stranded the user in a fresh empty chat when
      // the delete failed, with the old row still listed. The gateway's
      // liveness is handled by closing the live handle below; the delete is
      // what must gate the screen swap.
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
      const wasActive = activeStoredId.get() === storedId
      if (live) await forgetSession(live)
      if (wasActive) await newChat()
      // Drop the row so the drawer updates without waiting for a poll.
      sessionRows.set(sessionRows.get().filter((r) => r.id !== storedId))
      forgetChatMarks(storedId)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : tr('common.deleteFailed')
    }
  }, [liveIdOf])
  const connColor = online ? C.greenSoft : connecting ? C.amber : C.amber
  const connLabel = online ? tr('shell.connected') : connecting ? tr('shell.connecting') : tr('shell.offline')

  return (
    <View style={s.root} {...openPan.panHandlers}>
      <View style={[s.headerWrap, { paddingTop: insets.top + 4 }]}>
        <View style={[s.header, { flexDirection: dir.row }, S.trayHeader ? s.headerTray : s.headerBar]}>
          <HeaderButton onPress={openDrawer} accessibilityLabel={tr('shell.menu')}>
            <Icon name="menu" size={20} color={C.text} />
          </HeaderButton>

          <View style={s.titleBlock}>
            <View style={[s.titleRow, { flexDirection: dir.row }]}>
              <Pressable
                onPress={online ? undefined : () => { void retryNow().catch(() => {}) }}
                hitSlop={8}
                accessibilityRole={online ? undefined : 'button'}
                accessibilityLabel={connLabel}
                style={s.connDotHit}
              >
                <View style={[s.connDot, { backgroundColor: connColor, shadowColor: connColor }]} />
              </Pressable>
              <Text style={s.title} numberOfLines={1}>
                {title}
              </Text>
            </View>
            {showBrand ? <Text style={s.brand}>MOCH</Text> : null}
          </View>

          <View style={[s.rightCluster, { flexDirection: dir.row }]}>
            {onSearch ? (
              <HeaderButton onPress={onSearch} accessibilityLabel={tr('shell.allChats')}>
                <Icon name="search" size={18} color={C.text} />
              </HeaderButton>
            ) : null}
            {right}
          </View>
        </View>
      </View>

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
          // BUG-131 (client half): same for the gateway-running overlay — a
          // turn started on another device marks its row the moment the
          // drawer opens, not at the next 60s tick.
          void refreshRunningSessions()
          // UI-1: project counts/labels are server state too (created on the
          // desktop, archived elsewhere) — re-read them with the list.
          void refreshProjects()
          // Bots mode's roster: a bot created on another device, or a
          // canonical `Bot Chat` that just appeared, must be there on open.
          void refreshFleet()
        }}
        onClose={closeDrawer}
        onRequestOpen={openDrawer}
        nav={topNav}
        bottomNav={bottomNav}
        identity={identity}
        onIdentity={handleIdentity}
        projects={projects}
        activeProjectId={activeProjectId}
        onProject={handleProject}
        onNewProject={handleNewProject}
        projectChats={projectChats}
        onProjectChatsMore={openProjectChats}
        profiles={profiles}
        onOpenBot={openBot}
        onNewBot={newBot}
        recent={recent}
        onNav={go}
        onNewChat={startNew}
        onOpenChat={openChat}
        onPinToggle={handlePinToggle}
        onArchiveToggle={handleArchiveToggle}
        onRename={handleRename}
        onDelete={handleDelete}
        footer={
          pendingN > 0 ? (
            <View style={[s.footerNote, { flexDirection: dir.row }]}>
              <Icon name="alert-circle" size={14} color={C.amber} />
              <Text style={s.footerText}>
                {pendingN > 1
                  ? tr('sidebar.pending.many', { n: pendingN })
                  : tr('sidebar.pending.one')}
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
  headerWrap: { paddingHorizontal: 12, paddingBottom: 6, zIndex: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 44,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  // Mocheme: floating rounded tray (mockup §7 .shell-header under mocheme).
  headerTray: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  // Relay: plain bar with a hairline under it.
  headerBar: {
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    borderRadius: 0,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  titleBlock: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  connDotHit: { padding: 3 },
  connDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    shadowColor: C.greenSoft,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { color: C.text, fontSize: 14.5, fontWeight: '700', flexShrink: 1 },
  brand: {
    color: C.textFaint,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.76,
    textTransform: 'uppercase',
    marginTop: 1,
  },
  rightCluster: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  body: { flex: 1 },
  footerNote: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  footerText: { color: C.amber, fontSize: 11.5, fontWeight: '700', flex: 1 },
})
