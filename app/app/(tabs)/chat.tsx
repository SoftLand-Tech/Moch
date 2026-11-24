import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  Platform,
  ActivityIndicator,
  ScrollView,
  Modal,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Icon } from '../../src/components/Icon'
import { Dot, GhostBtn, HeaderButton, Pill, PrimaryBtn, SheetBackdrop, SheetCard, SheetGrabber, Spinner, Txt } from '../../src/components/ui'
import { MochiMark } from '../../src/components/MochiMark'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import { AudioModule, useAudioRecorder, RecordingPresets, type RecordingOptions } from 'expo-audio'
import { transcribeRecording, voiceBusy } from '../../src/lib/voice'
import { VoiceRecStrip } from '../../src/components/VoiceRecStrip'
import { clearBadge } from '../../src/lib/push'
import { evaluateStick, shouldFollowOnAppend, contentGrew } from '../../src/lib/chatScroll'
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router'
import {
  messages,
  tools,
  agentBusy,
  pendingRequest,
  todos,
  outbox,
  activeTitle,
  activeStoredId,
  activeSession,
  sessionLoadings,
  sendPrompt,
  stopRun,
  steerRun,
  respondApproval,
  respondClarify,
  respondClarifyBatch,
  respondPrivileged,
  pendingUntracked,
  openLocalChatIfNeeded,
  activeLiveId,
  chatBanner,
  activeQueue,
  retryMessage,
  flushOutbox,
  newChat,
  pushLocalMessage,
  hydrateOcHistory,
  ocPermissionLive,
  ocReplyPermission,
  type ToolItem,
  type ChatMessage,
  type PendingRequest,
} from '../../src/lib/chat'
import { enqueueSend, removeQueued } from '../../src/lib/sendQueue'
import { setQueuedAttachments, takeQueuedAttachments } from '../../src/lib/chat'
import { MAX_ATTACHMENTS, ATTACH_MAX_BYTES, formatBytes, mediaKindForPath } from '../../src/lib/media'
import type { PendingAttachment } from '../../src/lib/mediaSend'
import { AttachmentChip } from '../../src/components/media/AttachmentChip'
import { AttachSheet } from '../../src/components/media/AttachSheet'
import { chatTabFocused } from '../../src/lib/attention'
import { draftFor, setDraft } from '../../src/lib/drafts'
import { activeBotAtom, fleetProfiles, type FleetProfile } from '../../src/lib/fleet'
import { openBotChat } from '../../src/lib/botChat'
import { BotAvatar } from '../../src/components/BotAvatar'
import { shareInInbox, ackShareIn, applySharedToDraft, type SharedFile } from '../../src/lib/shareIn'
import { isConnected as isConnectedAtom, everConnected, connectionState, gatewayError, retryNow } from '../../src/lib/gateway'
import { completeSlash, loadCatalog, runCommand, parseSlashCommand, canonicalName, interactiveTarget, describeCommand, subsFor, argumentModeFor, slashLabel, localCompleteSync, resolveSlashRoute, type CompletionItem, type SlashOutcome } from '../../src/lib/slash'
import { liveModel, liveReasoning, liveReasoningDisplay, fetchReasoningDisplay } from '../../src/lib/modelState'
import { thinkerAtom, ocOneShotAtom } from '../../src/lib/thinker'
import { ocPickFor, rememberOcPick } from '../../src/lib/opencodeChat'
import { ocDefaultModel, ocEnsureServer } from '../../src/lib/opencodeClient'
import { ModelPickerSheet } from '../../src/components/ModelPickerSheet'
import { CommandOptionsSheet } from '../../src/components/CommandOptionsSheet'
import { CommandCatalogSheet } from '../../src/components/CommandCatalogSheet'
import { MessageBubble, ToolRow } from '../../src/components/Chat'
import { Mascot } from '../../src/components/Mascot'
import { useMochiState } from '../../src/components/mochi/useMochiState'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { localeAtom, useDir, useT } from '../../src/lib/strings'
import { countUnanswered } from '../../src/lib/clarifyGate'
import { C, useStyles } from '../../src/lib/theme'

/** Empty-state prompts — the mockup's four starter rows (label from the chat
 *  catalog; `slash` focuses the composer so the palette opens, BUG-043). */
const STARTERS = [
  { key: 'chat.starter.what', slash: false },
  { key: 'chat.starter.day', slash: false },
  { key: 'chat.starter.repo', slash: false },
  { key: 'chat.starter.slash', slash: true },
] as const

const MAX_SLASH_ITEMS = 120

// Module scope so the hook keeps one recorder across renders — and so the
// VoiceRecStrip waveform gets live dB levels (voice.ts records .m4a).
const REC_OPTIONS: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true }

