import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Animated, Platform } from 'react-native'
// The maintained fork. The original `react-native-markdown-display` pins
// markdown-it 10, which does `require('punycode')` — a Node builtin that
// Metro's Hermes runtime does not provide, so it breaks the Android bundle.
// This fork resolves markdown-it 14, which imports the userland `punycode.js`
// package instead. Same `<Markdown style={...}>` API.
import Markdown from '@ronradtke/react-native-markdown-display'
import * as Clipboard from 'expo-clipboard'
import * as Speech from 'expo-speech'
import { Icon } from './Icon'
import { MochiMark } from './MochiMark'
import { speakText, stopTts } from '../lib/voice'
import { C, useStyles } from '../lib/theme'
import { formatThinkMeta, type ChatMessage, type ChatSegment, type ToolItem } from '../lib/chat'
import { MediaSegmentView } from './media/MediaSegmentView'
import { useReduceMotion } from './useReduceMotion'
import { CommandCard } from './CommandOutput'
import { openInAppBrowserTab } from '../lib/openInBrowser'
import { useDir, useT, type Dir } from '../lib/strings'

// BUG-135 interop: the package's dist DOES re-export the raw MarkdownIt
// constructor (dist/index.js `exports.MarkdownIt = markdown_it_1.default`),
// but its CJS-with-JSX shape loses NAMED import bindings under tsx/node ESM
// interop — the test:imports gate dies with "(MarkdownIt) is not a function".
// require() keeps the REAL exports object in both runtimes
// (Metro require + tsx), so the constructor is reachable either way.
type MarkdownItCtor = (typeof import('@ronradtke/react-native-markdown-display'))['MarkdownIt']
const { MarkdownIt } = require('@ronradtke/react-native-markdown-display') as {
  MarkdownIt: MarkdownItCtor
}

/**
 * BUG-135: the markdown lib's built-in MarkdownIt runs with linkify
 * DISABLED (createMarkdownIt), so bare URLs rendered as dead text, and its
 * default link open is Linking.openURL → the OS browser (wrong target).
 * ONE shared instance with linkify on makes bare URLs tappable; the shared
 * handler below routes every tap into the built-in Browser screen.
 * (CommandOutput's result card reuses both — keep it ONE instance.)
 */
const mdLinkified = MarkdownIt({ typographer: true, linkify: true })
export { mdLinkified }

/**
 * Route markdown link taps to a new built-in Browser tab. Returning false
 * suppresses the lib's own openUrl default (it only calls Linking.openURL
 * when the callback returns true — see its openUrl.ts).
 */
const onMdLinkPress = (url: string): boolean => {
  openInAppBrowserTab(url)
  return false
}
export { onMdLinkPress }

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

/**
 * Markdown type scale for assistant prose — the redesign's compact chat scale
 * (12.5 px body, 19 px leading) instead of the old 16/24 dashboard scale.
 */
