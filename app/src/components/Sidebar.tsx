import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  BackHandler,
  Easing,
  Image,
  PanResponder,
  Platform,
  SectionList,
  TextInput,
  useWindowDimensions,
} from 'react-native'
import type { GestureResponderEvent, PanResponderGestureState, ViewStyle } from 'react-native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname } from 'expo-router'
import { useStore } from '@nanostores/react'
import { archivedIds, groupChats, pinnedIds } from '../lib/chatListState'
import type { RowStatus } from '../lib/attention'
import { C, S, useStyles, useShape } from '../lib/theme'
import { useReduceMotion } from './useReduceMotion'

export interface NavItem {
  key: string
  label: string
  icon: keyof typeof Ionicons.glyphMap
  badge?: number
  /** Active automations: renders up to 3 mini Mochis, +N past that. */
  mochis?: number
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
// EDGE_W: width of the left-edge catch strip while closed. Kept at 28 with no
// hitSlop — taps starting inside the strip are swallowed (RN has no touch
// re-dispatch), so the strip stays narrow AND starts below the top bar
// (EDGE_TOP_GAP) so it never covers the hamburger button.
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

/** ChatGPT's panel is ~300dp, capped so it never looks empty on a tablet. */
export const drawerPanelWidth = (windowWidth: number) => Math.min(windowWidth * 0.82, 320)

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
 * ChatGPT-style slide-in sidebar.
 *
 * Implemented as an overlay rather than a Drawer navigator: the app already
 * routes through expo-router tabs, and an overlay keeps that intact while
 * giving the same "drawer slides over the conversation" behaviour.
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
  const S = useShape()
  const pathname = usePathname()
  const activeKey = nav.find((n) => pathname?.endsWith(n.key))?.key
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
  // ChatGPT's panel width — shared with the owner's swipe gesture via the
  // exported helper so both map finger pixels to the same 0→1 progress.
  const panelWidth = drawerPanelWidth(width)
  const [query, setQuery] = useState('')
  const [archOpen, setArchOpen] = useState(false)

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
  const translateX = useMemo(
    () => anim.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] }),
    [anim, panelWidth],
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

  // ── A2-21: edge swipe right to open ──────────────────────────────────────
  // Lives on a 28dp strip that only exists while closed (see the root JSX).
  // Positive-dx-only claim so leftward edge drags never grab; onStart is false
  // so taps stay inert (accepted dead zone). The gesture finger-tracks via JS
  // setValue on the native-driven `anim`; releases that open route through
  // onRequestOpen so the layout effect owns the final leg.
  const edgePan = useMemo(() => {
    const settle = (_e: GestureResponderEvent, g: PanResponderGestureState) => {
      if (g.vx > FLICK || progressRef.current > 0.5) {
        if (onRequestOpenRef.current) onRequestOpenRef.current()
        else settleTo(anim, 0, CANCEL_MS) // unwired owner: spring back, no stuck state
      } else {
        settleTo(anim, 0, CANCEL_MS)
      }
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !openRef.current && g.dx > EDGE_CLAIM && g.dx > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => {
        // Wake the display:none'd subtree (web) so the drag is visible.
        if (Platform.OS === 'web') setDormant(false)
        captureProgress(anim, progressRef, moveSeenRef)
      },
      onPanResponderMove: (_e, g) => {
        const p = clamp01(g.dx / panelWidthRef.current)
        progressRef.current = p
        moveSeenRef.current = true
        anim.setValue(p)
      },
      onPanResponderRelease: settle,
      // Stolen mid-gesture: settle by the same rule instead of sticking half-open.
      onPanResponderTerminate: settle,
    })
  }, [anim])

  // ── A2-21: drag left on the panel/scrim to close ──────────────────────────
  // Capture-phase so it beats the row Pressables, the 350ms long-press, the
  // scrim tap and SectionList scrolling — but only on horizontal-dominant
  // leftward drags while open, with no dialog up and the search field not
  // focused (text-selection drags must keep selecting). Dialogs render as
  // later siblings above the panel, so they never even reach these handlers.
  const panelPan = useMemo(() => {
    const settle = (_e: GestureResponderEvent, g: PanResponderGestureState) => {
      if (g.vx < -FLICK || progressRef.current < 0.5) onCloseRef.current?.()
      else settleTo(anim, 1, SNAP_MS)
    }
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        openRef.current &&
        !dialogActiveRef.current &&
        !searchFocusRef.current &&
        g.dx < -EDGE_CLAIM &&
        Math.abs(g.dx) > Math.abs(g.dy) * DOMINANCE,
      onPanResponderGrant: () => captureProgress(anim, progressRef, moveSeenRef),
      onPanResponderMove: (_e, g) => {
        const p = clamp01(1 + g.dx / panelWidthRef.current)
        progressRef.current = p
        moveSeenRef.current = true
        anim.setValue(p)
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    })
  }, [anim])

  // ── A2-18: stable identities for everything the SectionList re-renders ────
  const handleCloseDrawer = useCallback(() => onCloseRef.current?.(), [])
  const handleOpenChat = useCallback((id: string) => onOpenChatRef.current(id), [])

  const renderItem = useCallback(
    ({ item: c }: { item: RecentChat }) => (
      <RecentRow
        c={c}
        isPinned={pinned.includes(c.id)}
        onOpenChat={handleOpenChat}
        onCloseDrawer={handleCloseDrawer}
        onMenu={handleRowMenu}
      />
    ),
    [pinned, handleOpenChat, handleCloseDrawer, handleRowMenu],
  )

  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => {
      if (!section.label) return null
      if (section.collapsible) {
        return (
          <Pressable
            style={s.sectionLabelRow}
            onPress={() => setArchOpen((v) => !v)}
            accessibilityLabel={`${archOpen ? 'Collapse' : 'Expand'} archived chats`}
          >
            <Text style={s.sectionLabel}>{section.label} ({section.count ?? 0})</Text>
            <Icon name={archOpen ? 'chevron-up' : 'chevron-down'} size={12} color={C.textFaint} />
          </Pressable>
        )
      }
      return (
        <View style={s.sectionLabelRow}>
          <Text style={s.sectionLabel}>{section.label}</Text>
        </View>
      )
    },
    [archOpen],
  )

  const renderSectionFooter = useCallback(() => <View style={s.sectionGap} />, [])

  const listEmpty = useCallback(
    () => (searching ? <Text style={s.noMatch}>No chats matching “{query.trim()}”</Text> : null),
    [searching, query],
  )

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
          style={[s.edgeStrip, { top: insets.top + EDGE_TOP_GAP }]}
          pointerEvents="box-only"
          {...edgePan.panHandlers}
        />
      </View>
    )
  }

  const menuPinned = shownMenu ? pinned.includes(shownMenu.chat.id) : false
  const menuArchived = shownMenu ? archived.includes(shownMenu.chat.id) : false

  // Popover geometry: right edge hugs the press point (the ⋯ button), growing
  // leftward; falls back to the left edge for long-presses mid-row. Vertically
  // it aligns just above the press point and clamps to the window.
  const MENU_W = 240
  const MENU_H = 4 * 46 + 12
  const anchor = shownMenu?.anchor
  const menuLeft = anchor ? Math.max(8, Math.min(anchor.x - MENU_W - 6, width - MENU_W - 8)) : 0
  const menuTop = anchor ? Math.max(insets.top + 8, Math.min(anchor.y - 10, height - MENU_H - 16)) : 0

  return (
    // box-none: the overlay itself never blocks the screen underneath — only
    // the edge strip (while closed) and the scrim/panel (while open) catch.
    <View style={[StyleSheet.absoluteFill, s.layerZ]} pointerEvents="box-none">
      {/* Left-edge catch strip (A2-21). Starts below the top bar so it never
          covers the hamburger; 28dp wide, no hitSlop (accepted dead zone). */}
      <View
        style={[s.edgeStrip, { top: insets.top + EDGE_TOP_GAP }]}
        pointerEvents={open ? 'none' : 'box-only'}
        {...edgePan.panHandlers}
      />
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: anim }, dormantStyle]}
        pointerEvents={open ? 'auto' : 'none'}
        {...panelPan.panHandlers}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>

      <Animated.View
        style={[
          s.panel,
          { width: panelWidth, paddingTop: insets.top + 6, paddingBottom: insets.bottom + 10, transform: [{ translateX }] },
          dormantStyle,
        ]}
        pointerEvents={open ? 'auto' : 'none'}
        aria-hidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        {...panelPan.panHandlers}
      >
        <View style={s.header}>
          <View style={s.brandRow}>
            <Image source={require('../../assets/logo.png')} style={s.brandLogo} />
            <Text style={s.brand}>Moch</Text>
          </View>
          <Pressable
            style={({ pressed }) => [s.iconBtn, pressed && s.iconBtnPressed]}
            onPress={onClose}
            hitSlop={10}
            accessibilityLabel="Close menu"
          >
            <Icon name="close" size={20} color={C.textDim} />
          </Pressable>
        </View>

        <View>
          {nav.map((item) => (
            <Pressable
              key={item.key}
              style={({ pressed }) => [
                s.navRow,
                item.key === activeKey && S.drawerRoundedCap && s.navRowOn,
                pressed && s.rowPressed,
              ]}
              onPress={() => {
                onNav(item.key)
                onClose()
              }}
              accessibilityLabel={item.label}
            >
              <Icon
                name={item.icon}
                size={20}
                color={item.key === activeKey && S.drawerRoundedCap ? C.accent : C.text}
              />
              <Text style={s.navLabel}>{item.label}</Text>
              {item.mochis ? (
                <View
                  style={s.mochiRunRow}
                  accessibilityLabel={`${item.mochis} running automation${item.mochis === 1 ? '' : 's'}`}
                >
                  {Array.from({ length: Math.min(item.mochis, 3) }).map((_, i) => (
                    <Image key={i} source={MOCHI_RUN[i]} style={[s.mochiMini, i > 0 && s.mochiMiniOverlap]} />
                  ))}
                  {item.mochis > 3 ? <Text style={s.mochiMore}>+{item.mochis - 3}</Text> : null}
                </View>
              ) : null}
              {item.badge ? (
                <View style={s.badge}>
                  <Text style={s.badgeText}>{item.badge > 9 ? '9+' : item.badge}</Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>

        {recent.length > 0 ? (
          <>
            <View style={s.searchWrap}>
              <Icon name="search" size={14} color={C.textFaint} />
              <TextInput
                ref={searchInputRef}
                style={s.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search chats…"
                placeholderTextColor={C.textFaint}
                autoCorrect={false}
                autoCapitalize="none"
                editable={open}
                accessibilityLabel="Search chats"
                onFocus={() => {
                  searchFocusRef.current = true
                }}
                onBlur={() => {
                  searchFocusRef.current = false
                }}
              />
              {query ? (
                <Pressable
                  onPress={() => setQuery('')}
                  hitSlop={8}
                  style={({ pressed }) => [s.clearBtn, pressed && s.iconBtnPressed]}
                  accessibilityLabel="Clear search"
                >
                  <Icon name="close" size={14} color={C.textFaint} />
                </Pressable>
              ) : null}
            </View>
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
              ListEmptyComponent={listEmpty}
            />
          </>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        {footer}

        {/* Primary action, pinned like ChatGPT's blue button. */}
        <Pressable
          style={({ pressed }) => [s.newChat, pressed && { opacity: 0.85 }]}
          onPress={() => {
            onNewChat()
            onClose()
          }}
          accessibilityLabel="New chat"
        >
          <Icon name="add" size={20} color={C.onAccent} />
          <Text style={s.newChatText}>New chat</Text>
        </Pressable>
      </Animated.View>

      {/* ── Per-chat popover, anchored where the row was pressed ──────────── */}
      {shownMenu ? (
        <View style={s.overlay} pointerEvents="box-none">
          <Animated.View style={[StyleSheet.absoluteFill, s.menuScrim, { opacity: menuAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Close menu" />
          </Animated.View>
          <Animated.View
            style={[s.menuCard, { left: menuLeft, top: menuTop, opacity: menuAnim, transform: [{ scale: menuScale }] }]}
          >
            <MenuRow
              icon="pin-outline"
              label={menuPinned ? 'Unpin' : 'Pin'}
              onPress={() => {
                onPinToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow icon="pencil-outline" label="Rename" onPress={() => openRename(shownMenu.chat)} />
            <MenuRow
              icon="archive-outline"
              label={menuArchived ? 'Unarchive' : 'Archive'}
              onPress={() => {
                onArchiveToggle?.(shownMenu.chat.id)
                closeDialogs()
              }}
            />
            <MenuRow icon="trash-can-outline" label="Delete" danger onPress={() => openDelete(shownMenu.chat)} />
          </Animated.View>
        </View>
      ) : null}

      {/* ── Rename dialog ─────────────────────────────────────────────────── */}
      {shownRename ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: renameAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Cancel rename" />
          </Animated.View>
          <Animated.View style={[s.dialogCard, { opacity: renameAnim, transform: [{ scale: renameScale }] }]}>
            <Text style={s.dialogTitle}>Rename chat</Text>
            <TextInput
              style={s.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              selectTextOnFocus
              maxLength={200}
              onSubmitEditing={() => void saveRename()}
              accessibilityLabel="Chat name"
            />
            {dialogError ? <Text style={s.dialogError}>{dialogError}</Text> : null}
            <View style={s.dialogButtons}>
              <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                <Text style={s.dialogBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.dialogBtnPrimary, (dialogBusy || !renameText.trim()) && s.dialogBtnBusy]}
                onPress={() => void saveRename()}
                disabled={dialogBusy || !renameText.trim()}
              >
                <Text style={s.dialogBtnPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      ) : null}

      {/* ── Delete confirmation ───────────────────────────────────────────── */}
      {shownConfirm ? (
        <View style={s.overlay}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: confirmAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeDialogs} accessibilityLabel="Cancel delete" />
          </Animated.View>
          <Animated.View style={[s.dialogCard, { opacity: confirmAnim, transform: [{ scale: confirmScale }] }]}>
            <Text style={s.dialogTitle}>Delete this chat?</Text>
            <Text style={s.dialogBody}>
              “{shownConfirm.title}” is permanently removed from Moch.
            </Text>
            {dialogError ? <Text style={s.dialogError}>{dialogError}</Text> : null}
            <View style={s.dialogButtons}>
              <Pressable style={[s.dialogBtn, dialogBusy && s.dialogBtnBusy]} onPress={closeDialogs} disabled={dialogBusy}>
                <Text style={s.dialogBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.dialogBtnDanger, dialogBusy && s.dialogBtnBusy]}
                onPress={() => void runDelete()}
                disabled={dialogBusy}
              >
                <Text style={s.dialogBtnDangerText}>Delete</Text>
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
      accessibilityLabel={status === 'input' ? 'Waiting for your input' : status === 'done' ? 'New reply' : status === 'error' ? 'Errored' : 'Working'}
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
  return (
    <Pressable
      style={({ pressed }) => [s.menuRow, pressed && s.menuRowPressed]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Text style={[s.menuRowLabel, danger && { color: C.red }]}>{label}</Text>
    </Pressable>
  )
}

/**
 * One recent-chat row (A2-18): memoized and handed stable callbacks, so search
 * keystrokes, dialog state and store ticks only re-render rows whose props
 * actually changed. The row calls back with primitives (ids) instead of
 * receiving fresh closures per render.
 */
const RecentRow = React.memo(function RecentRow({
  c,
  isPinned,
  onOpenChat,
  onCloseDrawer,
  onMenu,
}: {
  c: RecentChat
  isPinned: boolean
  onOpenChat: (id: string) => void
  onCloseDrawer: () => void
  onMenu: (c: RecentChat, e?: GestureResponderEvent) => void
}) {
  const s = useStyles(makeS)
  return (
    <Pressable
      onPress={() => {
        onOpenChat(c.id)
        onCloseDrawer()
      }}
      onLongPress={(e) => onMenu(c, e)}
      delayLongPress={350}
      style={({ pressed }) => [s.recentRow, pressed && s.recentRowPressed]}
      accessibilityLabel={`Open ${c.title}`}
    >
      <Text style={[s.recentTitle, c.active && s.recentTitleActive]} numberOfLines={1}>
        {c.title}
      </Text>
      {isPinned ? <Icon name="pin" size={11} color={C.textFaint} /> : null}
      <StatusDot status={c.status} />
      <Pressable
        style={s.rowMenu}
        hitSlop={6}
        onPress={(e) => onMenu(c, e)}
        accessibilityLabel={`Options for ${c.title}`}
      >
        <Icon name="ellipsis-horizontal" size={15} color={C.textFaint} />
      </Pressable>
    </Pressable>
  )
})

const makeS = () => StyleSheet.create({
  // Explicit stacking floor: the drawer's subtree must paint above the chat
  // screen's floating elements (the model chip carries a zIndex of its own
  // and was drawing over the open drawer on Android).
  layerZ: { zIndex: 50, elevation: 50 },
  // Left-edge catch strip for the swipe-to-open gesture. `top` is set inline
  // (insets.top + EDGE_TOP_GAP) to clear the top bar/hamburger.
  edgeStrip: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: EDGE_W,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: C.bgElev,
    borderRightWidth: 1,
    borderRightColor: S.drawerRoundedCap ? C.border : C.borderSoft,
    borderTopRightRadius: S.drawerRoundedCap ? 28 : 0,
    borderBottomRightRadius: S.drawerRoundedCap ? 28 : 0,
    shadowColor: '#000',
    shadowOpacity: S.drawerRoundedCap ? 0.45 : 0,
    shadowRadius: 40,
    shadowOffset: { width: 12, height: 0 },
    elevation: S.drawerRoundedCap ? 16 : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 4,
  },
  brand: { color: C.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandLogo: { width: 34, height: 26, resizeMode: 'contain' },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  iconBtnPressed: { opacity: 0.5 },
  clearBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    minHeight: 48,
    justifyContent: 'flex-start',
    marginHorizontal: S.drawerRoundedCap ? 10 : 0,
    borderRadius: S.drawerRoundedCap ? 16 : 0,
  },
  // Mocheme's active nav row: a soft wash of the accent instead of nothing.
  navRowOn: { backgroundColor: C.accentSoft },
  rowPressed: { backgroundColor: C.bgHover },
  navLabel: { color: C.text, fontSize: 15.5, fontWeight: '500', flex: 1 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: C.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  // Mini Mochi run-counter next to "Automations": up to three overlapping
  // faces, then a +N suffix.
  mochiRunRow: { flexDirection: 'row', alignItems: 'center' },
  mochiMini: { width: 32, height: 32, resizeMode: 'contain' },
  mochiMiniOverlap: { marginLeft: -10 },
  mochiMore: { color: C.textFaint, fontSize: 12.5, fontWeight: '800', marginLeft: 3 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginVertical: 8,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.borderSoft,
  },
  searchInput: { flex: 1, color: C.text, fontSize: 14, paddingVertical: 0, minHeight: 36 },
  // Section headers: the "gaps" between time groups.
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  sectionLabel: {
    color: C.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionGap: { height: 6 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    minHeight: 44,
    borderRadius: 10,
  },
  recentRowPressed: { backgroundColor: C.bgHover },
  recentTitle: { flex: 1, color: C.textDim, fontSize: 14.5, fontWeight: '400' },
  recentTitleActive: { color: C.text, fontWeight: '600' },
  rowMenu: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noMatch: { color: C.textFaint, fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.accent,
  },
  newChatText: { color: C.onAccent, fontSize: 15.5, fontWeight: '700' },

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
    borderColor: C.borderSoft,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  menuRowPressed: { backgroundColor: C.bgHover },
  menuRowLabel: { color: C.text, fontSize: 15.5, flex: 1 },

  dialogCard: {
    width: '86%',
    maxWidth: 400,
    alignSelf: 'center',
    backgroundColor: C.bgCard,
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  dialogTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  dialogBody: { color: C.textDim, fontSize: 13.5 },
  dialogError: { color: C.red, fontSize: 12.5 },
  renameInput: {
    backgroundColor: C.inputBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.borderSoft,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  dialogBtn: {
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.bgHover,
  },
  dialogBtnBusy: { opacity: 0.5 },
  dialogBtnText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  dialogBtnPrimary: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  dialogBtnPrimaryText: { color: C.onAccent, fontSize: 14.5, fontWeight: '700' },
  dialogBtnDanger: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: C.red,
  },
  dialogBtnDangerText: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '700' },
})
