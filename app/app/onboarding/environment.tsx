import React, { useEffect, useState } from 'react'
import { View, StyleSheet, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import {
  Card,
  Elev,
  GhostBtn,
  Kicker,
  PrimaryBtn,
  ScreenScroll,
  Txt,
} from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import {
  ALL_PACKAGES,
  PACKAGE_CATEGORIES,
  defaultsPackageIds,
  installPackages,
  cancelPackageInstall,
  readInstallLog,
  withRequirements,
  type PackageResult,
} from '../../src/lib/linuxPackages'
import { linuxBootstrap, linuxStatus, type LinuxGuestStatus } from '../../src/lib/mochiRuntime'

/**
 * Onboarding step 1 — the environment (mockup 16).
 *
 * The Linux guest is optional but it is the only place OpenCode (and real
 * package work) can run. When the user installs it, this screen offers a
 * categorised picker so "npm/php/etc" is one tap, not an apt incantation.
 * Nothing here is fatal: a failed package is reported per-item and the user
 * can continue.
 */

/** Structured runner stage token — translated at render, never at callback. */
type InstallStage =
  | { kind: 'download' }
  | { kind: 'update' }
  | { kind: 'apt'; itemId: string | null }
  | { kind: 'npm'; itemId: string | null }
  | { kind: 'generic' }
  | { kind: 'cancelling' }

/** Catalogue ids → catalog keys: the package catalogue lives in lib and its
 *  labels are translated here at the render site. */
const CATEGORY_KEY: Record<string, string> = {
  languages: 'setup.pkgcat.languages',
  build: 'setup.pkgcat.build',
  databases: 'setup.pkgcat.databases',
  cli: 'setup.pkgcat.cli',
  media: 'setup.pkgcat.media',
  'node-tools': 'setup.pkgcat.nodeTools',
}
const PACKAGE_KEY: Record<string, string> = {
  node: 'setup.pkg.node',
  python: 'setup.pkg.python',
  php: 'setup.pkg.php',
  go: 'setup.pkg.go',
  rust: 'setup.pkg.rust',
  java: 'setup.pkg.java',
  'build-essential': 'setup.pkg.buildEssential',
  git: 'setup.pkg.git',
  cmake: 'setup.pkg.cmake',
  pkgconfig: 'setup.pkg.pkgconfig',
  sqlite: 'setup.pkg.sqlite',
  postgres: 'setup.pkg.postgres',
  redis: 'setup.pkg.redis',
  curl: 'setup.pkg.curl',
  jq: 'setup.pkg.jq',
  ripgrep: 'setup.pkg.ripgrep',
  tmux: 'setup.pkg.tmux',
  htop: 'setup.pkg.htop',
  unzip: 'setup.pkg.unzip',
  ffmpeg: 'setup.pkg.ffmpeg',
  imagemagick: 'setup.pkg.imagemagick',
  typescript: 'setup.pkg.typescript',
  pnpm: 'setup.pkg.pnpm',
  yarn: 'setup.pkg.yarn',
}

/** Map a runner stage token to its renderable shape (item names resolved). */
function parseStage(stage: string, wanted: string[], done: Record<string, PackageResult>): InstallStage {
  if (stage === 'update') return { kind: 'update' }
  const want = new Set(wanted)
  if (stage === 'apt') {
    // One apt command installs all apt items at once; naming the first one
    // that has not reported yet keeps the step text concrete and moving.
    const item = ALL_PACKAGES.find((i) => i.kind === 'apt' && want.has(i.id) && !done[i.id])
    return { kind: 'apt', itemId: item ? item.id : null }
  }
  if (stage.startsWith('npm:')) {
    const id = stage.slice(4)
    const item = ALL_PACKAGES.find((i) => i.id === id)
    return { kind: 'npm', itemId: item ? item.id : null }
  }
  return { kind: 'generic' }
}

export default function Environment() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [distro, setDistro] = useState<'ubuntu-24.04' | 'debian-12' | 'none'>('ubuntu-24.04')
  const [installed, setInstalled] = useState<LinuxGuestStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installingPackages, setInstallingPackages] = useState(false)
  const [stage, setStage] = useState<InstallStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(defaultsPackageIds())
  const [results, setResults] = useState<Record<string, PackageResult>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ languages: true, build: true })
  // The installer log, on demand — a failure's one-line detail is often not
  // enough, and re-running the whole install to see the error is wasteful.
  const [showLog, setShowLog] = useState(false)
  const [loadingLog, setLoadingLog] = useState(false)
  const [logText, setLogText] = useState('')
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
    void linuxStatus()
      .then((st) => {
        setInstalled(st)
        // Returning to Step 1 with an already-installed guest shouldn't keep
        // defaults ticked and trap the primary button on "Install selected".
        if (st?.bootstrapped) setSelected([])
      })
      .catch(() => {})
  }, [])

  const guestReady = !!installed?.bootstrapped
  const busy = installing || installingPackages
  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  /**
   * The ONE package-install path — both the button after a fresh bootstrap
   * and the continue-on-ready-guest click land here. The step text follows
   * the runner's real events (stage tokens + per-item outcomes), never a
   * fake "Installed N of M" counter over stale state.
   */
  const installSelected = async (): Promise<PackageResult[]> => {
    const list = withRequirements(selected)
    const seen: Record<string, PackageResult> = {}
    setInstallingPackages(true)
    setResults({})
    setStage({ kind: 'generic' })
    try {
      const res = await installPackages(
        list,
        (res) => {
          seen[res.id] = res
          setResults((cur) => ({ ...cur, [res.id]: res }))
        },
        (token) => setStage(parseStage(token, list, seen)),
      )
      const succeeded = new Set(res.filter((r) => r.ok).map((r) => r.id))
      if (aliveRef.current && succeeded.size > 0) {
        setSelected((cur) => cur.filter((id) => !succeeded.has(id)))
      }
      return res
    } catch {
      // The runner reports failures as per-item results; a throw here is a
      // bridge-level surprise — return empty so the caller keeps the screen usable.
      return []
    } finally {
      if (aliveRef.current) {
        setInstallingPackages(false)
        setStage(null)
      }
    }
  }

  const runInstall = async () => {
    if (installing) return
    setInstalling(true)
    setError(null)
    setResults({})
    setStage({ kind: 'download' })
    try {
      const r = await linuxBootstrap(distro === 'none' ? 'skip' : distro)
      if (!r || r.ok === false) {
        setError(t('setup.env.installFailed'))
        return
      }
      const st = await linuxStatus().catch(() => null)
      setInstalled(st)
      let allOk = true
      if (distro !== 'none' && selected.length) {
        const res = await installSelected()
        allOk = res.length > 0 && res.every((item) => item.ok)
      }
      setStage(null)
      if (allOk && aliveRef.current) {
        router.push('/onboarding/thinker')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
      setInstallingPackages(false)
      setStage(null)
    }
  }

  const next = async () => {
    // A live install must finish (it swallows the screen otherwise); a done
    // guest with newly ticked packages installs just those, then advances if
    // all succeeded (failures stay on screen so the user can inspect/retry).
    if (installing) return
    if (guestReady && selected.length) {
      const res = await installSelected()
      if (!res.length || res.some((item) => !item.ok)) return
    } else if (distro !== 'none' && !guestReady) {
      await runInstall()
      return
    }
    router.push('/onboarding/thinker')
  }

  const skip = () => { if (!busy) router.push('/onboarding/thinker') }

  const failures = Object.values(results).filter((r) => r.id !== 'apt' && !r.ok)

  /** Localized label for a catalogue package (fallback: the lib's own name). */
  const pkgName = (id: string): string => {
    const key = PACKAGE_KEY[id]
    if (key) return t(key)
    return ALL_PACKAGES.find((i) => i.id === id)?.name ?? id
  }

  /** Localized distro name for a guest status id (fallback: raw id). */
  const distroName = (id?: string | null): string => {
    if (id === 'debian-12') return t('setup.env.debian.short')
    if (id === 'ubuntu-24.04') return t('setup.env.ubuntu.short')
    return id || t('setup.env.linuxFallback')
  }

  /** Localized runner line, stage token → readable text. */
  const stageText = (st: InstallStage): string => {
    switch (st.kind) {
      case 'download': return t('setup.env.stage.download')
      case 'update': return t('setup.env.stage.update')
      case 'apt':
        return st.itemId ? t('setup.env.stage.aptItem', { name: pkgName(st.itemId) }) : t('setup.env.stage.apt')
      case 'npm':
        return st.itemId ? t('setup.env.stage.npmItem', { name: pkgName(st.itemId) }) : t('setup.env.stage.npm')
      case 'cancelling': return t('setup.env.cancelling')
      default: return t('setup.env.stage.generic')
    }
  }

  const distros = [
    { id: 'ubuntu-24.04' as const, label: t('setup.env.ubuntu.short') },
    { id: 'debian-12' as const, label: t('setup.env.debian.short') },
    { id: 'none' as const, label: t('setup.env.none.short') },
  ]

  const primaryLabel = busy
    ? t('setup.env.btn.installing')
    : distro === 'none'
      ? t('setup.env.btn.skipLinux')
      : guestReady
        ? selected.length
          ? t('setup.env.btn.installSelected')
          : t('common.continue')
        : t('setup.env.btn.installContinue')

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <Txt
          size={10.5}
          weight="800"
          color={C.accent}
          style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 0.84 }]}
        >
          {t('setup.env.kicker')}
        </Txt>
        <Txt size={19} weight="800">{t('setup.env.title')}</Txt>
      </View>

      <ScreenScroll contentContainerStyle={s.scrollContent}>
        {guestReady ? (
          <View style={[s.okCard, { flexDirection: dir.row }]}>
            <Icon name="checkmark-circle" size={20} color={C.greenSoft} />
            <View style={s.flex}>
              <Txt size={13} weight="700">{t('setup.env.ready.title')}</Txt>
              <Txt size={11} color={C.textDim} mono style={s.readySub}>
                {t('setup.env.ready.sub', {
                  distro: distroName(installed?.distro),
                  size: installed?.sizeMb ?? 0,
                })}
              </Txt>
            </View>
          </View>
        ) : null}

        <Kicker style={s.kickerFirst}>{t('setup.env.distro.kicker')}</Kicker>
        <View style={[s.tiles, { flexDirection: dir.row }]}>
          {distros.map((d) => {
            const on = distro === d.id
            return (
              <Pressable
                key={d.id}
                onPress={() => setDistro(d.id)}
                style={[s.tile, on && s.tileOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${d.label}${on ? `. ${t('setup.a11y.selected')}` : ''}`}
              >
                <Txt size={11.5} weight="700" center color={on ? C.accent : C.textDim} numberOfLines={1}>
                  {d.label}
                </Txt>
              </Pressable>
            )
          })}
        </View>

        {distro !== 'none' ? (
          <>
            <Kicker>{t('setup.env.packages.kicker')}</Kicker>
            <Card style={s.pkgsCard}>
              {PACKAGE_CATEGORIES.map((cat, idx) => {
                const open = !!expanded[cat.id]
                const catName = CATEGORY_KEY[cat.id] ? t(CATEGORY_KEY[cat.id]) : cat.name
                const catSelected = cat.items.filter((i) => selected.includes(i.id)).length
                const catFailures = cat.items.filter((i) => {
                  const r = results[i.id]
                  return r && !r.ok
                })
                return (
                  <View key={cat.id} style={[s.cat, idx > 0 && s.catDivided]}>
                    <Pressable
                      style={[s.catHead, { flexDirection: dir.row }]}
                      onPress={() => setExpanded((cur) => ({ ...cur, [cat.id]: !open }))}
                      accessibilityRole="button"
                      accessibilityLabel={t(open ? 'setup.env.collapse' : 'setup.env.expand', { name: catName })}
                    >
                      <Txt size={11.5} weight="700" color={C.textDim} style={s.flex}>{catName}</Txt>
                      <Txt size={10.5} weight="700" color={C.textFaint} mono>
                        {catSelected}/{cat.items.length}
                      </Txt>
                      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.textFaint} />
                    </Pressable>
                    {open ? (
                      <View style={[s.chips, { flexDirection: dir.row }]}>
                        {cat.items.map((item) => {
                          const itemName = PACKAGE_KEY[item.id] ? t(PACKAGE_KEY[item.id]) : item.name
                          const on = selected.includes(item.id)
                          const res = results[item.id]
                          const failed = !!res && !res.ok
                          const missing = !!item.requires && !selected.includes(item.requires)
                          const mark = failed ? '✕ ' : res?.ok || on ? '✓ ' : '+ '
                          const ink = failed
                            ? C.red
                            : res?.ok
                              ? C.greenSoft
                              : on
                                ? C.accent
                                : missing
                                  ? C.amber
                                  : C.textDim
                          const border = failed
                            ? C.red
                            : on
                              ? C.accent
                              : missing
                                ? C.amber
                                : C.border
                          const bg = failed ? C.redSoft : on ? C.accentSoft : C.bgElev
                          const label = [
                            itemName,
                            missing ? t('setup.env.needs', { pkg: pkgName(item.requires as string) }) : '',
                            res ? (res.ok ? t('setup.env.installed') : t('setup.env.failed')) : '',
                          ].filter(Boolean).join('. ')
                          return (
                            <Pressable
                              key={item.id}
                              onPress={() => toggle(item.id)}
                              style={({ pressed }) => [s.chip, { backgroundColor: bg, borderColor: border }, pressed && s.pressed]}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: on }}
                              accessibilityLabel={label}
                            >
                              <Txt size={11.5} weight="700" mono color={ink}>
                                {mark + itemName}
                              </Txt>
                            </Pressable>
                          )
                        })}
                      </View>
                    ) : null}
                    {open && catFailures.length
                      ? catFailures.map((item) => (
                          <Txt key={item.id} size={10.5} color={C.red} style={s.failDetail} numberOfLines={2}>
                            {pkgName(item.id)}: {results[item.id]?.detail || t('setup.env.failed')}
                          </Txt>
                        ))
                      : null}
                  </View>
                )
              })}
            </Card>
          </>
        ) : null}

        {stage ? (
          <Elev style={s.progress}>
            <View style={[s.progressRow, { flexDirection: dir.row }]}>
              <Txt size={11} color={C.greenSoft} mono style={s.flex}>
                {t('setup.env.stage.running', { stage: stageText(stage) })}
              </Txt>
              {installingPackages && stage.kind !== 'cancelling' ? (
                <Pressable
                  style={({ pressed }) => [s.cancelBtn, pressed && s.pressed]}
                  onPress={() => { cancelPackageInstall(); setStage({ kind: 'cancelling' }) }}
                  accessibilityRole="button"
                  accessibilityLabel={t('setup.env.cancelA11y')}
                >
                  <Txt size={11.5} weight="800" color={C.red}>{t('common.cancel')}</Txt>
                </Pressable>
              ) : null}
            </View>
          </Elev>
        ) : null}

        {error ? <Txt size={12.5} color={C.red} style={s.error}>{error}</Txt> : null}

        {failures.length ? (
          <View style={s.failBox}>
            <Txt size={12} color={C.red} numberOfLines={3}>
              {failures.length === 1
                ? t('setup.env.failures.one', { n: failures.length })
                : t('setup.env.failures.many', { n: failures.length })}
            </Txt>
            <Pressable
              style={({ pressed }) => [s.logBtn, pressed && s.pressed]}
              onPress={() => {
                if (showLog || loadingLog) { setShowLog(false); return }
                setLoadingLog(true)
                void readInstallLog()
                  .then((text) => {
                    setLogText(text || t('setup.env.log.empty'))
                    setShowLog(true)
                  })
                  .finally(() => setLoadingLog(false))
              }}
              accessibilityRole="button"
              accessibilityLabel={showLog ? t('setup.env.log.hideA11y') : t('setup.env.log.showA11y')}
            >
              <Txt size={12.5} weight="800" color={C.accent}>
                {loadingLog
                  ? t('setup.env.log.reading')
                  : showLog
                    ? t('setup.env.log.hide')
                    : t('setup.env.log.show')}
              </Txt>
            </Pressable>
            {showLog ? (
              <ScrollView style={s.logBox} nestedScrollEnabled>
                <Txt size={11} color={C.textDim} mono ltr selectable style={s.logText}>{logText}</Txt>
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        <View style={[s.actions, { flexDirection: dir.row }]}>
          <GhostBtn
            onPress={skip}
            disabled={busy}
            style={s.skipBtn}
            accessibilityLabel={t('setup.env.skipA11y')}
          >
            <Txt size={12.5} weight="600" color={busy ? C.textFaint : C.text} center numberOfLines={2}>
              {busy ? t('setup.env.skip.busy') : t('common.skip')}
            </Txt>
          </GhostBtn>
          <PrimaryBtn
            onPress={() => void next()}
            disabled={busy}
            style={s.installBtn}
            accessibilityLabel={primaryLabel}
          >
            <Txt size={13} weight="700" color={C.onAccent} center numberOfLines={1}>
              {primaryLabel}
            </Txt>
          </PrimaryBtn>
        </View>
      </ScreenScroll>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 },
  kicker: { textTransform: 'uppercase' },
  scrollContent: { paddingBottom: 28 },
  flex: { flex: 1 },
  pressed: { opacity: 0.75 },
  okCard: {
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.greenTint,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  readySub: { marginTop: 2 },
  kickerFirst: { marginTop: 2 },
  tiles: { gap: 6, marginBottom: 10 },
  tile: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
  },
  tileOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  pkgsCard: { paddingVertical: 4 },
  cat: { paddingVertical: 6 },
  catDivided: { borderTopWidth: 1, borderTopColor: C.borderSoft },
  catHead: { alignItems: 'center', gap: 8, paddingVertical: 4 },
  chips: { flexWrap: 'wrap', gap: 6, paddingBottom: 4 },
  chip: {
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  failDetail: { marginTop: 4 },
  progress: { marginBottom: 10 },
  progressRow: { alignItems: 'center', gap: 8 },
  cancelBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: C.bgHover },
  error: { lineHeight: 18, marginTop: 6, marginBottom: 6 },
  failBox: { marginTop: 2, marginBottom: 6 },
  logBtn: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: C.bgHover },
  logBox: { maxHeight: 220, marginTop: 8, backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.borderSoft, padding: 10 },
  logText: { lineHeight: 15 },
  actions: { alignItems: 'stretch', gap: 8, marginTop: 8 },
  skipBtn: { flex: 1 },
  installBtn: { flex: 2 },
})
