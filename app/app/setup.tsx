import React, { useEffect, useRef, useState } from 'react'
import { Animated, Easing, View, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
// BUG-133: plain ScrollView + no OS resize (edge-to-edge) left the API-key
// form and the Import-step CTAs under the IME. KeyboardAwareScrollView keeps
// the viewport above the keys and scrolls the focused input into view.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { router } from 'expo-router'
import { useStore } from '@nanostores/react'
import { Icon } from '../src/components/Icon'
import { Card, Field, GhostBtn, Pill, PrimaryBtn, Spinner, Txt } from '../src/components/ui'
import { C, useStyles } from '../src/lib/theme'
import { useDir, useT } from '../src/lib/strings'
import {
  linuxBootstrap,
  linuxStatus,
  linuxStatusLive,
  requestBatteryExemption,
  type LinuxGuestStatus,
} from '../src/lib/mochiRuntime'
import { ensureNotificationPermission } from '../src/lib/push'
import { fetchModelOptions, saveProviderKey, modelOptions, rankProviders } from '../src/lib/modelState'

/**
 * First-run setup wizard for the embedded ("This phone") mode (mockup 15):
 * environment → provider → basics → install progress. Local only: the agent
 * is the embedded runtime on this phone (no remote pairing in this build).
 */
export default function Setup() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [stepIdx, setStepIdx] = useState(0)
  // "Continue without Linux": the guest never lands, so the Install step must
  // not wait on status.bootstrapped (which stays false after a skip).
  const [skippedLinux, setSkippedLinux] = useState(false)
  // Local-only build: no remote import step, no pairing.
  const steps: Array<{ titleKey: string; render: () => React.ReactNode }> = [
    {
      titleKey: 'setup.wizard.title.env',
      render: () => <EnvStep onNext={(skipped) => { setSkippedLinux(skipped); setStepIdx(1) }} />,
    },
    { titleKey: 'setup.wizard.title.model', render: () => <ProviderStep onNext={() => setStepIdx(2)} /> },
    { titleKey: 'setup.wizard.title.basics', render: () => <BasicsStep onNext={() => setStepIdx(steps.length - 1)} /> },
    { titleKey: 'setup.wizard.title.install', render: () => <InstallStep skipped={skippedLinux} /> },
  ]
  const step = steps[Math.min(stepIdx, steps.length - 1)]
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <View style={[s.headerRow, { flexDirection: dir.row }]}>
          <Txt
            size={10.5}
            weight="800"
            color={C.accent}
            style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 0.945 }]}
          >
            {t('setup.wizard.kicker')}
          </Txt>
          <View
            style={[s.dots, { flexDirection: dir.row }]}
            accessible
            accessibilityLabel={t('setup.wizard.stepA11y', { n: stepIdx + 1 })}
          >
            {steps.map((_, i) => (
              <View key={i} style={[s.dot, i <= stepIdx && s.dotOn, i === stepIdx && s.dotActive]} />
            ))}
          </View>
        </View>
        <Txt size={20} weight="800">{t(step.titleKey)}</Txt>
      </View>
      <KeyboardAwareScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {step.render()}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  )
}

