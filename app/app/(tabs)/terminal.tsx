import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
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
  TERM_KEYS,
  TERM_RENDER_TAIL,
  TerminalController,
  applyFieldChange,
  renderTail,
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
  const [snap, setSnap] = useState<{ state: TermState; text: string; alive: boolean }>({
    state: 'idle',
    text: '',
    alive: false,
  })
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
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)
  const dead = snap.state === 'dead'
  // BUG-094: render only the tail of the buffer — Android rebuilds the
  // whole TextView layout on every Text change, so O(scrollback) renders
  // starve the JS thread (visible at 2Hz with the old caret blink; the
  // blink is gone, the caret is steady). Memoized on snap.text only: the
  // per-keystroke setHidden re-renders must not pay O(window) slices.
  const shown = useMemo(
    () => (snap.text ? renderTail(snap.text, TERM_RENDER_TAIL) : snap.state === 'starting' ? 'booting shell…' : ''),
    [snap.text, snap.state],
  )
  // Pin-to-bottom bookkeeping: scroll only while the user is at the bottom
  // and the tail actually grew (a shrink clamps naturally).
  const atBottomRef = useRef(true)
  const lastLenRef = useRef(0)

  const ctl = useMemo(
    () =>
      new TerminalController({
        start: (c, r) => linuxTermStart(c, r),
        write: (b) => linuxTermWrite(b),
        drain: () => linuxTermDrain(),
        replay: () => linuxTermReplay(),
        resize: (c, r) => linuxTermResize(c, r),
        kill: () => linuxTermKill(),
      }),
    [],
  )

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

  // Pin to bottom on new output (unless the user scrolled up). Only fires
  // when the tail grew and the user is near the bottom — every call is a
  // native scroll + draw during output streams.
  useEffect(() => {
    if (snap.text.length > lastLenRef.current && atBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
    lastLenRef.current = snap.text.length
  }, [snap.text])

  const onScroll = useCallback((e: { nativeEvent: { contentSize: { height: number }; layoutMeasurement: { height: number }; contentOffset: { y: number } } }) => {
    atBottomRef.current =
      e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height - e.nativeEvent.contentOffset.y < 48
  }, [])

  const send = useCallback(
    (raw: string) => {
      if (!raw) return
      void ctl.send(raw)
    },
    [ctl],
  )

  // Direct PTY typing: the PTY has ECHO ON, so the drained output is the
  // display — forward only what the field state machine derives
  // (applyFieldChange) and never render local input (no double echo).
  // The field value is FIELD_SENTINEL + logical, so a backspace always
  // has a char to delete (BUG-095): deleting the sentinel is "DEL past
  // field start"; the key-event channel is paired by counting, so IMEs
  // that emit both events can't double-delete.
  const onHiddenChange = useCallback(
    (raw: string) => {
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
    ctl.text = ''
    setSnap({ state: snap.state, text: '', alive: snap.alive })
  }, [ctl, snap.state, snap.alive])

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
          — see focusInput); touches bubble from the ScrollView to this View. */}
      <View style={s.outputWrap} onTouchEnd={focusInput}>
        <ScrollView
          ref={scrollRef}
          style={s.output}
          contentContainerStyle={s.outputInner}
          showsVerticalScrollIndicator
          keyboardShouldPersistTaps="always"
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {/* BUG-094: `shown` is the memoized tail window (steady between
              drain ticks — no blink, every blink rebuilt this whole Text).
              Caveat: ←/→ move the real PTY cursor inside the echo, but this
              ▍ stays pinned at the tail — resolved by the planned xterm.js
              renderer. */}
          <Text selectable style={[s.mono, { fontSize }]}>
            {shown}
            {!dead ? '▍' : ''}
          </Text>
          {dead ? (
            <>
              <Text style={[s.mono, s.deadLine, { fontSize }]}>[session ended]</Text>
              <Pressable
                style={({ pressed }) => [s.retry, pressed && s.pressed]}
                onPress={() => void ctl.start(80, 24)}
                accessibilityLabel="Restart shell"
              >
                <Text style={s.retryText}>Retry</Text>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
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

      <KeyRow onKey={send} />

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

const KEYS: { label: string; seq: string; hint: string }[] = [
  { label: 'Tab', seq: TERM_KEYS.TAB, hint: 'Autocomplete' },
  { label: '←', seq: TERM_KEYS.LEFT, hint: 'Cursor left' },
  { label: '→', seq: TERM_KEYS.RIGHT, hint: 'Cursor right' },
  { label: '↑', seq: TERM_KEYS.UP, hint: 'History back' },
  { label: '↓', seq: TERM_KEYS.DOWN, hint: 'History forward' },
  { label: '^C', seq: TERM_KEYS.CTRL_C, hint: 'Interrupt' },
  { label: '^D', seq: TERM_KEYS.CTRL_D, hint: 'Logout / EOF' },
  { label: 'Esc', seq: TERM_KEYS.ESC, hint: 'Escape' },
]

function KeyRow({ onKey }: { onKey: (seq: string) => void }) {
  const s = useStyles(makeS)
  return (
    <View style={s.keyRow}>
      {KEYS.map((k) => (
        <Pressable
          key={k.label}
          style={({ pressed }) => [s.key, pressed && s.pressed]}
          onPress={() => onKey(k.seq)}
          hitSlop={4}
          accessibilityLabel={k.hint}
        >
          <Text style={s.keyText}>{k.label}</Text>
        </Pressable>
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
    output: { flex: 1, backgroundColor: '#000', marginHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: C.border },
    outputWrap: { flex: 1 },
    outputInner: { padding: 10, paddingBottom: 16 },
    mono: { color: '#E8E8E8', fontFamily: 'monospace' },
    deadLine: { color: C.amber ?? '#E5A50A', marginTop: 8 },
    hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
    keyRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingTop: 8 },
    key: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 8,
      backgroundColor: C.bgCard,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: C.borderSoft,
    },
    keyText: { color: C.text, fontSize: 13, fontWeight: '600' },
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
