import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
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
import { TerminalController, TERM_KEYS, type TermState } from '../../src/lib/terminal'

type Gate = 'checking' | 'noprobe' | 'noguest' | 'nopty' | 'ready' | 'failed'

export default function Terminal() {
  const s = useStyles(makeS)
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
  const [gate, setGate] = useState<Gate>('checking')
  const [gateMsg, setGateMsg] = useState('')
  const [snap, setSnap] = useState<{ state: TermState; text: string; alive: boolean }>({
    state: 'idle',
    text: '',
    alive: false,
  })
  const [input, setInput] = useState('')
  const [fontSize, setFontSize] = useState(13)
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)

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

  const send = useCallback(
    (raw: string) => {
      if (!raw) return
      void ctl.send(raw)
    },
    [ctl],
  )

  const submitLine = useCallback(() => {
    if (!input) return
    send(input + '\n')
    setInput('')
  }, [input, send])

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

  const dead = snap.state === 'dead'

  return (
    <View style={s.root}>
      <ScrollView
        ref={scrollRef}
        style={s.output}
        contentContainerStyle={s.outputInner}
        showsVerticalScrollIndicator
      >
        <Text selectable style={[s.mono, { fontSize }]}>
          {snap.text || (snap.state === 'starting' ? 'booting shell…' : '')}
        </Text>
        {dead ? <Text style={[s.mono, s.deadLine, { fontSize }]}>[session ended — Retry to boot a fresh shell]</Text> : null}
      </ScrollView>

      <KeyRow onKey={send} />

      <View style={s.composer}>
        <Text style={s.prompt}>$</Text>
        <TextInput
          ref={inputRef}
          style={[s.input, { fontSize }]}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submitLine}
          placeholder={dead ? 'session ended' : 'type a command…'}
          placeholderTextColor={C.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          editable={!dead}
          blurOnSubmit={false}
        />
        <Pressable
          style={({ pressed }) => [s.send, pressed && s.pressed]}
          onPress={submitLine}
          hitSlop={8}
          accessibilityLabel="Send command"
        >
          <Icon name="return-up-forward" size={18} color={C.text} />
        </Pressable>
        <Pressable
          style={({ pressed }) => [s.send, pressed && s.pressed]}
          onPress={() => setFontSize((f) => Math.min(20, f + 1))}
          hitSlop={8}
          accessibilityLabel="Bigger font"
        >
          <Text style={s.aa}>A+</Text>
        </Pressable>
      </View>
    </View>
  )
}

const KEYS: { label: string; seq: string; hint: string }[] = [
  { label: 'Tab', seq: TERM_KEYS.TAB, hint: 'Autocomplete' },
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
    outputInner: { padding: 10, paddingBottom: 16 },
    mono: { color: '#E8E8E8', fontFamily: 'monospace' },
    deadLine: { color: C.amber ?? '#E5A50A', marginTop: 8 },
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
    input: {
      flex: 1,
      color: C.text,
      fontFamily: 'monospace',
      backgroundColor: C.bgCard,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.borderSoft,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
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