function EnvStep({ onNext }: { onNext: (skipped: boolean) => void }) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const distroName = (id?: string | null): string => {
    if (id === 'debian-12') return t('setup.env.debian.short')
    if (id === 'ubuntu-24.04') return t('setup.env.ubuntu.short')
    return id || t('setup.env.linuxFallback')
  }
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
      const r = await linuxBootstrap(distro === 'none' ? 'skip' : distro)
      if (!r || r.ok === false) {
        setBootErr(t('setup.wizard.env.failed'))
        return
      }
      // Skip path: the runtime answers ok with no guest installed — the next
      // step must not spin on status.bootstrapped.
      onNext(distro === 'none' || (r as { skipped?: boolean }).skipped === true)
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : t('setup.wizard.env.failedDetail'))
    } finally {
      setBooting(false)
    }
  }
  const options = [
    {
      id: 'ubuntu-24.04',
      name: t('setup.wizard.env.ubuntu'),
      tag: t('setup.wizard.env.tag.recommended'),
      desc: t('setup.wizard.env.ubuntu.desc'),
    },
    {
      id: 'debian-12',
      name: t('setup.wizard.env.debian'),
      tag: t('setup.wizard.env.tag.lightweight'),
      desc: t('setup.wizard.env.debian.desc'),
    },
    {
      id: 'none',
      name: t('setup.wizard.env.none'),
      tag: t('setup.wizard.env.tag.fastest'),
      desc: t('setup.wizard.env.none.desc'),
    },
  ]
  return (
    <>
      {options.map((o) => {
        const on = distro === o.id
        return (
          <Card
            key={o.id}
            onPress={() => setDistro(o.id)}
            style={on ? s.cardOn : undefined}
            accessibilityLabel={`${o.name}. ${o.tag}. ${o.desc}${on ? `. ${t('setup.a11y.selected')}` : ''}`}
          >
            <View style={[s.rowBetween, { flexDirection: dir.row, marginBottom: 3 }]}>
              <Txt size={13.5} weight="700" style={s.flex}>{o.name}</Txt>
              <Pill kind="accent">{o.tag}</Pill>
            </View>
            <Txt size={11.5} color={C.textDim}>{o.desc}</Txt>
          </Card>
        )
      })}
      {existing?.bootstrapped ? (
        <View style={[s.existingRow, { flexDirection: dir.row }]}>
          <Icon name="checkmark-circle" size={16} color={C.greenSoft} />
          <Txt size={11.5} color={C.textDim} style={s.flex}>
            {t('setup.wizard.env.existing', {
              distro: distroName(existing.distro),
              size: existing.sizeMb ?? 0,
            })}
          </Txt>
        </View>
      ) : null}
      {bootErr ? <Txt size={12.5} color={C.red} style={s.error}>{bootErr}</Txt> : null}
      <PrimaryBtn
        disabled={booting}
        onPress={() => { void runBootstrap() }}
        style={s.blockBtnTight}
      >
        {booting ? (
          <>
            <Spinner size="small" color={C.onAccent} />
            <Txt size={13} weight="700" color={C.onAccent}>{t('setup.wizard.env.installing')}</Txt>
          </>
        ) : (
          <Txt size={13} weight="700" color={C.onAccent}>
            {distro === 'none' ? t('setup.wizard.env.continueNone') : t('setup.wizard.env.install')}
          </Txt>
        )}
      </PrimaryBtn>
      <GhostBtn
        onPress={() => router.replace('/(tabs)/chat')}
        label={t('setup.wizard.env.skip')}
        style={s.blockGhost}
      />
    </>
  )
}

function ProviderStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const opts = useStore(modelOptions)
  // Full inventory, ranked (current → configured → rest): configured providers
  // used to be filtered out and the list capped at 8, hiding most of the
  // gateway registry. The container scrolls — no cap needed.
  const providers = rankProviders(opts?.providers ?? [])
  // Force a fresh fetch: a cached atom from a previous run of the sheet
  // renders stale authentication flags.
  useEffect(() => { void fetchModelOptions(undefined, { force: true }).catch(() => {}) }, [])
  const pickedProvider = providers.find((p) => p.slug === picked) ?? null

  /** Save the typed key (if any), then advance — the label is "Save & Continue". */
  const saveAndContinue = async () => {
    if (busy) return
    const apiKey = key.trim()
    if (!pickedProvider || !apiKey) { onNext(); return }
    setBusy(true)
    setSaveErr(null)
    try {
      await saveProviderKey(pickedProvider.slug, apiKey)
      onNext()
    } catch (e) {
      setSaveErr(
        t('setup.wizard.model.saveFailed', {
          why: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* BUG-052: the wire truth is server-side (model.save_key RPC) — the
          old "on this phone" copy contradicted the Models tab and reality. */}
      <Txt size={11.5} color={C.textDim} style={s.sub}>{t('setup.wizard.model.sub')}</Txt>
      {providers.map((p) => {
        const on = picked === p.slug
        return (
          <Card
            key={p.slug}
            // Tap-to-select only while unselected: the inline key field lives
            // inside this card, so a tap on the input must never close it.
            onPress={() => {
              if (on) return
              setPicked(p.slug)
              setKey('')
              setSaveErr(null)
            }}
            style={on ? s.cardOn : undefined}
            accessibilityLabel={`${p.name}${p.authenticated ? `, ${t('common.ready')}` : ''}`}
          >
            <View style={[s.rowBetween, { flexDirection: dir.row }]}>
              <Txt size={13} weight="700" style={s.flex}>{p.name}</Txt>
              {p.authenticated ? <Pill kind="green">{t('common.ready')}</Pill> : null}
            </View>
            {on ? (
              <View style={s.inlineForm}>
                <Field
                  value={key}
                  onChangeText={(v) => { setKey(v); if (saveErr) setSaveErr(null) }}
                  placeholder={t('setup.wizard.model.placeholder')}
                  accessibilityLabel={t('setup.wizard.model.keyA11y', { provider: p.name })}
                  secureTextEntry
                  mono
                  autoCapitalize="none"
                  autoCorrect={false}
                  wrapStyle={s.fieldGap}
                />
                {saveErr ? <Txt size={11.5} color={C.red} style={s.formError}>{saveErr}</Txt> : null}
                <PrimaryBtn disabled={busy} onPress={() => { void saveAndContinue() }}>
                  {busy ? (
                    <Spinner size="small" color={C.onAccent} />
                  ) : (
                    <Txt size={13} weight="700" color={C.onAccent}>{t('setup.wizard.model.save')}</Txt>
                  )}
                </PrimaryBtn>
              </View>
            ) : null}
          </Card>
        )
      })}
      {providers.length === 0 ? (
        <Txt size={11.5} color={C.textFaint} style={s.note}>{t('setup.wizard.model.loading')}</Txt>
      ) : null}
      <GhostBtn onPress={onNext} label={t('setup.wizard.model.skip')} style={s.blockGhost} />
    </>
  )
}

function BasicsStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const t = useT()
  const [battery, setBattery] = useState(false)
  const [notif, setNotif] = useState(false)
  useEffect(() => {
    void ensureNotificationPermission().then((ok) => setNotif(ok)).catch(() => {})
  }, [])
  return (
    <>
      {/* BUG-057: the tap actually (re-)requests the permission — it used to
          run `setNotif(notif || true)`, i.e. always flip to "allowed" without
          asking anything, so a user who denied could fake the card green. */}
      <Card
        onPress={() => { void ensureNotificationPermission().then((ok) => setNotif(ok)).catch(() => {}) }}
        accessibilityLabel={t('setup.wizard.basics.notifications.a11y')}
      >
        <Txt size={13} weight="700" style={s.cardTitleGap}>{t('setup.wizard.basics.notifications')}</Txt>
        <Txt size={11.5} color={C.textDim}>
          {notif
            ? t('setup.wizard.basics.notifications.allowed')
            : t('setup.wizard.basics.notifications.desc')}
        </Txt>
      </Card>
      <Card
        onPress={async () => {
          const r = await requestBatteryExemption().catch(() => null)
          setBattery(!!r)
        }}
        accessibilityLabel={t('setup.wizard.basics.battery.a11y')}
      >
        <Txt size={13} weight="700" style={s.cardTitleGap}>{t('setup.wizard.basics.battery')}</Txt>
        <Txt size={11.5} color={C.textDim}>
          {battery ? t('setup.wizard.basics.battery.done') : t('setup.wizard.basics.battery.desc')}
        </Txt>
      </Card>
      <PrimaryBtn onPress={onNext} label={t('setup.wizard.basics.finish')} style={s.blockBtnTop} />
    </>
  )
}

function InstallStep({ skipped }: { skipped: boolean }) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const pulse = useRef(new Animated.Value(0.06)).current
  const distroName = (id?: string | null): string => {
    if (id === 'debian-12') return t('setup.env.debian.short')
    if (id === 'ubuntu-24.04') return t('setup.env.ubuntu.short')
    return id || t('setup.env.linuxFallback')
  }
  const [status, setStatus] = useState<LinuxGuestStatus | null>(null)
  useEffect(() => {
    if (skipped) return
    const timer = setInterval(() => { void linuxStatusLive().then(setStatus).catch(() => {}) }, 2000)
    return () => clearInterval(timer)
  }, [skipped])
  const done = skipped || !!status?.bootstrapped
  // No percentage exists in the wire status (only the live on-disk size) —
  // the mockup's disk-progress bar runs as an indeterminate fill while the
  // install is busy and disappears on success.
  useEffect(() => {
    if (done) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.94, duration: 1600, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0.06, duration: 1600, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [done, pulse])
  const size = status?.sizeMb ?? 0
  const distro = distroName(status?.distro)
  return (
    <Card style={s.installCard}>
      {done ? (
        <View style={s.checkCircle}>
          <Icon name="checkmark" size={24} color={C.greenSoft} />
        </View>
      ) : (
        <Spinner size="large" color={C.accent} />
      )}
      <Txt size={16} weight="800" center style={s.installTitle}>
        {done ? t('setup.wizard.install.done') : t('setup.wizard.title.install')}
      </Txt>
      {!done ? (
        <View style={[s.track, { flexDirection: dir.row }]}>
          <Animated.View
            style={[
              s.trackFill,
              { width: pulse.interpolate({ inputRange: [0, 1], outputRange: ['6%', '94%'] }) },
            ]}
          />
        </View>
      ) : null}
      {done ? (
        <Txt size={11.5} color={C.textDim} mono center style={s.installLine}>
          {skipped
            ? t('setup.wizard.install.lineSkipped')
            : t('setup.wizard.install.line', { size, distro })}
        </Txt>
      ) : null}
      {!done ? (
        <Txt size={11.5} color={C.textDim} center style={s.installHint}>
          {t('setup.wizard.install.waiting')}
        </Txt>
      ) : null}
      {!done && status ? (
        <Txt size={11.5} color={C.textFaint} mono center style={s.installLine}>
          {t('setup.wizard.install.sizeSoFar', { size })}
        </Txt>
      ) : null}
      {skipped ? (
        <Txt size={11.5} color={C.textDim} center style={s.installHint}>
          {t('setup.wizard.install.skippedBody')}
        </Txt>
      ) : null}
      <PrimaryBtn
        onPress={() => router.replace('/(tabs)/chat')}
        label={t('setup.wizard.install.enter')}
        style={s.blockBtnTight}
      />
    </Card>
  )
}

// (The remote-import step is gone: this build has no remote pairing. The
// wizard is environment → model → basics → install, all on-phone.)

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 8 },
  headerRow: { alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  kicker: { textTransform: 'uppercase', flexShrink: 1 },
  dots: { alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 999, backgroundColor: C.bgHover },
  dotOn: { backgroundColor: C.accent },
  dotActive: { width: 18 },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 18 },
  rowBetween: { alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  flex: { flex: 1 },
  cardOn: { borderColor: C.accent },
  cardTitleGap: { marginBottom: 2 },
  existingRow: { alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 4, paddingHorizontal: 2 },
  sub: { lineHeight: 17, marginBottom: 12 },
  note: { lineHeight: 17, marginBottom: 10 },
  error: { lineHeight: 18, marginTop: 4, marginBottom: 8 },
  inlineForm: { marginTop: 10 },
  formError: { marginBottom: 8 },
  fieldGap: { marginBottom: 8 },
  blockBtnTight: { width: '100%', marginTop: 6 },
  blockBtnTop: { width: '100%', marginTop: 8 },
  blockGhost: { width: '100%', marginTop: 8 },
  installCard: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16 },
  checkCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.greenTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  installTitle: { marginBottom: 4 },
  track: {
    width: '100%',
    height: 2,
    borderRadius: 99,
    backgroundColor: C.borderSoft,
    overflow: 'hidden',
    marginTop: 2,
    marginBottom: 12,
  },
  trackFill: { height: '100%', borderRadius: 99, backgroundColor: C.accent },
  installLine: { marginBottom: 16 },
  installHint: { marginBottom: 16, lineHeight: 17 },
})
