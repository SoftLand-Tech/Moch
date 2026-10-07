import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../../src/components/Icon'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import { AudioModule, useAudioRecorder, RecordingPresets, type RecordingOptions } from 'expo-audio'
import { transcribeRecording, voiceBusy } from '../../src/lib/voice'
import { VoiceRecStrip } from '../../src/components/VoiceRecStrip'
import { clearBadge } from '../../src/lib/push'
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
  openLocalChatIfNeeded,
  activeLiveId,
  chatBanner,
  activeQueue,
  retryMessage,
  flushOutbox,
  newChat,
  pushLocalMessage,
  type ToolItem,
  type ChatMessage,
} from '../../src/lib/chat'
import { enqueueSend, removeQueued } from '../../src/lib/sendQueue'
import { setQueuedAttachments, takeQueuedAttachments } from '../../src/lib/chat'
import { MAX_ATTACHMENTS, ATTACH_MAX_BYTES, formatBytes, mediaKindForPath } from '../../src/lib/media'
import type { PendingAttachment } from '../../src/lib/mediaSend'
import { AttachmentChip } from '../../src/components/media/AttachmentChip'
import { AttachSheet } from '../../src/components/media/AttachSheet'
import { chatTabFocused } from '../../src/lib/attention'
import { draftFor, setDraft } from '../../src/lib/drafts'
import { shareInInbox, ackShareIn, applySharedToDraft, type SharedFile } from '../../src/lib/shareIn'
import { isConnected as isConnectedAtom, connectionState, gatewayError, retryNow, reconnectAttempt } from '../../src/lib/gateway'
import { completeSlash, loadCatalog, runCommand, parseSlashCommand, canonicalName, interactiveTarget, describeCommand, subsFor, argumentModeFor, slashLabel, localCompleteSync, type CompletionItem, type SlashOutcome } from '../../src/lib/slash'
import { liveModel, liveReasoning, liveReasoningDisplay, fetchReasoningDisplay } from '../../src/lib/modelState'
import { ModelPickerSheet } from '../../src/components/ModelPickerSheet'
import { CommandOptionsSheet } from '../../src/components/CommandOptionsSheet'
import { CommandCatalogSheet } from '../../src/components/CommandCatalogSheet'
import { MessageBubble, ToolRow } from '../../src/components/Chat'
import { Mascot } from '../../src/components/Mascot'
import { useMochiState } from '../../src/components/mochi/useMochiState'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { C, S, useStyles, useShape } from '../../src/lib/theme'

/** Empty-state prompts, styled as plain icon rows the way ChatGPT does. */
const STARTERS = [
  { icon: 'sparkles-outline' as const, label: 'What can you do?' },
  { icon: 'document-text-outline' as const, label: 'Summarize my day' },
  { icon: 'terminal-outline' as const, label: 'Explain this repo' },
  { icon: 'help-circle-outline' as const, label: 'Browse slash commands' },
]

const MAX_SLASH_ITEMS = 120

// Module scope so the hook keeps one recorder across renders — and so the
// VoiceRecStrip waveform gets live dB levels (voice.ts records .m4a).
const REC_OPTIONS: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true }