const makeMdBase = () => ({
  body: { color: C.text, fontSize: 12.5, lineHeight: 19 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: { color: C.accent, backgroundColor: C.accentSoft, borderRadius: 4, paddingHorizontal: 4, fontSize: 11.5 },
  fence: { color: C.text, backgroundColor: C.bgCard, borderRadius: 9, padding: 10, fontSize: 11, fontFamily: 'monospace' },
  code_block: { color: C.text, backgroundColor: C.bgCard, borderRadius: 9, padding: 10, fontSize: 11, fontFamily: 'monospace' },
  blockquote: { backgroundColor: 'transparent', borderLeftColor: C.border, marginLeft: 0, paddingLeft: 10 },
  link: { color: C.accent },
  bullet_list: { color: C.text },
  ordered_list: { color: C.text },
  heading1: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  heading2: { color: C.text, fontSize: 15, fontWeight: '700' },
  heading3: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  hr: { backgroundColor: C.border, height: 1 },
  table: { borderColor: C.border },
  th: { color: C.text, borderColor: C.border },
  td: { color: C.textDim, borderColor: C.border },
})

/**
 * Apply the active text direction over the theme-reactive markdown styles.
 * The catalog bundle itself stays direction-agnostic; prose inside the card
 * must read right-aligned in Arabic (SPEC §4).
 */
const withDir = (md: Record<string, object>, dir: Dir): never => {
  const body = (md.body ?? {}) as Record<string, unknown>
  const paragraph = (md.paragraph ?? {}) as Record<string, unknown>
  const heading = (md.heading1 ?? {}) as Record<string, unknown>
  const h2 = (md.heading2 ?? {}) as Record<string, unknown>
  const h3 = (md.heading3 ?? {}) as Record<string, unknown>
  return {
    ...md,
    body: { ...body, textAlign: dir.textAlign, writingDirection: dir.writingDirection },
    paragraph: { ...paragraph, textAlign: dir.textAlign, writingDirection: dir.writingDirection },
    heading1: { ...heading, textAlign: dir.textAlign, writingDirection: dir.writingDirection },
    heading2: { ...h2, textAlign: dir.textAlign, writingDirection: dir.writingDirection },
    heading3: { ...h3, textAlign: dir.textAlign, writingDirection: dir.writingDirection },
  } as never
}

/** Theme-reactive markdown styles — fetch through useStyles in components. */
export const makeMdStyles = () => makeMdBase() as never
export { withDir }

/** Denser markdown for command-output cards: 12.5/18 body, tighter paragraphs. */
export const makeCardMdStyles = () => {
  const mdBase = makeMdBase()
  return {
    ...mdBase,
    body: { ...mdBase.body, fontSize: 12.5, lineHeight: 18 },
    paragraph: { ...mdBase.paragraph, marginBottom: 6 },
    heading1: { ...mdBase.heading1, fontSize: 15 },
    heading2: { ...mdBase.heading2, fontSize: 14 },
    heading3: { ...mdBase.heading3, fontSize: 13 },
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
  const t = useT()
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
    <View style={s.dotsRow} accessibilityLabel={t('chat.msg.agentWorking')}>
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
  const dir = useDir()
  const t = useT()
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

  // Assistant replies are the mockup's Mochi-mark card; user messages are the
  // cream bubble on the right. Command outputs render as the card family, not
  // as prose — a terminal write-once row (no segments, no streaming tail).
  if (!isUser) {
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
      <View style={[s.botWrap, { flexDirection: dir.row }]}>
        <View style={s.avatarWrap}>
          <MochiMark size={26} />
        </View>
        <View style={[s.botCard, dir.rtl && s.botCardRtl]}>
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
            // BUG-040: the cursor rides INLINE at the text tail — as its own
            // block-level Text node it rendered on its own line below the
            // growing paragraph.
            <Text key={i} style={[s.streamText, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}>{seg.text}▍</Text>
          ) : (
            // BUG-135: completed text renders through the linkified
            // markdown-it + in-app link handler (see mdLinkified above).
            <Markdown key={i} style={withDir(md, dir)} markdownit={mdLinkified} onLinkPress={onMdLinkPress}>
              {seg.text}
            </Markdown>
          ),
        )}
        {m.streaming && !hasVisibleText ? <ThinkingDots /> : null}
        {m.status === 'failed' ? (
          <View style={[s.failedRow, { flexDirection: dir.row }]}>
            <Icon name="alert-circle" size={14} color={C.red} />
            <Text style={[s.failedText, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}>
              {m.error ?? t('chat.msg.failed')}
            </Text>
          </View>
        ) : null}
        {m.text && !m.streaming ? (
          <View style={[s.botActions, { flexDirection: dir.row }]}>
            <Text style={[s.time, dir.rtl ? { marginRight: 0, marginLeft: 6 } : null]}>{fmtTime(m.ts)}</Text>
            <Pressable
              onPress={copy}
              hitSlop={10}
              style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
              accessibilityRole="button"
              accessibilityLabel={t('chat.msg.copyA11y')}
            >
              <Icon name={copied ? 'checkmark' : 'copy-outline'} size={15} color={copied ? C.greenSoft : C.textFaint} />
            </Pressable>
            <Pressable
              onPress={() => { void toggleSpeak() }}
              hitSlop={10}
              style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
              accessibilityRole="button"
              accessibilityLabel={speakState === 'playing' ? t('chat.msg.stopPlaybackA11y') : t('chat.msg.listenA11y')}
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
  // Manual RTL mirroring (no I18nManager.forceRTL): outgoing bubbles move to
  // the reading-start side and the 4px tail corner follows them.
  const selfEnd = dir.rtl ? ('flex-start' as const) : ('flex-end' as const)
  return (
    <View style={[s.userWrap, { alignItems: selfEnd }]}>
      <View style={[s.userBubble, { alignSelf: selfEnd }, dir.rtl && s.userBubbleRtl, hasMediaSegs && s.userBubbleMedia]}>
        {userSegs.map((seg, i) =>
          seg.kind === 'media' ? (
            <MediaSegmentView key={i} seg={seg} />
          ) : seg.text ? (
            <Text key={i} style={[s.userText, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]} selectable>
              {seg.text}
            </Text>
          ) : null,
        )}
      </View>
      {/* BUG-045: user messages get a timestamp too — only assistant rows
          showed one. */}
      <Text style={[s.userTime, { alignSelf: selfEnd }]}>{fmtTime(m.ts)}</Text>
      {/* BUG-036: 'unconfirmed' renders through the same failed-row
          machinery (marker + Retry) but reads as a warning, not an error —
          a submit-phase timeout may still be running remotely. */}
      {m.status === 'failed' || m.status === 'unconfirmed' ? (
        <View style={[s.failedRow, s.failedRowUser, { flexDirection: dir.row, alignSelf: selfEnd }]}>
          <Icon
            name={m.status === 'unconfirmed' ? 'help-circle' : 'alert-circle'}
            size={14}
            color={m.status === 'unconfirmed' ? C.amber : C.red}
          />
          <Text style={[s.failedText, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}>
            {m.status === 'unconfirmed'
              ? (m.error ?? t('chat.msg.unconfirmed'))
              : (m.error ?? t('chat.msg.notSent'))}
          </Text>
          {onRetry && !hasMediaSegs ? (
            <Pressable
              onPress={() => onRetry(m.id)}
              style={({ pressed }) => [s.retryBtn, pressed && s.iconPressed]}
              accessibilityRole="button"
              accessibilityLabel={m.status === 'unconfirmed' ? t('chat.msg.retryUnconfirmedA11y') : t('chat.msg.retrySendA11y')}
            >
              <Icon name="refresh" size={12} color={C.text} />
              <Text style={s.retryText}>{t('common.retry')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
})

/**
 * One reasoning segment of an assistant message — the redesign's dashed
 * thinking pill. Collapsed it shows only the pill (blush dot + elapsed meta),
 * so even long transcripts with reasoning stay cheap; the text mounts only
 * while expanded, below the pill.
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
  const dir = useDir()
  const t = useT()
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
  return (
    <View style={s.thinkWrap}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={open ? t('chat.think.collapseA11y') : t('chat.think.expandA11y')}
        style={({ pressed }) => [
          s.thinkPill,
          { alignSelf: dir.rtl ? 'flex-end' : 'flex-start' },
          pressed && s.iconPressed,
        ]}
      >
        <View style={s.thinkDot} />
        {live ? <ThinkingDots /> : null}
        <Text style={s.thinkLabel}>
          {live ? t('chat.think.live') : t('chat.think.done')}
          {meta ? ` · ${meta}` : ''}
        </Text>
        {live && effort && onEffortPress ? (
          <Pressable
            hitSlop={6}
            style={({ pressed }) => [
              s.effortChip,
              dir.rtl ? { marginRight: 4 } : { marginLeft: 4 },
              pressed && s.iconPressed,
            ]}
            onPress={onEffortPress}
            accessibilityLabel={t('chat.think.effortA11y', { effort })}
          >
            <Text style={s.effortChipText}>{t('chat.think.effort', { effort })}</Text>
          </Pressable>
        ) : null}
      </Pressable>
      {open ? (
        <Text style={[s.thinkText, { textAlign: dir.textAlign, writingDirection: dir.writingDirection }]}>
          {seg.text.length > 4000 ? `${t('chat.think.truncated')}\n${seg.text.slice(-4000)}` : seg.text}
        </Text>
      ) : null}
    </View>
  )
})

/**
 * A collapsible tool-call card (mockup case 1): green check + mono tool name +
 * mono duration; tapping expands the tool's detail (the preview the gateway
 * pushed) under a hairline. Running rows keep their spinner, failed rows a red
 * cross — the data and states are unchanged from the old flat row.
 */
export const ToolRow = React.memo(function ToolRow({ t: tool }: { t: ToolItem }) {
  const s = useStyles(makeS)
  const dir = useDir()
  const t = useT()
  const [open, setOpen] = useState(false)
  const color = tool.status === 'running' ? C.accent : tool.status === 'failed' ? C.red : C.greenSoft
  const statusLabel =
    tool.status === 'running'
      ? t('chat.tool.status.running')
      : tool.status === 'failed'
        ? t('chat.tool.status.failed')
        : t('chat.tool.status.done')
  const expandable = !!tool.preview
  const head = (
    <View style={[s.toolHead, { flexDirection: dir.row }]}>
      {tool.status === 'running' ? (
        <ActivityIndicator size="small" color={color} style={s.toolSpinner} />
      ) : (
        <Icon name={tool.status === 'failed' ? 'close' : 'checkmark'} size={12} color={color} />
      )}
      <Text style={[s.toolName, s.mono]} numberOfLines={1}>{tool.name}</Text>
      {tool.durationS != null ? (
        <Text style={[s.toolDur, s.mono]}>{(tool.durationS).toFixed(1)}s</Text>
      ) : null}
      {expandable ? (
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={11}
          color={C.textFaint}
          style={s.toolChevron}
        />
      ) : null}
    </View>
  )
  const detail = open && tool.preview ? (
    <View style={s.toolDetail}>
      <Text style={[s.toolDetailText, s.mono]} numberOfLines={12}>{tool.preview}</Text>
    </View>
  ) : null
  if (!expandable) {
    return <View style={s.toolCard} accessibilityLabel={t('chat.tool.a11y', { name: tool.name, status: statusLabel })}>{head}</View>
  }
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      accessibilityRole="button"
      accessibilityLabel={
        open
          ? t('chat.tool.collapseA11y', { name: tool.name })
          : t('chat.tool.expandA11y', { name: tool.name })
      }
      style={({ pressed }) => [s.toolCard, pressed && s.iconPressed]}
    >
      {head}
      {detail}
    </Pressable>
  )
})

const makeS = () => StyleSheet.create({
  mono: { fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }) },
  // ── Assistant row: MochiMark 26 + the bgCard message card ────────────────
  botWrap: {
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 5,
  },
  avatarWrap: { width: 26, height: 26, marginTop: 2, flexShrink: 0 },

  botCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  // RTL mirror: the 4px tail corner moves to the reading-end corner.
  botCardRtl: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 4,
  },
  streamText: { color: C.text, fontSize: 12.5, lineHeight: 19 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 12, marginTop: 2 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.blush },
  botActions: { alignItems: 'center', gap: 2, marginTop: 6 },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  iconPressed: { opacity: 0.5 },
  time: { color: C.textFaint, fontSize: 10.5, marginRight: 6 },
  failedRow: { alignItems: 'center', gap: 6, marginTop: 8 },
  failedRowUser: { alignSelf: 'flex-end', marginTop: 6 },
  failedText: { color: C.red, fontSize: 12, flexShrink: 1, lineHeight: 17 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    height: 28,
  },
  retryText: { color: C.text, fontSize: 11.5, fontWeight: '700' },

  // ── User bubble: cream, right-aligned, 16/16/4/16 ────────────────────────
  userWrap: { alignItems: 'flex-end', paddingVertical: 5 },
  userTime: { color: C.textFaint, fontSize: 10.5, alignSelf: 'flex-end', marginTop: 3 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: C.userBubble,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 9,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  // RTL mirror of the bubble tail.
  userBubbleRtl: {
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  // Media rows: the photo/doc sits flush inside the bubble like ChatGPT's —
  // tighter padding, no double-inset around the media tiles.
  userBubbleMedia: { paddingHorizontal: 6, paddingVertical: 6, gap: 6 },
  userText: { color: C.userText, fontSize: 12.5, fontWeight: '500', lineHeight: 18 },

  // ── Dashed thinking pill ─────────────────────────────────────────────────
  thinkWrap: { marginBottom: 6 },
  thinkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: C.thinkBorder,
    backgroundColor: C.bgCard,
  },
  thinkDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.blush, flexShrink: 0 },
  thinkLabel: { color: C.textDim, fontSize: 11, fontWeight: '400' },
  thinkText: { color: C.textDim, fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  effortChip: { backgroundColor: C.bgHover, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  effortChipText: { color: C.textFaint, fontSize: 10, fontWeight: '700' },

  // ── Tool rows: tappable cards ────────────────────────────────────────────
  toolCard: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 11,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginVertical: 3,
  },
  toolHead: { alignItems: 'center', gap: 6 },
  toolSpinner: { width: 12, height: 12 },
  toolName: { color: C.textDim, fontSize: 11, fontWeight: '600', flexShrink: 1 },
  toolDur: { color: C.textFaint, fontSize: 10, marginLeft: 'auto' },
  toolChevron: { marginLeft: 2 },
  toolDetail: { marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: C.borderSoft },
  toolDetailText: { color: C.textDim, fontSize: 10.5, lineHeight: 15 },
})
