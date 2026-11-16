import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { tr } from '../../src/lib/strings'
import {
  ALL_PACKAGES,
  PACKAGE_CATEGORIES,
  defaultsPackageIds,
  installPackages,
  cancelPackageInstall,
  withRequirements,
  type PackageResult,
} from '../../src/lib/linuxPackages'
import { linuxBootstrap, linuxStatus, type LinuxGuestStatus } from '../../src/lib/mochiRuntime'

/**
 * Onboarding step 1 — the environment.
 *
 * The Linux guest is optional but it is the only place OpenCode (and real
 * package work) can run. When the user installs it, this screen offers a
 * categorised picker so "npm/php/etc" is one tap, not an apt incantation.
 * Nothing here is fatal: a failed package is reported per-item and the user
 * can continue.
 */

/** Human step text for a runner stage token, using the item catalogue. */
function installStageText(stage: string, wanted: string[], done: Record<string, PackageResult>): string {
  if (stage === 'update') return 'apt-get update…'
  const want = new Set(wanted)
  if (stage === 'apt') {
    // One apt command installs all apt items at once; naming the first one
    // that has not reported yet keeps the step text concrete and moving.
    const item = ALL_PACKAGES.find((i) => i.kind === 'apt' && want.has(i.id) && !done[i.id])
    return item ? `installing ${item.name}…` : 'installing apt packages…'
  }
  if (stage.startsWith('npm:')) {
    const item = ALL_PACKAGES.find((i) => i.id === stage.slice(4))
    return item ? `installing ${item.name}…` : 'installing npm packages…'
  }
  return 'Installing the packages you picked…'
}

