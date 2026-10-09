import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { WebView } from 'react-native-webview'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import {
  linuxStatus,
  linuxTermProbe,
  linuxTermStart,
  linuxTermWrite,
  linuxTermDrain,
  linuxTermReplay,
  linuxTermResize,
  linuxTermKill,
} from '../../src/lib/hermesRuntime'
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

type Gate = 'checking' | 'noprobe' | 'noguest' | 'nopty' | 'ready' | 'failed'

export default function Terminal() {
  const s = useStyles(makeS)
  // BUG-093: the bottom edge stays STATIC. The keyboard lift is the chat
  // pattern's animated negative paddingBottom (TerminalInner); swapping the
  // edge per keyboard state re-lays-out the whole frame mid-animation for
  // nothing (and sank the lift back by the inset in the KAV attempt).
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell
        title="Terminal"
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
  return (
    <View style={s.menuRow}>
      <Pressable
        style={({ pressed }) => [s.menuBtn, pressed && s.pressed]}
        onPress={onClear}
        hitSlop={8}
        accessibilityLabel="Clear screen"
      >
        <Icon name="ban-outline" size={17} color={C.text} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [s.menuBtn, pressed && s.pressed]}
        onPress={onKill}
        hitSlop={8}
        accessibilityLabel="Kill terminal session"
      >
        <Icon name="skull-outline" size={17} color={C.text} />
      </Pressable>
    </View>
  )
}

