import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Animated, Image } from 'react-native'
// The maintained fork. The original `react-native-markdown-display` pins
// markdown-it 10, which does `require('punycode')` — a Node builtin that
// Metro's Hermes runtime does not provide, so it breaks the Android bundle.
// This fork resolves markdown-it 14, which imports the userland `punycode.js`
// package instead. Same `<Markdown style={...}>` API.
import Markdown from '@ronradtke/react-native-markdown-display'
import * as Clipboard from 'expo-clipboard'
import * as Speech from 'expo-speech'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { speakText, stopTts } from '../lib/voice'
import { C, S, useStyles, useShape } from '../lib/theme'
import { formatThinkMeta, type ChatMessage, type ChatSegment, type ToolItem } from '../lib/chat'
import { MediaSegmentView } from './media/MediaSegmentView'
import { useReduceMotion } from './useReduceMotion'
import { CommandCard } from './CommandOutput'

/** A message's renderable content: explicit segments, else its plain text. */
function segmentsOf(m: ChatMessage): ChatSegment[] {
  if (m.segments?.length) return m.segments
  return m.text ? [{ kind: 'text', text: m.text }] : []
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const makeMdBase = () => ({
  body: { color: C.text, fontSize: 16, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 12 },
  code_inline: { color: C.accent, backgroundColor: C.accentSoft, borderRadius: 4, paddingHorizontal: 5, fontSize: 14.5 },
  fence: { color: C.text, backgroundColor: C.bgCard, borderRadius: 10, padding: 12, fontSize: 13, fontFamily: 'monospace' },
  code_block: { color: C.text, backgroundColor: C.bgCard, borderRadius: 10, padding: 12, fontSize: 13, fontFamily: 'monospace' },
  blockquote: { backgroundColor: 'transparent', borderLeftColor: C.border, marginLeft: 0, paddingLeft: 12 },
  link: { color: C.accent },
  bullet_list: { color: C.text },
  ordered_list: { color: C.text },
  heading1: { color: C.text, fontSize: 21, fontWeight: '700' },
  heading2: { color: C.text, fontSize: 18, fontWeight: '700' },
  heading3: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  hr: { backgroundColor: C.border, height: 1 },
  table: { borderColor: C.border },
  th: { color: C.text, borderColor: C.border },
  td: { color: C.textDim, borderColor: C.border },
})

/** Theme-reactive markdown styles — fetch through useStyles in components. */
export const makeMdStyles = () => makeMdBase() as never

/** Denser markdown for command-output cards: 14.5/21 body, tighter paragraphs. */
export const makeCardMdStyles = () => {
  const mdBase = makeMdBase()
  return {
    ...mdBase,
    body: { ...mdBase.body, fontSize: 14.5, lineHeight: 21 },
    paragraph: { ...mdBase.paragraph, marginBottom: 8 },
  } as never
}

/**
 * Three bouncing dots — the "the agent is on it" pulse, shown wherever a
 * turn is visibly in flight but nothing has landed yet. Native-driver
 * animation, so the loop costs nothing on the JS thread while streams flush.
 * Static (faded) dots under the OS reduce-motion setting.
 */
export const ThinkingDots = React.memo(function ThinkingDots() {
  const s = useStyles(makeS)
  // BUG-056: shared live hook — the old one-shot read went stale until a
  // remount (no listener on the OS setting).
  const reduce = useReduceMotion()
  const dots = useRef<Animated.Value[]>([0, 1, 2].map(() => new Animated.Value(0))).current
  useEffect(() => {
    if (reduce) return
    // Staggered bounce: every dot runs the same 880 ms up-down cycle,
    // phase-shifted 160 ms, so the wave travels left→right.
    const loops = dots.map((v: Animated.Value, i: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 280, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    )
    loops.forEach((l: { start: () => void; stop: () => void }) => l.start())
    return () => loops.forEach((l: { start: () => void; stop: () => void }) => l.stop())
  }, [reduce, dots])
  return (
    <View style={s.dotsRow} accessibilityLabel="Agent is working">
      {dots.map((v: Animated.Value, i: number) => (
        <Animated.View
          key={i}
          style={[
            s.dot,
            reduce && { opacity: 0.35 + i * 0.2 },
            !reduce && { transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }] },
          ]}
        />
      ))}
    </View>
  )
})

/**
 * Memoized: the chat screen re-renders on every stream flush (~30 Hz while a
 * fast model streams). Memo keeps untouched bubbles from re-rendering, so
 * only the growing bubble (new object identity) does work. `onRetry` /
 * `onEffortPress` must be stable callbacks or every flush re-renders every row.
 */
