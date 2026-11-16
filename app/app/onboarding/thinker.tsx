import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import {
  loadThinker,
  opencodeInstalled,
  installOpencode,
  diagnoseOpencodeServer,
  probeOpencodeRun,
  startOpencodeServer,
  setThinker,
  thinkerAtom,
  type Thinker,
} from '../../src/lib/thinker'
import { linuxStatus } from '../../src/lib/mochiRuntime'
import { useStore } from '@nanostores/react'

/**
 * Onboarding step 2 — whose brain answers.
 *
 * Moch (hermes, full feature set) or OpenCode (free models, chat + terminal).
 * OpenCode requires the Linux guest; the environment step (step 1, before this
 * one) installs it — choosing OpenCode with no guest points back there.
 */
export default function ThinkerChoice() {
  const s = useStyles(makeS)
  const thinker = useStore(thinkerAtom)
  const [guest, setGuest] = useState<boolean | null>(null)
  const [ocReady, setOcReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState<string>('')
  // Last-failure evidence, collected automatically (see pick) — the user can
  // expand it and send it back instead of another blind round-trip.
  const [diag, setDiag] = useState<string | null>(null)
  const [showDiag, setShowDiag] = useState(false)
  const [diagBusy, setDiagBusy] = useState(false)
  // One-shot probe state (manual trigger — spends a real model call).
  const [runReport, setRunReport] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const runDiagnostics = async () => {
    setDiagBusy(true)
    try {
      const d = await diagnoseOpencodeServer()
      setDiag(d.report)
    } catch (e) {
      setDiag(`Diagnostics failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDiagBusy(false)
    }
  }

  const runOneShotProbe = async () => {
    setRunBusy(true)
    setRunReport(null)
    try {
      const p = await probeOpencodeRun()
      setRunReport(p.report)
    } catch (e) {
      setRunReport(`Probe failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunBusy(false)
    }
  }

  useEffect(() => {
    void loadThinker()
    void linuxStatus().then((st) => setGuest(!!st?.bootstrapped)).catch(() => setGuest(false))
  }, [])

  useEffect(() => {
    if (!guest) return
    void opencodeInstalled().then(setOcReady).catch(() => setOcReady(false))
  }, [guest])

  const pick = async (t: Thinker) => {
    setErr(null)
    if (t === 'opencode') {
      if (!guest) {
        setErr('OpenCode runs inside the Linux guest — install it first.')
        return
      }
      setBusy(true)
      try {
        if (!ocReady) {
          setLog('Downloading OpenCode…')
          const inst = await installOpencode((pct) => setLog(`Downloading OpenCode… ${pct}%`))
          if (!inst.ok) {
            setErr(inst.stderr || 'OpenCode install failed.')
            return
          }
          setOcReady(true)
          setLog(`OpenCode ${inst.stdout.split('\n').pop()?.trim() ?? ''}`)
        }
        setLog('Starting the OpenCode server…')
        const up = await startOpencodeServer()
        if (!up.ok) {
          setErr(up.stderr || 'The OpenCode server did not start.')
          // Collect the evidence now, while the failure is fresh (stale log
          // included) — the expander below shows it verbatim.
          setDiag(null)
          setShowDiag(false)
          void runDiagnostics().then(() => setShowDiag(true))
          return
        }
        await setThinker('opencode')
        router.push('/onboarding/providers')
      } finally {
        setBusy(false)
        setLog('')
      }
      return
    }
    await setThinker('moch')
    router.push('/onboarding/providers')
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        <Text style={s.kicker}>STEP 2 OF 4</Text>
        <Text style={s.title}>Who's thinking?</Text>
        <Text style={s.sub}>
          Moch ships its own agent. OpenCode is an alternative brain for people who just want
          to try things, or don't have a model subscription — it runs free models by default.
        </Text>

        <Pressable
          style={[s.card, thinker === 'moch' && s.cardOn]}
          onPress={() => void pick('moch')}
          disabled={busy}
          accessibilityRole="radio"
          accessibilityState={{ selected: thinker === 'moch' }}
        >
          <View style={s.head}>
            <View style={[s.badge, { backgroundColor: C.accentSoft }]}>
              <Icon name="sparkles" size={20} color={C.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>Moch</Text>
              <Text style={s.tag}>Full agent · everything works</Text>
            </View>
            {thinker === 'moch' ? <Icon name="checkmark-circle" size={20} color={C.accent} /> : null}
          </View>
          <Text style={s.desc}>
            The embedded hermes runtime on this phone: bots, crew, automations, the agent browser,
            terminal, knocks, memory. Needs a model provider key.
          </Text>
        </Pressable>

        <Pressable
          style={[s.card, thinker === 'opencode' && s.cardOn]}
          onPress={() => void pick('opencode')}
          disabled={busy}
          accessibilityRole="radio"
          accessibilityState={{ selected: thinker === 'opencode' }}
        >
          <View style={s.head}>
            <View style={[s.badge, { backgroundColor: C.bgHover }]}>
              <Icon name="terminal-outline" size={20} color={C.textDim} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>OpenCode</Text>
              <Text style={s.tag}>Free models · chat + Linux only</Text>
            </View>
            {thinker === 'opencode' ? <Icon name="checkmark-circle" size={20} color={C.accent} /> : null}
          </View>
          <Text style={s.desc}>
            Installed in the Linux guest and paired with Moch. No subscription needed for its free
            models. Bots, crew, automations and the agent browser are hidden while this is active.
          </Text>
          {guest === false ? <Text style={s.warn}>Needs the Linux guest — go back a step to install it first, then come back here.</Text> : null}
        </Pressable>

        {busy ? (
          <View style={s.progress}>
            <ActivityIndicator size="small" color={C.accent} />
            <Text style={s.progressText}>{log || 'Working…'}</Text>
          </View>
        ) : null}
        {err ? <Text style={s.error}>{err}</Text> : null}
        {err && (diag || diagBusy) ? (
          <View style={s.diagBox}>
            <Pressable
              style={({ pressed }) => [s.diagBtn, pressed && s.pressed]}
              onPress={() => {
                if (showDiag || diagBusy) { setShowDiag(false); return }
                void runDiagnostics().then(() => setShowDiag(true))
              }}
              accessibilityRole="button"
              accessibilityLabel={showDiag ? 'Hide diagnostics' : 'Show diagnostics'}
            >
              <Text style={s.diagBtnText}>{diagBusy ? 'Collecting…' : showDiag ? 'Hide diagnostics' : 'Show diagnostics'}</Text>
            </Pressable>
            {showDiag && diag ? (
              <ScrollView style={s.diagScroll} nestedScrollEnabled>
                <Text style={s.diagText} selectable>{diag}</Text>
              </ScrollView>
            ) : null}
            {showDiag ? (
              <Text style={s.diagHint}>Long-press the text to copy it and send it back — it says exactly which step failed.</Text>
            ) : null}
            <Pressable
              style={({ pressed }) => [s.diagBtn, pressed && s.pressed]}
              onPress={() => { if (!runBusy) void runOneShotProbe() }}
              accessibilityRole="button"
              accessibilityLabel="Test one-shot mode"
            >
              <Text style={s.diagBtnText}>{runBusy ? 'Asking the model (up to 2 min)…' : 'Test one-shot mode'}</Text>
            </Pressable>
            {runReport ? (
              <View style={s.logBox}>
                <Text style={s.logText} selectable>{runReport}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {guest === false ? (
          <Pressable style={s.ghost} onPress={() => router.push('/onboarding/environment')} accessibilityRole="button">
            <Text style={s.ghostText}>Install Linux first →</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 48 },
  kicker: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.8, marginBottom: 8 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', lineHeight: 33, marginBottom: 8 },
  sub: { color: C.textDim, fontSize: 14, lineHeight: 20, marginBottom: 20 },
  card: { backgroundColor: C.bgCard, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, marginBottom: 12 },
  cardOn: { borderColor: C.accent },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  name: { color: C.text, fontSize: 17, fontWeight: '800' },
  tag: { color: C.textFaint, fontSize: 12, marginTop: 2 },
  desc: { color: C.textDim, fontSize: 13, lineHeight: 19, marginTop: 12 },
  warn: { color: C.amber, fontSize: 12, lineHeight: 17, marginTop: 10 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  progressText: { color: C.textDim, fontSize: 12.5, flex: 1 },
  error: { color: C.red, fontSize: 12.5, lineHeight: 18, marginTop: 12 },
  diagBox: { marginTop: 10 },
  diagBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: C.bgHover },
  diagBtnText: { color: C.accent, fontSize: 12.5, fontWeight: '800' },
  diagScroll: { maxHeight: 240, marginTop: 8, backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.borderSoft, padding: 10 },
  diagText: { color: C.textDim, fontSize: 11, lineHeight: 15, fontFamily: 'monospace' },
  logBox: { maxHeight: 220, marginTop: 8, backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.borderSoft, padding: 10 },
  logText: { color: C.textDim, fontSize: 11, lineHeight: 15, fontFamily: 'monospace' },
  diagHint: { color: C.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
  ghost: { alignItems: 'center', paddingVertical: 16 },
  ghostText: { color: C.accent, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.75 },
})
