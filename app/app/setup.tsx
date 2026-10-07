import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../src/components/Icon'
import { C, useStyles } from '../src/lib/theme'
import {
  linuxBootstrap,
  linuxStatus,
  linuxStatusLive,
  requestBatteryExemption,
  type LinuxGuestStatus,
} from '../src/lib/hermesRuntime'
import { ensureNotificationPermission } from '../src/lib/push'
import { fetchModelOptions, saveProviderKey, modelOptions } from '../src/lib/modelState'
import { useStore } from '@nanostores/react'
import { ProviderKeyForm } from '../src/components/ProviderKeyForm'

/**
 * First-run setup wizard for the embedded ("This phone") mode:
 * environment → provider → basics → install progress.
 * Reachable from Settings → LINUX ENVIRONMENT → "Run setup".
 */
export default function Setup() {
  const s = useStyles(makeS)
  const [step, setStep] = useState(0)
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.kicker}>FIRST-RUN SETUP</Text>
        <Text style={s.title}>{['Choose an environment', 'Connect a model', 'Basics', 'Installing'][step]}</Text>
        <View style={s.stepsRow}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[s.stepDot, i <= step && s.stepDotOn]} />
          ))}
        </View>
        {step === 0 ? <EnvStep onNext={() => setStep(1)} /> : null}
        {step === 1 ? <ProviderStep onNext={() => setStep(2)} /> : null}
        {step === 2 ? <BasicsStep onNext={() => setStep(3)} /> : null}
        {step === 3 ? <InstallStep /> : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function EnvStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const [distro, setDistro] = useState('ubuntu-24.04')
  const [existing, setExisting] = useState<LinuxGuestStatus | null>(null)
  // BUG-016: the bootstrap is a minutes-long download that can fail — the
  // old button swallowed every error and advanced regardless, stranding the
  // Install step on an infinite spinner with no retry and no busy state.
  const [booting, setBooting] = useState(false)
  const [bootErr, setBootErr] = useState<string | null>(null)
  useEffect(() => { void linuxStatus().then(setExisting).catch(() => {}) }, [])
  const runBootstrap = async () => {
    if (booting) return
    setBootErr(null)
    setBooting(true)
    try {
      const r = await linuxBootstrap(distro === "none" ? "skip" : distro)
      if (!r || r.ok === false) {
        setBootErr("The install didn't finish — check the connection and try again.")
        return
      }
      onNext()
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : "The install failed — check the connection and try again.")
    } finally {
      setBooting(false)
    }
  }
  return (
    <>
      <Text style={s.sub}>
        Give the agent a real Linux userspace (apt, any language, servers).
        Downloaded on demand, lives entirely inside Moch's storage.
      </Text>
      {[
        { id: 'ubuntu-24.04', name: 'Ubuntu 24.04 LTS', desc: '~31 MB download · newest packages' },
        { id: 'debian-12', name: 'Debian 12', desc: 'smaller base, rock solid' },
        { id: 'none', name: 'None for now', desc: 'Android-only tools; can install later in Settings' },
      ].map((o) => (
        <Pressable key={o.id} style={[s.card, distro === o.id && s.cardOn]} onPress={() => setDistro(o.id)}>
          <View style={s.cardHead}>
            <Icon name={o.id === 'none' ? 'phone-portrait-outline' : 'logo-tux'} size={20} color={C.accent} />
            <Text style={s.cardTitle}>{o.name}</Text>
            {distro === o.id ? <Icon name="checkmark-circle" size={20} color={C.accent} /> : null}
          </View>
          <Text style={s.cardDesc}>{o.desc}</Text>
        </Pressable>
      ))}
      {existing?.bootstrapped ? (
        <Text style={s.note}>Already installed: {existing.distro || 'Linux'} · {existing.sizeMb} MB</Text>
      ) : null}
      {bootErr ? <Text style={s.err}>{bootErr}</Text> : null}
      <Pressable style={[s.btn, s.btnBlock, booting && s.btnBusy]} disabled={booting} onPress={() => { void runBootstrap() }}>
        <Text style={s.btnText}>{booting ? "Installing…" : distro === "none" ? "Continue without Linux" : "Install environment"}</Text>
      </Pressable>
      <Pressable style={s.ghost} onPress={() => router.replace('/(tabs)/chat')}>
        <Text style={s.ghostText}>Skip setup</Text>
      </Pressable>
    </>
  )
}

function ProviderStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const opts = useStore(modelOptions)
  const providers = (opts?.providers ?? []).filter((p) => !p.authenticated)
  useEffect(() => { void fetchModelOptions().catch(() => {}) }, [])
  return (
    <>
      <Text style={s.sub}>Pick the model provider the agent should use. Keys are stored on this phone.</Text>
      {providers.slice(0, 8).map((p) => (
        <Pressable key={p.slug} style={[s.card, picked === p.slug && s.cardOn]} onPress={() => setPicked(p.slug)}>
          <View style={s.cardHead}>
            <Icon name="flash-outline" size={18} color={C.accent} />
            <Text style={s.cardTitle}>{p.name}</Text>
            {p.authenticated ? <Text style={s.okTag}>ready</Text> : null}
          </View>
        </Pressable>
      ))}
      {providers.length === 0 ? <Text style={s.note}>Provider list loading… you can also set this later in Settings.</Text> : null}
      {picked ? (
        <ProviderKeyForm
          provider={providers.find((p) => p.slug === picked)!}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={async (key) => {
            setBusy(true)
            try {
              await saveProviderKey(picked, key)
              return null
            } catch (e) {
              return e instanceof Error ? e.message : 'save failed'
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}
      <Pressable style={[s.btn, s.btnBlock]} onPress={onNext}>
        <Text style={s.btnText}>{picked ? 'Continue' : 'Skip for now'}</Text>
      </Pressable>
    </>
  )
}

function BasicsStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const [battery, setBattery] = useState(false)
  const [notif, setNotif] = useState(false)
  useEffect(() => {
    void ensureNotificationPermission().then((ok) => setNotif(ok)).catch(() => {})
  }, [])
  return (
    <>
      <Text style={s.sub}>Two permissions that keep the agent reliable in the background.</Text>
      <Pressable style={s.card} onPress={() => setNotif(notif || true)}>
        <View style={s.cardHead}>
          <Icon name={notif ? 'notifications' : 'notifications-outline'} size={20} color={C.accent} />
          <Text style={s.cardTitle}>{notif ? 'Notifications allowed' : 'Notifications — asking…'}</Text>
        </View>
        <Text style={s.cardDesc}>Automation knocks and reply alerts</Text>
      </Pressable>
      <Pressable style={[s.card, battery && s.cardOn]} onPress={async () => { const r = await requestBatteryExemption().catch(() => null); setBattery(!!r) }}>
        <View style={s.cardHead}>
          <Icon name="battery-charging-outline" size={20} color={C.accent} />
          <Text style={s.cardTitle}>{battery ? 'Battery exemption requested' : 'Exempt from battery optimization'}</Text>
        </View>
        <Text style={s.cardDesc}>Recommended on MIUI and other aggressive ROMs</Text>
      </Pressable>
      <Pressable style={[s.btn, s.btnBlock]} onPress={onNext}>
        <Text style={s.btnText}>Finish setup</Text>
      </Pressable>
    </>
  )
}

function InstallStep() {
  const s = useStyles(makeS)
  const [status, setStatus] = useState<LinuxGuestStatus | null>(null)
  useEffect(() => {
    const t = setInterval(() => { void linuxStatusLive().then(setStatus).catch(() => {}) }, 2000)
    return () => clearInterval(t)
  }, [])
  const done = status?.bootstrapped
  return (
    <>
      <Text style={s.sub}>
        {done
          ? `Linux is ready: ${status?.distro ?? 'guest'} · ${status?.sizeMb ?? 0} MB. The agent's terminal now runs inside it.`
          : 'Setting up. This can take a few minutes on first install — you can leave this screen.'}
      </Text>
      {!done ? <ActivityIndicator color={C.accent} style={{ marginVertical: 18 }} /> : (
        <Icon name="checkmark-circle" size={56} color={C.accent} style={{ alignSelf: 'center', marginVertical: 18 }} />
      )}
      {status && !done ? <Text style={s.note}>on disk so far: {status.sizeMb} MB</Text> : null}
      <Pressable style={[s.btn, s.btnBlock]} onPress={() => router.replace('/(tabs)/chat')}>
        <Text style={s.btnText}>Enter Moch</Text>
      </Pressable>
    </>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingBottom: 48 },
  kicker: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 6 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 10 },
  stepsRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  stepDot: { width: 34, height: 4, borderRadius: 2, backgroundColor: C.bgCard },
  stepDotOn: { backgroundColor: C.accent },
  sub: { color: C.textDim, fontSize: 15, lineHeight: 21, marginBottom: 18 },
  card: { backgroundColor: C.bgCard, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  cardOn: { borderColor: C.accent },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '700', flex: 1 },
  cardDesc: { color: C.textFaint, fontSize: 13, marginTop: 6, lineHeight: 18 },
  okTag: { color: C.accent, fontSize: 12, fontWeight: '700' },
  note: { color: C.textFaint, fontSize: 12.5, marginVertical: 10 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  btnBusy: { opacity: 0.6 },
  err: { color: C.red, fontSize: 13, lineHeight: 18, marginTop: 10, textAlign: 'center' },
  btnBlock: { marginTop: 16 },
  btnText: { color: C.onAccent, fontSize: 16, fontWeight: '800' },
  ghost: { alignItems: 'center', paddingVertical: 14 },
  ghostText: { color: C.textFaint, fontSize: 14, fontWeight: '600' },
})