export default function Chat() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  // The RETRY badge is mono/LTR ONLY for the English literal; translated
  // scripts (ar/zh/fr) must keep their natural direction and proportional font.
  const englishRetry = useStore(localeAtom) === 'en'
  /** Single-button alert with the catalog's localized OK. */
  const alertOk = (title: string, message?: string) =>
    void showAlert(title, message, [{ text: t('chat.alert.ok') }])
  /** Direction overrides for the raw <Text> nodes that carry user content. */
  const rtlText = { textAlign: dir.textAlign, writingDirection: dir.writingDirection } as const
  const msgs = useStore(messages)
  const tls = useStore(tools)
  const busy = useStore(agentBusy)
  // BUG-111: which bot NEW chats are scoped to (persisted in fleet.ts).
  const activeBot = useStore(activeBotAtom)
  // Bot Switcher (round-2 feedback): the pill under the header opens this
  // sheet — the roster lives here instead of a "Switch back" dead end.
  const profiles = useStore(fleetProfiles)
  // Native Bot Mode title for the active bot (marker title, else profile id).
  const activeBotTitle = (name: string | null) =>
    (name ? profiles.find((p) => p.name === name)?.title : '') || name || ''
  const [botSwitcherOpen, setBotSwitcherOpen] = useState(false)
  /** The bot currently being switched to ('' = the default agent). */
  const [switchingBot, setSwitchingBot] = useState<string | null>(null)
  const req = useStore(pendingRequest)
  const td = useStore(todos)
  const qb = useStore(outbox)
  const title = useStore(activeTitle)
  const storedId = useStore(activeStoredId)
  const loadings = useStore(sessionLoadings)
  // This chat's content is still on its way (optimistic placeholder waiting
  // on the cached transcript / session.resume) — never render the starters.
  const booting = !!(storedId && loadings[storedId]) && msgs.length === 0
  const banner = useStore(chatBanner)
  const online = useStore(isConnectedAtom)
  const sharedIn = useStore(shareInInbox)
  // A short drop (background socket death + ~2s rebuild) must not flash the
  // offline banner — the chat renders fine from cache meanwhile. The banner
  // only appears when the outage outlasts this grace window.
  const [offlineGrace, setOfflineGrace] = useState(false)
  const connState = useStore(connectionState)
  // Never connected yet THIS run = booting, not offline. The banner must not
  // tell a phone with full signal that it is "Offline" while the embedded
  // agent is still coming up (1.0.39 routes straight to chat during boot).
  const everOpen = useStore(everConnected)
  useEffect(() => {
    if (online) { setOfflineGrace(false); return }
    setOfflineGrace(true)
    const t = setTimeout(() => setOfflineGrace(false), 2500)
    return () => clearTimeout(t)
  }, [online])
  // BUG-005: after the grace window, the banner is the mid-session outage
  // surface (the boot veil no longer covers the app once this run has
  // connected). While a dial is in flight it reads "Connecting…"; during
  // backoff waits (state 'closed') it reads "Offline — tap to retry", so
  // there is continuous feedback through the whole outage instead of the
  // old inverted attempt-gate that hid the banner exactly when the outage
  // was real.
  const showOfflineBanner = !online && !offlineGrace
  const conn = useStore(connectionState)
  const gerr = useStore(gatewayError)
  const curModel = useStore(liveModel)
  const curEffort = useStore(liveReasoning)
  const showThinking = useStore(liveReasoningDisplay) !== 'hide'
  // ── OpenCode mode (OPENCODE-MODE contract) ── same transcript atoms, a
  // different wire. Everything hermes-specific on this screen (model chip,
  // bot chip, steer chip, gateway question cards) is gated off; the OpenCode
  // thinker chip, its model sheet and the OC permission card take their
  // places.
  const thinker = useStore(thinkerAtom)
  const ocMode = thinker === 'opencode'
  // One-shot mode (no server): chip says so, the sheet lists CLI models and
  // picks are passed per turn (see rememberOcPick).
  const ocOneShot = useStore(ocOneShotAtom)
  // The OpenCode permission ask blocking the ACTIVE chat (reactive mirror in
  // chat.ts; the sync accessor is ocActivePermission).
  const ocPerm = useStore(ocPermissionLive)
  // Live id — only used to scope the reasoning-display config read; the
  // screen itself keys off storedId.
  const sid = useStore(activeSession)
  const [input, setInput] = useState('')
  const [steerMode, setSteerMode] = useState(false)
  const queued = useStore(activeQueue)
  const [answerText, setAnswerText] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({})
  const [stick, setStick] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [slashItems, setSlashItems] = useState<CompletionItem[] | null>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  // Current OpenCode default model — the thinker chip's label. Refreshed on
  // mount in oc mode and whenever the model sheet closes (a pick updates the
  // server's default).
  const [ocModel, setOcModel] = useState('')
  // Session-scoped picks: the chip must keep showing what THIS chat picked —
  // the server default would clobber it right after the sheet closes.
  // In one-shot mode there IS no server default: hydrate from the persisted
  // pick store so the chip survives restarts.
  const [ocPicks, setOcPicks] = useState<Record<string, string>>({})
  const ocModelForChip = (storedId && ocPicks[storedId]) || ocModel
  useEffect(() => {
    if (!ocMode) return
    let alive = true
    if (ocOneShot) {
      setOcModel('')
      if (storedId) {
        ocPickFor(storedId)
          .then((m) => { if (alive && m) setOcPicks((p) => ({ ...p, [storedId]: m })) })
          .catch(() => {})
      }
      return () => { alive = false }
    }
    ocEnsureServer()
      .catch(() => {})
      .then(() => ocDefaultModel())
      .then((m) => { if (alive) setOcModel(m?.modelID ?? '') })
      .catch(() => {})
    return () => { alive = false }
  }, [ocMode, ocOneShot, modelPickerOpen, storedId, online])
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [optionSheet, setOptionSheet] = useState<{ command: string; allowText: boolean } | null>(null)
  const listRef = useRef<FlatList>(null)
  const insets = useSafeAreaInsets()
  // The slash palette tracks input focus, not just the leading "/": a "/"
  // sitting in the composer while it's unfocused (keyboard dismissed, user
  // reading the transcript) must not hold the palette open.
  const [composerFocused, setComposerFocused] = useState(false)
  // Keyboard avoidance without frame math: `height` tracks the device's real
  // IME inset (0 closed → −keyboardHeight open, animated in sync by the OS),
  // so the composer's bottom lands exactly on the keyboard's top edge on any
  // phone — keyboard height, nav bar and screen geometry are all per-device.
  // The KAV 'height' behavior undershot here: it derives the lift from a
  // measured view frame, which doesn't line up on every device (MIUI et al).
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  // BUG-037 → BUG-133: composerPad is the SINGLE bottom-inset owner. The old
  // ternary (`kb.height.value < 0 ? 0 : …`) flipped the instant the IME
  // animation started, hopping the pill down a full nav-bar inset and back —
  // and the SafeAreaView below still added its own static inset on top. The
  // clamp ramps continuously: max(insets,10) at rest, 0 once the IME passes
  // that height, so the pill lands flush on the keys with no dead gap.
  const composerPad = useAnimatedStyle(() => ({
    paddingBottom: Math.max(Math.max(insets.bottom, 10) + kb.height.value, 0),
  }))
  const recorder = useAudioRecorder(REC_OPTIONS)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const voiceState = useStore(voiceBusy)
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // BUG-048: mirrors recSecs so the interval callback can check the limit
  // without a side effect inside a state updater.
  const recSecsRef = useRef(0)
  const slashSeq = useRef(0)
  // BUG-043: the slash starter focuses the composer so the palette opens.
  const inputRef = useRef<TextInput>(null)
  // BUG-086: questions from sessions this app isn't tracking (automation or
  // a CLI on the host). Answering is a plain response frame keyed by the
  // `srq-…` id — no session tracking needed — so they render as ONE
  // aggregate card below the active chat's own question, expandable into
  // the same answer machinery.
  const foreign = useStore(pendingUntracked)
  const [foreignOpen, setForeignOpen] = useState(false)
  // Mascot waterfall — recording (press-to-talk) and the composer text (any
  // keystroke is activity) feed the idle clock; everything else it subscribes
  // to itself.
  const mochi = useMochiState({ recording, activityKey: input })
  // Composer attachments (ChatGPT-style chips). Memory-only — queued ones
  // ride chat.ts's in-memory map keyed by the queued send id.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  // BUG-038: chips are scoped to the chat like drafts — switching chats used
  // to carry them over, and Send delivered them (and any caption text) to
  // the NEWLY active chat.
  const attachmentsByChat = useRef<Record<string, PendingAttachment[]>>({})
  const lastChatsRef = useRef(storedId)
  // The ChatGPT-style attach action sheet (library / camera / file).
  const [attachOpen, setAttachOpen] = useState(false)

  useFocusEffect(
    useCallback(() => {
      // Attention dispatch suppresses toasts for the chat being watched —
      // "watched" means focused, not just mounted.
      chatTabFocused.set(true)
      void clearBadge()
      return () => { chatTabFocused.set(false) }
    }, []),
  )

  // The Skills screen hands over a command to pre-fill (`/model ` etc).
  //
  // NOTE: the Fleet screen used to hand over a bot identity here and this
  // effect called setActiveBot() + newChat() — i.e. EVERY "Chat" tap minted a
  // brand-new `Bot · <name>` session instead of reopening the bot's one
  // canonical `Bot Chat`. That was the "bots are just sessions with extra
  // prompts" bug: opening a bot now goes through openBotChat() at the call
  // site (exact-title lookup → resume), and this hand-off is gone.
  const { draft } = useLocalSearchParams<{ draft?: string }>()
  const lastDraft = useRef<string | undefined>(undefined)

  // ── Bot Switcher (round-2 feedback) ─────────────────────────────────────
  // Direct switching, no confirm: pick a bot → its canonical chat opens;
  // pick the default agent → a fresh default chat. The sheet stays up with
  // a spinner while the switch runs, and a failure surfaces as an alert
  // with the sheet still open (the user can retry or pick another bot).
  const pickBot = async (name: string) => {
    if (switchingBot !== null) return
    setSwitchingBot(name)
    try {
      // A bot's ONE canonical Bot Chat — `Moch` (the launch/default profile)
      // is a bot too, so it opens ITS Bot Chat rather than minting a fresh
      // launch-profile session. openBotChat owns the identity marker; an
      // ordinary bot-scoped chat is never created (Bot Mode).
      await openBotChat(name)
      setBotSwitcherOpen(false)
    } catch (e) {
      alertOk(
        t('chat.bot.switchFailed', { name: activeBotTitle(name) }),
        e instanceof Error ? e.message : String(e),
      )
    } finally {
      setSwitchingBot(null)
    }
  }
  const closeBotSwitcher = () => { if (switchingBot === null) setBotSwitcherOpen(false) }

  // ── Per-chat composer drafts ─────────────────────────────────────────────
  // Leaving a chat (sidebar switch, attention-toast hop, app restart) must
  // never cost the text being typed: restore on switch, mirror every change.
  // The swap also resets the reading position: scroll state must not carry
  // over from the previous chat (stale offset, stray jump FAB, wrong
  // bottom-follow). scrollMetrics is a ref declared below — safe to touch
  // here because the effect body runs after the render completes.
  useEffect(() => {
    // BUG-038: swap the attachment chips alongside the draft — stash the
    // outgoing chat's chips, restore the incoming chat's (or none).
    const prev = lastChatsRef.current
    if (prev !== storedId) {
      if (prev) attachmentsByChat.current[prev] = pendingAttachments
      setPendingAttachments(attachmentsByChat.current[storedId] ?? [])
      lastChatsRef.current = storedId
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedId])

  // Reset per-chat state before first paint. The FlatList is inverted and
  // keyed by storedId, so offset 0 IS the latest message on frame 1 — no
  // hidden parking pass or scroll-to-end race needed.
  useLayoutEffect(() => {
    setInput(draftFor(storedId))
    setStick(true)
    setShowScrollBtn(false)
    scrollMetrics.current = { y: 0, contentH: 0, viewH: 0 }
    stickUntil.current = 0
  }, [storedId])

  const updateInput = useCallback((t: string) => {
    setInput(t)
    setDraft(storedId, t)
  }, [storedId])

  useEffect(() => {
    if (!draft || draft === lastDraft.current) return
    lastDraft.current = draft
    updateInput(draft)
  }, [draft, updateInput])

  // A cold boot / backend switch lands on a LOCAL new-chat window — no
  // server session exists until the first message. ensureSession is NOT
  // called here on purpose: it would create an empty session (and a saved
  // row) on every launch.
  useEffect(() => {
    openLocalChatIfNeeded()
  }, [sid])
  // ^ sidValue rides the deps so a purge (device switch) that blanks the
  // screen re-opens the window, while a landing resume (sid set) does not.

  // OpenCode hydration: an OC-backed chat's transcript lives on the OpenCode
  // server, not in the gateway's resume payload. Pull while idle — forced on
  // mount/switch so a turn that completed while away (or a partial row left
  // by a retired stream) is reconciled with the completed server history.
  // chat.ts owns the throttle, in-flight guard, busy re-check and the merge.
  // `msgs.length` is deliberately NOT a dep: hydration changes messages, and
  // re-running on that change would loop.
  useEffect(() => {
    if (!ocMode || !sid || !storedId) return
    if (busy) return // never fight the streaming path
    void hydrateOcHistory(sid, { force: true }).catch(() => {})
  }, [ocMode, sid, storedId, busy])

  // Coming back to this tab (app resume, another tab, drawer) must refresh an
  // OpenCode transcript: the turn may have finished while SSE was detached.
  // The stable callback reads live values through a ref, and the local guard
  // plus chat.ts's per-live-id in-flight set make rapid tab switches safe.
  const ocHydrateCtx = useRef({ ocMode, sid, storedId, busy })
  ocHydrateCtx.current = { ocMode, sid, storedId, busy }
  const focusHydrating = useRef(false)
  useFocusEffect(
    useCallback(() => {
      const h = ocHydrateCtx.current
      if (!h.ocMode || !h.sid || !h.storedId || h.busy) return
      if (focusHydrating.current) return
      focusHydrating.current = true
      void hydrateOcHistory(h.sid, { force: true })
        .catch(() => {})
        .finally(() => { focusHydrating.current = false })
    }, []),
  )

  useEffect(() => {
    if (!online) return
    void (async () => {
      try {
        await loadCatalog()
        await flushOutbox().catch(() => {})
      } catch {
        /* the offline banner already explains it */
      }
    })()
  }, [online])

  // Mirror the gateway's reasoning-display config so the chat renderer honors
  // the "Show thinking in the chat" toggle (Agent tab) even when the user
  // never visits that tab this run. Re-reads on session switch — the config
  // is session-scoped, and a different chat may hide thinking.
  useEffect(() => {
    if (!online || !sid) return
    void fetchReasoningDisplay(sid)
  }, [online, sid])

  // ── Bottom-of-list tracking (inverted coordinates) ─────────────────────
  // The FlatList is inverted (`data={reversedMsgs}`): offset 0 is the visual
  // bottom (the newest message, 16px above the composer) and scrolling UP
  // toward older history increases `y`. Long chats therefore open at the
  // latest message on frame 1 without measuring or scrolling through older
  // virtualized batches first.
  const scrollMetrics = useRef({ y: 0, contentH: 0, viewH: 0 })
  // While a programmatic jump-to-bottom is in flight, intermediate scroll
  // events and content-size changes must not cancel `stick` mid-flight.
  const stickUntil = useRef(0)
  const scrollListToEnd = useCallback((animated: boolean) => {
    if (animated) stickUntil.current = Date.now() + 500
    listRef.current?.scrollToOffset?.({ offset: 0, animated })
  }, [])
  const evalBottom = useCallback(() => {
    if (Date.now() < stickUntil.current) return
    // Position policy (band width, overscroll clamp, fits-viewport) lives in
    // src/lib/chatScroll.ts — pinned offline by scripts/test-chat-scroll.ts.
    const verdict = evaluateStick(scrollMetrics.current)
    if (!verdict) return // no layout yet — hold the previous state
    setStick(verdict.stick)
    setShowScrollBtn(verdict.showJump)
  }, [])
  const readScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    scrollMetrics.current = { y: contentOffset.y, contentH: contentSize.height, viewH: layoutMeasurement.height }
    evalBottom()
  }, [evalBottom])

  const lastMsgText = msgs[msgs.length - 1]?.text
  const lastMsgSegs = msgs[msgs.length - 1]?.segments?.length
  useEffect(() => {
    // At offset 0, new bubbles and streaming tokens grow directly from the
    // bottom edge natively; only nudge back to 0 when the chatScroll policy
    // says the user is still pinned within reach (see src/lib/chatScroll.ts).
    if (!shouldFollowOnAppend(scrollMetrics.current, { stick, quietWindow: Date.now() < stickUntil.current })) return
    const t = setTimeout(() => scrollListToEnd(!busy), 16)
    return () => clearTimeout(t)
  }, [msgs.length, lastMsgText, lastMsgSegs, tls.length, stick, busy, scrollListToEnd])

  /** Force the view to the newest message — every send dispatch and the
   *  jump-to-latest button. Sending while scrolled up must never leave the
   *  user's own message off-screen. */
  const jumpToLatest = useCallback(() => {
    stickUntil.current = Date.now() + 800
    setStick(true)
    setShowScrollBtn(false)
    scrollListToEnd(true)
  }, [scrollListToEnd])

  // ── Slash palette ──────────────────────────────────────────────────────
  const slashQuery = input.startsWith('/') ? input.split('\n')[0] : null

  useEffect(() => {
    if (slashQuery === null) {
      setSlashItems(null)
      return
    }
    const seq = ++slashSeq.current
    // Instant paint from the locally loaded registry — no debounce, no RPC
    // wait. The debounced gateway call below only refines the ranking; when
    // it fails, the local paint survives instead of collapsing the palette.
    setSlashItems(localCompleteSync(slashQuery).slice(0, MAX_SLASH_ITEMS))
    const t = setTimeout(async () => {
      try {
        // Resolve the optimistic switch/create windows to a real live id so
        // the completion RPC never sees a `pending:` placeholder key.
        const live = await activeLiveId().catch(() => null)
        const items = await completeSlash(slashQuery, live ?? undefined)
        if (seq === slashSeq.current) setSlashItems(items.slice(0, MAX_SLASH_ITEMS))
      } catch {
        // Keep the local paint.
      }
    }, 120)
    return () => clearTimeout(t)
  }, [slashQuery, storedId])

  const runSlash = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return

    // Bare commands the gateway can only answer with usage text get a native
    // picker instead: /model opens the full provider/model/scope sheet, and
    // every command the catalog marks options/mixed opens its subcommand
    // chooser. Typed arguments keep the typed path untouched.
    const parsed = parseSlashCommand(trimmed)
    if (parsed && !parsed.args) {
      const canonical = canonicalName(parsed.name)
      // Bare /new starts a fresh app-side chat exactly like the sidebar
      // button: the gateway's own reply ("New session started!") only resets
      // its server-side session and would print a card in the current chat
      // without switching anything.
      if (canonical === 'new') {
        updateInput('')
        setSlashItems(null)
        void newChat().catch((e) => alertOk(t('chat.newChatFailed'), e instanceof Error ? e.message : String(e)))
        return
      }
      const target = interactiveTarget(canonical, parsed.args)
      if (target === 'model-picker') {
        updateInput('')
        setSlashItems(null)
        setModelPickerOpen(true)
        return
      }
      // Bare /help // /commands open the command browser instead of the
      // gateway's dump; the sheet self-loads the registry (spinner) when it
      // has not landed yet, so this works on an unloaded session too.
      if (target === 'catalog') {
        updateInput('')
        setSlashItems(null)
        setCatalogOpen(true)
        return
      }
      if (target === 'options') {
        updateInput('')
        setSlashItems(null)
        setOptionSheet({ command: canonical, allowText: argumentModeFor(canonical) === 'mixed' })
        return
      }
    }

    try {
      // activeLiveId resolves the optimistic windows (new-chat create,
      // detached switch placeholder) to a REAL live id — a `pending:` key
      // must never reach the gateway.
      const s = await activeLiveId()
      const out: SlashOutcome = await runCommand(trimmed, s)

      if (out.action === 'send' && out.text) {
        // The gateway asked for this text to go through as a real turn.
        updateInput('')
        setSlashItems(null)
        jumpToLatest()
        await sendPrompt(out.text)
        return
      }
      if (out.action === 'prefill' && out.text) {
        // Review-then-send: drop it in the composer, don't send.
        updateInput(out.text)
        setSlashItems(null)
        return
      }
      if (out.action === 'show' && out.text) {
        // Command outputs render as the card family; the label is normalized
        // here once (slashLabel covers both name conventions out of slash.ts).
        // BUG-015: file the card onto the chat the command RAN against (`s`,
        // resolved before the await) — the active chat may have changed.
        pushLocalMessage(out.text, 'assistant', {
          name: slashLabel(out.name),
          variant: out.subtype,
          suggestion: out.suggestion,
          hint: out.hint,
        }, s)
      }
      updateInput('')
      setSlashItems(null)
    } catch (e) {
      // BUG-041: the composer was cleared before the dispatch — a failed
      // command must give the text back (the plain-send failure path does).
      updateInput(trimmed)
      alertOk(t('chat.alert.commandFailed'), e instanceof Error ? e.message : String(e))
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────
  // ChatGPT's attach flow: + opens a three-way action sheet (library /
  // camera / file); picks land as preview chips. The size gates run at BOTH
  // ends: non-image picks over the 8 MB cap are rejected here (hours of 3
  // kB/s link otherwise), images ride the JPEG ladder inside the send (an
  // over-cap ORIGINAL still shrinks to the 1.8 MB auto-approve budget), and
  // processAttachments re-checks the cap defensively before uploading.
  const canAttach = online && !recording && !(steerMode && busy) && !ocMode // steer is text-only; OpenCode prompts are text-only too
  const addAttachment = (att: PendingAttachment) => {
    if (att.kind !== 'image' && att.size != null && att.size > ATTACH_MAX_BYTES) {
      alertOk(
        t('chat.alert.attachTooLargeTitle'),
        t('chat.alert.attachTooLargeBody', {
          name: att.name,
          size: formatBytes(att.size),
          limit: formatBytes(ATTACH_MAX_BYTES),
        }),
      )
      return
    }
    setPendingAttachments((cur) => {
      if (cur.length >= MAX_ATTACHMENTS) {
        alertOk(t('chat.alert.attachLimitTitle'), t('chat.alert.attachLimitBody', { n: MAX_ATTACHMENTS }))
        return cur
      }
      return [...cur, att]
    })
  }

  const pickAsset = (a: ImagePicker.ImagePickerAsset) => {
    const isVideo = a.type === 'video'
    const kind: PendingAttachment['kind'] = isVideo ? 'video' : 'image'
    addAttachment({
      id: `att${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      uri: a.uri,
      name: a.fileName ?? (isVideo ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
      size: a.fileSize ?? undefined,
      mime: a.mimeType ?? undefined,
      width: a.width,
      height: a.height,
      state: 'pick',
    })
  }

  const pickFromLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) {
        alertOk(t('chat.alert.photosDeniedTitle'), t('chat.alert.photosDeniedBody'))
        return
      }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'] })
      if (!r.canceled && r.assets?.length) pickAsset(r.assets[0])
    } catch (e) {
      alertOk(t('chat.alert.pickerFailed'), e instanceof Error ? e.message : String(e))
    }
  }

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) {
        alertOk(t('chat.alert.cameraDeniedTitle'), t('chat.alert.cameraDeniedBody'))
        return
      }
      const r = await ImagePicker.launchCameraAsync()
      if (!r.canceled && r.assets?.length) pickAsset(r.assets[0])
    } catch (e) {
      alertOk(t('chat.alert.cameraFailed'), e instanceof Error ? e.message : String(e))
    }
  }

  const pickFile = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
      if (r.canceled || !r.assets?.length) return
      const f = r.assets[0]
      const inferred = mediaKindForPath(f.name)
      const kind: PendingAttachment['kind'] =
        inferred === 'unknown' || inferred === 'file' ? 'file' : inferred
      addAttachment({
        id: `att${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind,
        uri: f.uri,
        name: f.name,
        size: f.size ?? undefined,
        mime: f.mimeType ?? undefined,
        state: 'pick',
      })
    } catch (e) {
      alertOk(t('chat.alert.pickerFailed'), e instanceof Error ? e.message : String(e))
    }
  }

  const openAttachSheet = () => {
    if (!canAttach) return
    setAttachOpen(true)
  }

  /** Chips update in place as the attach pipeline progresses. */
  const patchAttachment = useCallback((id: string, patch: Partial<PendingAttachment>) => {
    setPendingAttachments((cur) => cur.map((a) => a.id === id ? { ...a, ...patch } : a))
  }, [])

  // "Ask Moch" share target: a share delivered by shareIn.ts lands here.
  // Text merges into the composer draft; files ride the SAME addAttachment
  // gates as a picked file (size/count caps, alerts). Consumed in one pass —
  // ack first so a re-render can't double-apply — and nothing auto-sends:
  // the user reviews the composer and taps Send (ChatGPT's share behavior).
  useEffect(() => {
    if (!sharedIn) return
    // BUG-113: a COLD share arrives before this screen owns a session, and
    // `draftFor('')` is '' — so the text was written to the empty draft key and
    // then wiped when the new session landed and re-read its own draft
    // (chat.tsx: `setInput(draftFor(storedId))`). Hold the share in the inbox
    // until a session exists; the effect re-runs on `storedId` and lands the
    // text in the right draft. Files are deferred with it.
    if (!storedId) return
    ackShareIn()
    const cur = draftFor(storedId)
    const merged = applySharedToDraft(cur, sharedIn)
    if (merged !== cur) updateInput(merged)
    sharedIn.files.forEach((f: SharedFile, i: number) => {
      const inferred = mediaKindForPath(f.name)
      const kind: PendingAttachment['kind'] =
        inferred === 'unknown' || inferred === 'file' ? 'file' : inferred
      addAttachment({
        id: `shr${sharedIn.at}_${i}_${Math.random().toString(36).slice(2, 8)}`,
        kind,
        uri: f.uri,
        name: f.name,
        size: f.size,
        mime: f.mime,
        state: 'pick',
      })
    })
    if (sharedIn.skipped > 0) {
      alertOk(
        t('chat.alert.shareSkippedTitle'),
        sharedIn.skipped === 1
          ? t('chat.alert.shareSkippedBodyOne', { limit: formatBytes(ATTACH_MAX_BYTES) })
          : t('chat.alert.shareSkippedBodyMany', { n: sharedIn.skipped, limit: formatBytes(ATTACH_MAX_BYTES) }),
      )
    }
    // One-shot per share: ack above clears the trigger, so the closed-over
    // helpers (updateInput/addAttachment) are only read on the firing pass.
    // `storedId` is a real dependency now: a cold share waits for it (BUG-113).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedIn, storedId])


  const send = async () => {
    if (recording) return // finishing the take wins over sending
    const text = input.trim()
    if (!text && pendingAttachments.length === 0) return
    // Whatever this dispatch turns into (turn, steer, queued message), the
    // user's eye belongs at the newest message.
    jumpToLatest()
    // BUG-042: only KNOWN commands dispatch — any other leading-slash text
    // ("/usr/bin/env — what's in there?") is a normal message the user wants
    // answered, not a command error that eats the typed text.
    // BH-000023: an empty catalog (offline / pre-boot) must not guess
    // "command" either — that dead-end alert ate the text AND bypassed the
    // offline outbox. Hold for ONE loadCatalog() (it fails fast offline),
    // then re-decide: known → dispatch; unknown or still unloaded → fall
    // through, so the text reaches sendPrompt and the offline machinery
    // (failed row + outbox retry) owns it.
    if (text.startsWith('/') && pendingAttachments.length === 0 && (await resolveSlashRoute(text)) === 'command') {
      updateInput('')
      await runSlash(text)
      return
    }
    // Steer mode is the explicit "inject NOW" path; everything else sent
    // mid-turn queues (harness-style) and goes out when the turn ends.
    // Steer is text-only — the attach button is gated off in steer mode.
    if (steerMode && busy) {
      updateInput('')
      setSteerMode(false)
      try {
        // Fire-and-forget: the haptics bridge round-trip must not delay the
        // steer (same as the queue-send path below).
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        await steerRun(text)
      } catch (e) {
        updateInput(text)
        alertOk(t('chat.alert.steerFailed'), e instanceof Error ? e.message : t('chat.alert.unknown'))
      }
      return
    }
    if (busy) {
      if (!storedId) {
        // BUG-075: a silent no-op — say why the send didn't happen.
        alertOk(t('chat.alert.openingTitle'), t('chat.alert.openingBody'))
        return // keep the text
      }
      // Attachment-only sends queue with empty text (allowEmpty); the chips
      // ride the in-memory attach map keyed by the queued id.
      const item = enqueueSend(storedId, text, { allowEmpty: pendingAttachments.length > 0 })
      if (!item) {
        alertOk(t('chat.alert.queueFullTitle'), t('chat.alert.queueFullBody'))
        return
      }
      setQueuedAttachments(item.id, pendingAttachments)
      setPendingAttachments([])
      updateInput('')
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      return
    }
    try {
      // Keep the chips visible through the upload — their state machine
      // (preparing → uploading → ready/failed) tracks the attach pipeline.
      updateInput('')
      // Fire-and-forget: don't delay the user bubble on the haptics bridge.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      const sentIds = new Set(pendingAttachments.map((a) => a.id))
      await sendPrompt(text, { attachments: pendingAttachments, onAttachment: patchAttachment })
      // Clear only THIS send's chips — anything added mid-upload stays.
      setPendingAttachments((cur) => cur.filter((a) => !sentIds.has(a.id)))
    } catch (e) {
      updateInput(text)
      // Chips stay in the strip, reset to re-sendable — anything the failed
      // attempt had attached was detached server-side, so a re-send cannot
      // duplicate attachments.
      setPendingAttachments((cur) => cur.map((a) => ({ ...a, state: 'pick' as const, error: undefined, path: undefined })))
      alertOk(t('chat.alert.sendFailed'), e instanceof Error ? e.message : t('chat.alert.unknown'))
    }
  }

  // ── Voice ──────────────────────────────────────────────────────────────
  const stopRecTimer = () => {
    if (recTimer.current) {
      clearInterval(recTimer.current)
      recTimer.current = null
    }
  }

  const finishRecording = async () => {
    stopRecTimer()
    setRecording(false)
    let uri: string | null = null
    try {
      await recorder.stop()
      uri = recorder.uri ?? null
    } catch (e) {
      alertOk(t('chat.alert.recordingFailed'), e instanceof Error ? e.message : t('chat.alert.unknown'))
      return
    }
    if (!uri) {
      alertOk(t('chat.alert.recordingFailed'), t('chat.alert.noAudio'))
      return
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      const { transcript } = await transcribeRecording(uri)
      // The transcript landing in the composer IS the success feedback — a
      // dialog here was a tap-to-dismiss speed bump on every voice note.
      updateInput(transcript)
    } catch (e) {
      alertOk(t('chat.alert.transcriptionFailed'), e instanceof Error ? e.message : t('chat.alert.unknown'))
    }
  }

  /** Stop and throw the take away — the strip's ✕. */
  const cancelRecording = async () => {
    stopRecTimer()
    setRecording(false)
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) } catch {}
    try { await recorder.stop() } catch {}
  }

  const toggleRecord = async () => {
    if (voiceState) return
    try {
      if (recording) {
        await finishRecording()
        return
      }
      const st = await AudioModule.requestRecordingPermissionsAsync()
      if (!st.granted) {
        alertOk(t('chat.alert.micDeniedTitle'), t('chat.alert.micDeniedBody'))
        return
      }
      await recorder.prepareToRecordAsync()
      recorder.record()
      setRecording(true)
      setRecSecs(0)
      recSecsRef.current = 0
      recTimer.current = setInterval(() => {
        // BUG-048: the limit check lives OUTSIDE the state updater — updaters
        // must be pure, and finishRecording() (async: recorder stop, haptics,
        // transcription) is not idempotent.
        recSecsRef.current += 1
        setRecSecs(recSecsRef.current)
        if (recSecsRef.current >= 120) void finishRecording()
      }, 1000)
    } catch (e) {
      stopRecTimer()
      setRecording(false)
      alertOk(t('chat.alert.recordingFailed'), e instanceof Error ? e.message : t('chat.alert.unknown'))
    }
  }

  useEffect(() => stopRecTimer, [])
  useEffect(() => {
    if (!busy) setSteerMode(false)
  }, [busy])

  // The finished-turn tool log collapses on its own; expanded review is a
  // momentary state, so any turn start/end or chat switch re-collapses it.
  useEffect(() => { setToolsOpen(false) }, [storedId, busy])

  // Reset the answer fields whenever the set of questions on screen changes
  // (the active one, or the aggregate card's foreign ones).
  const questionKey = `${req?.id ?? ''}|${foreign.map((f) => f.id).join(',')}`
  useEffect(() => {
    setAnswerText('')
    setSecretValue('')
    setBatchAnswers({})
  }, [questionKey])

  // Per-request (BUG-086: the same machinery answers the active chat's
  // question AND each foreign request from the aggregate card).
  const isBatchClarifyOf = (r: PendingRequest) => r.method === 'clarify' && !!r.questions?.length
  const approvalChoicesFor = (r: PendingRequest) => {
    if (r.method !== 'approval') return []
    const offered = r.choices?.length ? r.choices : ['once', 'session', 'always', 'deny']
    return offered.filter((c) => {
      if (c === 'always' && r.allowPermanent === false) return false
      if (c === 'session' && r.allowSession === false) return false
      return true
    })
  }

  /** The approval / clarify / sudo-secret question card — one renderer for
   *  every answerable question (the active session's own, and each foreign
   *  request expanded from the BUG-086 aggregate card). */
  const questionCard = (r: PendingRequest) => {
    // BH-000025: the batch Send gate — a missing qid is indistinguishable
    // from a DELIBERATE skip on the server (clarify_tool maps it to "" with
    // no timed_out flag) and retire() makes the question unrecoverable, so
    // Send stays off until EVERY question has a real answer.
    const batchMissing = isBatchClarifyOf(r) ? countUnanswered(r.questions ?? [], batchAnswers) : 0
    const approvalLabel = (c: string) =>
      c === 'once'
        ? t('chat.approval.allow')
        : c === 'session'
          ? t('chat.approval.allowSession')
          : c === 'always'
            ? t('chat.approval.allowAlways')
            : t('chat.approval.deny')
    return (
    <>
      {r.method === 'approval' ? (
        <View style={s.sheet}>
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <Icon name="shield-checkmark-outline" size={15} color={C.amber} />
            <Txt size={13} weight="800" style={s.sheetTitle}>
              {r.replayed ? t('chat.approval.restored') : t('chat.approval.title')}
            </Txt>
          </View>
          {/* BUG-082: the body scrolls inside a height-capped card; the
              choices row below stays pinned and always reachable, no
              matter how long the command/description is. */}
          <ScrollView style={s.sheetScroll} nestedScrollEnabled>
            {r.toolName ? (
              <Txt size={10.5} weight="700" color={C.textFaint} mono ltr style={s.sheetKicker}>{r.toolName}</Txt>
            ) : null}
            <Text style={[s.sheetBody, rtlText]} selectable>
              {r.command ?? r.description ?? t('chat.approval.defaultCommand')}
            </Text>
            {r.description && r.description !== r.command ? (
              <Text style={[s.sheetDesc, rtlText]}>{r.description}</Text>
            ) : null}
          </ScrollView>
          <View style={[s.sheetRow, { flexDirection: dir.row }]}>
            {approvalChoicesFor(r).map((c) => {
              const deny = c === 'deny'
              const onPress = () => {
                // BUG-050: refusing the agent is a warning, not a
                // success — the haptic language must match the red
                // Deny styling (AlertDialog uses Warning for
                // destructive choices too).
                void Haptics.notificationAsync(
                  deny ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
                )
                void respondApproval(c as 'once' | 'session' | 'always' | 'deny', false, r)
              }
              if (deny) {
                return (
                  <GhostBtn
                    key={c}
                    onPress={onPress}
                    accessibilityLabel={approvalLabel(c)}
                    label={approvalLabel(c)}
                    style={[s.sheetBtn, s.denyBtn]}
                    textStyle={s.denyText}
                  />
                )
              }
              return (
                <PrimaryBtn
                  key={c}
                  onPress={onPress}
                  accessibilityLabel={approvalLabel(c)}
                  label={approvalLabel(c)}
                  style={[s.sheetBtn, c === 'always' && { backgroundColor: C.accentDark }]}
                />
              )
            })}
          </View>
        </View>
      ) : null}

      {r.method === 'clarify' ? (
        <View style={s.sheet}>
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <Icon name="help-circle-outline" size={15} color={C.accent} />
            <Txt size={13} weight="800" style={s.sheetTitle}>{t('chat.clarify.title')}</Txt>
          </View>
          {isBatchClarifyOf(r) ? (
            <>
              {/* BUG-082: unbounded question count — the list scrolls;
                  the Send button below stays pinned. */}
              <ScrollView style={s.sheetScroll} nestedScrollEnabled>
              {r.questions!.map((q) => (
                <View key={q.qid} style={{ marginBottom: 10 }}>
                  <Text style={[s.qText, rtlText]}>{q.question ?? q.qid}</Text>
                  {q.choices?.map((o) => (
                    <Pressable
                      key={o}
                      style={({ pressed }) => [s.clarifyBtn, batchAnswers[q.qid] === o && s.clarifyOn, pressed && s.btnPressed]}
                      onPress={() => setBatchAnswers((a) => ({ ...a, [q.qid]: o }))}
                      accessibilityRole="button"
                      accessibilityState={{ selected: batchAnswers[q.qid] === o }}
                    >
                      <Text style={[s.clarifyText, batchAnswers[q.qid] === o && { color: C.onAccent }]}>{o}</Text>
                    </Pressable>
                  ))}
                  {!q.choices?.length ? (
                    <TextInput
                      style={[s.qInput, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}
                      value={batchAnswers[q.qid] ?? ''}
                      onChangeText={(val) => setBatchAnswers((a) => ({ ...a, [q.qid]: val }))}
                      placeholder={t('chat.clarify.placeholder')}
                      placeholderTextColor={C.textFaint}
                      // BUG-049: the question text, not an internal id.
                      accessibilityLabel={t('chat.clarify.answerA11y', { question: q.question ?? q.qid })}
                    />
                  ) : null}
                </View>
              ))}
              </ScrollView>
              {batchMissing > 0 ? (
                <Txt size={11} color={C.amber} center style={s.qHint}>
                  {batchMissing === 1
                    ? t('chat.clarify.pending.one')
                    : t('chat.clarify.pending.many', { n: batchMissing })}
                </Txt>
              ) : null}
              <PrimaryBtn
                disabled={batchMissing > 0}
                accessibilityLabel={t('chat.clarify.send')}
                label={t('chat.clarify.send')}
                onPress={() => { if (batchMissing > 0) return; void respondClarifyBatch(batchAnswers, r) }}
                style={s.sheetBtnFull}
              />
            </>
          ) : (
            <>
              {/* BUG-082: long question/many options scroll; the answer
                  input stays pinned. */}
              <ScrollView style={s.sheetScroll} nestedScrollEnabled>
              <Text style={[s.sheetBody, rtlText]}>{r.question ?? t('chat.clarify.needed')}</Text>
              {r.options?.map((o) => (
                <Pressable
                  key={o}
                  style={({ pressed }) => [s.clarifyBtn, pressed && s.btnPressed]}
                  onPress={() => { void respondClarify(o, r) }}
                  accessibilityRole="button"
                  accessibilityLabel={o}
                >
                  <Text style={[s.clarifyText, rtlText]}>{o}</Text>
                </Pressable>
              ))}
              </ScrollView>
              <View style={[s.clarifyRow, { flexDirection: dir.row }]}>
                <TextInput
                  style={[s.qInput, { flex: 1, textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}
                  value={answerText}
                  onChangeText={setAnswerText}
                  placeholder={t('chat.clarify.orTypePlaceholder')}
                  placeholderTextColor={C.textFaint}
                  accessibilityLabel={t('chat.clarify.answerLabel')}
                />
                <Pressable
                  style={({ pressed }) => [s.miniSend, pressed && s.btnPressed]}
                  onPress={() => {
                    // BUG-075: an empty tap used to wipe the field and do
                    // nothing — keep the text, and only send a real answer.
                    const val = answerText.trim()
                    if (!val) return
                    setAnswerText('')
                    void respondClarify(val, r)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.clarify.sendA11y')}
                >
                  <Icon name="arrow-up" size={17} color={C.onAccent} />
                </Pressable>
              </View>
            </>
          )}
        </View>
      ) : null}

      {(r.method === 'sudo' || r.method === 'secret') ? (
        <View style={s.sheet}>
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <Icon name="lock-closed-outline" size={15} color={C.red} />
            <Txt size={13} weight="800" color={C.red} style={s.sheetTitle}>
              {r.method === 'sudo' ? t('chat.sudo.title') : t('chat.secret.title')}
            </Txt>
          </View>
          {/* BUG-082: long prompt scrolls; the password field and the
              Send/Deny row stay pinned. */}
          <ScrollView style={s.sheetScroll} nestedScrollEnabled>
            <Text style={[s.sheetBody, rtlText]} selectable>
              {r.prompt}
            </Text>
          </ScrollView>
          <TextInput
            style={[s.qInput, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}
            value={secretValue}
            onChangeText={setSecretValue}
            placeholder={
              r.method === 'sudo'
                ? t('chat.secret.sudoPlaceholder')
                : t('chat.secret.valuePlaceholder', { name: r.envVar ?? 'secret' })
            }
            placeholderTextColor={C.textFaint}
            secureTextEntry
            accessibilityLabel={t('chat.secret.a11y')}
          />
          <View style={[s.sheetRow, { flexDirection: dir.row, marginTop: 10 }]}>
            <PrimaryBtn
              label={t('chat.clarify.send')}
              onPress={() => { const v = secretValue; setSecretValue(''); void respondPrivileged(true, v || undefined, r) }}
              style={s.sheetBtn}
            />
            <GhostBtn
              label={t('chat.approval.deny')}
              onPress={() => { setSecretValue(''); void respondPrivileged(false, undefined, r) }}
              style={[s.sheetBtn, s.denyBtn]}
              textStyle={s.denyText}
            />
          </View>
        </View>
      ) : null}
    </>
    )
  }

  // Text OR attachments — ChatGPT sends captionless photos.
  const canSend = !recording && (!!input.trim() || pendingAttachments.length > 0)
  const isSlashMode = slashQuery !== null
  const cmdCount = slashItems?.filter((i) => i.kind !== 'skill').length ?? 0
  const skillCount = slashItems?.filter((i) => i.kind === 'skill').length ?? 0
  // Collapsed tool-log label: "bash ×2, read ×4, edit" — the names are the
  // content the user is looking for when the live rows fold away.
  const toolSummary = (() => {
    const counts = new Map<string, number>()
    for (const t of tls) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
  })()

  // Stable row renderer: without this, every stream flush re-created the
  // closure and re-rendered every visible bubble, not just the growing one.
  const onRetryMsg = useCallback((id: string) => { void retryMessage(id).catch(() => {}) }, [])
  // Stable so MessageBubble's memo holds across stream flushes.
  const onEffortPress = useCallback(() => { setOptionSheet({ command: 'reasoning', allowText: false }) }, [])
  // Command-card rows: a suggestion/list tap drops the command in the composer
  // (one leading slash — the card already applies slashLabel).
  const onCommandInsert = useCallback((line: string) => { updateInput(line); setSlashItems(null) }, [updateInput])
  // Card footer + error-card "Browse all commands" chip open the browser.
  const onOpenCatalog = useCallback(() => setCatalogOpen(true), [])
  const renderMsg = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble m={item} onRetry={onRetryMsg} effort={curEffort || undefined} onEffortPress={onEffortPress} onCommandInsert={onCommandInsert} onOpenCatalog={onOpenCatalog} showThinking={showThinking} />
    ),
    [onRetryMsg, onEffortPress, curEffort, onCommandInsert, onOpenCatalog, showThinking],
  )
  // Inverted FlatList places index 0 at offset 0 (the visual bottom above
  // the composer), so the newest messages mount first on open.
  const reversedMsgs = useMemo(() => [...msgs].reverse(), [msgs])
  // FlatList contract: with a stable renderItem, memoized cells only
  // re-evaluate when `extraData` changes. Without this, streaming updates
  // never reach the rows on Fabric — text piles up invisibly until the turn
  // ends ("waits, then dumps the whole reply"). Derived from message state so
  // it changes exactly when a row's content can have: text length, thinking
  // size (reasoning can grow without the answer text changing), segment count
  // (a re-think after output adds a block). Memoized so keystrokes and the
  // 1Hz recording timer stop paying an O(messages×segments) rebuild — the
  // value (and therefore the Fabric contract) is identical.
  const extraData = useMemo(
    () =>
      msgs
        .map((m) => {
          const thinkChars = m.segments?.reduce((n, seg) => n + (seg.kind === 'thinking' ? seg.text.length : 0), 0) ?? 0
          // Media contributes its COUNT only: upload progress/error lives in
          // the mediaState nanostores (per cache key), never here — putting
          // mutable media state in extraData would rebuild this on every tick
          // and tear down the memo contract.
          const mediaCount = m.segments?.reduce((n, seg) => n + (seg.kind === 'media' ? 1 : 0), 0) ?? 0
          return `${m.id}:${m.text.length}:${thinkChars}:${m.segments?.length ?? 0}:${mediaCount}:${m.streaming ? 's' : ''}:${m.status ?? ''}`
        })
        .join('|') + (showThinking ? ':T' : ':F'),
    [msgs, showThinking],
  )

  return (
    // BUG-133: edges={[]} — the SafeAreaView's static bottom inset stacked on
    // top of the kbPad while the IME was open (composer floated one nav-bar
    // inset above the keys) and doubled the resting gap. ScreenShell already
    // pads the top; composerPad above owns the bottom inset exclusively.
    <SafeAreaView style={s.safe} edges={[]}>
      <ScreenShell
        // Mockup: a brand-new chat is titled "New chat"; real sessions keep
        // their title or fall back to the app name.
        title={title || (msgs.length === 0 && !booting ? t('chat.newChat') : 'Moch')}
        onSearch={ocMode ? undefined : () => router.navigate('/(tabs)/sessions')}
        right={
          <>
            {/* New chat — the header's "+" (same flow as the drawer's startNew
                → newChat). Always available, even when the model chip is
                hidden (tray header / no model yet). */}
            <HeaderButton
              onPress={() => {
                router.navigate('/(tabs)/chat')
                void newChat().catch((e) => alertOk(t('chat.newChatFailed'), e instanceof Error ? e.message : String(e)))
              }}
              accessibilityLabel={t('chat.newChat')}
            >
              <Icon name="add" size={18} color={C.text} />
            </HeaderButton>
            {/* OpenCode thinker chip — replaces the hermes model chip in
                OpenCode mode (never hermes provider state on an OC chat).
                Tapping opens the model sheet, which talks to the OC server. */}
            {ocMode ? (
              <Pressable
                style={({ pressed }) => [s.modelChip, pressed && s.btnPressed]}
                onPress={() => setModelPickerOpen(true)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={
                  ocModelForChip
                    ? (ocOneShot
                        ? t('chat.oc.a11yOneShot', { model: ocModelForChip })
                        : t('chat.oc.a11yThinker', { model: ocModelForChip }))
                    : (ocOneShot ? t('chat.oc.a11yOneShotDefault') : t('chat.oc.a11yThinkerDefault'))
                }
              >
                <Text style={s.modelChipText} numberOfLines={1}>
                  {ocOneShot
                    ? (ocModelForChip ? t('chat.oc.oneShotModel', { model: ocModelForChip }) : t('chat.oc.oneShot'))
                    : (ocModelForChip ? t('chat.oc.thinkerModel', { model: ocModelForChip }) : t('chat.oc.thinker'))}
                </Text>
              </Pressable>
            ) : null}
            {!ocMode ? (
              <Pressable
                style={({ pressed }) => [s.modelChip, !curModel && s.modelChipEmpty, pressed && s.btnPressed]}
                onPress={() => setModelPickerOpen(true)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={
                  curModel ? t('chat.model.a11y', { model: curModel }) : t('chat.model.connectA11y')
                }
              >
                <Text style={s.modelChipText} numberOfLines={1}>
                  {curModel || t('chat.model.connect')}
                </Text>
              </Pressable>
            ) : null}
          </>
        }
      >
        <Animated.View style={[s.root, kbPad]}>
          {/* Active-bot profile chip (BUG-111 → round-2 feedback): the pill
              IS the bot switcher — tapping it opens the Bot Switcher sheet
              (the old "Switch back" link is gone; switching is direct).
              Hermes-only: bots don't exist in OC. */}
          {!ocMode && activeBot ? (
            <View style={[s.botRow, { flexDirection: dir.row }]}>
              <Pressable
                style={({ pressed }) => [s.botPill, { flexDirection: dir.row }, pressed && s.btnPressed]}
                onPress={() => setBotSwitcherOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('chat.bot.a11y', { name: activeBotTitle(activeBot) })}
              >
                <Dot kind="green" size={8} />
                <Txt size={11} color={C.textDim}>{t('chat.bot.label')}</Txt>
                <Txt size={11} weight="700" numberOfLines={1} style={s.botName}>@{activeBotTitle(activeBot)}</Txt>
                <Icon name="chevron-down" size={12} color={C.textFaint} />
              </Pressable>
            </View>
          ) : null}

          {/* Offline / connecting banner (mockup: amberSoft strip + mono RETRY)
              — the real connectState / retryNow / queued-count machine stays. */}
          {showOfflineBanner ? (
            <Pressable
              style={({ pressed }) => [s.banner, { flexDirection: dir.row }, pressed && s.btnPressed]}
              onPress={() => { void retryNow().catch(() => {}) }}
              accessibilityRole="button"
              accessibilityLabel={t('chat.offline.reconnectA11y')}
            >
              <Text style={[s.bannerText, rtlText]} numberOfLines={2}>
                {conn === 'connecting'
                  ? t('chat.offline.connecting')
                  : !everOpen
                    ? t('chat.offline.starting')
                    : gerr
                      ? t('chat.offline.retry')
                      : t('chat.offline.plain')}
                {qb.length ? ` · ${t('chat.offline.queued', { n: qb.length })}` : ''}
              </Text>
              <Txt size={10} mono={englishRetry} ltr={englishRetry} color={C.amber}>{t('chat.offline.retryShort')}</Txt>
            </Pressable>
          ) : null}

          {/* Switch/create failure: the optimistic swap already put the user
              on the target chat, so the retry lives HERE — the placeholder
              keeps the cached transcript readable offline in the meantime. */}
          {banner ? (
            <Pressable
              style={({ pressed }) => [s.banner, { flexDirection: dir.row }, pressed && s.btnPressed]}
              onPress={() => banner.retry?.()}
              accessibilityRole="button"
              accessibilityLabel={banner.retry ? t('chat.offline.retryA11y') : undefined}
            >
              <Text style={[s.bannerText, rtlText]} numberOfLines={2}>{banner.text}</Text>
              {banner.retry ? (
                <Txt size={10} mono={englishRetry} ltr={englishRetry} color={C.amber}>{t('chat.offline.retryShort')}</Txt>
              ) : null}
            </Pressable>
          ) : null}

          {/* The list gets its own positioned box so Moch can float over its
              top-right corner without reserving layout height: the transcript
              flows underneath him while scrolling, and the paddingTop reserve
              below keeps the oldest messages clear of him at the top rest. */}
          <View style={s.listWrap}>
          <FlatList
            ref={listRef}
            // Keyed by STORED id: a real chat swap mounts a clean list (no
            // inherited offsets, no wasted row mounts), while a live-id
            // rotation (boot placeholder→real, background reattach) keeps
            // the list and the user's scroll position intact.
            key={storedId ?? 'boot'}
            inverted
            initialNumToRender={20}
            // REVIEW FIX: content grows at the offset-0 end (the visual
            // bottom — new rows prepend, the streaming row grows). Without
            // this, RN keeps the raw contentOffset while cells shift to
            // higher offsets, so reading history while a turn streams creeps
            // toward the newer end on every flush. mVCP re-anchors to the
            // first rendered cell instead — the canonical inverted-chat-list
            // prop for exactly this.
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
            style={s.list}
            data={reversedMsgs}
            keyExtractor={(m) => m.id}
            renderItem={renderMsg}
            extraData={extraData}
            contentContainerStyle={s.listContent}
            keyboardShouldPersistTaps="handled"
            // BUG-133: "interactive" is a documented Android no-op (RN's
            // ScrollView source maps it to 'none'), so drag-to-dismiss never
            // worked. "on-drag" actually dismisses when the transcript drag
            // begins.
            keyboardDismissMode="on-drag"
            onScroll={readScroll}
            onScrollBeginDrag={() => {
              // The user takes the wheel: let position evaluations speak
              // immediately, even if a programmatic follow armed its quiet
              // window a moment ago.
              stickUntil.current = 0
            }}
            onScrollEndDrag={readScroll}
            onMomentumScrollEnd={readScroll}
            onContentSizeChange={(_w, h) => {
              scrollMetrics.current.contentH = h
              const action = contentGrew(scrollMetrics.current, stick)
              if (action === 'follow') {
                scrollListToEnd(!busy)
              } else if (action === 'reevaluate') {
                evalBottom()
              }
            }}
            onLayout={(e) => {
              scrollMetrics.current.viewH = e.nativeEvent.layout.height
              evalBottom()
            }}
            scrollEventThrottle={16}
            ListEmptyComponent={
              booting ? (
                // A chat whose content is still on its way (placeholder +
                // resume over a slow link) must never look like a brand-new
                // chat — the starters are ONLY for genuinely empty ones.
                <View style={s.booting}>
                  <Spinner />
                  <Txt size={12} color={C.textFaint}>{t('chat.loading')}</Txt>
                </View>
              ) : (
                // Empty state (mockup case 1): centered MochiMark 68, title,
                // subtitle, then the four starter cards. The data/logic is the
                // original STARTERS array — only the visual language changed.
                <View style={s.empty}>
                  <MochiMark size={68} />
                  <Txt size={16} weight="800" center style={s.emptyTitle}>{t('chat.empty.title')}</Txt>
                  <Txt size={12} color={C.textDim} center style={s.emptySubtitle}>{t('chat.empty.subtitle')}</Txt>
                  {!ocMode && !curModel && online ? (
                    <Pressable
                      style={({ pressed }) => [s.connectNudge, { flexDirection: dir.row }, pressed && s.starterPressed]}
                      onPress={() => setModelPickerOpen(true)}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.empty.connectModel')}
                    >
                      <Icon name="key-outline" size={15} color={C.accent} />
                      <Text style={[s.connectNudgeText, rtlText]} numberOfLines={2}>
                        {t('chat.empty.connectModel')}
                      </Text>
                      <Icon name={dir.icon.forward} size={14} color={C.accent} />
                    </Pressable>
                  ) : null}
                  <View style={s.starterList}>
                    {STARTERS.map((st) => (
                      <Pressable
                        key={st.key}
                        style={({ pressed }) => [s.starter, { flexDirection: dir.row }, pressed && s.starterPressed]}
                        onPress={() => {
                          // BUG-043: the slash palette only renders while the
                          // composer is focused — the starter must focus it or
                          // the user stares at a lone "/" with no catalog.
                          if (st.slash) {
                            updateInput('/')
                            inputRef.current?.focus()
                          } else updateInput(t(st.key))
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t(st.key)}
                      >
                        <Text style={[s.starterText, rtlText]} numberOfLines={2}>{t(st.key)}</Text>
                        <Icon name={dir.icon.forward} size={14} color={C.accent} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              )
            }
          />

          {/* Tool log + todos — quiet, above the composer. Reasoning lives on
              the message itself (dashed thinking pill), not here. While the
              turn runs the tool rows show live; once it ends the log collapses
              to one tappable line so a finished turn stops eating screen
              space. */}
          {(tls.length > 0 || td.length > 0) ? (
            <View style={s.runFooter}>
              {busy ? (
                <>
                  {tls.slice(-3).map((tool: ToolItem) => <ToolRow key={tool.id} t={tool} />)}
                  {tls.length > 3 ? (
                    <Txt size={11} color={C.textFaint} style={s.moreTools}>{t('chat.tools.more', { n: tls.length - 3 })}</Txt>
                  ) : null}
                </>
              ) : tls.length > 0 && !toolsOpen ? (
                <Pressable
                  style={({ pressed }) => [s.toolsToggle, { flexDirection: dir.row }, pressed && s.btnPressed]}
                  onPress={() => setToolsOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.tools.showA11y', { n: tls.length, summary: toolSummary })}
                >
                  <Icon name="terminal-outline" size={12} color={C.accent} />
                  <Text style={[s.toolsToggleText, rtlText]} numberOfLines={1}>
                    {toolSummary}
                  </Text>
                  <Icon name="chevron-up" size={12} color={C.textFaint} />
                </Pressable>
              ) : tls.length > 0 ? (
                <>
                  <Pressable
                    style={({ pressed }) => [s.toolsToggle, { flexDirection: dir.row }, pressed && s.btnPressed]}
                    onPress={() => setToolsOpen(false)}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.tools.hideA11y')}
                  >
                    <Icon name="terminal-outline" size={12} color={C.accent} />
                    <Text style={[s.toolsToggleText, rtlText]} numberOfLines={1}>
                      {toolSummary}
                    </Text>
                    <Icon name="chevron-down" size={12} color={C.textFaint} />
                  </Pressable>
                  <ScrollView style={s.toolsOpenList} keyboardShouldPersistTaps="handled">
                    {tls.map((tool: ToolItem) => <ToolRow key={tool.id} t={tool} />)}
                  </ScrollView>
                </>
              ) : null}
              {td.length > 0 ? (
                <View style={s.todos}>
                  {/* BUG-077: show what was cut instead of silently dropping. */}
                  {td.slice(0, 4).map((todo, i) => (
                    <Text key={i} style={[s.todo, rtlText]}>
                      {todo.done ? '✓' : '○'} {todo.text}
                    </Text>
                  ))}
                  {td.length > 4 ? (
                    <Text style={s.todoMore}>{t('chat.todo.more', { n: td.length - 4 })}</Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          {showScrollBtn ? (
              <Pressable
                style={({ pressed }) => [s.fab, pressed && s.btnPressed]}
                onPress={jumpToLatest}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={t('chat.jumpLatestA11y')}
              >
              <Icon name="arrow-down" size={19} color={C.text} />
            </Pressable>
          ) : null}

          {/* Slash palette — the mockup's elevated card. Only while the
              composer is focused: the rows' ScrollView is
              keyboardShouldPersistTaps="handled", so tapping a row never blurs
              the input and can never race this gate. */}
          {composerFocused && slashItems && slashItems.length > 0 ? (
            <View style={s.slashPanel}>
              <View style={[s.slashHead, { flexDirection: dir.row }]}>
                <Txt size={10} weight="700" color={C.textFaint} style={s.slashKicker}>{t('chat.slash.kicker')}</Txt>
                <Text style={[s.slashHint, rtlText]}>
                  {t('chat.slash.counts', {
                    commands: cmdCount === 1 ? t('chat.cmd.commandOne') : t('chat.cmd.commandMany', { n: cmdCount }),
                    skills: skillCount === 1 ? t('chat.cmd.skillOne') : t('chat.cmd.skillMany', { n: skillCount }),
                  })}
                </Text>
              </View>
              {/* BUG-054: virtualized — the registry can hold 120+ rows and an
                  unvirtualized ScrollView mounted every one of them on each
                  keystroke's filtered list. */}
              <FlatList
                keyboardShouldPersistTaps="handled"
                style={s.slashList}
                data={slashItems}
                keyExtractor={(it, i) => `${it.kind ?? 'c'}-${it.text.startsWith('/') ? it.text : `/${it.text}`}-${i}`}
                renderItem={({ item: it }) => {
                  // complete.slash returns `text` without the leading slash
                  // and `display` with it, for both commands and skills.
                  const isSkill = it.kind === 'skill'
                  const label = it.display ?? (it.text.startsWith('/') ? it.text : `/${it.text}`)
                  const insertable = it.text.startsWith('/') ? it.text : `/${it.text}`
                  return (
                    <Pressable
                      style={({ pressed }) => [s.slashRow, { flexDirection: dir.row }, pressed && s.slashRowPressed]}
                      onPress={() => {
                        updateInput(insertable)
                        setSlashItems(null)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.slash.a11y', {
                        label,
                        kind: isSkill ? t('chat.slash.skill') : t('chat.slash.command'),
                      })}
                    >
                      <Txt size={12} weight="700" color={C.accent} mono ltr numberOfLines={1} style={s.slashName}>{label}</Txt>
                      <Text
                        style={[s.slashMeta, { textAlign: dir.rtl ? 'left' : 'right' }]}
                        numberOfLines={1}
                      >
                        {it.meta ?? (isSkill ? t('chat.slash.skill') : '')}
                      </Text>
                    </Pressable>
                  )
                }}
              />
            </View>
          ) : null}

          {/* Question cards (hermes gateway questions — none in OpenCode
              mode; the OC ask renders its own card below) */}
          {!ocMode && req ? questionCard(req) : null}

          {/* BUG-086: ONE aggregate card for questions from sessions this
              app isn't tracking (automation/CLI on the host) — collapsed it
              only announces; expanded, each request renders through the same
              answer machinery as the active chat's question above. */}
          {!ocMode && foreign.length > 0 ? (
            <View>
              <View style={s.sheet}>
                <Pressable
                  style={({ pressed }) => [s.foreignHead, { flexDirection: dir.row }, pressed && s.btnPressed]}
                  onPress={() => setForeignOpen(!foreignOpen)}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.foreign.a11y', {
                    title: t('chat.foreign.title'),
                    count: t('chat.foreign.count', { n: foreign.length }),
                    action: foreignOpen ? t('chat.foreign.hide') : t('chat.foreign.show'),
                  })}
                >
                  <Icon name="git-network-outline" size={15} color={C.amber} />
                  <Text style={[s.sheetTitle, s.foreignTitle]} numberOfLines={2}>
                    {t('chat.foreign.title')} ({foreign.length})
                  </Text>
                  <Icon name={foreignOpen ? 'chevron-down' : 'chevron-up'} size={14} color={C.textFaint} />
                </Pressable>
                {!foreignOpen ? <Text style={[s.sheetDesc, rtlText]}>{t('chat.foreign.hint')}</Text> : null}
              </View>
              {foreignOpen ? foreign.map((f) => <View key={f.id}>{questionCard(f)}</View>) : null}
            </View>
          ) : null}

          {/* OpenCode permission ask — the same card language as the hermes
              question cards, answered through the OC server. Keyed to the
              chat it blocks, so a quick switch away hides it. */}
          {ocMode && ocPerm && ocPerm.sid === sid ? (
            <View style={s.sheet}>
              <View style={[s.sheetHead, { flexDirection: dir.row }]}>
                <Icon name="shield-checkmark-outline" size={15} color={C.amber} />
                <Txt size={13} weight="800" style={s.sheetTitle}>{t('chat.ocPerm.title')}</Txt>
              </View>
              <ScrollView style={s.sheetScroll} nestedScrollEnabled>
                {ocPerm.req.message ? (
                  <Txt size={10.5} weight="700" color={C.textFaint} mono ltr style={s.sheetKicker}>{ocPerm.req.message}</Txt>
                ) : null}
                <Text style={[s.sheetBody, rtlText]} selectable>{ocPerm.req.action || t('chat.ocPerm.toolFallback')}</Text>
                {ocPerm.req.resources.length ? (
                  <Text style={[s.sheetDesc, rtlText]}>{ocPerm.req.resources.join(', ')}</Text>
                ) : null}
              </ScrollView>
              <View style={[s.sheetRow, { flexDirection: dir.row }]}>
                <PrimaryBtn
                  label={t('chat.ocPerm.allowOnce')}
                  accessibilityLabel={t('chat.ocPerm.allowOnce')}
                  onPress={() => {
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                    void ocReplyPermission(ocPerm.sid, 'once')
                  }}
                  style={s.sheetBtn}
                />
                <PrimaryBtn
                  label={t('chat.ocPerm.allowAlways')}
                  accessibilityLabel={t('chat.ocPerm.allowAlways')}
                  onPress={() => {
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                    void ocReplyPermission(ocPerm.sid, 'always')
                  }}
                  style={[s.sheetBtn, { backgroundColor: C.accentDark }]}
                />
                <GhostBtn
                  label={t('chat.approval.deny')}
                  accessibilityLabel={t('chat.approval.deny')}
                  onPress={() => {
                    // Refusing the agent is a warning, not a success — same
                    // haptic language as the hermes Deny (BUG-050).
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
                    void ocReplyPermission(ocPerm.sid, 'reject')
                  }}
                  style={[s.sheetBtn, s.denyBtn]}
                  textStyle={s.denyText}
                />
              </View>
            </View>
          ) : null}

          {/* ── Composer: the mockup's rounded pill, safe-area bottom owner ── */}
          <Animated.View style={[s.composerWrap, composerPad]}>
            {queued.length > 0 ? (
              <View style={s.queueStrip}>
                <View style={[s.queueHead, { flexDirection: dir.row }]}>
                  <Txt size={10} weight="700" color={C.amber} style={s.queueKicker}>
                    {t('chat.queue.kicker', { n: queued.length })}
                  </Txt>
                  <Text style={[s.queueStatus, rtlText]} numberOfLines={1}>
                    {busy ? t('chat.queue.whenBusy') : online ? t('chat.queue.sending') : t('chat.queue.waiting')}
                  </Text>
                </View>
                {queued.slice(0, 3).map((q) => {
                  // Edit/remove drop the queued item's attachments (memory-
                  // only, keyed by queued id — see chat.ts): edit moves them
                  // back into the composer, remove drops them. Steer is
                  // HIDDEN for attachment-only items: steerRun no-ops on
                  // empty text, so a handler that deletes before steering
                  // would destroy the message with no steer sent and no
                  // requeue.
                  const editQueued = () => {
                    const atts = takeQueuedAttachments(q.id)
                    removeQueued(storedId, q.id)
                    updateInput(q.text)
                    if (atts.length) {
                      setPendingAttachments((cur) => {
                        // The composer cap still applies when it already holds
                        // chips — the overflow is dropped with a heads-up
                        // (the queued item itself is already gone either way).
                        const room = Math.max(0, MAX_ATTACHMENTS - cur.length)
                        if (atts.length > room) {
                          alertOk(
                            t('chat.alert.attachLimitTitle'),
                            t('chat.alert.attachLimitPartial', { n: room, total: atts.length }),
                          )
                        }
                        return [...cur, ...atts.slice(0, room)]
                      })
                    }
                  }
                  const dropQueued = () => {
                    takeQueuedAttachments(q.id)
                    removeQueued(storedId, q.id)
                  }
                  return (
                  <View key={q.id} style={[s.queueRow, { flexDirection: dir.row }]}>
                    <Pressable
                      style={({ pressed }) => [s.queueMsg, pressed && s.btnPressed]}
                      onPress={editQueued}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.queue.editA11y', { text: q.text.slice(0, 60) })}
                    >
                      <Text style={[s.queueMsgText, rtlText]} numberOfLines={1}>
                        {q.text || t('chat.queue.attachment')}
                      </Text>
                    </Pressable>
                    {busy && q.text.trim() ? (
                      <Pill
                        kind="accent"
                        onPress={() => {
                          const atts = takeQueuedAttachments(q.id)
                          removeQueued(storedId, q.id)
                          jumpToLatest()
                          // If the steer fails, put the whole item back —
                          // text AND media, re-keyed to the fresh entry.
                          steerRun(q.text).catch(() => {
                            const item = enqueueSend(storedId, q.text)
                            if (item) {
                              if (atts.length) setQueuedAttachments(item.id, atts)
                            } else {
                              updateInput(q.text)
                            }
                          })
                        }}
                        accessibilityLabel={t('chat.queue.steerA11y')}
                        style={s.queueSteerPill}
                      >
                        {t('chat.queue.sendNow')}
                      </Pill>
                    ) : null}
                    <Pressable
                      style={({ pressed }) => [s.queueAct, pressed && s.btnPressed]}
                      onPress={dropQueued}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.queue.removeA11y')}
                    >
                      <Icon name="close" size={14} color={C.textDim} />
                    </Pressable>
                  </View>
                  )
                })}
                {queued.length > 3 ? (
                  <Text style={s.queueMore}>{t('chat.queue.more', { n: queued.length - 3 })}</Text>
                ) : null}
              </View>
            ) : null}

            {/* Attachment preview chips — between the queue strip and the pill.
                States live on each PendingAttachment; the elapsed/estimate
                timer is inside AttachmentChip. */}
            {pendingAttachments.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipStrip} keyboardShouldPersistTaps="handled">
                {pendingAttachments.map((att) => (
                  <AttachmentChip
                    key={att.id}
                    att={att}
                    onRemove={() => setPendingAttachments((cur) => cur.filter((a) => a.id !== att.id))}
                    onRetry={() =>
                      // "Retry" a failed chip = make it sendable again: the
                      // pipeline reruns on the next send (a failed attempt
                      // detached anything it had attached, so no duplicates).
                      patchAttachment(att.id, { state: 'pick' as const, error: undefined, path: undefined })
                    }
                  />
                ))}
              </ScrollView>
            ) : null}

            {/* Run status line (mockup): what the agent is doing + the steer
                lever. Hermes-only — session.redirect/steer are gateway RPCs an
                OpenCode chat never speaks. */}
            {busy && !ocMode && !recording ? (
              <View style={[s.runStatus, { flexDirection: dir.row }]}>
                <Text style={[s.runStatusText, rtlText]} numberOfLines={1}>
                  {tls.length
                    ? t('chat.run.running', { name: tls[tls.length - 1].name })
                    : t('chat.run.working')}
                </Text>
                <Pressable
                  onPress={() => setSteerMode(!steerMode)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={steerMode ? t('chat.steer.modeOnA11y') : t('chat.steer.modeA11y')}
                  style={({ pressed }) => [pressed && s.btnPressed]}
                >
                  <Text style={[s.runStatusSteer, steerMode && { color: C.accent }]}>
                    {steerMode ? t('chat.steer.active') : t('chat.steer.label')}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {recording ? (
              // The mockup's recording pill replaces the composer while a take
              // is live: pulsing dot, live waveform, mono timer, Transcribe
              // (stop+transcribe, the same finishRecording path) and discard.
              <VoiceRecStrip
                recorder={recorder}
                secs={recSecs}
                onFinish={() => { void finishRecording() }}
                onCancel={() => { void cancelRecording() }}
              />
            ) : (
              <View style={[s.composer, { flexDirection: dir.row }]}>
                {/* + attach — a 32px btnTint circle, dimmed while busy/offline. */}
                <Pressable
                  style={({ pressed }) => [s.attach, !canAttach && s.attachOff, pressed && s.btnPressed]}
                  onPress={openAttachSheet}
                  disabled={!canAttach}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={
                    canAttach
                      ? t('chat.composer.attachA11y')
                      : steerMode && busy
                        ? t('chat.composer.attachSteerLocked')
                        : t('chat.composer.attachOffline')
                  }
                >
                  <Icon name="add" size={20} color={canAttach ? C.text : C.textFaint} />
                </Pressable>

                <TextInput
                  ref={inputRef}
                  style={[s.input, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}
                  value={input}
                  onChangeText={updateInput}
                  placeholder={
                    isSlashMode
                      ? t('chat.slash.filterPlaceholder')
                      : voiceState === 'transcribing'
                        ? t('chat.composer.placeholderTranscribing')
                        : steerMode && busy
                          ? t('chat.composer.placeholderSteer')
                          : busy
                            ? t('chat.composer.placeholderBusy')
                            : t('chat.composer.placeholder')
                  }
                  placeholderTextColor={C.textFaint}
                  multiline={Platform.OS !== 'web'}
                  returnKeyType="send"
                  onSubmitEditing={() => { if (Platform.OS === 'web') void send() }}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  accessibilityLabel={t('chat.composer.a11y')}
                />

                {busy ? (
                  <Pressable
                    style={({ pressed }) => [s.sendBtn, s.stopBtn, pressed && s.btnPressed]}
                    onPress={() => { void stopRun() }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.composer.stopA11y')}
                  >
                    <Icon name="stop" size={15} color="#FFFFFF" />
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      style={({ pressed }) => [s.micBtn, pressed && s.btnPressed]}
                      onPress={toggleRecord}
                      disabled={!!voiceState}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.composer.recordA11y')}
                    >
                      {voiceState === 'transcribing' ? (
                        <ActivityIndicator color={C.textDim} size="small" />
                      ) : (
                        <Icon name="mic-outline" size={17} color={C.textDim} />
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [s.sendBtn, !canSend && s.sendOff, pressed && s.btnPressed]}
                      onPress={() => { void send() }}
                      disabled={!canSend}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={steerMode && busy ? t('chat.composer.sendSteerA11y') : t('chat.composer.sendA11y')}
                    >
                      <Icon
                        name={isSlashMode ? 'return-down-back' : steerMode && busy ? 'bulb' : 'arrow-up'}
                        size={17}
                        color={canSend ? C.onAccent : C.textFaint}
                      />
                    </Pressable>
                  </>
                )}
              </View>
            )}
          </Animated.View>

          {/* Interactive pickers — attach sources, /model, options/mixed commands, and the command browser */}
          <AttachSheet
            visible={attachOpen}
            onClose={() => setAttachOpen(false)}
            onLibrary={() => void pickFromLibrary()}
            onCamera={() => void takePhoto()}
            onFile={() => void pickFile()}
          />
          <ModelPickerSheet
            open={modelPickerOpen}
            onClose={() => setModelPickerOpen(false)}
            ocMode={ocMode}
            ocOneShot={ocOneShot}
            ocSessionId={storedId || null}
            // The chip's label is the sheet's checked row — per-session picks
            // never reach /api/model/default, so the sheet must be told.
            ocCurrent={ocModelForChip || null}
            onPicked={(modelID) => { const sid = activeStoredId.get(); if (sid) { setOcPicks((p) => ({ ...p, [sid]: modelID })); void rememberOcPick(sid, modelID) } }}
          />
          <CommandCatalogSheet
            open={catalogOpen}
            onClose={() => setCatalogOpen(false)}
            onInsert={onCommandInsert}
            onRunFallback={() => { setCatalogOpen(false); void runSlash('/help') }}
          />
          {optionSheet ? (
            <CommandOptionsSheet
              command={optionSheet.command}
              description={describeCommand(optionSheet.command)}
              choices={subsFor(optionSheet.command).map((v) => ({ value: v }))}
              allowText={optionSheet.allowText}
              loadChoices={async () => {
                // Dynamic options (personalities, skins, handoff targets…)
                // come from the gateway's own completion scorer.
                // activeLiveId resolves the optimistic switch/create windows
                // so the RPC never sees a placeholder id.
                const live = await activeLiveId().catch(() => null)
                const items = await completeSlash(`/${optionSheet.command} `, live ?? undefined)
                return items
                  .filter((it) => it.text && !it.text.startsWith('/'))
                  .map((it) => ({ value: it.text, meta: it.meta }))
              }}
              onRun={(commandLine) => {
                setOptionSheet(null)
                void runSlash(commandLine)
              }}
              onClose={() => setOptionSheet(null)}
            />
          ) : null}

          {/* Bot Switcher (round-2 feedback): default agent + every named
              bot, the active one selected and inert. No TextInput inside, so
              a plain Modal root suffices — no keyboard can rise here. */}
          <Modal
            visible={botSwitcherOpen}
            transparent
            animationType="slide"
            onRequestClose={closeBotSwitcher}
          >
            <View style={s.botSheetRoot}>
              <SheetBackdrop onPress={closeBotSwitcher} />
              <SheetCard style={s.botSheetCard}>
                <SheetGrabber />
                <View style={[s.botSheetHead, { flexDirection: dir.row }]}>
                  <View style={s.botSheetHeadText}>
                    <Txt size={14} weight="800" numberOfLines={1}>{t('chat.bot.sheetTitle')}</Txt>
                    <Txt size={11} color={C.textDim} numberOfLines={1}>{t('chat.bot.sheetSubtitle')}</Txt>
                  </View>
                  <HeaderButton onPress={closeBotSwitcher} accessibilityLabel={t('common.close')}>
                    <Icon name="close" size={14} color={C.textDim} />
                  </HeaderButton>
                </View>
                <ScrollView style={s.botSheetList} keyboardShouldPersistTaps="handled">
                  {/* Moch — the DEFAULT BOT. Like every bot it has ONE
                      canonical Bot Chat; it is not the plain launch surface. */}
                  <Pressable
                    style={({ pressed }) => [
                      s.botSheetRow,
                      { flexDirection: dir.row },
                      activeBot === 'default' && s.botSheetRowOn,
                      pressed && switchingBot === null && s.btnPressed,
                    ]}
                    onPress={() => { if (activeBot !== 'default') void pickBot('default') }}
                    disabled={activeBot === 'default' || switchingBot !== null}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.bot.switchTo', { name: t('chat.bot.defaultLabel') })}
                    accessibilityState={{ selected: activeBot === 'default', busy: switchingBot === 'default' }}
                  >
                    <BotAvatar profile="default" isDefault size={34} />
                    <View style={s.botSheetRowText}>
                      <Txt size={13} weight="700" numberOfLines={1}>{t('chat.bot.defaultLabel')}</Txt>
                      <Txt size={11} color={C.textDim} numberOfLines={1}>{t('chat.bot.defaultDesc')}</Txt>
                    </View>
                    {switchingBot === 'default' ? (
                      <Spinner size="small" />
                    ) : activeBot === 'default' ? (
                      <Icon name="checkmark-circle" size={18} color={C.accent} />
                    ) : null}
                  </Pressable>
                  {/* Named bots from the fleet roster (Moch has its own row). */}
                  {profiles.filter((p) => !p.isDefault).map((p: FleetProfile) => {
                    const isOn = activeBot === p.name
                    const isSwitching = switchingBot === p.name
                    return (
                      <Pressable
                        key={p.name}
                        style={({ pressed }) => [
                          s.botSheetRow,
                          { flexDirection: dir.row },
                          isOn && s.botSheetRowOn,
                          pressed && !isOn && switchingBot === null && s.btnPressed,
                        ]}
                        onPress={() => { if (!isOn) void pickBot(p.name) }}
                        disabled={isOn || switchingBot !== null}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.bot.switchTo', { name: p.title })}
                        accessibilityState={{ selected: isOn, busy: isSwitching }}
                      >
                        <BotAvatar profile={p.name} size={34} frozen={p.frozen} />
                        <View style={s.botSheetRowText}>
                          <Txt size={13} weight="700" numberOfLines={1}>{p.title}</Txt>
                          {!!p.description ? (
                            <Txt size={11} color={C.textDim} numberOfLines={1}>{p.description}</Txt>
                          ) : null}
                        </View>
                        {isSwitching ? (
                          <Spinner size="small" />
                        ) : isOn ? (
                          <Icon name="checkmark-circle" size={18} color={C.accent} />
                        ) : null}
                      </Pressable>
                    )
                  })}
                </ScrollView>
              </SheetCard>
            </View>
          </Modal>

            {/* Moch floats: NO layout height of his own; the box is the only
                touch target (tap = wink, press-and-hold = pat). */}
            <View style={s.mochFloat} pointerEvents="box-none">
              <Mascot mochi={mochi} />
            </View>
          </View>
        </Animated.View>
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  // Shared press feedback so every tappable answers on the frame it's hit.
  btnPressed: { opacity: 0.6 },

  // ── Offline / failure banner (mockup: amberSoft strip + mono RETRY) ──────
  banner: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 11,
    backgroundColor: C.amberSoft,
    borderWidth: 1,
    borderColor: 'rgba(245,165,36,0.35)',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  bannerText: { color: C.amber, fontSize: 11.5, fontWeight: '700', flex: 1, lineHeight: 16 },

  // ── Active-bot chip row under the header (BUG-111) ──────────────────────
  botRow: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  botPill: {
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
    flexShrink: 1,
  },
  botName: { flexShrink: 1 },

  // ── Bot Switcher sheet (round-2 feedback) ────────────────────────────────
  // Modal root fills the screen; the backdrop is the scrim, the card docks at
  // the bottom (ui's SheetCard carries the elevation + top radii).
  botSheetRoot: { flex: 1, justifyContent: 'flex-end' },
  botSheetCard: { paddingBottom: 24 },
  botSheetHead: { alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8 },
  botSheetHeadText: { flex: 1, gap: 1 },
  botSheetList: { maxHeight: 380 },
  botSheetRow: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgCard,
    marginBottom: 6,
  },
  botSheetRowOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  botSheetRowText: { flex: 1, gap: 1 },

  // ── Empty state (mockup: centered MochiMark + starter cards) ────────────
  booting: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 80 },
  empty: {
    flexGrow: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
    paddingVertical: 12,
  },
  emptyTitle: { marginTop: 6 },
  emptySubtitle: { marginTop: 2, marginBottom: 14 },
  connectNudge: {
    width: '100%',
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accent,
    borderRadius: 13,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  connectNudgeText: { color: C.accent, fontSize: 12.5, fontWeight: '700', flex: 1 },
  starterList: { width: '100%', gap: 7 },
  starter: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minHeight: 40,
  },
  starterPressed: { opacity: 0.6 },
  starterText: { color: C.text, fontSize: 12.5, fontWeight: '600', flex: 1 },

  // ── Tool log / todos above the composer ─────────────────────────────────
  runFooter: { paddingHorizontal: 14, paddingVertical: 4, maxHeight: 190 },
  moreTools: { paddingHorizontal: 2, marginTop: 2 },
  toolsToggle: {
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 11,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  toolsToggleText: { color: C.textDim, fontSize: 11.5, fontWeight: '700', flexShrink: 1 },
  toolsOpenList: { maxHeight: 170 },
  todos: {
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 11,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 4,
    gap: 2,
  },
  todo: { color: C.textDim, fontSize: 12, lineHeight: 17 },
  todoMore: { color: C.textFaint, fontSize: 11, marginTop: 2 },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 96,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },

  // ── Slash palette card (mockup: elevated card, uppercase kicker) ────────
  slashPanel: {
    marginHorizontal: 12,
    marginBottom: 6,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    padding: 6,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  slashHead: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingHorizontal: 6,
    paddingTop: 2,
    paddingBottom: 4,
  },
  slashKicker: { letterSpacing: 0.75, textTransform: 'uppercase' },
  slashHint: { color: C.textFaint, fontSize: 10, flexShrink: 1 },
  slashList: { maxHeight: 320 },
  slashRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    minHeight: 34,
  },
  slashRowPressed: { backgroundColor: C.bgHover },
  slashName: { flexShrink: 0, maxWidth: '54%' },
  slashMeta: { color: C.textDim, fontSize: 11, flex: 1 },

  // ── Header model chip (mockup: accentSoft stadium, maxWidth 96) ─────────
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 96,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.border,
  },
  modelChipEmpty: {
    borderColor: C.accent,
  },
  modelChipText: {
    color: C.accent,
    fontSize: 10.5,
    fontWeight: '700',
    flexShrink: 1,
  },

  // ── Question cards (approval / clarify / sudo / secret) ─────────────────
  sheet: {
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: C.bgElev,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: '55%',
    overflow: 'hidden',
  },
  // The body shrinks (flexShrink) inside the capped card and scrolls; the
  // action rows after it keep their intrinsic height and stay pinned.
  sheetScroll: { flexShrink: 1 },
  sheetHead: { alignItems: 'center', gap: 6, marginBottom: 8 },
  sheetTitle: { color: C.text },
  sheetKicker: { marginBottom: 4 },
  sheetBody: { color: C.text, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  sheetDesc: { color: C.textDim, fontSize: 12, lineHeight: 17, marginBottom: 8 },
  sheetRow: { gap: 8 },
  // BUG-086 aggregate foreign-question header: same card vocabulary, but the
  // whole header row is the expander tap target.
  foreignHead: { alignItems: 'center', gap: 6, marginBottom: 4 },
  foreignTitle: { flex: 1 },
  sheetBtn: { flex: 1, paddingHorizontal: 8, minHeight: 40 },
  sheetBtnFull: { width: '100%', marginTop: 8 },
  denyBtn: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.red },
  denyText: { color: C.red },
  qHint: { marginTop: 8, marginBottom: 2 },
  qText: { color: C.text, fontSize: 13, marginBottom: 6, lineHeight: 19 },
  qInput: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 9,
    color: C.text,
    fontSize: 13,
    marginTop: 8,
    minHeight: 40,
  },
  clarifyBtn: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 11,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 6,
    minHeight: 40,
    justifyContent: 'center',
  },
  clarifyOn: { backgroundColor: C.accent, borderColor: C.accent },
  clarifyText: { color: C.text, fontSize: 12.5, fontWeight: '600' },
  clarifyRow: { gap: 8, marginTop: 10, alignItems: 'center' },
  miniSend: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },

  // ── Composer ────────────────────────────────────────────────────────────
  composerWrap: { paddingHorizontal: 12, paddingTop: 6, backgroundColor: C.bg },
  // Positioned box around the transcript that hosts the floating mascot.
  listWrap: { flex: 1 },
  list: { flex: 1 },
  // Inverted coordinates: paddingTop (16) is the visual bottom gap above the
  // composer; paddingBottom (156) is the visual top reserve that keeps the
  // oldest message (and short/empty chats via flex-end) clear of floating Moch.
  listContent: { paddingTop: 16, paddingBottom: 156, paddingHorizontal: 14, flexGrow: 1, justifyContent: 'flex-end' },
  // Top-right float for Moch: the absolutely positioned view shrinks to the
  // 144px box (no opposite anchors), so the box is the only touch target and
  // the scroll-to-bottom FAB keeps the bottom-right corner.
  mochFloat: { position: 'absolute', top: 0, right: 12 },
  chipStrip: { maxHeight: 72, marginBottom: 6 },
  composer: {
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: C.bgCard,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 6,
    paddingVertical: 5,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  attach: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.btnTint,
    flexShrink: 0,
  },
  attachOff: { opacity: 0.45 },
  input: {
    flex: 1,
    color: C.text,
    fontSize: 13,
    lineHeight: 18,
    maxHeight: 110,
    minHeight: 32,
    paddingTop: 7,
    paddingBottom: 7,
    paddingHorizontal: 4,
  },
  micBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stopBtn: { backgroundColor: C.red },
  sendOff: { backgroundColor: C.bgHover },

  // Run status line (mockup: accent "● Running tool:" + mono steer lever).
  runStatus: {
    paddingVertical: 3,
    paddingHorizontal: 16,
    // composerWrap already pads 12px to the screen edge — escape that gutter so
    // the net inset stays the mockup's 16px rather than stacking to 28px.
    marginHorizontal: -12,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  runStatusText: { color: C.accent, fontSize: 11, fontWeight: '600', flexShrink: 1 },
  runStatusSteer: {
    color: C.textDim,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }),
  },

  // ── Queued-sends strip (mockup: bgElev card, amber kicker, Send now) ────
  queueStrip: {
    backgroundColor: C.bgElev,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
    gap: 4,
  },
  queueHead: { alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  queueKicker: { letterSpacing: 0.75, textTransform: 'uppercase' },
  queueStatus: { color: C.textFaint, fontSize: 10, flexShrink: 1 },
  queueRow: { alignItems: 'center', gap: 6, minHeight: 30 },
  queueMsg: { flex: 1, justifyContent: 'center' },
  queueMsgText: { color: C.text, fontSize: 11.5, fontWeight: '500', lineHeight: 16 },
  queueAct: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  queueSteerPill: { paddingVertical: 2, paddingHorizontal: 8 },
  queueMore: { color: C.textFaint, fontSize: 10.5, paddingHorizontal: 2 },
})