export const MessageBubble = React.memo(function MessageBubble({
  m, onRetry, effort, onEffortPress, onCommandInsert, onOpenCatalog, showThinking = true,
}: {
  m: ChatMessage
  onRetry?: (id: string) => void
  /** Live reasoning effort — forwarded to the thinking block while streaming. */
  effort?: string
  onEffortPress?: () => void
  /** Inserts a command line into the composer (command-card suggestion/list rows). */
  onCommandInsert?: (line: string) => void
  /** Opens the command catalog browser (command-card footer / hint chip). */
  onOpenCatalog?: () => void
  /** The "Show thinking in the chat" preference. False hides every thinking
   *  block — including ones already in the transcript — not just future ones. */
  showThinking?: boolean
}) {
  const s = useStyles(makeS)
  const md = useStyles(makeMdStyles)
  const S = useShape()
  const isUser = m.role === 'user'
  const [copied, setCopied] = useState(false)
  const [speakState, setSpeakState] = useState<'idle' | 'loading' | 'playing'>('idle')

  const copy = async () => {
    await Clipboard.setStringAsync(m.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const toggleSpeak = async () => {
    if (speakState !== 'idle') {
      stopTts()
      try {
        Speech.stop()
      } catch {}
      setSpeakState('idle')
      return
    }
    setSpeakState('loading')
    try {
      // Gateway voice (Deepgram/Edge/… — whatever the server runs)
      await speakText(m.text.slice(0, 3000))
      setSpeakState('playing')
    } catch {
      // Fallback: on-device TTS so Listen always does something
      try {
        Speech.speak(m.text.slice(0, 2000), {
          onDone: () => setSpeakState('idle'),
          onStopped: () => setSpeakState('idle'),
          onError: () => setSpeakState('idle'),
        })
        setSpeakState('playing')
      } catch {
        setSpeakState('idle')
      }
    }
  }

  // ChatGPT renders the assistant unboxed and full width; only the user gets a bubble.
  if (!isUser) {
    // Command outputs render as the card family, not as prose — a terminal
    // write-once row (no segments, no streaming tail, no Listen).
    if (m.cmd) {
      return <CommandCard m={m} onInsert={onCommandInsert} onOpenCatalog={onOpenCatalog} />
    }
    const segs = segmentsOf(m)
    const lastIdx = segs.length - 1
    // What the user can actually see — hidden thinking doesn't count as
    // content, or the "working" dots would never show while it runs quiet.
    // Only TEXT segments count: media segments carry text: '' (calling
    // .trim() over them was a crash on undefined-to-string before that
    // invariant existed, and would still miscount media as words).
    const hasVisibleText = (showThinking ? segs : segs.filter((seg) => seg.kind !== 'thinking')).some(
      (seg) => seg.kind === 'text' && seg.text.trim(),
    )
    return (
      <View style={s.botWrap}>
        {S.assistantAvatar ? (
          <View style={s.avatarWrap}>
            <Image source={MOCHI_AVATAR} style={s.avatarImg} />
          </View>
        ) : null}
        <View style={[s.botBody, S.assistantCard && s.botCard]}>
        {segs.map((seg, i) =>
          seg.kind === 'media' ? (
            <MediaSegmentView key={i} seg={seg} />
          ) : seg.kind === 'thinking' ? (
            showThinking ? (
              <ThinkingBlock
                key={i}
                seg={seg}
                live={m.streaming && i === lastIdx}
                effort={effort}
                onEffortPress={onEffortPress}
              />
            ) : null
          ) : m.streaming && i === lastIdx ? (
            // Plain Text while streaming: Markdown re-creates the message's whole
            // native view tree on every stream flush, and that churn starves the
            // JS thread until flushes stop landing mid-turn ("all at once at the
            // end"). One Text node is trivial to re-render; the full Markdown
            // render happens once, when the segment completes.
            <Text key={i} style={s.streamText}>{seg.text}</Text>
          ) : (
            <Markdown key={i} style={md}>{seg.text}</Markdown>
          ),
        )}
        {m.streaming ? (hasVisibleText ? <Text style={s.cursor}>▍</Text> : <ThinkingDots />) : null}
        {m.status === 'failed' ? (
          <View style={s.failedRow}>
            <Icon name="alert-circle" size={15} color={C.red} />
            <Text style={s.failedText}>{m.error ?? 'Something went wrong'}</Text>
          </View>
        ) : null}
        {m.text && !m.streaming ? (
          <View style={s.botActions}>
            <Text style={s.time}>{fmtTime(m.ts)}</Text>
            <Pressable
              onPress={copy}
              hitSlop={10}
              style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
              accessibilityLabel="Copy message"
            >
              <Icon name={copied ? 'checkmark' : 'copy-outline'} size={15} color={copied ? C.greenSoft : C.textFaint} />
            </Pressable>
            <Pressable
              onPress={() => { void toggleSpeak() }}
              hitSlop={10}
              style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
              accessibilityLabel={speakState === 'playing' ? 'Stop playback' : 'Listen'}
            >
              {speakState === 'loading' ? (
                <ActivityIndicator color={C.textFaint} size="small" />
              ) : (
                <Icon name={speakState === 'playing' ? 'stop' : 'volume-medium-outline'} size={16} color={speakState === 'playing' ? C.text : C.textFaint} />
              )}
            </Pressable>
          </View>
        ) : null}
        </View>
      </View>
    )
  }

  const userSegs = segmentsOf(m)
  // Media rows are not retryable (design finding 9): the attachments can't be
  // re-picked from here, so the Retry button hides instead of offering a
  // no-op that would silently drop the media. The failed row keeps its media
  // segments — that IS the user's cue to re-attach and resend.
  const hasMediaSegs = userSegs.some((seg) => seg.kind === 'media')
  return (
    <View style={s.userWrap}>
      <View style={[s.userBubble, hasMediaSegs && s.userBubbleMedia]}>
        {userSegs.map((seg, i) =>
          seg.kind === 'media' ? (
            <MediaSegmentView key={i} seg={seg} />
          ) : seg.text ? (
            <Text key={i} style={s.userText} selectable>
              {seg.text}
            </Text>
          ) : null,
        )}
      </View>
      {m.status === 'failed' ? (
        <View style={s.failedRow}>
          <Icon name="alert-circle" size={15} color={C.red} />
          <Text style={s.failedText}>{m.error ?? 'Not sent'}</Text>
          {onRetry && !hasMediaSegs ? (
            <Pressable
              onPress={() => onRetry(m.id)}
              style={({ pressed }) => [s.retryBtn, pressed && s.iconPressed]}
              accessibilityLabel="Retry send"
            >
              <Icon name="refresh" size={13} color={C.text} />
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
})

/**
 * One reasoning segment of an assistant message — the ChatGPT-style collapsed
 * block. Hidden by default: collapsed renders only the header line, so even
 * long transcripts with reasoning stay cheap; the text mounts only while
 * expanded.
 *
 * While `live` (this block is the message's actively growing tail) the header
 * runs its own 1 Hz heartbeat so the elapsed counter keeps counting through
 * silent stretches — tool calls, gateway clumping — instead of only advancing
 * when a chunk happens to land. The tok/s estimate still tracks real chars.
 */
export const ThinkingBlock = React.memo(function ThinkingBlock({
  seg, live, effort, onEffortPress,
}: {
  seg: ChatSegment
  /** True while this block is the message's actively growing tail. */
  live?: boolean
  /** Live reasoning effort — the lever on thinking length. */
  effort?: string
  /** Opens the /reasoning chooser; config.set applies it mid-session. */
  onEffortPress?: () => void
}) {
  const s = useStyles(makeS)
  const S = useShape()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hasText = !!seg.text.trim()
  useEffect(() => {
    if (!live || !hasText) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live, hasText])
  if (!hasText) return null
  const meta = live ? formatThinkMeta(seg.startedAt ?? 0, seg.chars ?? seg.text.length, now) : seg.meta
  const header = (
    <View style={s.thinkHead}>
      <Icon name={open ? 'chevron-down' : 'chevron-forward'} size={12} color={C.textFaint} />
      {live ? <ThinkingDots /> : null}
      <Text style={s.thinkLabel}>
        {live ? 'Thinking' : 'Thought'}
        {meta ? ` · ${meta}` : ''}
      </Text>
      {live && effort && onEffortPress ? (
        <Pressable
          hitSlop={6}
          style={({ pressed }) => [s.effortChip, pressed && s.iconPressed]}
          onPress={onEffortPress}
          accessibilityLabel={`Reasoning effort ${effort}. Tap to change`}
        >
          <Text style={s.effortChipText}>effort: {effort}</Text>
        </Pressable>
      ) : null}
    </View>
  )
  if (S.dashedThinking) {
    // Mocheme: the dashed pill wraps ONLY the header — a multi-line paragraph
    // inside a stadium-shaped capsule read as one giant dashed blob. The
    // expanded reasoning sits below it, outside the shape.
    return (
      <View style={s.thinkMochi}>
        <Pressable
          onPress={() => setOpen(!open)}
          accessibilityLabel={open ? 'Collapse thinking' : 'Expand thinking'}
          style={({ pressed }) => [s.think, s.thinkPill, pressed && s.iconPressed]}
        >
          {header}
        </Pressable>
        {open ? (
          <Text style={s.thinkText}>{seg.text.length > 4000 ? seg.text.slice(-4000) : seg.text}</Text>
        ) : null}
      </View>
    )
  }
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      accessibilityLabel={open ? 'Collapse thinking' : 'Expand thinking'}
      style={({ pressed }) => [s.think, pressed && s.iconPressed]}
    >
      {header}
      {open ? (
        <Text style={s.thinkText}>{seg.text.length > 4000 ? seg.text.slice(-4000) : seg.text}</Text>
      ) : null}
    </Pressable>
  )
})

export const ToolRow = React.memo(function ToolRow({ t }: { t: ToolItem }) {
  const s = useStyles(makeS)
  const color = t.status === 'running' ? C.accent : t.status === 'failed' ? C.red : C.greenSoft
  return (
    <View style={s.toolRow} accessibilityLabel={`${t.name} ${t.status}`}>
      {t.status === 'running' ? (
        <ActivityIndicator size="small" color={color} style={{ width: 14 }} />
      ) : (
        <Icon name={t.status === 'failed' ? 'close' : 'checkmark'} size={13} color={color} />
      )}
      <Text style={s.toolName}>{t.name}</Text>
      {t.preview ? (
        <Text style={s.toolPreview} numberOfLines={1}>
          {t.preview}
        </Text>
      ) : null}
      {t.durationS != null ? <Text style={s.toolDur}>{(t.durationS).toFixed(1)}s</Text> : null}
    </View>
  )
})

/** Mochi's face, pre-rendered from mochi-svgs/mochi.svg (scripts render pipeline). */
const MOCHI_AVATAR = require('../../assets/mochi-avatar.png')

const makeS = () => StyleSheet.create({
  botWrap: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: S.assistantAvatar ? 12 : 16,
    paddingVertical: 10,
  },
  // Mocheme: assistant replies sit in a soft blob card; Relay runs unboxed.
  botBody: { flex: 1, minWidth: 0 },
  botCard: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: S.radiusCard + 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  avatarWrap: { width: 30, height: 30, borderRadius: 15, overflow: 'hidden', marginTop: 2 },
  avatarImg: { width: 30, height: 30 },
  userWrap: { paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end' },
  userBubble: {
    backgroundColor: C.userBubble,
    borderRadius: S.radiusBubble,
    borderBottomRightRadius: S.radiusBubbleTail,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOpacity: S.radiusBubbleTail < S.radiusBubble ? 0.35 : 0,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: S.radiusBubbleTail < S.radiusBubble ? 4 : 0,
  },
  // Media rows: the photo/doc sits flush inside the bubble like ChatGPT's —
  // tighter padding, no double-inset around the media tiles.
  userBubbleMedia: { paddingHorizontal: 6, paddingVertical: 6, gap: 6 },
  userText: { color: C.userText, fontSize: 16, lineHeight: 23 },
  streamText: { color: C.text, fontSize: 16, lineHeight: 24 },
  cursor: { color: C.textDim, fontSize: 15, marginTop: 2 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 12, marginTop: 2 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.blush },
  botActions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, marginLeft: -6 },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 15 },
  iconPressed: { opacity: 0.5 },
  time: { color: C.textFaint, fontSize: 11, marginRight: 6 },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  failedText: { color: C.red, fontSize: 12.5, flexShrink: 1 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bgCard, borderRadius: 14, paddingHorizontal: 10, height: 30 },
  retryText: { color: C.text, fontSize: 12, fontWeight: '700' },
  think: {
    backgroundColor: C.bgCard,
    borderRadius: S.dashedThinking ? 999 : S.radiusCard,
    borderWidth: S.dashedThinking ? 1.5 : 0,
    borderStyle: 'dashed',
    borderColor: C.thinkBorder,
    paddingHorizontal: S.dashedThinking ? 14 : 10,
    paddingVertical: S.dashedThinking ? 8 : 10,
    alignSelf: S.dashedThinking ? 'flex-start' : 'stretch',
  },
  // Mocheme wrapper: pill + (when expanded) the reasoning text below it.
  thinkMochi: { marginBottom: 8 },
  thinkPill: { marginBottom: 0 },
  thinkHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  thinkLabel: { color: C.textFaint, fontSize: 11.5, fontWeight: '600' },
  thinkText: { color: C.textDim, fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  effortChip: { marginLeft: 'auto', backgroundColor: C.bgHover, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  effortChipText: { color: C.textFaint, fontSize: 10, fontWeight: '700' },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  toolName: { color: C.textDim, fontSize: 12.5, fontWeight: '600' },
  toolPreview: { color: C.textFaint, fontSize: 12, flexShrink: 1 },
  toolDur: { color: C.textFaint, fontSize: 11 },
})
