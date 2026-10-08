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
import { TerminalController, TERM_KEYS, diffKeystrokes, type TermState } from '../../src/lib/terminal'

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
  // RN focus tracking of the hidden input — blink driver only; IME truth is
  // keyboard.isVisible (Android keeps RN focus after the IME hides).
  const [focused, setFocused] = useState(false)
  const [caretOn, setCaretOn] = useState(true)
  const dead = snap.state === 'dead'
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)
  // Last value of the hidden composer field — diffed per change to derive
  // the exact keystrokes to forward to the PTY.
  const prevHiddenRef = useRef('')

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

  // Pin to bottom on new output (unless the user scrolled up — v1 keeps it simple).
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false })
  }, [snap.text])

  // 500ms caret blink while the IME is up AND the field holds RN focus;
  // steady block caret otherwise — the user must always see where typing
  // lands (BUG-090). Android keeps RN focus after the IME hides, so the
  // blink gates on real keyboard visibility, not focus alone.
  useEffect(() => {
    if (!focused || dead || !keyboard.isVisible) {
      setCaretOn(true)
      return
    }
    const id = setInterval(() => setCaretOn((v) => !v), 500)
    return () => clearInterval(id)
  }, [focused, dead, keyboard.isVisible])

  const send = useCallback(
    (raw: string) => {
      if (!raw) return
      void ctl.send(raw)
    },
    [ctl],
  )

  // Direct PTY typing: the PTY has ECHO ON, so the drained output is the
  // display — forward the diff (diffKeystrokes) and never render local
  // input (no double echo). Empty-field backspace never produces a change
  // event — handled by onKeyPress below.
  const onHiddenChange = useCallback(
    (t: string) => {
      const bytes = diffKeystrokes(prevHiddenRef.current, t)
      if (bytes) send(bytes)
      prevHiddenRef.current = t
      setHidden(t)
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
    prevHiddenRef.current = ''
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
        >
          {/* Caveat: ←/→ move the real PTY cursor inside the echo, but this
              ▍ stays pinned at the tail — a single Text node can't place a
              caret mid-stream. Resolved by the planned xterm.js renderer. */}
          <Text selectable style={[s.mono, { fontSize }]}>
            {snap.text || (snap.state === 'starting' ? 'booting shell…' : '')}
            {!dead && caretOn ? '▍' : ''}
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
        value={hidden}
        onChangeText={onHiddenChange}
        /* Backspace on an EMPTY field is the diff's dead zone: the value is
           cleared after every submit, so there is no text to remove and no
           onChangeText ever fires — but key events still do. Send DEL only
           while the field is empty; once it holds text the removal branch of
           onHiddenChange already emits \x7f, and firing both would delete
           two characters per keypress. */
        onKeyPress={(e) => {
          if (e.nativeEvent.key === 'Backspace' && prevHiddenRef.current === '') send('\x7f')
        }}
        onSubmitEditing={submitLine}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
