import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Pressable, StyleSheet, TextInput, type GestureResponderEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { WebView } from 'react-native-webview'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { Icon } from '../../src/components/Icon'
import { Card, GhostBtn, HeaderButton, PrimaryBtn, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { tr, useT } from '../../src/lib/strings'
import {
  linuxStatus,
  linuxTermProbe,
  linuxTermStart,
  linuxTermWrite,
  linuxTermDrain,
  linuxTermReplay,
  linuxTermResize,
  linuxTermKill,
} from '../../src/lib/mochiRuntime'
import {
  FIELD_SENTINEL,
  TERM_DRAIN_FAST_MS,
  TERM_KEYS,
  TERM_CTRL_KEYS,
  TerminalController,
  applyFieldChange,
  type FieldState,
  type TermState,
} from '../../src/lib/terminal'
import { openInAppBrowserTab } from '../../src/lib/openInBrowser'

type Gate = 'checking' | 'noprobe' | 'noguest' | 'nopty' | 'ready' | 'failed'

/**
 * BUG-135: grace window a tap gives the WebView's __linkAt hit-test to
 * answer before the legacy IME re-focus fires. Well above the bridge
 * round-trip (~tens of ms), short enough that the refocus still feels
 * instant.
 */
const REFOCUS_DELAY_MS = 140

/** xterm font bounds — 13 is the renderer's default, 9/20 keep it legible. */
const FONT_MIN = 9
const FONT_MAX = 20

export default function Terminal() {
  const s = useStyles(makeS)
  const t = useT()
  // BUG-093: the bottom edge stays STATIC. The keyboard lift is the chat
  // pattern's animated negative paddingBottom (TerminalInner); swapping the
  // edge per keyboard state re-lays-out the whole frame mid-animation for
  // nothing (and sank the lift back by the inset in the KAV attempt).
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell
        title={t('sidebar.terminal')}
        right={<TerminalMenu onKill={() => killRef.current?.()} onClear={() => clearRef.current?.()} />}
      >
        <TerminalInner />
      </ScreenShell>
    </SafeAreaView>
  )
}

// ScreenShell renders `right` outside the screen subtree — cross the gap with refs.
const killRef = { current: null as null | (() => void) }
const clearRef = { current: null as null | (() => void) }

function TerminalMenu({ onKill, onClear }: { onKill: () => void; onClear: () => void }) {
  const s = useStyles(makeS)
  const t = useT()
  // Mockup: compact 28dp header icons — clear in ink, kill in red.
  return (
    <View style={s.menuRow}>
      <HeaderButton
        onPress={onClear}
        accessibilityLabel={t('terminal.clear')}
        style={s.menuBtn}
      >
        <Icon name="backspace-outline" size={16} color={C.text} />
      </HeaderButton>
      <HeaderButton
        onPress={onKill}
        accessibilityLabel={t('terminal.kill')}
        style={s.menuBtn}
      >
        <Icon name="close" size={16} color={C.red} />
      </HeaderButton>
    </View>
  )
}

