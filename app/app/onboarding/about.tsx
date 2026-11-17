import React, { useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { saveAbout, setOnboarded } from '../../src/lib/aboutMe'
import { ensureNotificationPermission } from '../../src/lib/push'
import { requestBatteryExemption } from '../../src/lib/mochiRuntime'
import { thinkerAtom } from '../../src/lib/thinker'

/**
 * Onboarding step 4 — about you, then the two permissions that keep the runtime
 * alive. The answers go into the launch profile's USER.md through MemoryStore,
 * so the agent has them from its first turn.
 */
export default function About() {
  const s = useStyles(makeS)
  const [name, setName] = useState('')
  const [work, setWork] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notif, setNotif] = useState(false)
  const [battery, setBattery] = useState(false)
  const thinker = thinkerAtom.get()

  const finish = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    const r = await saveAbout({ name, work, extra })
    if (!r.ok) {
      // Memory is a nice-to-have: report, but never trap the user in setup.
      setErr(r.error ?? 'Could not save that.')
    }
    await setOnboarded(true)
    setBusy(false)
    router.replace('/(tabs)/chat')
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <KeyboardAwareScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.kicker}>STEP 4 OF 4</Text>
        <Text style={s.title}>A little about you</Text>
        <Text style={s.sub}>
          This becomes Moch's memory of you — it is stored on this phone, in the agent's own
          memory file, and it reads it on every turn.
        </Text>

        <Text style={s.label}>YOUR NAME</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="What should Moch call you?"
          placeholderTextColor={C.textFaint}
          autoCapitalize="words"
          accessibilityLabel="Your name"
        />

        <Text style={s.label}>WHAT DO YOU DO?</Text>
        <TextInput
          style={s.input}
          value={work}
          onChangeText={setWork}
          placeholder="Job, studies, projects…"
          placeholderTextColor={C.textFaint}
          accessibilityLabel="What you do"
        />

        <Text style={s.label}>ANYTHING ELSE TO REMEMBER?</Text>
        <TextInput
          style={[s.input, s.multiline]}
          value={extra}
          onChangeText={setExtra}
          placeholder="Languages, timezone, preferences…"
          placeholderTextColor={C.textFaint}
          multiline
          accessibilityLabel="Anything else to remember"
        />

        <View style={s.permCard}>
          <Pressable
            style={s.permRow}
            onPress={() => void ensureNotificationPermission().then(setNotif).catch(() => {})}
            accessibilityRole="button"
          >
            <Icon name={notif ? 'notifications' : 'notifications-outline'} size={19} color={C.accent} />
            <View style={{ flex: 1 }}>
              <Text style={s.permTitle}>{notif ? 'Notifications allowed' : 'Allow notifications'}</Text>
              <Text style={s.permSub}>Job knocks and replies while the app is closed</Text>
            </View>
          </Pressable>
          <View style={s.divider} />
          <Pressable
            style={s.permRow}
            onPress={() => void requestBatteryExemption().then((r) => setBattery(!!r)).catch(() => {})}
            accessibilityRole="button"
          >
            <Icon name="battery-charging-outline" size={19} color={C.accent} />
            <View style={{ flex: 1 }}>
              <Text style={s.permTitle}>{battery ? 'Battery exemption requested' : 'Keep the agent alive'}</Text>
              <Text style={s.permSub}>Exempt from battery optimization (recommended on MIUI)</Text>
            </View>
          </Pressable>
        </View>

        {thinker === 'opencode' ? (
          <View style={s.noteCard}>
            <Icon name="information-circle-outline" size={18} color={C.amber} />
            <Text style={s.noteText}>
              You chose OpenCode as the thinker. Bots, crew, automations and the agent browser are
              hidden — chat and the Linux terminal are the surface. You can switch back in Settings.
            </Text>
          </View>
        ) : null}

        {err ? <Text style={s.error}>{err}</Text> : null}

        <Pressable style={[s.btn, busy && s.btnBusy]} disabled={busy} onPress={() => void finish()} accessibilityRole="button">
          {busy ? <ActivityIndicator color={C.onAccent} /> : <Text style={s.btnText}>Start using Moch</Text>}
        </Pressable>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 56 },
  kicker: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.8, marginBottom: 8 },
  title: { color: C.text, fontSize: 27, fontWeight: '800', lineHeight: 32, marginBottom: 8 },
  sub: { color: C.textDim, fontSize: 14, lineHeight: 20, marginBottom: 18 },
  label: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4, marginTop: 14, marginBottom: 6 },
  input: {
    backgroundColor: C.inputBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 48,
  },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  permCard: { backgroundColor: C.bgCard, borderRadius: 16, borderWidth: 1, borderColor: C.border, marginTop: 22 },
  permRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 58 },
  permTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  permSub: { color: C.textFaint, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
  divider: { height: 1, backgroundColor: C.borderSoft, marginLeft: 45 },
  noteCard: { flexDirection: 'row', gap: 10, backgroundColor: C.amberSoft, borderRadius: 14, padding: 12, marginTop: 16 },
  noteText: { color: C.textDim, fontSize: 12, lineHeight: 17, flex: 1 },
  error: { color: C.red, fontSize: 12.5, marginTop: 12, lineHeight: 18 },
  btn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 20 },
  btnBusy: { opacity: 0.65 },
  btnText: { color: C.onAccent, fontSize: 15.5, fontWeight: '800' },
})
