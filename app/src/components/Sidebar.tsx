import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Pressable,
  StyleSheet,
  Animated,
  BackHandler,
  Easing,
  Image,
  PanResponder,
  Platform,
  ScrollView,
  SectionList,
  TextInput,
  useWindowDimensions,
} from 'react-native'
import type { GestureResponderEvent, PanResponderGestureState, TextStyle, ViewStyle } from 'react-native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { MochiMark } from './MochiMark'
import { Field, HeaderButton, Kicker, Txt } from './ui'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import RAnimated, { useAnimatedStyle } from 'react-native-reanimated'
import { usePathname } from 'expo-router'
import { useStore } from '@nanostores/react'
import { isConnected as isConnectedAtom } from '../lib/gateway'
import { archivedIds, groupChats, pinnedIds } from '../lib/chatListState'
import type { RowStatus } from '../lib/attention'
import { thinkerAtom } from '../lib/thinker'
import { ocListSessions, describeOcError, type OcSession } from '../lib/opencodeClient'
import { ocSessionsCached, ocSessionsStore } from '../lib/ocSessionsCache'
import { openOcChat } from '../lib/chat'
import { projectIdForCwd } from '../lib/projectScope'
import { C, useStyles } from '../lib/theme'
import { useReduceMotion } from './useReduceMotion'
import { IdentitySwitch } from './IdentitySwitch'
import { ProjectList } from './ProjectList'
import { BotsRoster } from './BotsRoster'
import { tr, localeAtom, useDir } from '../lib/strings'
import type { Identity, ProjectRow } from '../lib/workspace'
import type { FleetProfile } from '../lib/fleet'

// ── OpenCode sessions drawer list (OPENCODE-MODE contract) ──────────────────
// In OpenCode mode the drawer's chat list is the OpenCode server's session
// list, not hermes session.rows. Fetched when the drawer opens; the 15s
// cache lives in src/lib/ocSessionsCache.ts so the chat transport can
// invalidate it the moment a turn creates/renames a session.

function formatOcTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Compact relative age ("2m", "3h", …) with the unit localized. The pure
 * helper in `lib/chatListState` only groups by day, so drawer rows format
 * their own timestamp with chrome.age.* keys (SPEC §3: localize relative
 * times at the render site rather than hardcoding English units).
 */