export default function Chat() {
  const S = useShape()
  const s = useStyles(makeS)
  const msgs = useStore(messages)
  const tls = useStore(tools)
  const busy = useStore(agentBusy)
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
  useEffect(() => {
    if (online) { setOfflineGrace(false); return }
    setOfflineGrace(true)
    const t = setTimeout(() => setOfflineGrace(false), 2500)
    return () => clearTimeout(t)
  }, [online])
  // The connect window (~1s wifi, up to 4s mobile data) is NOT an outage:
  // showing OFFLINE while the dial is in flight made healthy opens look
  // broken. Same for the first auto-reconnects after a mid-session drop —
  // the app is already dialing and about to heal. OFFLINE appears when
  // reconnects keep failing (3rd+ attempt, ~7s+ of real outage).
  const reconnects = useStore(reconnectAttempt)
  const showOfflineBanner = !online && !offlineGrace && connState !== 'connecting' && reconnects < 2
  const conn = useStore(connectionState)
  const gerr = useStore(gatewayError)
  const curModel = useStore(liveModel)
  const curEffort = useStore(liveReasoning)
  const showThinking = useStore(liveReasoningDisplay) !== 'hide'
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
  const recorder = useAudioRecorder(REC_OPTIONS)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const voiceState = useStore(voiceBusy)
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const slashSeq = useRef(0)
  // Mascot waterfall — recording (press-to-talk) and the composer text (any
  // keystroke is activity) feed the idle clock; everything else it subscribes
  // to itself.
  const mochi = useMochiState({ recording, activityKey: input })
  // Composer attachments (ChatGPT-style chips). Memory-only — queued ones
  // ride chat.ts's in-memory map keyed by the queued send id.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
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
  const { draft } = useLocalSearchParams<{ draft?: string }>()
  const lastDraft = useRef<string | undefined>(undefined)

  // ── Per-chat composer drafts ─────────────────────────────────────────────
  // Leaving a chat (sidebar switch, attention-toast hop, app restart) must
  // never cost the text being typed: restore on switch, mirror every change.
  // The swap also resets the reading position: scroll state must not carry
  // over from the previous chat (stale offset, stray jump FAB, wrong
  // bottom-follow). scrollMetrics is a ref declared below — safe to touch
  // here because the effect body runs after the render completes.
  useEffect(() => {
    setInput(draftFor(storedId))
    setStick(true)
    setShowScrollBtn(false)
    scrollMetrics.current = { y: 0, contentH: 0, viewH: 0 }
    // Opening a chat parks at the LATEST message: the remounted list lays
    // out over several frames, and each content-size event re-anchors to
    // the end until the first scroll reading confirms we're there.
    parkAtBottomRef.current = true
    // …and until that arrival the list stays INVISIBLE: a long transcript
    // mounts at offset 0 (top) and the eye sees the top-then-jump even with
    // non-animated scrolls. Gating the reveal hides the parking entirely;
    // the timer is the safety net — a transcript that never reports arrival
    // (or a very long one still laying out) reveals at 700ms rather than
    // leaving a blank chat, which is no worse than the old behavior.
    setListRevealed(false)
    const t = setTimeout(() => setListRevealed(true), 700)
    return () => clearTimeout(t)
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

  useEffect(() => {
    if (!stick) return
    // One frame of defer so the freshly grown content has laid out before we
    // measure it. Must stay shorter than the 33 ms stream-flush interval, or
    // the timer is cancelled forever and following stops mid-stream.
    // Non-animated while streaming: an animated scroll re-fired every flush
    // fights itself and makes the stream look slower than it is.
    const t = setTimeout(() => scrollListToEnd(!busy), 16)
    return () => clearTimeout(t)
  }, [msgs.length, msgs[msgs.length - 1]?.text, msgs[msgs.length - 1]?.segments?.length, tls.length, stick, busy])

  // ── Bottom-of-list tracking ─────────────────────────────────────────────
  // One reading of "is the user parked at the bottom" drives both
  // follow-streaming (`stick`) and the jump-to-latest button. It is
  // re-checked on drag/momentum end because throttled in-flight events can
  // leave the last reading short of the true resting offset — that was the
  // "I'm at the bottom but the button still shows" bug — and on
  // content-size/layout changes, since a new message landing while scrolled
  // up fires no scroll event at all (that was the "button never shows" bug).
  const scrollMetrics = useRef({ y: 0, contentH: 0, viewH: 0 })
  // True from chat-open until the first scroll reading lands near the
  // bottom: while parking, layout events re-anchor to the end instead of
  // evaluating "is the user at the bottom" against a not-yet-scrolled
  // offset (which read as "scrolled up" and threw the jump button on a
  // freshly opened chat — with the follow killed, it stuck until pressed).
  const parkAtBottomRef = useRef(true)
  // The open-chat reveal gate: false while the list is still parking at the
  // bottom (see the storedId effect) — the FlatList renders opacity 0 so the
  // top-then-scroll of a long transcript is never on screen. Flips true the
  // moment parking confirms arrival, or at the 700ms fallback.
  const [listRevealed, setListRevealed] = useState(true)
  // Exact end-of-content scroll. FlatList's scrollToEnd undershoots by the
  // contentContainer's bottom reserve (the mascot clearance): on web it
  // estimates the target from cell metrics, which never see container
  // padding — the list lands 162px short, the last line rests behind Moch,
  // and the 120px at-bottom threshold flips off and kills stream-follow.
  // contentSize from scroll events DOES include the padding, so target
  // contentH - viewH directly; fall back to scrollToEnd before the first
  // scroll event populates the metrics.
  const scrollListToEnd = useCallback((animated: boolean) => {
    // An animated follow scroll emits its own intermediate scroll events,
    // each >120px from the end at first — without this guard, evalBottom
    // would cancel the follow mid-flight and strand the jump button on.
    if (animated) stickUntil.current = Date.now() + 500
    const { contentH, viewH } = scrollMetrics.current
    if (viewH > 0 && contentH > viewH) {
      listRef.current?.scrollToOffset?.({ offset: contentH - viewH, animated })
    } else {
      listRef.current?.scrollToEnd?.({ animated })
    }
  }, [])
  // While a programmatic jump-to-bottom is in flight, content-size changes
  // are our own doing — evaluating "is the user at the bottom" mid-jump
  // would see the not-yet-scrolled offset and cancel the follow.
  const stickUntil = useRef(0)
  const evalBottom = useCallback(() => {
    const { y, contentH, viewH } = scrollMetrics.current
    if (!viewH) return
    if (Date.now() < stickUntil.current) return
    // Overscroll (rubber-band past the end) makes the raw distance negative;
    // clamping keeps "scrolled too far" counting as at-bottom.
    const distance = Math.max(0, contentH - viewH - y)
    const nearBottom = distance < 120
    setStick(nearBottom)
    setShowScrollBtn(!nearBottom)
  }, [])
  const readScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    scrollMetrics.current = { y: contentOffset.y, contentH: contentSize.height, viewH: layoutMeasurement.height }
    evalBottom()
    // Parked → arrived: the first reading within the at-bottom band ends
    // the open-chat anchoring; from here the user owns the position.
    const { y, contentH, viewH } = scrollMetrics.current
    if (parkAtBottomRef.current && viewH > 0 && Math.max(0, contentH - viewH - y) < 120) {
      parkAtBottomRef.current = false
      setListRevealed(true)
    }
  }, [evalBottom])

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
        void newChat().catch((e) => showAlert('New chat failed', e instanceof Error ? e.message : String(e)))
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
        pushLocalMessage(out.text, 'assistant', {
          name: slashLabel(out.name),
          variant: out.subtype,
          suggestion: out.suggestion,
          hint: out.hint,
        })
      }
      updateInput('')
      setSlashItems(null)
    } catch (e) {
      showAlert('Command failed', e instanceof Error ? e.message : String(e))
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────
  // ChatGPT's attach flow: + opens a three-way action sheet (library /
  // camera / file); picks land as preview chips. The size gates run at BOTH
  // ends: non-image picks over the 8 MB cap are rejected here (hours of 3
  // kB/s link otherwise), images ride the JPEG ladder inside the send (an
  // over-cap ORIGINAL still shrinks to the 1.8 MB auto-approve budget), and
  // processAttachments re-checks the cap defensively before uploading.
  const canAttach = online && !recording && !(steerMode && busy) // steer is text-only
  const addAttachment = (att: PendingAttachment) => {
    if (att.kind !== 'image' && att.size != null && att.size > ATTACH_MAX_BYTES) {
      showAlert(
        'Attachment too large',
        `${att.name} is ${formatBytes(att.size)} — the limit is ${formatBytes(ATTACH_MAX_BYTES)}.`,
      )
      return
    }
    setPendingAttachments((cur) => {
      if (cur.length >= MAX_ATTACHMENTS) {
        showAlert('Attachment limit', `Up to ${MAX_ATTACHMENTS} files per message.`)
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
        showAlert('Photos denied', 'Allow photo access to attach images.')
        return
      }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'] })
      if (!r.canceled && r.assets?.length) pickAsset(r.assets[0])
    } catch (e) {
      showAlert('Picker failed', e instanceof Error ? e.message : String(e))
    }
  }

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) {
        showAlert('Camera denied', 'Allow camera access to take photos.')
        return
      }
      const r = await ImagePicker.launchCameraAsync()
      if (!r.canceled && r.assets?.length) pickAsset(r.assets[0])
    } catch (e) {
      showAlert('Camera failed', e instanceof Error ? e.message : String(e))
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
      showAlert('Picker failed', e instanceof Error ? e.message : String(e))
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
      showAlert(
        'Share skipped',
        `${sharedIn.skipped} shared file${sharedIn.skipped === 1 ? '' : 's'} exceeded the ${formatBytes(ATTACH_MAX_BYTES)} limit.`,
      )
    }
    // One-shot per share: ack above clears the trigger, so the closed-over
    // helpers (updateInput/addAttachment) are only read on the firing pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedIn])


  const send = async () => {
    if (recording) return // finishing the take wins over sending
    const text = input.trim()
    if (!text && pendingAttachments.length === 0) return
    // Whatever this dispatch turns into (turn, steer, queued message), the
    // user's eye belongs at the newest message.
    jumpToLatest()
    if (text.startsWith('/') && pendingAttachments.length === 0) {
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
        showAlert('Steer failed', e instanceof Error ? e.message : 'unknown')
      }
      return
    }
    if (busy) {
      if (!storedId) return // nowhere to queue yet — keep the text
      // Attachment-only sends queue with empty text (allowEmpty); the chips
      // ride the in-memory attach map keyed by the queued id.
      const item = enqueueSend(storedId, text, { allowEmpty: pendingAttachments.length > 0 })
      if (!item) {
        showAlert('Queue full', 'Remove a queued message or wait for the current reply to finish.')
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
      showAlert('Send failed', e instanceof Error ? e.message : 'unknown')
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
      showAlert('Recording failed', e instanceof Error ? e.message : 'unknown')
      return
    }
    if (!uri) {
      showAlert('Recording failed', 'No audio captured.')
      return
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      const { transcript } = await transcribeRecording(uri)
      // The transcript landing in the composer IS the success feedback — a
      // dialog here was a tap-to-dismiss speed bump on every voice note.
      updateInput(transcript)
    } catch (e) {
      showAlert('Transcription failed', e instanceof Error ? e.message : 'unknown')
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
        showAlert('Mic denied', 'Allow microphone access to record voice.')
        return
      }
      await recorder.prepareToRecordAsync()
      recorder.record()
      setRecording(true)
      setRecSecs(0)
      recTimer.current = setInterval(() => {
        setRecSecs((n) => {
          if (n + 1 >= 120) void finishRecording()
          return n + 1
        })
      }, 1000)
    } catch (e) {
      stopRecTimer()
      setRecording(false)
      showAlert('Recording failed', e instanceof Error ? e.message : 'unknown')
    }
  }

  useEffect(() => stopRecTimer, [])
  useEffect(() => {
    if (!busy) setSteerMode(false)
  }, [busy])

  // The finished-turn tool log collapses on its own; expanded review is a
  // momentary state, so any turn start/end or chat switch re-collapses it.
  useEffect(() => { setToolsOpen(false) }, [storedId, busy])

  useEffect(() => {
    setAnswerText('')
    setSecretValue('')
    setBatchAnswers({})
  }, [req?.id])

  const isBatchClarify = req?.method === 'clarify' && !!req.questions?.length
  const approvalChoices = (() => {
    if (req?.method !== 'approval') return []
    const offered = req.choices?.length ? req.choices : ['once', 'session', 'always', 'deny']
    return offered.filter((c) => {
      if (c === 'always' && req.allowPermanent === false) return false
      if (c === 'session' && req.allowSession === false) return false
      return true
    })
  })()

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
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell
        title={title || 'Moch'}
        onSearch={() => router.navigate('/(tabs)/sessions')}
        right={
          !S.trayHeader && curModel ? (
            <Pressable
              style={({ pressed }) => [s.modelChip, pressed && s.btnPressed]}
              onPress={() => setModelPickerOpen(true)}
              hitSlop={6}
              accessibilityLabel={`Current model ${curModel}. Tap to change`}
            >
              <Icon name="cube-outline" size={12} color={C.accent} />
              <Text style={s.modelChipText} numberOfLines={1}>{curModel}</Text>
            </Pressable>
          ) : null
        }
      >
        <Animated.View style={[s.root, kbPad]}>
          {showOfflineBanner ? (
            <Pressable
              style={({ pressed }) => [s.banner, pressed && s.btnPressed]}
              onPress={() => { void retryNow().catch(() => {}) }}
              accessibilityLabel="Reconnect"
            >
              <Text style={s.bannerText}>
                {conn === 'connecting' ? 'Connecting…' : `Offline${gerr ? ' — tap to retry' : ''}`}
                {qb.length ? ` · ${qb.length} queued` : ''}
              </Text>
            </Pressable>
          ) : null}

          {/* Switch/create failure: the optimistic swap already put the user
              on the target chat, so the retry lives HERE — the placeholder
              keeps the cached transcript readable offline in the meantime. */}
          {banner ? (
            <Pressable
              style={({ pressed }) => [s.banner, pressed && s.btnPressed]}
              onPress={() => banner.retry?.()}
              accessibilityLabel={banner.retry ? 'Retry' : undefined}
            >
              <Text style={s.bannerText}>{banner.text}</Text>
            </Pressable>
          ) : null}

          {/* The list gets its own positioned box so Moch can float over its
              top-right corner without reserving layout height: the transcript
              flows underneath him while scrolling, and the paddingTop reserve
              below keeps the oldest messages clear of him at the top rest. */}
          <View style={s.listWrap}>
          {S.trayHeader && curModel ? (
            // Tray keeps a single symmetric row (menu | centered title |
            // status), so the model chip floats here — mirrored from Moch,
            // who owns the right corner. Messages scroll under it like they
            // do under him; the list's top reserve keeps both clear at rest.
            <Pressable
              style={({ pressed }) => [s.modelChip, s.modelFloatChip, pressed && s.btnPressed]}
              onPress={() => setModelPickerOpen(true)}
              hitSlop={6}
              accessibilityLabel={`Current model ${curModel}. Tap to change`}
            >
              <Icon name="cube-outline" size={12} color={C.accent} />
              <Text style={s.modelChipText} numberOfLines={1}>{curModel}</Text>
            </Pressable>
          ) : null}
          <FlatList
            ref={listRef}
            // Keyed by STORED id: a real chat swap mounts a clean list (no
            // inherited offsets, no wasted row mounts), while a live-id
            // rotation (boot placeholder→real, background reattach) keeps
            // the list and the user's scroll position intact.
            key={storedId ?? 'boot'}
            // Invisible until the open-chat parking ARRIVES at the bottom —
            // a long transcript mounts at the top and the re-anchor scroll
            // would otherwise flash by (see listRevealed).
            style={{ flex: 1, opacity: listRevealed ? 1 : 0 }}
            data={msgs}
            keyExtractor={(m) => m.id}
            renderItem={renderMsg}
            extraData={extraData}
            contentContainerStyle={{ paddingTop: 156, paddingBottom: 16, flexGrow: msgs.length ? 0 : 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onScroll={readScroll}
            onScrollBeginDrag={() => {
              // The user takes the wheel: end any open-chat parking and let
              // position evaluations speak immediately, even if a
              // programmatic follow armed its quiet window a moment ago.
              parkAtBottomRef.current = false
              stickUntil.current = 0
            }}
            onScrollEndDrag={readScroll}
            onMomentumScrollEnd={readScroll}
            onContentSizeChange={(_w, h) => {
              scrollMetrics.current.contentH = h
              // Content fits the viewport → there IS no parking to do (empty
              // and short chats never scroll, so readScroll's arrival flip
              // would never fire and the reveal would ride the 700ms
              // fallback). Arrive immediately.
              if (parkAtBottomRef.current && scrollMetrics.current.viewH > 0 && h <= scrollMetrics.current.viewH) {
                parkAtBottomRef.current = false
                setListRevealed(true)
              }
              if (stick) {
                // Content grew while following (or while parking at the
                // latest on open): re-anchor to the end using THIS event's
                // laid-out size — exact target, no 16ms guess, and it
                // repeats through every layout stage of a restored
                // transcript. Evaluating "at bottom?" here instead would use
                // the pre-growth offset and kill the follow (that was the
                // ghost jump-button bug).
                scrollListToEnd(parkAtBottomRef.current ? false : !busy)
              } else {
                // Scrolled up: a message landing fires no scroll event at
                // all, so THIS is where the jump button must re-check.
                evalBottom()
              }
            }}
            onLayout={(e) => {
              scrollMetrics.current.viewH = e.nativeEvent.layout.height
              // Skip the at-bottom evaluation while parking: at mount the
              // offset is still 0 against a tall laid-out transcript, which
              // read as "scrolled up" and threw the button on open.
              if (!parkAtBottomRef.current) evalBottom()
            }}
            scrollEventThrottle={16}
            ListEmptyComponent={
              booting ? (
                // A chat whose content is still on its way (placeholder +
                // resume over a slow link) must never look like a brand-new
                // chat — the starters are ONLY for genuinely empty ones.
                <View style={s.booting}>
                  <ActivityIndicator color={C.accent} />
                  <Text style={s.bootingText}>Loading chat…</Text>
                </View>
              ) : (
                <View style={s.empty}>
                  {STARTERS.map((st) => (
                    <Pressable
                      key={st.label}
                      style={({ pressed }) => [s.starter, pressed && s.starterPressed]}
                      onPress={() => {
                        if (st.label === 'Browse slash commands') updateInput('/')
                        else updateInput(st.label)
                      }}
                      accessibilityLabel={st.label}
                    >
                      <Icon name={st.icon} size={19} color={C.textDim} />
                      <Text style={s.starterText}>{st.label}</Text>
                    </Pressable>
                  ))}
                </View>
              )
            }
          />

          {/* Run status — quiet, above the composer. Reasoning lives on the
              message itself now (collapsed "Thinking" block), not here. While
              the turn runs the tool rows show live; once it ends the log
              collapses to one tappable line so a finished turn stops eating
              screen space. */}
          {(tls.length > 0 || td.length > 0) ? (
            <View style={s.runFooter}>
              {busy ? (
                <>
                  {tls.slice(-3).map((t: ToolItem) => <ToolRow key={t.id} t={t} />)}
                  {tls.length > 3 ? <Text style={s.moreTools}>+{tls.length - 3} more</Text> : null}
                </>
              ) : tls.length > 0 && !toolsOpen ? (
                <Pressable
                  style={({ pressed }) => [s.toolsToggle, pressed && s.btnPressed]}
                  onPress={() => setToolsOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${tls.length} tool calls: ${toolSummary}`}
                >
                  <Icon name="terminal-outline" size={11} color={C.accent} />
                  <Text style={s.toolsToggleText} numberOfLines={1}>
                    {toolSummary}
                  </Text>
                  <Icon name="chevron-up" size={12} color={C.textFaint} />
                </Pressable>
              ) : tls.length > 0 ? (
                <>
                  <Pressable
                    style={({ pressed }) => [s.toolsToggle, pressed && s.btnPressed]}
                    onPress={() => setToolsOpen(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Hide tool calls"
                  >
                    <Icon name="terminal-outline" size={11} color={C.accent} />
                    <Text style={s.toolsToggleText} numberOfLines={1}>
                      {toolSummary}
                    </Text>
                    <Icon name="chevron-down" size={12} color={C.textFaint} />
                  </Pressable>
                  <ScrollView style={s.toolsOpenList} keyboardShouldPersistTaps="handled">
                    {tls.map((t: ToolItem) => <ToolRow key={t.id} t={t} />)}
                  </ScrollView>
                </>
              ) : null}
              {td.length > 0 ? (
                <View style={s.todos}>
                  {td.slice(0, 4).map((t, i) => (
                    <Text key={i} style={s.todo}>
                      {t.done ? '✓' : '○'} {t.text}
                    </Text>
                  ))}
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
                accessibilityLabel="Jump to latest"
              >
              <Icon name="arrow-down" size={19} color={C.text} />
            </Pressable>
          ) : null}

          {/* Slash palette — only while the composer is focused. The rows'
              ScrollView is keyboardShouldPersistTaps="handled", so tapping a
              row never blurs the input and can never race this gate. */}
          {composerFocused && slashItems && slashItems.length > 0 ? (
            <View style={s.slashPanel}>
              <View style={s.slashHead}>
                <Icon name="terminal-outline" size={13} color={C.accent} />
                <Text style={s.slashHeadText}>
                  {cmdCount} command{cmdCount === 1 ? '' : 's'} · {skillCount} skill{skillCount === 1 ? '' : 's'}
                </Text>
                <Text style={s.slashHint}>tap to fill</Text>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 320 }}>
                {slashItems.map((it, i) => {
                  // complete.slash returns `text` without the leading slash
                  // and `display` with it, for both commands and skills.
                  const isSkill = it.kind === 'skill'
                  const label = it.display ?? (it.text.startsWith('/') ? it.text : `/${it.text}`)
                  const insertable = it.text.startsWith('/') ? it.text : `/${it.text}`
                  return (
                    <Pressable
                      key={`${it.kind ?? 'c'}-${insertable}-${i}`}
                      style={({ pressed }) => [s.slashRow, pressed && s.slashRowPressed]}
                      onPress={() => {
                        updateInput(insertable)
                        setSlashItems(null)
                      }}
                      accessibilityLabel={`${label}, ${isSkill ? 'skill' : 'command'}`}
                    >
                      <Icon
                        name={isSkill ? 'sparkles-outline' : 'terminal-outline'}
                        size={14}
                        color={isSkill ? C.accent : C.textFaint}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={s.slashName}>{label}</Text>
                        {it.meta ? (
                          <Text style={s.slashMeta} numberOfLines={2}>
                            {it.meta}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={s.slashKind}>{isSkill ? 'skill' : 'cmd'}</Text>
                    </Pressable>
                  )
                })}
              </ScrollView>
            </View>
          ) : null}

          {/* Question cards */}
          {req?.method === 'approval' ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Icon name="shield-checkmark-outline" size={15} color={C.amber} />
                <Text style={s.sheetTitle}>
                  Approval needed{req.replayed ? ' (restored)' : ''}
                </Text>
              </View>
              {req.toolName ? <Text style={s.sheetKicker}>{req.toolName}</Text> : null}
              <Text style={s.sheetBody} selectable>
                {req.command ?? req.description ?? 'The agent wants to run a command.'}
              </Text>
              {req.description && req.description !== req.command ? (
                <Text style={s.sheetDesc}>{req.description}</Text>
              ) : null}
              <View style={s.sheetRow}>
                {approvalChoices.map((c) => {
                  const deny = c === 'deny'
                  return (
                    <Pressable
                      key={c}
                      style={({ pressed }) => [
                        s.sheetBtn,
                        deny ? s.denyBtn : { backgroundColor: c === 'always' ? C.accentDark : C.accent },
                        pressed && s.btnPressed,
                      ]}
                      onPress={() => {
                        // BUG-050: refusing the agent is a warning, not a
                        // success — the haptic language must match the red
                        // Deny styling (AlertDialog uses Warning for
                        // destructive choices too).
                        void Haptics.notificationAsync(
                          deny ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
                        )
                        void respondApproval(c as 'once' | 'session' | 'always' | 'deny')
                      }}
                      accessibilityLabel={c}
                    >
                      <Text style={[s.sheetBtnText, !deny && { color: C.onAccent }]}>
                        {c === 'once' ? 'Allow' : c === 'session' ? 'Always this chat' : c === 'always' ? 'Always' : 'Deny'}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ) : null}

          {req?.method === 'clarify' ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Icon name="help-circle-outline" size={15} color={C.accent} />
                <Text style={s.sheetTitle}>Hermes needs you</Text>
              </View>
              {isBatchClarify ? (
                <>
                  {req.questions!.map((q) => (
                    <View key={q.qid} style={{ marginBottom: 10 }}>
                      <Text style={s.qText}>{q.question ?? q.qid}</Text>
                      {q.choices?.map((o) => (
                        <Pressable
                          key={o}
                          style={({ pressed }) => [s.clarifyBtn, batchAnswers[q.qid] === o && s.clarifyOn, pressed && s.btnPressed]}
                          onPress={() => setBatchAnswers((a) => ({ ...a, [q.qid]: o }))}
                        >
                          <Text style={[s.clarifyText, batchAnswers[q.qid] === o && { color: C.onAccent }]}>{o}</Text>
                        </Pressable>
                      ))}
                      {!q.choices?.length ? (
                        <TextInput
                          style={s.qInput}
                          value={batchAnswers[q.qid] ?? ''}
                          onChangeText={(t) => setBatchAnswers((a) => ({ ...a, [q.qid]: t }))}
                          placeholder="Your answer…"
                          placeholderTextColor={C.textFaint}
                          accessibilityLabel={`Answer ${q.qid}`}
                        />
                      ) : null}
                    </View>
                  ))}
                  <Pressable
                    style={({ pressed }) => [s.sheetBtn, { backgroundColor: C.accent }, pressed && s.btnPressed]}
                    onPress={() => { void respondClarifyBatch(batchAnswers) }}
                  >
                    <Text style={[s.sheetBtnText, { color: C.onAccent }]}>Send</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={s.sheetBody}>{req.question ?? 'Clarification needed'}</Text>
                  {req.options?.map((o) => (
                    <Pressable
                      key={o}
                      style={({ pressed }) => [s.clarifyBtn, pressed && s.btnPressed]}
                      onPress={() => { void respondClarify(o) }}
                    >
                      <Text style={s.clarifyText}>{o}</Text>
                    </Pressable>
                  ))}
                  <View style={s.clarifyRow}>
                    <TextInput
                      style={[s.qInput, { flex: 1 }]}
                      value={answerText}
                      onChangeText={setAnswerText}
                      placeholder="Or type your answer…"
                      placeholderTextColor={C.textFaint}
                      accessibilityLabel="Clarification answer"
                    />
                    <Pressable
                      style={({ pressed }) => [s.miniSend, pressed && s.btnPressed]}
                      onPress={() => { const t = answerText; setAnswerText(''); void respondClarify(t) }}
                      accessibilityLabel="Send clarification"
                    >
                      <Icon name="arrow-up" size={17} color={C.onAccent} />
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          ) : null}

          {(req?.method === 'sudo' || req?.method === 'secret') ? (
            <View style={s.sheet}>
              <View style={s.sheetHead}>
                <Icon name="lock-closed-outline" size={15} color={C.red} />
                <Text style={[s.sheetTitle, { color: C.red }]}>
                  {req.method === 'sudo' ? 'Sudo requested' : 'Secret requested'}
                </Text>
              </View>
              <Text style={s.sheetBody} selectable>
                {req.prompt}
              </Text>
              <TextInput
                style={s.qInput}
                value={secretValue}
                onChangeText={setSecretValue}
                placeholder={req.method === 'sudo' ? 'sudo password…' : `Value for ${req.envVar ?? 'secret'}…`}
                placeholderTextColor={C.textFaint}
                secureTextEntry
                accessibilityLabel="Secret value"
              />
              <View style={[s.sheetRow, { marginTop: 10 }]}>
                <Pressable
                  style={({ pressed }) => [s.sheetBtn, { backgroundColor: C.accent }, pressed && s.btnPressed]}
                  onPress={() => { const v = secretValue; setSecretValue(''); void respondPrivileged(true, v || undefined) }}
                >
                  <Text style={[s.sheetBtnText, { color: C.onAccent }]}>Send</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [s.sheetBtn, s.denyBtn, pressed && s.btnPressed]}
                  onPress={() => { setSecretValue(''); void respondPrivileged(false) }}
                >
                  <Text style={[s.sheetBtnText, { color: C.red }]}>Deny</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* ── Composer: rounded pill, like ChatGPT ── */}
          <View style={[s.composerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            {queued.length > 0 ? (
              <View style={s.queueStrip}>
                <View style={s.queueHead}>
                  <Icon name="time-outline" size={12} color={C.accent} />
                  <Text style={s.queueHeadText}>
                    {queued.length === 1 ? '1 message' : `${queued.length} messages`} queued ·{' '}
                    {busy ? 'sends when this reply finishes' : online ? 'sending…' : 'waiting for connection'}
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
                          showAlert('Attachment limit', `Only ${room} of ${atts.length} attachments fit this message.`)
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
                  <View key={q.id} style={s.queueRow}>
                    <Pressable
                      style={({ pressed }) => [s.queueMsg, pressed && s.btnPressed]}
                      onPress={editQueued}
                      accessibilityLabel={`Edit queued message: ${q.text.slice(0, 60)}`}
                    >
                      <Text style={s.queueMsgText} numberOfLines={1}>{q.text || '(attachment)'}</Text>
                    </Pressable>
                    {busy && q.text.trim() ? (
                      <Pressable
                        style={({ pressed }) => [s.queueAct, pressed && s.btnPressed]}
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
                        hitSlop={6}
                        accessibilityLabel="Send this now as a steer"
                      >
                        <Icon name="flash-outline" size={14} color={C.accent} />
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={({ pressed }) => [s.queueAct, pressed && s.btnPressed]}
                      onPress={dropQueued}
                      hitSlop={6}
                      accessibilityLabel="Remove queued message"
                    >
                      <Icon name="close" size={14} color={C.textDim} />
                    </Pressable>
                  </View>
                  )
                })}
                {queued.length > 3 ? <Text style={s.queueMore}>+{queued.length - 3} more</Text> : null}
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

            <View style={s.composer}>
              <Pressable
                style={({ pressed }) => [s.attach, !canAttach && s.attachOff, pressed && s.btnPressed]}
                onPress={openAttachSheet}
                disabled={!canAttach}
                hitSlop={8}
                accessibilityLabel={canAttach ? 'Add attachment' : steerMode && busy ? 'Attachments unavailable in steer mode' : 'Attachments unavailable offline'}
              >
                <Icon name={canAttach ? 'add' : 'add-circle-outline'} size={22} color={canAttach ? C.textDim : C.border} />
              </Pressable>

              {recording ? (
                <VoiceRecStrip recorder={recorder} secs={recSecs} onCancel={() => { void cancelRecording() }} />
              ) : (
                <TextInput
                  style={s.input}
                  value={input}
                  onChangeText={updateInput}
                  placeholder={
                    isSlashMode
                      ? 'Filter commands…'
                      : voiceState === 'transcribing'
                        ? 'Transcribing…'
                        : steerMode && busy
                          ? 'Steer the running task…'
                          : busy
                            ? 'Reply — queued until it finishes'
                            : S.askPlaceholder
                  }
                  placeholderTextColor={C.textFaint}
                  multiline={Platform.OS !== 'web'}
                  returnKeyType="send"
                  onSubmitEditing={() => { if (Platform.OS === 'web') void send() }}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  accessibilityLabel="Message input"
                />
              )}

              {busy ? (
                <Pressable
                  style={({ pressed }) => [s.sendBtn, pressed && s.btnPressed]}
                  onPress={() => { void stopRun() }}
                  hitSlop={8}
                  accessibilityLabel="Stop"
                >
                  <Icon name="stop" size={17} color={C.onAccent} />
                </Pressable>
              ) : (
                <Pressable
                  style={({ pressed }) => [s.iconCircle, recording && s.recOn, pressed && s.btnPressed]}
                  onPress={toggleRecord}
                  disabled={!!voiceState}
                  hitSlop={8}
                  accessibilityLabel={recording ? `Stop recording (${recSecs}s)` : 'Record voice'}
                >
                  {voiceState === 'transcribing' ? (
                    <ActivityIndicator color={C.textDim} size="small" />
                  ) : (
                    <Icon name={recording ? 'square' : 'mic-outline'} size={19} color={recording ? '#fff' : C.textDim} />
                  )}
                </Pressable>
              )}

              <Pressable
                style={({ pressed }) => [s.sendBtn, !canSend && s.sendOff, pressed && s.btnPressed]}
                onPress={() => { void send() }}
                disabled={!canSend}
                hitSlop={8}
                accessibilityLabel={steerMode && busy ? 'Send steer' : 'Send message'}
              >
                <Icon
                  name={isSlashMode ? 'return-down-back' : steerMode && busy ? 'bulb' : 'arrow-up'}
                  size={18}
                  color={canSend ? C.onAccent : C.textFaint}
                />
              </Pressable>
            </View>

            {busy ? (
              <Pressable
                style={({ pressed }) => [s.steerChip, steerMode && s.steerChipOn, pressed && s.btnPressed]}
                onPress={() => setSteerMode(!steerMode)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={steerMode ? 'Steer mode on' : 'Steer mode'}
              >
                <Icon name="git-branch-outline" size={12} color={steerMode ? C.onAccent : C.textDim} />
                <Text style={[s.steerText, steerMode && { color: C.onAccent }]}>Steer</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Interactive pickers — attach sources, /model, options/mixed commands, and the command browser */}
          <AttachSheet
            visible={attachOpen}
            onClose={() => setAttachOpen(false)}
            onLibrary={() => void pickFromLibrary()}
            onCamera={() => void takePhoto()}
            onFile={() => void pickFile()}
          />
          <ModelPickerSheet open={modelPickerOpen} onClose={() => setModelPickerOpen(false)} />
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
  banner: { backgroundColor: '#241A08', paddingVertical: 9, paddingHorizontal: 14 },
  bannerText: { color: C.amber, fontSize: 12.5, fontWeight: '600', textAlign: 'center' },
  empty: { paddingHorizontal: 16, paddingTop: 24, gap: 2 },
  booting: { flex: 1, flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 80 },
  bootingText: { color: C.textFaint, fontSize: 13.5 },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 44, justifyContent: 'flex-start' },
  starterPressed: { opacity: 0.6 },
  starterText: { color: C.textDim, fontSize: 15.5, fontWeight: '500' },
  runFooter: { borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.bg, paddingVertical: 4, maxHeight: 190 },
  moreTools: { color: C.textFaint, fontSize: 11.5, paddingHorizontal: 16, marginTop: 2 },
  // Collapsed tool-log affordance: a bordered chip (same idiom as the steer
  // chip) so it reads as a tappable control, not missing UI.
  toolsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginHorizontal: 16,
    marginVertical: 5,
    maxWidth: '92%',
    paddingHorizontal: S.radiusChip > 100 ? 14 : 10,
    height: S.radiusChip > 100 ? 30 : 26,
    borderRadius: S.radiusChip,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  toolsToggleText: { color: C.textDim, fontSize: 11.5, fontWeight: '700', flexShrink: 1 },
  toolsOpenList: { maxHeight: 170 },
  todos: { paddingHorizontal: 16, paddingVertical: 2 },
  todo: { color: C.textDim, fontSize: 12.5, lineHeight: 18 },
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
  slashPanel: { borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.bgElev },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 148,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: S.modelChipTint ? C.accentSoft : C.bgCard,
    borderWidth: 1,
    borderColor: S.modelChipTint ? C.accentSoft : C.border,
  },
  modelChipText: { color: C.textDim, fontSize: 11.5, fontWeight: '700', flexShrink: 1 },
  modelFloatChip: { position: 'absolute', top: 8, left: 12, zIndex: 2 },
  slashHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  slashHeadText: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, flex: 1 },
  slashHint: { color: C.textFaint, fontSize: 10.5 },
  slashRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, minHeight: 44 },
  slashRowPressed: { backgroundColor: C.bgHover },
  slashName: { color: C.text, fontSize: 14, fontWeight: '600' },
  slashMeta: { color: C.textFaint, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
  slashKind: { color: C.textFaint, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  sheet: { marginHorizontal: 12, marginBottom: 8, backgroundColor: C.bgElev, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.border },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  sheetTitle: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  sheetKicker: { color: C.textFaint, fontSize: 11.5, marginBottom: 4 },
  sheetBody: { color: C.text, fontSize: 14.5, lineHeight: 21, marginBottom: 12 },
  sheetDesc: { color: C.textDim, fontSize: 12.5, marginBottom: 10, lineHeight: 18 },
  sheetRow: { flexDirection: 'row', gap: 8 },
  sheetBtn: { flex: 1, borderRadius: 22, paddingVertical: 11, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  denyBtn: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: C.red },
  sheetBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  qText: { color: C.text, fontSize: 14.5, marginBottom: 6, lineHeight: 20 },
  qInput: { backgroundColor: C.bgCard, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 11, color: C.text, fontSize: 15, marginTop: 8, minHeight: 44 },
  clarifyBtn: { backgroundColor: C.bgCard, borderRadius: 20, paddingVertical: 11, alignItems: 'center', marginTop: 6, minHeight: 44, justifyContent: 'center' },
  clarifyOn: { backgroundColor: C.accent },
  clarifyText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  clarifyRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  miniSend: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { paddingHorizontal: 12, paddingTop: 6, backgroundColor: C.bg },
  // Positioned box around the transcript that hosts the floating mascot.
  listWrap: { flex: 1 },
  // Top-right float for Moch: the absolutely positioned view shrinks to the
  // 144px box (no opposite anchors), so the box is the only touch target and
  // the scroll-to-bottom FAB keeps the bottom-right corner.
  mochFloat: { position: 'absolute', top: 0, right: 12 },
  chipStrip: { maxHeight: 72, marginBottom: 6 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: C.bgElev,
    borderRadius: S.radiusComposer,
    borderWidth: S.composerBorder,
    borderColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: S.composerBorder > 1 ? 7 : 6,
    shadowColor: '#000',
    shadowOpacity: S.radiusComposer > 26 ? 0.4 : 0,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 5 },
    elevation: S.radiusComposer > 26 ? 8 : 0,
  },
  attach: {
    width: S.sendSize,
    height: S.sendSize,
    borderRadius: S.sendSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.btnTint,
  },
  attachOff: { opacity: 0.4 },
  input: { flex: 1, color: C.text, fontSize: 16, maxHeight: 110, minHeight: 34, paddingTop: 7, paddingBottom: 7, paddingHorizontal: 4 },
  iconCircle: {
    width: S.sendSize,
    height: S.sendSize,
    borderRadius: S.sendSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.btnTint,
  },
  recOn: { backgroundColor: C.red },
  sendBtn: {
    width: S.sendSize,
    height: S.sendSize,
    borderRadius: S.sendSize / 2,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: S.radiusComposer > 26 ? 0.35 : 0,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: S.radiusComposer > 26 ? 5 : 0,
  },
  sendOff: { backgroundColor: C.bgCard },
  steerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: S.radiusChip > 100 ? 14 : 10,
    height: S.radiusChip > 100 ? 28 : 26,
    borderRadius: S.radiusChip,
    backgroundColor: C.bgCard,
  },
  steerChipOn: { backgroundColor: C.accent },
  steerText: { color: C.textDim, fontSize: 11.5, fontWeight: '700' },
  queueStrip: {
    backgroundColor: C.bgElev,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    gap: 4,
  },
  queueHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  queueHeadText: { color: C.textDim, fontSize: 11, fontWeight: '700' },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 30 },
  queueMsg: { flex: 1, justifyContent: 'center' },
  queueMsgText: { color: C.text, fontSize: 13.5, lineHeight: 18 },
  queueAct: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  queueMore: { color: C.textFaint, fontSize: 11, paddingLeft: 2 },
})