export default function Environment() {
  const s = useStyles(makeS)
  const [distro, setDistro] = useState<'ubuntu-24.04' | 'debian-12' | 'none'>('ubuntu-24.04')
  const [installed, setInstalled] = useState<LinuxGuestStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installingPackages, setInstallingPackages] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(defaultsPackageIds())
  const [results, setResults] = useState<Record<string, PackageResult>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ languages: true, build: true })
  // The package runner polls a guest log for up to 30 minutes — leaving the
  // screen must stop that loop, and the user gets a visible Cancel too.
  const aliveRef = React.useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      cancelPackageInstall()
    }
  }, [])

  useEffect(() => {
    void linuxStatus().then(setInstalled).catch(() => {})
  }, [])

  const guestReady = !!installed?.bootstrapped
  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  /**
   * The ONE package-install path — both the button after a fresh bootstrap
   * and the continue-on-ready-guest click land here. The step text follows
   * the runner's real events (stage tokens + per-item outcomes), never a
   * fake "Installed N of M" counter over stale state.
   */
  const installSelected = async (): Promise<void> => {
    const list = withRequirements(selected)
    const seen: Record<string, PackageResult> = {}
    setInstallingPackages(true)
    setResults({})
    setStep('Installing the packages you picked…')
    try {
      await installPackages(
        list,
        (res) => {
          seen[res.id] = res
          setResults((cur) => ({ ...cur, [res.id]: res }))
        },
        (stage) => setStep(installStageText(stage, list, seen)),
      )
    } catch {
      // The runner reports failures as per-item results; a throw here is a
      // bridge-level surprise — swallow so the screen stays usable.
    } finally {
      if (aliveRef.current) {
        setInstallingPackages(false)
        setStep('')
      }
    }
  }

  const runInstall = async () => {
    if (installing) return
    setInstalling(true)
    setError(null)
    setResults({})
    setStep('Downloading the base system…')
    try {
      const r = await linuxBootstrap(distro === 'none' ? 'skip' : distro)
      if (!r || r.ok === false) {
        setError("The Linux install didn't finish — check the connection and try again.")
        return
      }
      const st = await linuxStatus().catch(() => null)
      setInstalled(st)
      if (distro !== 'none' && selected.length) await installSelected()
      setStep('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
      setInstallingPackages(false)
      setStep('')
    }
  }

  const next = async () => {
    // A live install must finish (it swallows the screen otherwise); a done
    // guest with newly ticked packages installs just those, then advances.
    if (installing) return
    if (guestReady && selected.length) {
      await installSelected()
    } else if (distro !== 'none' && !guestReady) {
      await runInstall()
      return
    }
    router.push('/onboarding/thinker')
  }

  const failures = Object.values(results).filter((r) => r.id !== 'apt' && !r.ok)

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        <Text style={s.kicker}>STEP 1 OF 4</Text>
        <Text style={s.title}>Give Moch a computer</Text>
        <Text style={s.sub}>
          A real Ubuntu userspace on your phone. Optional — but it gives the agent apt,
          any language and servers, and it is where the OpenCode option runs.
        </Text>

        {guestReady ? (
          <View style={s.okCard}>
            <Icon name="checkmark-circle" size={20} color={C.greenSoft} />
            <View style={{ flex: 1 }}>
              <Text style={s.okTitle}>Linux is ready</Text>
              <Text style={s.okSub}>{installed?.distro || 'guest'} · {installed?.sizeMb ?? 0} MB — you can add packages below.</Text>
            </View>
          </View>
        ) : null}

        <Text style={s.sectionTitle}>BASE SYSTEM</Text>
        {([
          { id: 'ubuntu-24.04', name: 'Ubuntu 24.04 LTS', note: 'Newest packages · the default' },
          { id: 'debian-12', name: 'Debian 12', note: 'Smaller base, rock solid' },
          { id: 'none', name: 'None for now', note: 'Android-only tools; install later in Settings' },
        ] as const).map((d) => (
          <Pressable
            key={d.id}
            style={[s.card, distro === d.id && s.cardOn]}
            onPress={() => setDistro(d.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: distro === d.id }}
          >
            <View style={s.cardHead}>
              <Icon name={d.id === 'none' ? 'phone-portrait-outline' : 'logo-tux'} size={20} color={C.accent} />
              <Text style={s.cardTitle}>{d.name}</Text>
              {distro === d.id ? <Icon name="checkmark-circle" size={18} color={C.accent} /> : null}
            </View>
            <Text style={s.cardDesc}>{d.note}</Text>
          </Pressable>
        ))}

        {distro !== 'none' ? (
          <>
            <Text style={s.sectionTitle}>PACKAGES</Text>
            <Text style={s.sectionHint}>Tick what you want installed inside it. Everything is skippable.</Text>
            {PACKAGE_CATEGORIES.map((cat) => {
              const open = !!expanded[cat.id]
              return (
                <View key={cat.id} style={s.cat}>
                  <Pressable
                    style={s.catHead}
                    onPress={() => setExpanded((cur) => ({ ...cur, [cat.id]: !open }))}
                    accessibilityRole="button"
                    accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${cat.name}`}
                  >
                    <Text style={s.catName}>{cat.name}</Text>
                    <Text style={s.catCount}>{cat.items.filter((i) => selected.includes(i.id)).length}/{cat.items.length}</Text>
                    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.textFaint} />
                  </Pressable>
                  {open ? cat.items.map((item) => {
                    const on = selected.includes(item.id)
                    const res = results[item.id]
                    return (
                      <Pressable
                        key={item.id}
                        style={({ pressed }) => [s.pkgRow, pressed && s.pressed]}
                        onPress={() => toggle(item.id)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                      >
                        <View style={[s.box, on && s.boxOn]}>
                          {on ? <Icon name="checkmark" size={13} color={C.onAccent} /> : null}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.pkgName}>{item.name}</Text>
                          <Text style={s.pkgNote}>{item.note}</Text>
                          {res ? (
                            <Text style={[s.pkgResult, { color: res.ok ? C.greenSoft : C.red }]} numberOfLines={2}>
                              {res.ok ? 'installed' : res.detail || 'failed'}
                            </Text>
                          ) : null}
                        </View>
                        {item.requires && !selected.includes(item.requires) ? (
                          <Text style={s.warnTag}>needs {item.requires}</Text>
                        ) : null}
                      </Pressable>
                    )
                  }) : null}
                </View>
              )
            })}
          </>
        ) : null}

        {step ? (
          <View style={s.progress}>
            <ActivityIndicator size="small" color={C.accent} />
            <Text style={s.progressText}>{step}</Text>
            {installingPackages ? (
              <Pressable
                style={({ pressed }) => [s.cancelBtn, pressed && s.pressed]}
                onPress={() => { cancelPackageInstall(); setStep('Cancelling…') }}
                accessibilityRole="button"
                accessibilityLabel="Cancel the package install"
              >
                <Text style={s.cancelText}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
        {failures.length ? (
          <Text style={s.error} numberOfLines={3}>
            {failures.length} package{failures.length > 1 ? 's' : ''} failed — you can retry from Settings.
          </Text>
        ) : null}

        <Pressable
          style={[s.btn, (installing || installingPackages) && s.btnBusy]}
          disabled={installing || installingPackages}
          onPress={() => void next()}
          accessibilityRole="button"
        >
          <Text style={s.btnText}>
            {installing || installingPackages
              ? 'Installing…'
              : distro === 'none'
                ? 'Skip Linux'
                : guestReady
                  ? selected.length ? 'Install selected packages' : 'Continue'
                  : 'Install environment'}
          </Text>
        </Pressable>
        <Pressable
          style={[s.skip, (installing || installingPackages) && s.pressed]}
          onPress={() => { if (!installing && !installingPackages) router.push('/onboarding/thinker') }}
          disabled={installing || installingPackages}
          accessibilityRole="button"
          accessibilityLabel="Skip this step"
        >
          <Text style={[s.skipText, (installing || installingPackages) && { color: C.textFaint }]}>
            {installing || installingPackages ? 'Installing — cancel or wait' : 'Skip this step'}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 48 },
  kicker: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.8, marginBottom: 8 },
  title: { color: C.text, fontSize: 27, fontWeight: '800', lineHeight: 32, marginBottom: 8 },
  sub: { color: C.textDim, fontSize: 14, lineHeight: 20, marginBottom: 18 },
  sectionTitle: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, marginTop: 8, marginBottom: 6 },
  sectionHint: { color: C.textFaint, fontSize: 12, marginBottom: 10, lineHeight: 16 },
  card: { backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 13, marginBottom: 8 },
  cardOn: { borderColor: C.accent },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700', flex: 1 },
  cardDesc: { color: C.textFaint, fontSize: 12.5, marginTop: 5, lineHeight: 17 },
  okCard: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: C.greenTint, borderRadius: 14, padding: 12, marginBottom: 12 },
  okTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  okSub: { color: C.textDim, fontSize: 12, marginTop: 2 },
  cat: { backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.borderSoft, marginBottom: 8, overflow: 'hidden' },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, minHeight: 46 },
  catName: { color: C.text, fontSize: 14, fontWeight: '700', flex: 1 },
  catCount: { color: C.textFaint, fontSize: 11.5, fontWeight: '700' },
  pkgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 13, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.borderSoft },
  pressed: { opacity: 0.75 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: C.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: C.accent, borderColor: C.accent },
  pkgName: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  pkgNote: { color: C.textFaint, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
  pkgResult: { fontSize: 11, marginTop: 3 },
  warnTag: { color: C.amber, fontSize: 10.5, fontWeight: '700', marginTop: 2 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  progressText: { color: C.textDim, fontSize: 12.5, flex: 1 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: C.bgHover },
  cancelText: { color: C.red, fontSize: 12.5, fontWeight: '800' },
  error: { color: C.red, fontSize: 12.5, lineHeight: 18, marginTop: 10 },
  btn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 18 },
  btnBusy: { opacity: 0.6 },
  btnText: { color: C.onAccent, fontSize: 15.5, fontWeight: '800' },
  skip: { alignItems: 'center', paddingVertical: 16 },
  skipText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
})