function TerminalInner() {
  const s = useStyles(makeS)
  // IME visibility truth (RN focus lies on Android — see focusInput).
  const keyboard = useKeyboardState()
  const [gate, setGate] = useState<Gate>('checking')
  const [gateMsg, setGateMsg] = useState('')
  const [snap, setSnap] = useState<{ state: TermState; alive: boolean }>({ state: 'idle', alive: false })
  const [hidden, setHidden] = useState('')
  const [fontSize, setFontSize] = useState(13)
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
      let msg: { type?: string; cols?: number; rows?: number; data?: string }
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
        void ctl.resize(msg.cols, msg.rows)
      } else if (msg.type === 'key' && typeof msg.data === 'string' && msg.data) {
        // BUG-100 safety net: if the WebView ever holds focus, the Android
        // IME types into xterm's internal textarea — forward those bytes
        // instead of dropping them. Android has exactly one focused view,
        // so this channel and the hidden sentinel input are mutually
        // exclusive; no double-send is possible.
        send(msg.data)
      }
    },
    [ctl, inject, send],
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
          setGateMsg('Native terminal bridge missing — rebuild the APK with this branch.')
          return
        }
        if (!p.pty || !p.shell) {
          setGate('nopty')
          setGateMsg(p.error ?? 'This device refused the terminal pty.')
          return
        }
        setGate('ready')
        const ok = await ctl.start(80, 24)
        if (!alive) return
        if (!ok) setGate('failed')
      } catch (e) {
        if (alive) {
          setGate('failed')
          setGateMsg(e instanceof Error ? e.message : 'Terminal failed to start')
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
    if (!el || keyboard.isVisible) return
    el.blur()
    requestAnimationFrame(() => el.focus())
  }, [keyboard.isVisible])

  const submitLine = useCallback(() => {
    send(TERM_KEYS.ENTER)
    fieldRef.current = { logical: '', pendingKeys: 0 }
    setHidden('')
  }, [send])

  killRef.current = useCallback(() => {
    showAlert('Kill terminal session?', 'The shell and its jobs die. Next open boots a fresh one.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Kill',
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

  if (gate === 'checking') {
    return (
      <View style={s.center}>
        <ActivityIndicator color={C.textDim} />
        <Text style={s.dim}>Starting terminal…</Text>
      </View>
    )
  }

  if (gate === 'noguest') {
    return (
      <View style={s.center}>
        <Text style={s.dim}>Moch Linux isn't installed yet.</Text>
        <Text style={s.dim}>Install it from Settings → Linux environment, then come back.</Text>
      </View>
    )
  }

  if (gate === 'noprobe' || gate === 'nopty' || gate === 'failed') {
    return (
      <View style={s.center}>
        <Text style={s.dim}>{gateMsg || 'Terminal failed to start.'}</Text>
        {snap.state === 'dead' ? (
          <Pressable
            style={({ pressed }) => [s.retry, pressed && s.pressed]}
            onPress={() => {
              setGate('checking')
              void ctl.start(80, 24).then((ok) => setGate(ok ? 'ready' : 'failed'))
            }}
          >
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }

  return (
    <Animated.View style={[s.root, kbPad]}>
      {/* Tapping the output re-raises the IME when it's down (blur + refocus
          — see focusInput). BUG-100: Android enforces pointerEvents only on
          ReactViewGroup containers — on the WebView itself it's a no-op, so
          the WebView ate every tap and the IME typed into xterm's internal
          textarea, never reaching the PTY. The box-only wrapper intercepts
          touches BEFORE the WebView and is itself the tap target; the dead
          overlay stays a sibling so Retry remains tappable. */}
      <View style={s.outputWrap} onLayout={scheduleFit}>
        <View style={s.outputHit} pointerEvents="box-only" onTouchEnd={focusInput}>
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
            <Text style={[s.mono, s.deadLine]}>[session ended]</Text>
            <Pressable
              style={({ pressed }) => [s.retry, pressed && s.pressed]}
              onPress={() => void ctl.start(80, 24)}
              accessibilityLabel="Restart shell"
            >
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
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
        accessibilityLabel="Terminal input"
      />

      <KeyRow onKey={onPadKey} armed={armed} onArm={(m) => { armedRef.current = m; setArmed(m) }} />

      <View style={s.composer}>
        <Text style={s.prompt}>{dead ? 'session ended' : '$ touch output to type'}</Text>
        <Pressable
          style={({ pressed }) => [s.send, pressed && s.pressed]}
          onPress={() => setFontSize((f) => Math.min(20, f + 1))}
          hitSlop={8}
          accessibilityLabel="Bigger font"
        >
          <Text style={s.aa}>A+</Text>
        </Pressable>
      </View>
    </Animated.View>
  )
}

/** Pad keys: seq sent as-is; ctrlSeq = Ctrl+key form; hint = a11y label. */
const PAD_ROWS: { label: string; seq?: string; ctrlSeq?: string; modifier?: 'ctrl' | 'alt'; hint: string }[][] = [
  [
    { label: 'Esc', seq: TERM_KEYS.ESC, hint: 'Escape' },
    { label: 'Tab', seq: TERM_KEYS.TAB, hint: 'Autocomplete' },
    { label: 'Ctrl', modifier: 'ctrl', hint: 'Ctrl modifier for the next key' },
    { label: '↑', seq: TERM_KEYS.UP, ctrlSeq: TERM_CTRL_KEYS.UP, hint: 'History back' },
    { label: '↓', seq: TERM_KEYS.DOWN, ctrlSeq: TERM_CTRL_KEYS.DOWN, hint: 'History forward' },
    { label: '^C', seq: TERM_KEYS.CTRL_C, hint: 'Interrupt' },
    { label: '^D', seq: TERM_KEYS.CTRL_D, hint: 'Logout / EOF' },
  ],
  [
    { label: 'Alt', modifier: 'alt', hint: 'Alt modifier for the next key' },
    { label: '←', seq: TERM_KEYS.LEFT, ctrlSeq: TERM_CTRL_KEYS.LEFT, hint: 'Cursor left' },
    { label: '→', seq: TERM_KEYS.RIGHT, ctrlSeq: TERM_CTRL_KEYS.RIGHT, hint: 'Cursor right' },
    { label: 'Home', seq: TERM_KEYS.HOME, ctrlSeq: TERM_CTRL_KEYS.HOME, hint: 'Line start' },
    { label: 'End', seq: TERM_KEYS.END, ctrlSeq: TERM_CTRL_KEYS.END, hint: 'Line end' },
    { label: 'PgUp', seq: TERM_KEYS.PGUP, hint: 'Page up' },
    { label: 'PgDn', seq: TERM_KEYS.PGDN, hint: 'Page down' },
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
                accessibilityLabel={k.hint}
                accessibilityState={isModifier ? { selected: isArmed } : undefined}
              >
                <Text style={[s.keyText, isArmed && s.keyTextArmed]}>{k.label}</Text>
              </Pressable>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const makeS = () =>
  ({
    frame: { flex: 1, backgroundColor: C.bg },
    root: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    dim: { color: C.textDim, fontSize: 14, textAlign: 'center' },
    output: { flex: 1, backgroundColor: '#000', borderRadius: 12, borderWidth: 1, borderColor: C.border },
    outputWrap: { flex: 1 },
    outputHit: { flex: 1, marginHorizontal: 10 },
    mono: { color: '#E8E8E8', fontFamily: 'monospace' },
    deadWrap: { position: 'absolute', top: 14, left: 0, right: 0, alignItems: 'center' },
    deadLine: { color: C.amber ?? '#E5A50A', marginTop: 8 },
    hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
    keyRow: { flexDirection: 'row', gap: 5, paddingHorizontal: 10, paddingTop: 6 },
    padWrap: { paddingBottom: 2 },
    key: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 7,
      backgroundColor: C.bgCard,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: C.borderSoft,
    },
    keyArmed: { backgroundColor: C.bgElev, borderColor: C.accent ?? C.text },
    keyText: { color: C.text, fontSize: 12, fontWeight: '600' },
    keyTextArmed: { color: C.accent ?? C.text },
    composer: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10 },
    prompt: { color: C.textDim, fontSize: 16, fontWeight: '700' },
    send: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgCard,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.borderSoft,
    },
    aa: { color: C.text, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.55 },
    retry: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: C.bgCard, borderRadius: 10, borderWidth: 1, borderColor: C.borderSoft },
    retryText: { color: C.text, fontWeight: '600' },
    menuRow: { flexDirection: 'row', gap: 6 },
    menuBtn: {
      width: 38,
      height: 38,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.borderSoft,
    },
  }) as const