function TerminalInner() {
  const s = useStyles(makeS)
  const t = useT()
  const router = useRouter()
  // IME visibility truth (RN focus lies on Android — see focusInput).
  // BUG-133: selector form — the object form re-rendered on every per-frame
  // keyboard animation field; only isVisible is consumed here.
  const keyboardVisible = useKeyboardState((k) => k.isVisible)
  const [gate, setGate] = useState<Gate>('checking')
  const [gateMsg, setGateMsg] = useState('')
  const [snap, setSnap] = useState<{ state: TermState; alive: boolean }>({ state: 'idle', alive: false })
  const [hidden, setHidden] = useState('')
  const [fontSize, setFontSize] = useState(13)
  /** Fitted xterm grid — display-only mirror of the `fit` message. */
  const [termGrid, setTermGrid] = useState({ cols: 80, rows: 24 })
  // BUG-093 lift: same driver as the chat screen (chat.tsx BUG-037 fix) —
  // the reanimated keyboard height as a negative bottom pad. The
  // KeyboardAvoidingView computed its pad from parent-relative coords and
  // ran short by status-bar + header height, so the key row and composer
  // stayed behind the IME; no coordinate math survives this host.
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  // Composer state machine (BUG-095): logical text + backspace key events
  // awaiting their change event. The field value is FIELD_SENTINEL + logical.
  const fieldRef = useRef<FieldState>({ logical: '', pendingKeys: 0 })
  const inputRef = useRef<TextInput>(null)
  const dead = snap.state === 'dead'
  // BUG-097 renderer: xterm.js lives in a local-asset WebView. Raw PTY
  // bytes flow controller → injectJavaScript → window.__tq → xterm.write;
  // the WebView answers with {ready|fit} JSON on postMessage.
  const wvRef = useRef<WebView>(null)
  const out = useRef({ ready: false, buf: [] as string[], bytes: 0 })
  // BUG-135 tap arbitration: the box-only wrapper (BUG-100) owns every tap.
  // A tap is EITHER a link open (WebView answers the __linkAt hit-test with
  // {type:'link'}) OR the legacy IME re-focus — never both. The refocus is
  // deferred one beat; a link reply cancels it.
  const hitRef = useRef<View>(null)
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingRefocus = useCallback(() => {
    if (refocusTimer.current != null) {
      clearTimeout(refocusTimer.current)
      refocusTimer.current = null
    }
  }, [])
  const inject = useCallback((js: string) => {
    wvRef.current?.injectJavaScript(js)
  }, [])
  const pushChunk = useCallback(
    (b64: string) => {
      const o = out.current
      if (!o.ready) {
        // WebView still loading — buffer, dropping the OLDEST bytes past
        // 4MB (a `cat huge` before load isn't worth memory).
        o.buf.push(b64)
        o.bytes += b64.length
        while (o.bytes > 4_000_000 && o.buf.length > 1) {
          const head = o.buf[0] ?? ''
          o.bytes -= head.length
          o.buf.shift()
        }
        return
      }
      inject(`window.__tq(${JSON.stringify(b64)});void 0;`)
    },
    [inject],
  )

  const ctl = useMemo(
    () =>
      new TerminalController(
        {
          start: (c, r) => linuxTermStart(c, r),
          write: (b) => linuxTermWrite(b),
          drain: () => linuxTermDrain(),
          replay: () => linuxTermReplay(),
          resize: (c, r) => linuxTermResize(c, r),
          kill: () => linuxTermKill(),
        },
        { drainMs: TERM_DRAIN_FAST_MS, onChunk: pushChunk },
      ),
    [pushChunk],
  )

  const send = useCallback(
    (raw: string) => {
      if (!raw) return
      void ctl.send(raw)
    },
    [ctl],
  )

  const handleWebMsg = useCallback(
    (e: { nativeEvent: { data: string } }) => {
      let msg: { type?: string; cols?: number; rows?: number; data?: string; url?: string }
      try {
        msg = JSON.parse(e.nativeEvent.data)
      } catch {
        return
      }
      if (msg.type === 'ready') {
        out.current.ready = true
        // The controller's raw bank is authoritative — it contains the
        // replay AND every chunk (including ones buffered while loading).
        const bank = ctl.rawBank
        if (bank) inject(`window.__tq(${JSON.stringify(bank)});void 0;`)
        out.current.buf = []
        out.current.bytes = 0
        inject('window.__fit();void 0;')
      } else if (msg.type === 'fit' && msg.cols && msg.rows) {
        const cols = msg.cols
        const rows = msg.rows
        // Display-only mirror for the status bar; resize itself unchanged.
        setTermGrid((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }))
        void ctl.resize(cols, rows)
      } else if (msg.type === 'key' && typeof msg.data === 'string' && msg.data) {
        // BUG-100 safety net: if the WebView ever holds focus, the Android
        // IME types into xterm's internal textarea — forward those bytes
        // instead of dropping them. Android has exactly one focused view,
        // so this channel and the hidden sentinel input are mutually
        // exclusive; no double-send is possible.
        send(msg.data)
      } else if (msg.type === 'link' && typeof msg.url === 'string' && msg.url) {
        // BUG-135: the WebView's __linkAt hit-test answered — this tap was
        // on a URL. Cancel the pending IME re-focus and open the built-in
        // Browser instead of raising the keyboard.
        cancelPendingRefocus()
        openInAppBrowserTab(msg.url)
      }
    },
    [cancelPendingRefocus, ctl, inject, send],
  )

  // Refit on layout changes (keyboard lift, font bump) — trailing throttle
  // so the RNKC animation frames don't storm fit/resize.
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleFit = useCallback(() => {
    clearTimeout(fitTimer.current)
    fitTimer.current = setTimeout(() => inject('window.__fit();void 0;'), 120)
  }, [inject])
  useEffect(() => () => clearTimeout(fitTimer.current), [])

  useEffect(() => {
    const off = ctl.onChange(setSnap)
    let alive = true
    ;(async () => {
      try {
        const st = await linuxStatus()
        if (!alive) return
        if (!st?.bootstrapped) {
          setGate('noguest')
          return
        }
        const p = await linuxTermProbe()
        if (!alive) return
        if (!p) {
          setGate('noprobe')
          setGateMsg(tr('terminal.bridgeMissing'))
          return
        }
        if (!p.pty || !p.shell) {
          setGate('nopty')
          setGateMsg(p.error ?? tr('terminal.ptyRefused'))
          return
        }
        setGate('ready')
        const ok = await ctl.start(80, 24)
        if (!alive) return
        if (!ok) setGate('failed')
      } catch (e) {
        if (alive) {
          setGate('failed')
          setGateMsg(e instanceof Error ? e.message : tr('terminal.startFailed'))
        }
      }
    })()
    return () => {
      alive = false
      off()
    }
  }, [ctl])

  // Session survives unmount (app holds the process) — stop polling only.
  useEffect(() => ctl.destroy.bind(ctl), [ctl])

  // Sticky pad modifiers (BUG-099): Ctrl/Alt arm and compose with the NEXT
  // key — a pad key sends its ctrlSeq; a typed char gets Ctrl→\x03-class
  // or Alt→ESC-prefix treatment. One-shot: consumed or disarmed.
  const [armed, setArmed] = useState<'ctrl' | 'alt' | null>(null)
  const armedRef = useRef<'ctrl' | 'alt' | null>(null)
  const consumeArmed = useCallback(() => {
    const m = armedRef.current
    armedRef.current = null
    setArmed(null)
    return m
  }, [])
  const onPadKey = useCallback(
    (seq: string) => {
      const m = consumeArmed()
      // An armed Alt prefixes; an armed Ctrl over a plain pad key falls
      // back to the unmodified seq (the pad's ctrlSeq handled Ctrl already).
      send(m === 'alt' ? TERM_KEYS.ESC + seq : seq)
    },
    [consumeArmed, send],
  )

  // Direct PTY typing: the PTY has ECHO ON, so the drained output is the
  // display — forward only what the field state machine derives
  // (applyFieldChange) and never render local input (no double echo).
  // The field value is FIELD_SENTINEL + logical, so a backspace always
  // has a char to delete (BUG-095): deleting the sentinel is "DEL past
  // field start"; the key-event channel is paired by counting, so IMEs
  // that emit both events can't double-delete. Armed pad modifiers
  // (BUG-099) compose with the typed char instead of applying the field.
  const onHiddenChange = useCallback(
    (raw: string) => {
      const m = armedRef.current
      if (m && raw.length >= 1) {
        const appended = raw.startsWith(FIELD_SENTINEL) ? raw.slice(1) : raw
        const ch = appended.slice(fieldRef.current.logical.length)
        if (ch.length === 1 && ch >= ' ' && ch !== '\x7f') {
          armedRef.current = null
          setArmed(null)
          send(m === 'ctrl' ? String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64) : TERM_KEYS.ESC + ch)
          // Leave the field untouched: the composed byte never entered it.
          setHidden(fieldRef.current.logical)
          return
        }
      }
      const { bytes, next } = applyFieldChange(fieldRef.current, raw)
      fieldRef.current = next
      if (bytes) send(bytes)
      setHidden(next.logical)
    },
    [send],
  )

  // Re-raising a dismissed IME needs a REAL native focus transition: when
  // the user hides the keyboard, Android silently keeps the input focused,
  // and showSoftInput off an already-focused view is dropped by the IMMS
  // (BUG-091 — plain focus() did nothing; selecting output text was the
  // only thing that blurred the field for real). blur() then refocus a
  // frame later supplies the transition. While the IME is up this is
  // skipped — no point tearing focus on every output tap. Touch-CANCEL is
  // deliberately NOT wired: long-press text selection ends there and must
  // not be torn down.
  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el || keyboardVisible) return
    el.blur()
    requestAnimationFrame(() => el.focus())
  }, [keyboardVisible])

  /**
   * BUG-135 tap arbitration for the box-only wrapper. On touchEnd: ask the
   * WebView WHERE the tap landed (window.__linkAt does the px→cell→URL
   * hit-test — only it knows cells and scrollback), and defer the legacy
   * focusInput by one beat (REFOCUS_DELAY_MS). A {type:'link'} reply
   * cancels the refocus and opens the built-in Browser; no reply within
   * the window means "not a link" and focusInput runs exactly as before.
   * When the WebView isn't ready (still loading / renderer gone) there is
   * no one to answer, so focusInput runs immediately — today's behavior.
   */
  const onTapOutput = useCallback(
    (e: GestureResponderEvent) => {
      if (!out.current.ready) {
        focusInput()
        return
      }
      cancelPendingRefocus()
      hitRef.current?.measureInWindow((wx, wy) => {
        const x = Math.round(e.nativeEvent.pageX - wx)
        const y = Math.round(e.nativeEvent.pageY - wy)
        if (x >= 0 && y >= 0) inject(`window.__linkAt(${x},${y});void 0;`)
      })
      refocusTimer.current = setTimeout(() => {
        refocusTimer.current = null
        focusInput()
      }, REFOCUS_DELAY_MS)
    },
    [cancelPendingRefocus, focusInput, inject],
  )
  useEffect(() => cancelPendingRefocus, [cancelPendingRefocus])

  const submitLine = useCallback(() => {
    send(TERM_KEYS.ENTER)
    fieldRef.current = { logical: '', pendingKeys: 0 }
    setHidden('')
  }, [send])

  killRef.current = useCallback(() => {
    showAlert(tr('terminal.killTitle'), tr('terminal.killBody'), [
      { text: tr('common.cancel'), style: 'cancel' },
      {
        text: tr('terminal.killCta'),
        style: 'destructive',
        onPress: () => {
          void ctl.kill()
        },
      },
    ])
  }, [ctl])

  clearRef.current = useCallback(() => {
    // Wipe the xterm viewport AND the replay bank, so a WebView reload
    // doesn't resurrect cleared output.
    ctl.rawBank = ''
    inject('window.__reset();void 0;')
  }, [ctl, inject])

  // Font size lives in xterm now — push it on change (13 on mount is the
  // HTML default; subsequent bumps arrive live).
  useEffect(() => {
    inject(`window.__tsize(${fontSize});void 0;`)
  }, [fontSize, inject])

  const bumpFont = useCallback((delta: number) => {
    setFontSize((f) => Math.max(FONT_MIN, Math.min(FONT_MAX, f + delta)))
  }, [])

  if (gate === 'checking') {
    return (
      <View style={s.center}>
        <Spinner />
        <Txt size={13} color={C.textDim} center>{t('terminal.starting')}</Txt>
      </View>
    )
  }

  if (gate === 'noguest') {
    return (
      <View style={s.emptyWrap}>
        <Card style={s.emptyCard}>
          <Txt size={15} weight="800" center>{t('terminal.noguest.title')}</Txt>
          <Txt size={12} color={C.textDim} center style={s.emptyBody}>
            {t('terminal.noguest.body')}
          </Txt>
          <PrimaryBtn
            label={t('terminal.noguest.cta')}
            onPress={() => router.push('/onboarding/environment')}
            style={s.emptyCta}
          />
        </Card>
      </View>
    )
  }

  if (gate === 'noprobe' || gate === 'nopty' || gate === 'failed') {
    return (
      <View style={s.center}>
        <Txt size={13} color={C.textDim} center>{gateMsg || t('terminal.failed')}</Txt>
        {snap.state === 'dead' ? (
          <GhostBtn
            label={t('common.retry')}
            onPress={() => {
              setGate('checking')
              void ctl.start(80, 24).then((ok) => setGate(ok ? 'ready' : 'failed'))
            }}
            style={s.gateRetry}
          />
        ) : null}
      </View>
    )
  }

  return (
    <Animated.View style={[s.root, kbPad]}>
      {/* xterm.js frame (mockup screen 5): flex 1, 2/10/6 margins, near-black
          surface, 14 radius, 10 padding; the font-size bar sits inside on a
          hairline, the sticky key pad just below the frame. */}
      <View style={s.termFrame}>
        {/* Tapping the output re-raises the IME when it's down (blur + refocus
            — see focusInput). BUG-100: Android enforces pointerEvents only on
            ReactViewGroup containers — on the WebView itself it's a no-op, so
            the WebView ate every tap and the IME typed into xterm's internal
            textarea, never reaching the PTY. The box-only wrapper intercepts
            touches BEFORE the WebView and is itself the tap target; the dead
            overlay stays a sibling so Retry remains tappable. */}
        <View style={s.outputWrap} onLayout={scheduleFit}>
          <View ref={hitRef} style={s.outputHit} pointerEvents="box-only" onTouchEnd={onTapOutput}>
            <WebView
              ref={wvRef}
              source={{ uri: 'file:///android_asset/term/index.html' }}
              javaScriptEnabled
              allowFileAccess
              onMessage={handleWebMsg}
              style={s.output}
              onRenderProcessGone={() => {
                // Android WebView renderer died — a reload replays from rawBank.
                out.current.ready = false
                inject('window.location.reload();void 0;')
              }}
            />
          </View>
          {dead ? (
            <View style={s.deadWrap} pointerEvents="box-none">
              <Txt mono ltr size={11} color={C.amber} style={s.deadLine}>
                {t('terminal.sessionEnded')}
              </Txt>
              <GhostBtn
                small
                label={t('common.retry')}
                accessibilityLabel={t('terminal.restart')}
                onPress={() => void ctl.start(80, 24)}
                style={s.deadRetry}
              />
            </View>
          ) : null}
        </View>

        {/* Font-size bar — mono xterm.js grid label + A− / A+ (real state). */}
        <View style={s.fontBar}>
          <Txt mono ltr size={10.5} color={C.textFaint}>
            {t('terminal.xtermSize', { cols: termGrid.cols, rows: termGrid.rows })}
          </Txt>
          <View style={s.fontBtns}>
            <Pressable
              onPress={() => bumpFont(-1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('terminal.fontSmaller')}
              style={({ pressed }) => [s.fontBtn, pressed && s.pressed]}
            >
              <Txt size={11} weight="700" color={C.text}>{t('terminal.font.decrease')}</Txt>
            </Pressable>
            <Pressable
              onPress={() => bumpFont(1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('terminal.fontBigger')}
              style={({ pressed }) => [s.fontBtn, pressed && s.pressed]}
            >
              <Txt size={11} weight="700" color={C.text}>{t('terminal.font.increase')}</Txt>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Invisible direct-typing field: zero-size, never rendered as text
          (the PTY echo in the drained output is the display). */}
      <TextInput
        ref={inputRef}
        value={FIELD_SENTINEL + hidden}
        onChangeText={onHiddenChange}
        /* Backspace key events: Android dispatches onKeyPress BEFORE the
           text change. Only the logically-empty field needs this channel
           (GBoard's delete on the bare sentinel deletes it and fires the
           change too — applyFieldChange pairs the two so exactly one DEL
           goes out; IMEs that emit the key without the change are covered
           because the DEL is sent HERE). With text in the field the change
           event's diff is authoritative — don't double-send. */
        onKeyPress={(e) => {
          if (e.nativeEvent.key !== 'Backspace' || fieldRef.current.logical !== '') return
          fieldRef.current = { ...fieldRef.current, pendingKeys: fieldRef.current.pendingKeys + 1 }
          send('\x7f')
        }}
        onSubmitEditing={submitLine}
        style={s.hiddenInput}
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        multiline={false}
        blurOnSubmit={false}
        editable={!dead}
        accessibilityLabel={t('terminal.inputA11y')}
      />

      <KeyRow onKey={onPadKey} armed={armed} onArm={(m) => { armedRef.current = m; setArmed(m) }} />

      {dead ? null : (
        <Txt size={11.5} color={C.textDim} center style={s.hint}>
          {t('terminal.tapHint')}
        </Txt>
      )}
    </Animated.View>
  )
}