export function ageLabel(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ''
  const delta = Date.now() - ms
  if (delta < 60_000) return tr('chrome.age.lessMinute')
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return tr('chrome.age.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return tr('chrome.age.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return tr('chrome.age.days', { n: days })
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return tr('chrome.age.weeks', { n: weeks })
  return tr('chrome.age.months', { n: Math.floor(days / 30) })
}

/** Drawer rows that are hermes-only surfaces — dropped in OpenCode mode. */
const OC_HIDDEN_NAV_KEYS = new Set(['inbox', 'automations', 'library'])

/** Section labels come from `groupChats` in English; translate by group key. */
const SECTION_LABEL_KEYS: Record<string, string> = {
  pinned: 'chrome.drawer.chatsPinned',
  today: 'common.today',
  yesterday: 'common.yesterday',
  week: 'chrome.drawer.chatsWeek',
  older: 'chrome.drawer.chatsOlder',
  archived: 'chrome.drawer.chatsArchived',
}

export interface NavItem {
  key: string
  label: string
  icon: keyof typeof Ionicons.glyphMap
  badge?: number
  /** Active automations: renders up to 3 mini Mochis, +N past that. */
  mochis?: number
  /**
   * Route slug this row belongs to when it differs from `key` — e.g. the
   * Library row opens /(tabs)/connectors for now, and the drawer highlights
   * by route suffix.
   */
  activeFor?: string
}

export interface RecentChat {
  id: string
  title: string
  /** Wall-clock ms of the chat's latest activity — drives the section grouping. */
  ts?: number
  /**
   * Live status of the conversation: `input` (yellow — the agent asked
   * something), `done` (green — a reply landed while unwatched), `error`
   * (red), or `busy` (cyan pulse — a turn is streaming). Undefined = idle.
   */
  status?: RowStatus
  active?: boolean
}

/** Actions return an error message to show in the dialog, or null on success. */
type ChatAction = (id: string) => Promise<string | null>

interface Props {
  open: boolean
  onClose: () => void
  onOpen?: () => void
  /**
   * The shared 0→1 drawer progress, owned by ScreenShell so its
   * swipe-anywhere open gesture and this component's own edge/panel gestures
   * all drive one value.
   */
  progress: Animated.Value
  /**
   * True once the owner has seen any touch: mounts the panel subtree BEFORE
   * the first drag claims it, so the mount cost never freezes a moving drawer
   * (a mid-drag mount reads as the panel "cutting out" then catching up).
   */
  primed?: boolean
  /**
   * Ask the owner of `open` to open the drawer — fired by the edge-swipe
   * gesture. The gesture animates only the cancel cases; every release that
   * changes state routes through here so the open/close layout effect owns
   * the final animation leg, the query reset and the dialog drop.
   */
  onRequestOpen?: () => void
  nav: NavItem[]
  /**
   * Bottom-docked nav (ChatGPT-style): rendered after the chat list, pinned
   * above the New-chat pill at the panel's bottom edge.
   */
  bottomNav?: NavItem[]
  /** Sessions | Bots switch, rendered directly under the brand row. */
  identity: Identity
  onIdentity: (i: Identity) => void
  /** Projects for the drawer's project list (Sessions mode only). */
  projects: ProjectRow[]
  activeProjectId: string | null
  /** Select a project; `null` = the default (Personal) bucket. */
  onProject: (id: string | null) => void
  onNewProject: () => void
  onProjectMenu?: (p: ProjectRow) => void
  /**
   * Per-project recent chats (session id → its most recent rows), supplied by
   * ScreenShell from the same `session.list` rows the drawer list already
   * renders. Drives the expandable project rows: tapping a project also opens
   * an inline mini-list of up to five of its conversations. No project key =
   * no conversations yet (the row stays a plain row, no dead expansion).
   */
  projectChats?: Record<string, RecentChat[]>
  /**
   * "More" under a project's mini-list: the owner activates the project and
   * navigates to the Chats screen (which filters on the active project).
   */
  onProjectChatsMore?: (id: string) => void
  /** Bots mode roster source (`profiles.list` via `fleetProfiles`). */
  profiles?: readonly FleetProfile[]
  /**
   * Open a bot's canonical Bot Chat. Every row is a bot, `Moch` (the launch
   * profile) included — its Bot Chat is its ONE persistent conversation.
   */
  onOpenBot?: (profile: string) => void
  /** Open the bot create flow (the Fleet screen). */
  onNewBot?: () => void
  recent: RecentChat[]
  onNav: (key: string) => void
  onNewChat: () => void
  onOpenChat: (id: string) => void
  onPinToggle?: (id: string) => void
  onArchiveToggle?: (id: string) => void
  onRename?: (id: string, title: string) => Promise<string | null>
  onDelete?: ChatAction
  footer?: React.ReactNode
}

interface Section {
  key: string
  label: string
  data: RecentChat[]
  collapsible?: boolean
  /** Real item count — a collapsed section reports data=[] but still shows its header. */
  count?: number
}

/**
 * Mount/unmount with a pop animation instead of solid appearing/disappearing.
 * visible=true mounts and eases to 1; visible=false eases back to 0 and only
 * then unmounts, so the exit transition actually plays. Overlays rendered with
 * this must keep their last data around while fading out (see the refs next
 * to each call site).
 */
function usePopFade(visible: boolean, inMs = 150, outMs = 130) {
  const anim = useRef(new Animated.Value(0)).current
  const [rendered, setRendered] = useState(visible)
  useEffect(() => {
    if (visible) {
      setRendered(true)
      const a = Animated.timing(anim, {
        toValue: 1,
        duration: inMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      })
      a.start()
      return () => a.stop()
    }
    const a = Animated.timing(anim, {
      toValue: 0,
      duration: outMs,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    })
    a.start(({ finished }) => {
      if (finished) setRendered(false)
    })
    return () => a.stop()
  }, [visible, anim, inMs, outMs])
  return { anim, rendered }
}

// ── Drawer swipe tuning (A2-21) ──────────────────────────────────────────────
// Shared with ScreenShell, whose swipe-anywhere open gesture drives the same
// progress value and reuses the same claim/threshold language.
// EDGE_W: width of the edge catch strip while closed (left edge in LTR, right
// edge in RTL). Kept at 28 with no hitSlop — taps starting inside the strip
// are swallowed (RN has no touch re-dispatch), so the strip stays narrow AND
// starts below the top bar (EDGE_TOP_GAP) so it never covers the hamburger.
const EDGE_W = 28
// The top bar's bottom edge sits at insets.top + 52 (paddingTop 6 + 38dp
// circle + paddingBottom 8); 56 leaves a little slack under it.
const EDGE_TOP_GAP = 56
// px of horizontal travel before a drag claims the pan.
export const EDGE_CLAIM = 10
// |dx| must beat |dy| by this factor, so vertical list scrolls and taps win.
export const DOMINANCE = 1.5
// px/ms — the unit of gestureState.vx (dt is in ms timestamps).
export const FLICK = 0.25
export const OPEN_MS = 190
export const CLOSE_MS = 150
// Release below threshold while still closed → spring back.
export const CANCEL_MS = 150
// Release above threshold while still open → snap back open.
const SNAP_MS = 180

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The mockup's drawer is 292dp wide (`design.html .drawer-panel`), capped so
 * it never looks empty on a tablet.
 */
export const drawerPanelWidth = (windowWidth: number) => Math.min(windowWidth * 0.84, 292)

/** SectionList keyExtractor hoisted to module scope for identity stability. */
const chatKey = (c: RecentChat) => c.id

/** The real Mochi design (mochi-svgs/mochi.svg) rasterized static, one per
    running-automation slot, in the app's three signal colors. */
const MOCHI_RUN = [
  require('../../assets/mochi-run-1.png'),
  require('../../assets/mochi-run-2.png'),
  require('../../assets/mochi-run-3.png'),
]

/**
 * Shared grant step for both pan responders: freeze any running settle and
 * snapshot the live gesture progress. For native-driven values the
 * stopAnimation callback resolves asynchronously (NativeAnimatedAPI.getValue),
 * so `moveSeenRef` guards against a late callback clobbering progress the
 * finger has already moved past.
 */
export function captureProgress(
  anim: Animated.Value,
  progressRef: { current: number },
  moveSeenRef: { current: boolean },
) {
  moveSeenRef.current = false
  anim.stopAnimation((v) => {
    if (!moveSeenRef.current) progressRef.current = v
  })
}

/**
 * Native-driven settle for the gesture CANCEL cases only (spring back closed
 * while still closed; snap back open while still open). Releases that change
 * drawer state go through onRequestOpen()/onClose() so the open/close layout
 * effect owns the final leg (prop-flip contract).
 */
export function settleTo(anim: Animated.Value, toValue: 0 | 1, duration: number) {
  Animated.timing(anim, { toValue, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
}

/**
 * ChatGPT-style slide-in sidebar, restyled to the redesign mockup
 * (`design.html` renderSidebarDrawer):
 *
 *   panel (292dp, bgCard, hairline side border, 12dp gutters)
 *   ├─ MochiMark + "Moch" + search affordance + close
 *   ├─ Sessions | Bots Segmented (identity state stays in lib/workspace)
 *   ├─ Sessions body: Workspace 2-col nav grid → Projects (expandable, with
 *   │  per-project recent chats) → Recent Chats
 *   │  (OpenCode mode swaps the chat list for the server's sessions)
 *   ├─ Bots body: BotsRoster cards + dashed "+ New bot"
 *   ├─ amber pending-questions card (owner-provided footer)
 *   └─ bottom-docked nav (Settings)
 *
 * Implemented as an overlay rather than a Drawer navigator: the app already
 * routes through expo-router tabs, and an overlay keeps that intact while
 * giving the same "drawer slides over the conversation" behaviour. In Arabic
 * (RTL) the panel docks to the RIGHT edge and both the open/close animation
 * and its drag gestures mirror — the shared 0→1 progress value is unchanged.
 *
 * All sessions live here. The list is grouped into sections (Pinned / Today /
 * Yesterday / Previous 7 days / Older / Archived) and every row exposes its
 * actions through long-press or the trailing ⋯ button: pin, rename, archive,
 * delete. Like ChatGPT, the menu is a small popover anchored AT the row you
 * pressed — not a bottom sheet — with icon rows and no Cancel (tapping
 * outside closes it), and every overlay fades/scales in and out instead of
 * popping solid. Dialogs are in-app overlays rather than Alert.alert because
 * react-native-web's Alert is a silent no-op.
 */
export function Sidebar({
  open,
  onClose,
  onOpen,
  progress,
  primed,
  onRequestOpen,
  nav,
  bottomNav,
  identity,
  onIdentity,
  projects,
  activeProjectId,
  onProject,
  onNewProject,
  onProjectMenu,
  projectChats,
  onProjectChatsMore,
  profiles,
  onOpenBot,
  onNewBot,
  recent,
  onNav,
  onNewChat,
  onOpenChat,
  onPinToggle,
  onArchiveToggle,
  onRename,
  onDelete,
  footer,
}: Props) {
  const s = useStyles(makeS)
  const dir = useDir()
  // Locale switches must re-render the drawer's own copy (project labels,
  // search placeholder, section headers) — tr() reads the atom, not state.
  const locale = useStore(localeAtom)
  void locale
  const pathname = usePathname()
  // A row can own a route whose slug differs from its key (Library currently
  // opens the connectors screen); highlight by that slug when present.
  const activeKey = nav.find((n) => pathname?.endsWith(n.activeFor ?? n.key))?.key

  // ── OpenCode mode ── read from the atom directly: this component is mounted
  // by ScreenShell (not thinker-aware), so threading an ocMode prop through
  // would touch a file outside this slice. Same theme, different data.
  const thinker = useStore(thinkerAtom)
  const ocMode = thinker === 'opencode'
  // Boot vs failure: right after launch the gateway (and therefore the oc
  // server) is still starting. That is not an error — the list shows a
  // skeleton until the first successful connect, then fetches.
  const online = useStore(isConnectedAtom)
  // Hermes-only nav rows drop; Chats, Terminal (and the docked Settings) stay.
  const shownNav = useMemo(
    () => (ocMode ? nav.filter((n) => !OC_HIDDEN_NAV_KEYS.has(n.key)) : nav),
    [nav, ocMode],
  )
  const shownBottomNav = useMemo(
    () => (ocMode ? (bottomNav ?? []).filter((n) => !OC_HIDDEN_NAV_KEYS.has(n.key)) : bottomNav),
    [bottomNav, ocMode],
  )
  // The OpenCode server's session list — the drawer's chat list in oc mode.
  const [ocSessions, setOcSessions] = useState<OcSession[]>([])
  const [ocLoading, setOcLoading] = useState(false)
  const [ocError, setOcError] = useState('')
  useEffect(() => {
    if (!ocMode || !open) return
    const cached = ocSessionsCached()
    if (cached) {
      setOcSessions(cached)
      setOcError('')
      return
    }
    // Booting: the gateway hasn't connected yet this run, so the oc server
    // cannot answer — show the skeleton, not a scary error. The effect
    // re-runs when `online` flips true and fetches then.
    if (!online) {
      setOcLoading(true)
      setOcError('')
      return
    }
    let alive = true
    setOcLoading(true)
    setOcError('')
    ocListSessions()
      .then((rows) => {
        if (!alive) return
        // Newest activity first (ordering is the caller's job per the wire
        // contract), capped at 30 rows.
        const sorted = [...(rows ?? [])]
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
          .slice(0, 30)
        ocSessionsStore(sorted)
        setOcSessions(sorted)
        setOcLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setOcLoading(false)
        // describeOcError keeps OPENCODE-MODE's "every catch renders the
        // classifier" promise — a 403/500 must not read as a generic miss.
        setOcError(describeOcError(e) || tr('chrome.drawer.ocError'))
      })
    return () => { alive = false }
  }, [open, ocMode, online])
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const anim = progress
  // Mount-on-first-open (A2-16, as revised for the web tab-order review): the
  // panel/dialog subtree renders on the first open and stays mounted forever
  // after — only the edge strip exists before that. Zero mount cost on every
  // subsequent open, and no invisible control is tabbable pre-first-use.
  const [everOpened, setEverOpened] = useState(false)
  // Fallback everOpened flip: if a drag ever moves progress before the
  // owner's touch-down priming lands, the panel still mounts — a
  // finger-tracking drag must be VISIBLE.
  useEffect(() => {
    const id = anim.addListener(({ value }) => {
      if (value > 0.01) setEverOpened(true)
    })
    return () => anim.removeListener(id)
  }, [anim])
  // Web only: after the close animation finishes, the panel subtree gets
  // display:'none' — RNW keeps role=button elements tabbable regardless of
  // pointerEvents/aria-hidden, and display:none is the only thing browsers
  // reliably drop from the tab order (it also blurs anything focused inside).
  const [dormant, setDormant] = useState(false)
  // The mockup's panel width — shared with the owner's swipe gesture via the
  // exported helper so both map finger pixels to the same 0→1 progress.
  const panelWidth = drawerPanelWidth(width)
  const [query, setQuery] = useState('')
  // The mockup has no always-on search field: a compact affordance in the
  // drawer header expands the real search input (same query state/behaviour;
  // top-anchored-search avoidance below keeps results above the keyboard).
  const [searchOpen, setSearchOpen] = useState(false)
  // The drawer's search filters OpenCode sessions by title too (declared here
  // because it reads `query`).
  const ocFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ocSessions
    return ocSessions.filter((c) => (c.title ?? '').toLowerCase().includes(q))
  }, [ocSessions, query])
  // BUG-149: bucket the oc rows under their project via each row's
  // `directory` (mints carry the selected project's cwd). Same labeled-group
  // shape as the hermes list's section headers; rows without a directory
  // (pre-BUG-149 sessions) or whose folder matches no project stay in the
  // flat tail, ungrouped. The list is still NOT project-filtered — selecting
  // a project changes where NEW sessions are created, not what is listed.
  const ocGroups = useMemo(() => {
    const projRows = projects.map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject }))
    const byProject = new Map<string, OcSession[]>()
    const flat: OcSession[] = []
    for (const c of ocFiltered) {
      const pid = projectIdForCwd(projRows, c.directory)
      if (!pid) {
        flat.push(c)
        continue
      }
      const arr = byProject.get(pid)
      if (arr) arr.push(c)
      else byProject.set(pid, [c])
    }
    const groups = projects
      .filter((p) => !p.isNoProject && byProject.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, rows: byProject.get(p.id) ?? [] }))
    return { groups, flat }
  }, [ocFiltered, projects])
  const [archOpen, setArchOpen] = useState(false)

  // Number of named bots, for the mockup's "Bots (n)" segment label.
  const botsN = useMemo(
    () => (profiles ?? []).filter((p) => p.name !== 'default').length,
    [profiles],
  )

  // Per-chat action state. The three overlays are mutually exclusive.
  const [menuFor, setMenuFor] = useState<RecentChat | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<RecentChat | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirming, setConfirming] = useState<RecentChat | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Each overlay fades out before unmounting; the refs keep its data (chat +
  // anchor) available so the exit animation still has something to render.
  const menuOpen = menuFor != null
  const { anim: menuAnim, rendered: menuRendered } = usePopFade(menuOpen)
  const menuRef = useRef<{ chat: RecentChat; anchor: { x: number; y: number } } | null>(null)
  useEffect(() => {
    if (menuFor && menuAnchor) menuRef.current = { chat: menuFor, anchor: menuAnchor }
  }, [menuFor, menuAnchor])
  const shownMenu = menuRendered ? menuRef.current : null

  const renameOpen = renaming != null
  const { anim: renameAnim, rendered: renameRendered } = usePopFade(renameOpen)
  // BUG-133: the rename dialog's autoFocus input opened the keyboard straight
  // over the centered card (input, error and Cancel/Save under the IME). The
  // wrapper pads by the live IME height (chat-pad pattern), so the card stays
  // centered in the area ABOVE the keys — input and buttons always visible.
  const kb = useReanimatedKeyboardAnimation()
  const renameKbPad = useAnimatedStyle(() => ({
    paddingBottom: Math.max(24 + kb.height.value, 24),
  }))
  const drawerListKbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  const renameRef = useRef<RecentChat | null>(null)
  useEffect(() => {
    if (renaming) renameRef.current = renaming
  }, [renaming])
  const shownRename = renameRendered ? renameRef.current : null

  const confirmOpen = confirming != null
  const { anim: confirmAnim, rendered: confirmRendered } = usePopFade(confirmOpen)
  const confirmRef = useRef<RecentChat | null>(null)
  useEffect(() => {
    if (confirming) confirmRef.current = confirming
  }, [confirming])
  const shownConfirm = confirmRendered ? confirmRef.current : null

  const pinned = useStore(pinnedIds)
  const archived = useStore(archivedIds)

  // Render-synced refs: gesture and settle callbacks read live values through
  // these, so their identities never change and the effect below never re-fires
  // on parent re-renders (A2-19). Worst case of a briefly stale ref is clamped
  // visual misposition for one gesture.
  const openRef = useRef(open)
  openRef.current = open
  const panelWidthRef = useRef(panelWidth)
  panelWidthRef.current = panelWidth
  const widthRef = useRef(width)
  widthRef.current = width
  const dialogActiveRef = useRef(false)
  dialogActiveRef.current = !!(menuFor || renaming || confirming)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onRequestOpenRef = useRef(onRequestOpen)
  onRequestOpenRef.current = onRequestOpen
  const onOpenChatRef = useRef(onOpenChat)
  onOpenChatRef.current = onOpenChat
  const searchInputRef = useRef<TextInput>(null)
  const searchFocusRef = useRef(false)
  const progressRef = useRef(0)
  const moveSeenRef = useRef(false)
  const firstRun = useRef(true)

  // Focus the expanded search field on demand (the tap that opened it is the
  // user gesture; the top-anchored-search kbPad below keeps results above the
  // IME — app/AGENTS.md pattern #4).
  useEffect(() => {
    if (!searchOpen) return
    const id = setTimeout(() => searchInputRef.current?.focus(), 60)
    return () => clearTimeout(id)
  }, [searchOpen])

  // ── Navigation tiles (mockup "Workspace" 2-column grid) ──────────────────
  // Same items/routes/labels and badges as before; the mockup renders them as
  // compact elevated tiles instead of icon rows. Running automations keep
  // their mini-Mochi indicator, inbox keeps its amber count pill.
  const renderNavTile = (item: NavItem) => {
    const on = item.key === activeKey
    return (
      <Pressable
        key={item.key}
        style={({ pressed }) => [
          s.navTile,
          { flexDirection: dir.row },
          on && s.navTileOn,
          pressed && s.rowPressed,
        ]}
        onPress={() => {
          onNav(item.key)
          onClose()
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={item.label}
      >
        <Txt
          size={11.5}
          weight="600"
          color={C.text}
          numberOfLines={1}
          style={s.navTileLabel}
        >
          {item.label}
        </Txt>
        {item.mochis ? (
          <View
            style={[s.mochiRunRow, { flexDirection: dir.row }]}
            accessibilityLabel={
              item.mochis === 1
                ? tr('sidebar.running.one')
                : tr('sidebar.running.many', { n: item.mochis })
            }
          >
            {Array.from({ length: Math.min(item.mochis, 3) }).map((_, i) => (
              <Image
                key={i}
                source={MOCHI_RUN[i]}
                style={[s.mochiMini, i > 0 && (dir.rtl ? s.mochiMiniOverlapRtl : s.mochiMiniOverlap)]}
              />
            ))}
            {item.mochis > 3 ? (
              <Txt size={9.5} weight="700" color={C.textFaint} style={s.mochiMore}>
                +{item.mochis - 3}
              </Txt>
            ) : null}
          </View>
        ) : null}
        {item.badge ? (
          <View style={[s.navBadge, item.key === 'inbox' ? s.navBadgeAmber : s.navBadgeTint]}>
            <Txt size={10} weight="700" color={item.key === 'inbox' ? C.amber : C.textDim}>
              {item.badge > 9 ? '9+' : item.badge}
            </Txt>
          </View>
        ) : null}
      </Pressable>
    )
  }

  const renderNavGrid = (items: NavItem[], columns = 2) => {
    if (!items.length) return null
    const rows: NavItem[][] = []
    for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns))
    return (
      <View style={s.navGrid}>
        {rows.map((row, ri) => (
          <View key={ri} style={[s.navGridRow, { flexDirection: dir.row }]}>
            {row.map((item) => renderNavTile(item))}
            {row.length < columns
              ? Array.from({ length: columns - row.length }).map((_, i) => (
                  <View key={`spacer-${i}`} style={s.navTileSpacer} />
                ))
              : null}
          </View>
        ))}
      </View>
    )
  }

  // Feedback round 2 [2]: the docked Settings control is an icon-ONLY small
  // card (≈44×44, radius 12, bgElev + hairline) centered at the panel bottom —
  // the label lives on the accessibilityLabel, not in the pixels. Any future
  // second bottom item keeps the old labeled grid.
  const renderBottomTile = (item: NavItem) => {
    const on = item.key === activeKey
    return (
      <Pressable
        key={item.key}
        style={({ pressed }) => [s.bottomTile, on && s.bottomTileOn, pressed && s.rowPressed]}
        onPress={() => {
          onNav(item.key)
          onClose()
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={item.label}
      >
        <Icon name={item.icon} size={20} color={on ? C.accent : C.textDim} />
      </Pressable>
    )
  }

  // Open/close slide. A layout effect on the `open` prop flip, so no extra
  // render sits between the tap/gesture-release and the first animated frame;
  // the tree is already mounted (from the first open on). First run is a no-op:
  // ScreenShell mounts with open=false and anim already parks at 0 — this also
  // removes the old accidental mount-time loadSessions.
  useLayoutEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    if (open) {
      setDormant(false)
      setQuery('')
      setSearchOpen(false)
      // Fixed-duration leg, identical to the hamburger-open animation,
      // starting wherever the drag released: one consistent glide the user
      // already knows. (Scaling the duration by remaining distance made the
      // release speed depend on the release point — a fast whip from mid-drag
      // that reads as a jump, not a continuation.)
      Animated.timing(anim, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
      // A2-20: refresh when the drawer OPENS (ScreenShell's "always re-read
      // on open" intent). This used to fire in the close branch, where a
      // 200-row sessionRows.set landed mid chat-switch.
      onOpenRef.current?.()
      return
    }
    // Leaving also drops any open dialog so nothing survives into the next open.
    setMenuFor(null)
    setMenuAnchor(null)
    setRenaming(null)
    setConfirming(null)
    setDialogError(null)
    setSearchOpen(false)
    searchInputRef.current?.blur()
    const a = Animated.timing(anim, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })
    a.start(({ finished }) => {
      if (finished && Platform.OS === 'web') setDormant(true)
    })
  }, [open, anim])

  // Android hardware back closes the drawer instead of navigating away
  // (BackHandler is a console-error stub on web, hence the platform gate).
  useEffect(() => {
    if (Platform.OS !== 'android' || !open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current?.()
      return true
    })
    return () => sub.remove()
  }, [open])

  const toggleSearch = () => {
    if (searchOpen) {
      searchInputRef.current?.blur()
      setQuery('')
      setSearchOpen(false)
    } else {
      setSearchOpen(true)
    }
  }

  // One oc row — shared by the project groups and the flat tail so both
  // render the exact same row language (BUG-149 grouping).
  const renderOcRow = (c: OcSession) => (
    <Pressable
      key={c.id}
      style={({ pressed }) => [s.recentRow, { flexDirection: dir.row }, pressed && s.recentRowPressed]}
      onPress={() => {
        onClose()
        void openOcChat(c.id).catch(() => {})
      }}
      accessibilityRole="button"
      accessibilityLabel={tr('chrome.drawer.openOc', { title: c.title || tr('sidebar.untitled') })}
    >
      <Txt size={12} weight="600" color={C.textDim} numberOfLines={1} style={s.recentTitle}>
        {c.title || tr('sidebar.untitled')}
      </Txt>
      {c.time?.updated ? (
        <Txt size={10} color={C.textFaint} mono numberOfLines={1}>{formatOcTime(c.time.updated)}</Txt>
      ) : null}
    </Pressable>
  )

  const searching = query.trim().length > 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Search spans everything, including the archive.
    if (!q) return recent
    return recent.filter((c) => c.title.toLowerCase().includes(q))
  }, [recent, query])

  const sections = useMemo<Section[]>(() => {
    if (searching) return [{ key: 'results', label: '', data: filtered }]
    const groups = groupChats(recent, pinned, archived)
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      // Collapsed archive keeps its header but hides its rows.
      data: g.key === 'archived' && !archOpen ? [] : g.items,
      collapsible: g.key === 'archived',
      count: g.items.length,
    }))
  }, [recent, pinned, archived, searching, filtered, archOpen])

  // A2-22: memoized so the interpolation node (and its native-driver
  // attachment) isn't rebuilt on every render during search typing or churn.
  // The drawer docks LEFT in LTR and RIGHT in RTL; the progress value itself
  // is direction-agnostic (0 = closed, 1 = open).
  const translateX = useMemo(
    () => anim.interpolate({ inputRange: [0, 1], outputRange: [dir.rtl ? panelWidth : -panelWidth, 0] }),
    [anim, panelWidth, dir.rtl],
  )

  const closeDialogs = () => {
    setMenuFor(null)
    setMenuAnchor(null)
    setRenaming(null)
    setConfirming(null)
    setDialogError(null)
  }

  /**
   * ChatGPT-style: the menu pops open AT the row that was pressed.
   * Stable identity (reads width through widthRef) so RecentRow and the
   * SectionList callbacks never churn (A2-18).
   */
  const handleRowMenu = useCallback((c: RecentChat, e?: GestureResponderEvent) => {
    const n = e?.nativeEvent
    setMenuAnchor({
      x: typeof n?.pageX === 'number' ? n.pageX : widthRef.current - 40,
      y: typeof n?.pageY === 'number' ? n.pageY : 220,
    })
    setMenuFor(c)
  }, [])

  const openRename = (c: RecentChat) => {
    setMenuFor(null)
    setRenaming(c)
    setRenameText(c.title)
    setDialogError(null)
  }

  const openDelete = (c: RecentChat) => {
    setMenuFor(null)
    setConfirming(c)
    setDialogError(null)
  }

  const saveRename = async () => {
    if (!renaming || dialogBusy) return
    const title = renameText.trim()
    if (!title) return
    setDialogBusy(true)
    setDialogError(null)
    const err = (await onRename?.(renaming.id, title)) ?? null
    setDialogBusy(false)
    if (err) setDialogError(err)
    else closeDialogs()
  }

  const runDelete = async () => {
    if (!confirming || dialogBusy) return
    setDialogBusy(true)
    setDialogError(null)
    const err = (await onDelete?.(confirming.id)) ?? null
    setDialogBusy(false)
    if (err) setDialogError(err)
    else closeDialogs()
  }

  // ── A2-21: edge swipe to open (mirrored in RTL) ──────────────────────────
  // Lives on a 28dp strip on the leading edge that only exists while closed
  // (see the root JSX). Positive-dx-only claim in LTR (negative in RTL) so
  // opposite drags never grab; onStart is false so taps stay inert (accepted
  // dead zone). The gesture finger-tracks via JS setValue on the native-driven
  // `anim`; releases that open route through onRequestOpen so the layout
  // effect owns the final leg.
  const edgePan = useMemo(() => {
    const settle = (_e: GestureResponderEvent, g: PanResponderGestureState) => {
      const opening = dir.rtl ? g.vx < -FLICK : g.vx > FLICK
      if (opening || progressRef.current > 0.5) {
        if (onRequestOpenRef.current) onRequestOpenRef.current()
        else settleTo(anim, 0, CANCEL_MS) // unwired owner: spring back, no stuck state
      } else {
        settleTo(anim, 0, CANCEL_MS)
      }
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !openRef.current &&
        (dir.rtl ? g.dx < -EDGE_CLAIM : g.dx > EDGE_CLAIM) &&
        Math.abs(g.dx) > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => {
        // Wake the display:none'd subtree (web) so the drag is visible.
        if (Platform.OS === 'web') setDormant(false)
        captureProgress(anim, progressRef, moveSeenRef)
      },
      onPanResponderMove: (_e, g) => {
        const p = clamp01((dir.rtl ? -g.dx : g.dx) / panelWidthRef.current)
        progressRef.current = p
        moveSeenRef.current = true
        anim.setValue(p)
      },
      onPanResponderRelease: settle,
      // Stolen mid-gesture: settle by the same rule instead of sticking half-open.
      onPanResponderTerminate: settle,
    })
  }, [anim, dir.rtl])

  // ── A2-21: drag toward the leading edge to close (mirrored in RTL) ────────
  // Capture-phase so it beats the row Pressables, the 350ms long-press, the
  // scrim tap and SectionList scrolling — but only on horizontal-dominant
  // drags while open, with no dialog up and the search field not focused
  // (text-selection drags must keep selecting). Dialogs render as later
  // siblings above the panel, so they never even reach these handlers.
  const panelPan = useMemo(() => {
    const settle = (_e: GestureResponderEvent, g: PanResponderGestureState) => {
      const closing = dir.rtl ? g.vx > FLICK : g.vx < -FLICK
      if (closing || progressRef.current < 0.5) onCloseRef.current?.()
      else settleTo(anim, 1, SNAP_MS)
    }
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        openRef.current &&
        !dialogActiveRef.current &&
        !searchFocusRef.current &&
        (dir.rtl ? g.dx > EDGE_CLAIM : g.dx < -EDGE_CLAIM) &&
        Math.abs(g.dx) > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => captureProgress(anim, progressRef, moveSeenRef),
      onPanResponderMove: (_e, g) => {
        const p = clamp01(1 + (dir.rtl ? -g.dx : g.dx) / panelWidthRef.current)
        progressRef.current = p
        moveSeenRef.current = true
        anim.setValue(p)
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    })
  }, [anim, dir.rtl])

  // ── A2-18: stable identities for everything the SectionList re-renders ────
  const handleCloseDrawer = useCallback(() => onCloseRef.current?.(), [])
  const handleOpenChat = useCallback((id: string) => onOpenChatRef.current(id), [])
  // [12] opening a mini-list chat from an expanded project row: close the
  // drawer, then swap the screen (same hand-off as the plain chat rows).
  const openProjectChat = useCallback(
    (id: string) => {
      onCloseRef.current?.()
      onOpenChatRef.current(id)
    },
    [],
  )

  const renderItem = useCallback(
    ({ item: c }: { item: RecentChat }) => (
      <RecentRow
        c={c}
        locale={locale}
        isPinned={pinned.includes(c.id)}
        onOpenChat={handleOpenChat}
        onCloseDrawer={handleCloseDrawer}
        onMenu={handleRowMenu}
      />
    ),
    [pinned, handleOpenChat, handleCloseDrawer, handleRowMenu, locale],
  )

  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => {
      // `locale` is read through tr() below, not as a value — keep it in the
      // deps so a language switch re-renders the section headers.
      void locale
      if (!section.label) return null
      const labelKey = SECTION_LABEL_KEYS[section.key]
      const label = labelKey ? tr(labelKey) : section.label
      if (section.collapsible) {
        return (
          <Pressable
            style={[s.sectionLabelRow, { flexDirection: dir.row }]}
            onPress={() => setArchOpen((v) => !v)}
            accessibilityLabel={`${tr(archOpen ? 'sidebar.collapse' : 'sidebar.expand')} ${tr('sidebar.archivedChats')}`}
          >
            <Kicker style={s.sectionKicker}>
              {label} ({section.count ?? 0})
            </Kicker>
            <Icon name={archOpen ? 'chevron-up' : 'chevron-down'} size={12} color={C.textFaint} />
          </Pressable>
        )
      }
      return (
        <View style={[s.sectionLabelRow, { flexDirection: dir.row }]}>
          <Kicker style={s.sectionKicker}>{label}</Kicker>
        </View>
      )
    },
    [archOpen, dir.row, locale, s.sectionKicker, s.sectionLabelRow],
  )

  const renderSectionFooter = useCallback(() => <View style={s.sectionGap} />, [s.sectionGap])

  const listEmpty = useCallback(() => {
    // `locale` keeps the empty-state copy in the deps (tr() reads the atom).
    void locale
    if (!searching) return null
    return (
      <Txt size={13} color={C.textFaint} style={s.noMatch}>
        {tr('sidebar.noMatch', { query: query.trim() })}
      </Txt>
    )
  }, [searching, query, locale, s.noMatch])

  // A2-22: memoized dialog scales — stable interpolation nodes.
  const menuScale = useMemo(() => menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }), [menuAnim])
  const renameScale = useMemo(() => renameAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }), [renameAnim])
  const confirmScale = useMemo(() => confirmAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }), [confirmAnim])

  // Applied only AFTER the close animation finishes (web), so it never kills
  // an in-flight slide; the open layout-effect clears it before sliding in.
  const dormantStyle: ViewStyle | undefined = dormant ? { display: 'none' } : undefined

  // Mount-on-first-open gate: flips during render (React re-runs the component
  // before committing), so the subtree mounts in the same commit as open=true
  // — or as the owner's first touch (primed), which pre-pays the mount so a
  // drag never freezes mid-swipe while the panel mounts.
  if ((open || primed) && !everOpened) setEverOpened(true)

  if (!everOpened) {
    // First run: only the edge strip is mounted — nothing under the closed
    // drawer is blocked, and no invisible control exists to tab into.
    return (
      <View style={[StyleSheet.absoluteFill, s.layerZ]} pointerEvents="box-none">
        <View
          style={[
            s.edgeStrip,
            { top: insets.top + EDGE_TOP_GAP },
            dir.rtl ? { right: 0 } : { left: 0 },
          ]}
          pointerEvents="box-only"
          {...edgePan.panHandlers}
        />
      </View>
    )
  }

  const menuPinned = shownMenu ? pinned.includes(shownMenu.chat.id) : false
  const menuArchived = shownMenu ? archived.includes(shownMenu.chat.id) : false

  // Popover geometry: in LTR its right edge hugs the press point (the ⋯
  // button) growing leftward — in RTL the press point is on the panel's left
  // side, so it grows rightward. Vertically it aligns just above the press
  // point and clamps to the window.
  const MENU_W = 240
  const MENU_H = 4 * 46 + 12
  const anchor = shownMenu?.anchor
  const menuLeft = anchor
    ? dir.rtl
      ? Math.max(8, Math.min(anchor.x + 6, width - MENU_W - 8))
      : Math.max(8, Math.min(anchor.x - MENU_W - 6, width - MENU_W - 8))
    : 0
  const menuTop = anchor ? Math.max(insets.top + 8, Math.min(anchor.y - 10, height - MENU_H - 16)) : 0

  // The panel docks to the leading physical edge and carries its hairline on
  // the inner side (mockup .drawer-panel: border-right in LTR; mirrored for
  // Arabic so the drawer slides in from the RIGHT).
  const panelEdge: ViewStyle = dir.rtl
    ? {
        right: 0,
        borderLeftWidth: 1,
        borderLeftColor: C.border,
        shadowOffset: { width: -12, height: 0 },
      }
    : { left: 0, borderRightWidth: 1, borderRightColor: C.border }

  const showSearchButton = ocMode || identity === 'sessions'
  const showChatList = ocMode || identity === 'sessions'
  const showBots = !ocMode && identity === 'bots'
  const showFooter = !ocMode && identity === 'sessions' && footer != null

  // Drawer section header rows (mockup order): Projects, Workspace, chats.
  const chatsHeading = (
    <View style={[s.chatsHead, { flexDirection: dir.row }]}>
      <Kicker style={s.chatsKicker}>
        {ocMode ? tr('chrome.drawer.ocSessions') : tr('chrome.drawer.recentChats')}
      </Kicker>
      <Pressable
        onPress={() => {
          onNewChat()
          onClose()
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={tr('sidebar.newChat')}
      >
        <Txt size={11} weight="700" color={C.accent}>{tr('chrome.drawer.newChat')}</Txt>
      </Pressable>
    </View>
  )

  // Feedback round 2 [11]: Workspace grid ABOVE Projects. Selection state lives
  // in lib/workspace; "More" hands off to the owner (activates the project +
  // navigates to the Chats screen, which filters on the active project).
  const navAndProjects = (
    <>
      <Kicker style={s.firstKicker}>{tr('chrome.drawer.workspace')}</Kicker>
      {renderNavGrid(shownNav)}
      <Kicker>{tr('sidebar.projects')}</Kicker>
      <ProjectList
        projects={projects}
        activeProjectId={activeProjectId}
        onSelect={onProject}
        onNewProject={onNewProject}
        onProjectMenu={onProjectMenu}
        active={open}
        projectChats={projectChats}
        onOpenProjectChat={openProjectChat}
        onProjectMore={onProjectChatsMore}
      />
    </>
  )

  return (
    // box-none: the overlay itself never blocks the screen underneath — only
    // the edge strip (while closed) and the scrim/panel (while open) catch.
    <View style={[StyleSheet.absoluteFill, s.layerZ]} pointerEvents="box-none">
      {/* Leading-edge catch strip (A2-21). Starts below the top bar so it never
          covers the hamburger; 28dp wide, no hitSlop (accepted dead zone). */}
      <View
        style={[
          s.edgeStrip,
          { top: insets.top + EDGE_TOP_GAP },
          dir.rtl ? { right: 0 } : { left: 0 },
        ]}
        pointerEvents={open ? 'none' : 'box-only'}
        {...edgePan.panHandlers}
      />
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: anim }, dormantStyle]}
        pointerEvents={open ? 'auto' : 'none'}
        {...panelPan.panHandlers}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={tr('sidebar.closeMenu')} />
      </Animated.View>

      <Animated.View
        style={[
          s.panel,
          panelEdge,
          {
            width: panelWidth,
            paddingTop: insets.top + 8,
            paddingBottom: Math.max(insets.bottom, 10) + 12,
            transform: [{ translateX }],
          },
          dormantStyle,
        ]}
        pointerEvents={open ? 'auto' : 'none'}
        aria-hidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        {...panelPan.panHandlers}
      >
        {/* ── Brand row: MochiMark + Moch + search affordance + close ─────── */}
        <View style={[s.header, { flexDirection: dir.row }]}>
          <View style={[s.brandRow, { flexDirection: dir.row }]}>
            <MochiMark size={26} />
            <Txt size={15} weight="800">Moch</Txt>
          </View>
          <View style={[s.headerActions, { flexDirection: dir.row }]}>
            {showSearchButton ? (
              <HeaderButton
                onPress={toggleSearch}
                style={s.headerBtn}
                accessibilityLabel={
                  searchOpen ? tr('chrome.drawer.searchClose') : tr('chrome.drawer.searchOpen')
                }
              >
                <Icon name="search" size={15} color={searchOpen ? C.accent : C.textDim} />
              </HeaderButton>
            ) : null}
            <HeaderButton
              onPress={onClose}
              style={s.headerBtn}
              accessibilityLabel={tr('sidebar.closeMenu')}
            >
              <Icon name="close" size={14} color={C.textDim} />
            </HeaderButton>
          </View>
        </View>

        {/* Compact search affordance expanded from the header (mockup keeps
            search out of the drawer body; the behaviour is preserved). */}
        {searchOpen && showSearchButton ? (
          <View style={[s.searchRow, { flexDirection: dir.row }]}>
            <Field
              ref={searchInputRef}
              value={query}
              onChangeText={setQuery}
              placeholder={ocMode ? tr('chrome.drawer.searchOc') : tr('sidebar.searchChats')}
              autoCorrect={false}
              autoCapitalize="none"
              editable={open}
              returnKeyType="search"
              accessibilityLabel={ocMode ? tr('chrome.drawer.searchOc') : tr('sidebar.searchChats')}
              onFocus={() => {
                searchFocusRef.current = true
              }}
              onBlur={() => {
                searchFocusRef.current = false
              }}
              wrapStyle={s.searchField}
            />
            {query ? (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={8}
                style={({ pressed }) => [s.clearBtn, pressed && s.iconBtnPressed]}
                accessibilityLabel={tr('sidebar.clearSearch')}
              >
                <Icon name="close" size={14} color={C.textFaint} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Identity (Sessions | Bots) — the drawer's top-level switch. OpenCode
            mode has no Bots surface: [14] the Bots half is not rendered at all
            (an inert segment reads as broken), only the Sessions label stays. */}
        <IdentitySwitch
          identity={ocMode ? 'sessions' : identity}
          onChange={ocMode ? () => {} : onIdentity}
          botsCount={botsN}
          hideBots={ocMode}
        />

        {/* BUG-133: chat-pad pattern on the LIST only — the drawer's search
            field stays at the panel top while chat results render above the
            keys instead of behind them. */}
        {showChatList ? (
          <RAnimated.View style={[{ flex: 1 }, drawerListKbPad]}>
            {ocMode ? (
              // OpenCode sessions: rows come from the OpenCode server, keyed
              // by oc id. Tapping opens a fresh chat window bound to that
              // session and hydrates its transcript. Deliberately NOT
              // project-filtered — but BUG-149 GROUPS them: rows whose
              // `directory` lands inside a project folder render under that
              // project's name (same section shape as the hermes list);
              // everything else stays flat below.
              <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
                {navAndProjects}
                {chatsHeading}
                {ocLoading ? (
                  // Skeleton rows while the agent boots (or the list loads):
                  // placeholder bars in the row rhythm — no spinner, no error
                  // copy that reads like a failure before anything failed.
                  <View accessibilityLabel={tr('chrome.drawer.ocLoading')}>
                    {[0, 1, 2].map((i) => (
                      <View
                        key={i}
                        style={[s.recentRow, { flexDirection: dir.row }, { opacity: 0.55 - i * 0.15 }]}
                      >
                        <View style={{ flex: 1, gap: 7 }}>
                          <View style={{ height: 12, width: `${74 - i * 16}%`, borderRadius: 6, backgroundColor: C.border }} />
                          <View style={{ height: 9, width: '38%', borderRadius: 5, backgroundColor: C.border, opacity: 0.6 }} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : ocError ? (
                  <Txt size={13} color={C.textFaint} style={s.ocStateText}>{ocError}</Txt>
                ) : ocFiltered.length ? (
                  <>
                    {ocGroups.groups.map((g) => (
                      <View key={g.id}>
                        <View style={[s.sectionLabelRow, { flexDirection: dir.row }]}>
                          <Kicker style={s.sectionKicker}>{g.name}</Kicker>
                        </View>
                        {g.rows.map(renderOcRow)}
                      </View>
                    ))}
                    {ocGroups.flat.length ? (
                      <View>
                        {ocGroups.groups.length ? (
                          <View style={[s.sectionLabelRow, { flexDirection: dir.row }]}>
                            <Kicker style={s.sectionKicker}>{tr('oc.otherSessions')}</Kicker>
                          </View>
                        ) : null}
                        {ocGroups.flat.map(renderOcRow)}
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Txt size={13} color={C.textFaint} style={s.ocStateText}>
                    {tr('chrome.drawer.ocEmpty')}
                  </Txt>
                )}
                <View style={{ height: 12 }} />
              </ScrollView>
            ) : (
              <SectionList<RecentChat, Section>
                sections={sections}
                keyExtractor={chatKey}
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 8 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                // A2-17: a drawer doesn't need ~20 viewports of pre-render —
                // 44dp rows make windowSize=5 plenty.
                windowSize={5}
                maxToRenderPerBatch={8}
                updateCellsBatchingPeriod={50}
                initialNumToRender={12}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                renderSectionFooter={renderSectionFooter}
                ListHeaderComponent={
                  <>
                    {navAndProjects}
                    {chatsHeading}
                  </>
                }
                ListEmptyComponent={listEmpty}
              />
            )}
          </RAnimated.View>
        ) : null}

        {showBots ? (
          <View style={s.botsBody}>
            <BotsRoster
              profiles={profiles ?? []}
              onOpenBot={(key) => {
                onOpenBot?.(key)
                onClose()
              }}
              onNewBot={() => {
                onNewBot?.()
                onClose()
              }}
              onCloseDrawer={onClose}
              active={open}
            />
          </View>
        ) : null}

        {/* The pending-questions note counts CHATS waiting on you, so it is
            Sessions-only (mockup: the amber bottom card). Hermes-only:
            OpenCode questions render in the chat itself. */}
        {showFooter ? (
          <Pressable
            style={({ pressed }) => [
              s.pendingCard,
              { flexDirection: dir.row },
              pressed && s.rowPressed,
            ]}
            onPress={() => {
              onNav('inbox')
              onClose()
            }}
            accessibilityRole="button"
            accessibilityLabel={tr('chrome.drawer.pendingView')}
          >
            <View style={s.pendingBody}>{footer}</View>
            <Txt size={11} color={C.amber}>
              {tr('chrome.drawer.view')} {dir.rtl ? '←' : '→'}
            </Txt>
          </Pressable>
        ) : null}

        {/* Bottom-docked nav (Settings), pinned like ChatGPT's primary action.
            Bots mode has no "New chat": its primary action is the roster's
            `+ New bot`. Evidence of the mockup's Settings-in-the-grid lives
            here so it stays reachable from every drawer mode. */}
        {shownBottomNav?.length ? (
          <View style={s.bottomNav}>
            {shownBottomNav.length === 1
              ? renderBottomTile(shownBottomNav[0])
              : renderNavGrid(shownBottomNav, 1)}
          </View>
        ) : null}
      </Animated.View>

      {/* ── Per-chat popover, anchored where the row was pressed ──────────── */}
      {shownMenu ? (
        <View style={s.overlay} pointerEvents="box-none">
          <Animated.View style={[StyleSheet.absoluteFill, s.menuScrim, { opacity: menuAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel={tr('sidebar.closeMenu')} />
          </Animated.View>
          <Animated.View
            style={[s.menuCard, { left: menuLeft, top: menuTop, opacity: menuAnim, transform: [{ scale: menuScale }] }]}
          >
            <MenuRow
              icon="pin-outline"
              label={menuPinned ? tr('sidebar.unpin') : tr('sidebar.pin')}
              onPress={() => {
                onPinToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow icon="pencil-outline" label={tr('sidebar.rename')} onPress={() => openRename(shownMenu.chat)} />
            <MenuRow
              icon="archive-outline"
              label={menuArchived ? tr('sidebar.unarchive') : tr('sidebar.archive')}
              onPress={() => {
                onArchiveToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow
              icon="trash-can-outline"
              label={tr('sidebar.delete')}
              danger
              onPress={() => openDelete(shownMenu.chat)}
            />
          </Animated.View>
        </View>
      ) : null}

      {/* ── Rename dialog ─────────────────────────────────────────────────── */}
      {shownRename ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: renameAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel={tr('sidebar.cancel')} />
          </Animated.View>
          <RAnimated.View style={renameKbPad}>
            <Animated.View style={[s.dialogCard, { opacity: renameAnim, transform: [{ scale: renameScale }] }]}>
              <Txt style={s.dialogTitle}>{tr('sidebar.renameChatTitle')}</Txt>
              <TextInput
                style={[
                  s.dialogInput,
                  { textAlign: dir.textAlign, writingDirection: dir.writingDirection },
                ]}
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                selectTextOnFocus
                maxLength={200}
                onSubmitEditing={() => void saveRename()}
                accessibilityLabel={tr('sidebar.chatName')}
              />
              {dialogError ? <Txt style={s.dialogError}>{dialogError}</Txt> : null}
              <View style={[s.dialogButtons, { flexDirection: dir.row }]}>
                <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                  <Txt style={s.dialogBtnText}>{tr('sidebar.cancel')}</Txt>
                </Pressable>
                <Pressable
                  style={[s.dialogBtnPrimary, (dialogBusy || !renameText.trim()) && s.dialogBtnBusy]}
                  onPress={() => void saveRename()}
                  disabled={dialogBusy || !renameText.trim()}
                >
                  <Txt style={s.dialogBtnPrimaryText}>{tr('sidebar.save')}</Txt>
                </Pressable>
              </View>
            </Animated.View>
          </RAnimated.View>
        </View>
      ) : null}

      {/* ── Delete confirmation ───────────────────────────────────────────── */}
      {shownConfirm ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: confirmAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel={tr('sidebar.cancel')} />
          </Animated.View>
          <Animated.View style={[s.dialogCard, { opacity: confirmAnim, transform: [{ scale: confirmScale }] }]}>
            <Txt style={s.dialogTitle}>{tr('sidebar.deleteChatTitle')}</Txt>
            <Txt style={s.dialogBody}>
              {tr('sidebar.deleteChatBody', { title: shownConfirm.title })}
            </Txt>
            {dialogError ? <Txt style={s.dialogError}>{dialogError}</Txt> : null}
            <View style={[s.dialogButtons, { flexDirection: dir.row }]}>
              <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                <Txt style={s.dialogBtnText}>{tr('sidebar.cancel')}</Txt>
              </Pressable>
              <Pressable
                style={[s.dialogBtnDanger, dialogBusy && s.dialogBtnBusy]}
                onPress={() => void runDelete()}
                disabled={dialogBusy}
              >
                <Txt style={s.dialogBtnDangerText}>{tr('sidebar.delete')}</Txt>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      ) : null}
    </View>
  )
}

/**
 * The status dot every chat row (sidebar + Chats screen) renders. Attention
 * states are static and colored; `busy` pulses — it is the only transient
 * one, and the pulse is what separates "working" from "finished, unread".
 */
export function StatusDot({ status }: { status?: RowStatus }) {
  const pulse = useRef(new Animated.Value(1)).current
  // BUG-056: honor reduce-motion LIVE — the busy pulse renders static (full
  // opacity) under the OS setting.
  const reduceMotion = useReduceMotion()
  useEffect(() => {
    if (status !== 'busy' || reduceMotion) return
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    )
    a.start()
    return () => a.stop()
  }, [status, pulse, reduceMotion])
  if (!status) return null
  const color = status === 'input' ? C.amber : status === 'done' ? C.greenSoft : status === 'error' ? C.red : C.accent
  return (
    <Animated.View
      accessibilityLabel={tr(
        status === 'input' ? 'status.input' : status === 'done' ? 'status.done' : status === 'error' ? 'status.error' : 'status.busy',
      )}
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: status === 'busy' ? pulse : 1 }}
    />
  )
}

/** One icon row inside the anchored chat menu. */
function MenuRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap
  label: string
  danger?: boolean
  onPress: () => void
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <Pressable
      style={({ pressed }) => [s.menuRow, { flexDirection: dir.row }, pressed && s.menuRowPressed]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Txt size={14.5} color={danger ? C.red : C.text} style={s.menuRowLabel}>{label}</Txt>
    </Pressable>
  )
}

/**
 * One recent-chat row (A2-18): memoized and handed stable callbacks, so search
 * keystrokes, dialog state and store ticks only re-render rows whose props
 * actually changed. The row calls back with primitives (ids) instead of
 * receiving fresh closures per render. `locale` is passed purely so a
 * language switch re-renders the age / a11y copy.
 */
const RecentRow = React.memo(function RecentRow({
  c,
  locale,
  isPinned,
  onOpenChat,
  onCloseDrawer,
  onMenu,
}: {
  c: RecentChat
  locale: string
  isPinned: boolean
  onOpenChat: (id: string) => void
  onCloseDrawer: () => void
  onMenu: (c: RecentChat, e?: GestureResponderEvent) => void
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  void locale
  const age = ageLabel(c.ts)
  return (
    <Pressable
      onPress={() => {
        onOpenChat(c.id)
        onCloseDrawer()
      }}
      onLongPress={(e) => onMenu(c, e)}
      delayLongPress={350}
      style={({ pressed }) => [
        s.recentRow,
        { flexDirection: dir.row },
        c.active && s.recentRowActive,
        pressed && s.recentRowPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={tr('sidebar.openChat', { title: c.title })}
    >
      <StatusDot status={c.status} />
      <Txt
        size={12}
        weight="600"
        color={c.active ? C.text : C.textDim}
        numberOfLines={1}
        style={s.recentTitle}
      >
        {c.title}
      </Txt>
      {isPinned ? <Icon name="pin" size={11} color={C.textFaint} /> : null}
      {age ? <Txt size={10} color={C.textFaint}>{age}</Txt> : null}
      <Pressable
        style={s.rowMenu}
        hitSlop={6}
        onPress={(e) => onMenu(c, e)}
        accessibilityLabel={tr('sidebar.chatOptions', { title: c.title })}
      >
        <Icon name="ellipsis-horizontal" size={15} color={C.textFaint} />
      </Pressable>
    </Pressable>
  )
})

/**
 * The drawer's dialog card language (title / input / body / buttons), shared
 * by the chat dialogs and the project dialogs (ProjectList). One definition,
 * so a second dialog style can never drift in. Values mirror the mockup's
 * sheet card + ghost/primary buttons.
 */
function makeDialogStyles() {
  // `satisfies` (not a `: Type` annotation) keeps the literal types — a widened
  // `string` for alignSelf/fontWeight leaks into StyleSheet.create and breaks
  // every style in this sheet.
  return {
    dialogCard: {
      width: '88%',
      maxWidth: 400,
      alignSelf: 'center',
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 20,
      padding: 18,
      gap: 12,
    },
    dialogTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
    dialogBody: { color: C.textDim, fontSize: 12.5, lineHeight: 18 },
    dialogError: { color: C.red, fontSize: 12 },
    dialogInput: {
      backgroundColor: C.inputBg,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: C.border,
      color: C.text,
      fontSize: 13,
      paddingHorizontal: 11,
      paddingVertical: 9,
      minHeight: 38,
    },
    dialogButtons: { justifyContent: 'flex-end', gap: 8, marginTop: 4 },
    dialogBtn: {
      minHeight: 34,
      paddingHorizontal: 12,
      borderRadius: 11,
      justifyContent: 'center',
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.border,
    },
    dialogBtnBusy: { opacity: 0.5 },
    dialogBtnText: { color: C.text, fontSize: 12.5, fontWeight: '600' },
    dialogBtnPrimary: {
      minHeight: 36,
      paddingHorizontal: 14,
      borderRadius: 11,
      justifyContent: 'center',
      backgroundColor: C.accent,
    },
    dialogBtnPrimaryText: { color: C.onAccent, fontSize: 13, fontWeight: '700' },
    dialogBtnDanger: {
      minHeight: 36,
      paddingHorizontal: 14,
      borderRadius: 11,
      justifyContent: 'center',
      backgroundColor: C.red,
    },
    dialogBtnDangerText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  } satisfies Record<string, ViewStyle | TextStyle>
}

/**
 * Exported so ProjectList's dialogs reuse the exact same card/button styles.
 * A hoisted function declaration on purpose: ProjectList imports back from
 * this module (sidebar → project list → dialog styles), and a hoisted binding
 * is initialized at module instantiation, so the cycle can never observe a
 * temporal dead zone.
 */
export function makeDialogS() {
  return StyleSheet.create(makeDialogStyles())
}

const makeS = () => StyleSheet.create({
  // Explicit stacking floor: the drawer's subtree must paint above the chat
  // screen's floating elements (the model chip carries a zIndex of its own
  // and was drawing over the open drawer on Android).
  layerZ: { zIndex: 50, elevation: 50 },
  // Leading-edge catch strip for the swipe-to-open gesture. `top` is set
  // inline (insets.top + EDGE_TOP_GAP); left/right is set inline so it mirrors
  // in RTL.
  edgeStrip: {
    position: 'absolute',
    bottom: 0,
    width: EDGE_W,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: C.bgCard,
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 40,
    shadowOffset: { width: 12, height: 0 },
    elevation: 16,
  },
  header: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  brandRow: { alignItems: 'center', gap: 8, flexShrink: 0 },
  headerActions: { alignItems: 'center', gap: 4 },
  headerBtn: { width: 26, height: 26, borderRadius: 8 },
  searchRow: { alignItems: 'center', gap: 6, marginBottom: 10 },
  searchField: { flex: 1 },
  clearBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  iconBtnPressed: { opacity: 0.5 },
  // "Workspace" 2-column nav grid (mockup: bgElev tiles, borderSoft hairline).
  navGrid: { gap: 4, marginBottom: 10 },
  navGridRow: { gap: 4 },
  navTile: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 32,
    borderRadius: 8,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.borderSoft,
  },
  navTileOn: { backgroundColor: C.accentSoft, borderColor: C.border },
  navTileLabel: { flexShrink: 1 },
  navTileSpacer: { flex: 1 },
  navBadge: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBadgeTint: { backgroundColor: C.btnTint },
  navBadgeAmber: { backgroundColor: C.amberSoft },
  // Mini Mochi run-counter on the Automations tile: up to three overlapping
  // faces at tile scale, then a +N suffix.
  mochiRunRow: { alignItems: 'center' },
  mochiMini: { width: 16, height: 16, resizeMode: 'contain' },
  mochiMiniOverlap: { marginLeft: -5 },
  mochiMiniOverlapRtl: { marginRight: -5 },
  mochiMore: { marginHorizontal: 2 },
  firstKicker: { marginTop: 2 },
  chatsHead: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12, marginBottom: 6 },
  chatsKicker: { flex: 1, marginTop: 0, marginBottom: 0 },
  botsBody: { flex: 1 },
  sectionLabelRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  sectionKicker: { flex: 1, marginHorizontal: 0, marginBottom: 2 },
  sectionGap: { height: 4 },
  recentRow: {
    alignItems: 'center',
    gap: 7,
    paddingVertical: 7,
    paddingHorizontal: 8,
    minHeight: 38,
    borderRadius: 9,
  },
  recentRowPressed: { backgroundColor: C.bgHover },
  recentRowActive: { backgroundColor: C.bgHover },
  recentTitle: { flex: 1 },
  rowMenu: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowPressed: { backgroundColor: C.bgHover },
  noMatch: { paddingHorizontal: 8, paddingVertical: 12 },
  // OpenCode sessions list — honest loading/error/empty states.
  ocStateText: { paddingHorizontal: 8, paddingVertical: 12 },
  // Amber pending-questions card at the panel's bottom edge (mockup footer).
  pendingCard: {
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.amberSoft,
    // The mockup's amber hairline (rgba(245,165,36,0.28)); amber is identical
    // in both themes, so this literal is theme-safe.
    borderWidth: 1,
    borderColor: 'rgba(245,165,36,0.28)',
  },
  pendingBody: { flex: 1, minWidth: 0 },
  bottomNav: { marginTop: 8, alignItems: 'center' },
  // [2] icon-only docked Settings card.
  bottomTile: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
  },
  bottomTileOn: { borderColor: C.accent },

  // Anchored chat menu + dialogs — in-app overlays (Alert.alert is a no-op on
  // web). The container carries no background: each overlay fades its own
  // scrim so the whole thing can animate in and out.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  menuScrim: { backgroundColor: 'rgba(0,0,0,0.28)' },
  menuCard: {
    position: 'absolute',
    width: 240,
    borderRadius: 12,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  menuRow: {
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  menuRowPressed: { backgroundColor: C.bgHover },
  menuRowLabel: { flex: 1 },

  // Chat dialogs + project dialogs: one shared definition (makeDialogStyles).
  ...makeDialogStyles(),
})
