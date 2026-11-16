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
          setLog('Installing OpenCode in the Linux guest…')
          const inst = await installOpencode()
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
  ghost: { alignItems: 'center', paddingVertical: 16 },
  ghostText: { color: C.accent, fontSize: 14, fontWeight: '700' },
})