/**
 * Pad keys: seq sent as-is; ctrlSeq = Ctrl+key form; hintKey = a11y label.
 * Row 1 is the mockup's sticky row (Ctrl, Alt, Tab, Esc + arrows); row 2
 * keeps every legacy key (^C, ^D, Home, End, PgUp, PgDn) reachable.
 */
const PAD_ROWS: { label: string; seq?: string; ctrlSeq?: string; modifier?: 'ctrl' | 'alt'; hintKey: string }[][] = [
  [
    { label: 'Ctrl', modifier: 'ctrl', hintKey: 'terminal.key.ctrl' },
    { label: 'Alt', modifier: 'alt', hintKey: 'terminal.key.alt' },
    { label: 'Tab', seq: TERM_KEYS.TAB, hintKey: 'terminal.key.tab' },
    { label: 'Esc', seq: TERM_KEYS.ESC, hintKey: 'terminal.key.escape' },
    { label: '↑', seq: TERM_KEYS.UP, ctrlSeq: TERM_CTRL_KEYS.UP, hintKey: 'terminal.key.up' },
    { label: '↓', seq: TERM_KEYS.DOWN, ctrlSeq: TERM_CTRL_KEYS.DOWN, hintKey: 'terminal.key.down' },
    { label: '←', seq: TERM_KEYS.LEFT, ctrlSeq: TERM_CTRL_KEYS.LEFT, hintKey: 'terminal.key.left' },
    { label: '→', seq: TERM_KEYS.RIGHT, ctrlSeq: TERM_CTRL_KEYS.RIGHT, hintKey: 'terminal.key.right' },
  ],
  [
    { label: '^C', seq: TERM_KEYS.CTRL_C, hintKey: 'terminal.key.interrupt' },
    { label: '^D', seq: TERM_KEYS.CTRL_D, hintKey: 'terminal.key.eof' },
    { label: 'Home', seq: TERM_KEYS.HOME, ctrlSeq: TERM_CTRL_KEYS.HOME, hintKey: 'terminal.key.home' },
    { label: 'End', seq: TERM_KEYS.END, ctrlSeq: TERM_CTRL_KEYS.END, hintKey: 'terminal.key.end' },
    { label: 'PgUp', seq: TERM_KEYS.PGUP, hintKey: 'terminal.key.pageUp' },
    { label: 'PgDn', seq: TERM_KEYS.PGDN, hintKey: 'terminal.key.pageDown' },
  ],
]

function KeyRow({
  onKey,
  armed,
  onArm,
}: {
  onKey: (seq: string) => void
  armed: 'ctrl' | 'alt' | null
  onArm: (m: 'ctrl' | 'alt' | null) => void
}) {
  const s = useStyles(makeS)
  const t = useT()
  return (
    <View style={s.padWrap}>
      {PAD_ROWS.map((row, i) => (
        <View key={i} style={s.keyRow}>
          {row.map((k) => {
            const isModifier = k.modifier != null
            const isArmed = k.modifier != null && armed === k.modifier
            return (
              <Pressable
                key={k.label}
                style={({ pressed }) => [s.key, isArmed && s.keyArmed, pressed && s.pressed]}
                onPress={() => {
                  if (isModifier) {
                    // Sticky modifier: arms, disarms on re-tap; consumed by
                    // the next pad key (ctrlSeq) or the next typed char.
                    onArm(armed === k.modifier ? null : (k.modifier ?? null))
                    return
                  }
                  onKey(k.ctrlSeq && armed === 'ctrl' ? k.ctrlSeq : (k.seq ?? ''))
                  if (armed) onArm(null)
                }}
                hitSlop={2}
                accessibilityLabel={t(k.hintKey)}
                accessibilityState={isModifier ? { selected: isArmed } : undefined}
              >
                <Txt mono ltr size={11} weight="700" color={isArmed ? C.onAccent : C.text}>
                  {k.label}
                </Txt>
              </Pressable>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },

  // ── No-guest empty state (mockup screen 5) ────────────────────────────────
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyCard: { padding: 20, width: '100%' },
  emptyBody: { marginTop: 6, marginBottom: 14, lineHeight: 17 },
  emptyCta: { alignSelf: 'center' },
  gateRetry: { marginTop: 12 },

  // ── xterm frame + font bar ────────────────────────────────────────────────
  termFrame: {
    flex: 1,
    marginTop: 2,
    marginHorizontal: 10,
    marginBottom: 6,
    backgroundColor: '#050508',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 10,
  },
  outputWrap: { flex: 1 },
  outputHit: { flex: 1 },
  output: { flex: 1, backgroundColor: '#050508' },
  deadWrap: { position: 'absolute', top: 14, left: 0, right: 0, alignItems: 'center' },
  deadLine: { marginTop: 8 },
  deadRetry: { marginTop: 8 },
  fontBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  fontBtns: { flexDirection: 'row', gap: 5 },
  fontBtn: {
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 1,
    minWidth: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Sticky key pad ────────────────────────────────────────────────────────
  padWrap: { paddingTop: 2 },
  keyRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingTop: 4 },
  key: {
    flex: 1,
    minWidth: 36,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    backgroundColor: C.bgCard,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  keyArmed: { backgroundColor: C.accent, borderColor: C.accent },
  hint: { paddingTop: 4, paddingBottom: 8, paddingHorizontal: 10 },

  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  pressed: { opacity: 0.55 },

  menuRow: { flexDirection: 'row', gap: 6 },
  menuBtn: { width: 28, height: 28, borderRadius: 10 },
})
