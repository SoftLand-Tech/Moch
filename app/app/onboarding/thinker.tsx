import React, { useEffect, useState } from 'react'
import { View, StyleSheet, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { Card, GhostBtn, Pill, PrimaryBtn, ScreenScroll, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import {
  loadThinker,
  opencodeInstalled,
  installOpencode,
  diagnoseOpencodeServer,
  probeOpencodeRun,
  setOpencodeOneShot,
  startOpencodeServer,
  setThinker,
  thinkerAtom,
  opencodeBaseUrl,
  type Thinker,
} from '../../src/lib/thinker'
import { linuxStatus } from '../../src/lib/mochiRuntime'

/**
 * Onboarding step 2 — whose brain answers (mockup 17).
 *
 * Moch (hermes, full feature set) or OpenCode (free models, chat + terminal).
 * OpenCode requires the Linux guest; the environment step (step 1, before this
 * one) installs it — choosing OpenCode with no guest points back there.
 */
export default function ThinkerChoice() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  // The card tap only selects; Continue commits (and runs the OpenCode
  // install/server flow before advancing, exactly as the old immediate tap did).
  const [selected, setSelected] = useState<Thinker>(() => thinkerAtom.get())
  const [guest, setGuest] = useState<boolean | null>(null)
  const [ocReady, setOcReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busyMsg, setBusyMsg] = useState<{ key: string; pct?: number } | { raw: string } | null>(null)
  // Last-failure evidence, collected automatically (see commit) — the user can
  // expand it and send it back instead of another blind round-trip.
  const [diag, setDiag] = useState<string | null>(null)
  const [showDiag, setShowDiag] = useState(false)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  // One-shot probe state (manual trigger — spends a real model call).
  const [runReport, setRunReport] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  // Offered after a server start failure: continue with one-shot instead.
  const [oneShotOffer, setOneShotOffer] = useState(false)

  const runDiagnostics = async () => {
    setDiagBusy(true)
    try {
      const d = await diagnoseOpencodeServer()
      setDiag(d.report)
    } catch (e) {
      setDiag(t('setup.thinker.diag.failed', { why: e instanceof Error ? e.message : String(e) }))
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
      setRunReport(t('setup.thinker.probe.failed', { why: e instanceof Error ? e.message : String(e) }))
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

  const commit = async () => {
    setErr(null)
    setOneShotOffer(false)
    if (selected === 'opencode') {
      if (!guest) {
        setErr(t('setup.thinker.err.guestFirst'))
        return
      }
      setBusy(true)
      try {
        if (!ocReady) {
          setBusyMsg({ key: 'setup.thinker.progress.downloading' })
          const inst = await installOpencode((pct) =>
            setBusyMsg({ key: 'setup.thinker.progress.downloadingPct', pct }),
          )
          if (!inst.ok) {
            setErr(inst.stderr || t('setup.thinker.err.installFailed'))
            return
          }
          setOcReady(true)
          const version = inst.stdout.split('\n').pop()?.trim() ?? ''
          setBusyMsg({ raw: t('setup.thinker.progress.installedVersion', { version }) })
        }
        setBusyMsg({ key: 'setup.thinker.progress.starting' })
        const up = await startOpencodeServer()
        if (!up.ok) {
          // Server mode failed — but one-shot mode (no server) may still
          // work. Offer it right here instead of a dead end: the pick below
          // records the fallback and continues onboarding normally.
          setErr(t('setup.thinker.err.serverFailed'))
          // Collect the evidence now, while the failure is fresh (stale log
          // included) — the expander shows it verbatim.
          setDiag(null)
          setShowDiag(false)
          setOneShotOffer(true)
          setDiagOpen(true)
          void runDiagnostics().then(() => setShowDiag(true))
          return
        }
        await setOpencodeOneShot(false)
        await setThinker('opencode')
        router.push('/onboarding/providers')
      } finally {
        setBusy(false)
        setBusyMsg(null)
      }
      return
    }
    setBusy(true)
    try {
      await setThinker('moch')
      router.push('/onboarding/providers')
    } finally {
      setBusy(false)
    }
  }

  const continueOneShot = async () => {
    setBusy(true)
    try {
      await setOpencodeOneShot(true)
      await setThinker('opencode')
      router.push('/onboarding/providers')
    } finally {
      setBusy(false)
    }
  }

  const diagStatus = err
    ? { label: t('setup.thinker.diag.status.issue'), ink: C.red }
    : busy
      ? { label: t('setup.thinker.diag.status.checking'), ink: C.textFaint }
      : guest === false
        ? { label: t('setup.thinker.diag.status.noGuest'), ink: C.amber }
        : guest === null
          ? { label: t('setup.thinker.diag.status.checking'), ink: C.textFaint }
          : ocReady
            ? { label: t('setup.thinker.diag.status.ready'), ink: C.greenSoft }
            : { label: t('setup.thinker.diag.status.notInstalled'), ink: C.textFaint }

  const busyText = busyMsg
    ? 'raw' in busyMsg
      ? busyMsg.raw
      : t(busyMsg.key, busyMsg.pct !== undefined ? { pct: busyMsg.pct } : undefined)
    : t('setup.thinker.progress.working')

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <Txt
          size={10.5}
          weight="800"
          color={C.accent}
          style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 0.84 }]}
        >
          {t('setup.thinker.kicker')}
        </Txt>
        <Txt size={19} weight="800">{t('setup.thinker.title')}</Txt>
      </View>

      <ScreenScroll contentContainerStyle={s.scrollContent}>
        <Pressable
          style={[s.card, selected === 'moch' && s.cardOn]}
          onPress={() => setSelected('moch')}
          disabled={busy}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === 'moch' }}
          accessibilityLabel={t('setup.thinker.moch.a11y')}
        >
          <View style={[s.rowBetween, { flexDirection: dir.row, marginBottom: 4 }]}>
            <Txt size={14} weight="700" style={s.flex}>{t('setup.thinker.moch.name')}</Txt>
            <Pill kind="green">{t('setup.thinker.moch.pill')}</Pill>
          </View>
          <Txt size={12} color={C.textDim} style={s.cardDesc}>{t('setup.thinker.moch.desc')}</Txt>
        </Pressable>

        <Pressable
          style={[s.card, selected === 'opencode' && s.cardOn]}
          onPress={() => setSelected('opencode')}
          disabled={busy}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === 'opencode' }}
          accessibilityLabel={t('setup.thinker.opencode.a11y')}
        >
          <View style={[s.rowBetween, { flexDirection: dir.row, marginBottom: 4 }]}>
            <Txt size={14} weight="700" style={s.flex}>{t('setup.thinker.opencode.name')}</Txt>
            <Pill kind="amber">{t('setup.thinker.opencode.pill')}</Pill>
          </View>
          <Txt size={12} color={C.textDim} style={s.cardDesc}>{t('setup.thinker.opencode.desc')}</Txt>
          {guest === false ? (
            <Txt size={11.5} color={C.amber} style={s.warn}>{t('setup.thinker.opencode.needsGuest')}</Txt>
          ) : null}
        </Pressable>

        {/* Expandable diagnostics + one-shot probe */}
        <Card>
          <Pressable
            style={[s.diagHead, { flexDirection: dir.row }]}
            onPress={() => setDiagOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={t('setup.thinker.diag.title')}
          >
            <Txt size={12} weight="700" style={s.flex}>{t('setup.thinker.diag.title')}</Txt>
            <Txt size={11.5} weight="700" color={diagStatus.ink}>{diagStatus.label}</Txt>
            <Icon name={diagOpen ? 'chevron-up' : 'chevron-down'} size={14} color={diagStatus.ink} />
          </Pressable>
          {diagOpen ? (
            <View style={s.diagBody}>
              <Txt size={10.5} color={C.textDim} mono style={s.diagLine}>
                {t('setup.thinker.diag.loopback', { url: opencodeBaseUrl() })}
              </Txt>
              <View style={[s.diagBtns, { flexDirection: dir.row }]}>
                <Pressable
                  style={({ pressed }) => [s.diagBtn, pressed && s.pressed]}
                  onPress={() => {
                    if (showDiag || diagBusy) { setShowDiag(false); return }
                    void runDiagnostics().then(() => setShowDiag(true))
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={showDiag ? t('setup.thinker.diag.hideA11y') : t('setup.thinker.diag.showA11y')}
                >
                  <Txt size={11.5} weight="800" color={C.accent}>
                    {diagBusy
                      ? t('setup.thinker.diag.collecting')
                      : showDiag
                        ? t('setup.thinker.diag.hide')
                        : t('setup.thinker.diag.show')}
                  </Txt>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [s.diagBtn, pressed && s.pressed]}
                  onPress={() => { if (!runBusy) void runOneShotProbe() }}
                  accessibilityRole="button"
                  accessibilityLabel={t('setup.thinker.probe.a11y')}
                >
                  <Txt size={11.5} weight="800" color={C.accent}>
                    {runBusy ? t('setup.thinker.probe.busy') : t('setup.thinker.probe')}
                  </Txt>
                </Pressable>
              </View>
              {showDiag && diag ? (
                <ScrollView style={s.diagScroll} nestedScrollEnabled>
                  <Txt size={10.5} color={C.textDim} mono ltr selectable style={s.diagText}>{diag}</Txt>
                </ScrollView>
              ) : null}
              {showDiag ? (
                <Txt size={11.5} color={C.textFaint} style={s.diagHint}>
                  {t('setup.thinker.diag.copyHint')}
                </Txt>
              ) : null}
              {runReport ? (
                <View style={s.logBox}>
                  <Txt size={10.5} color={C.textDim} mono ltr selectable style={s.diagText}>{runReport}</Txt>
                </View>
              ) : null}
            </View>
          ) : null}
        </Card>

        {busy ? (
          <View style={[s.progress, { flexDirection: dir.row }]}>
            <Spinner size="small" color={C.accent} />
            <Txt size={12.5} color={C.textDim} style={s.flex}>{busyText}</Txt>
          </View>
        ) : null}
        {err ? <Txt size={12.5} color={C.red} style={s.error}>{err}</Txt> : null}

        {oneShotOffer && !busy ? (
          <PrimaryBtn
            onPress={() => void continueOneShot()}
            accessibilityLabel={t('setup.thinker.oneshot.a11y')}
            style={s.cta}
          >
            <Txt size={13} weight="700" color={C.onAccent}>{t('setup.thinker.oneshot.cta')}</Txt>
          </PrimaryBtn>
        ) : null}

        {guest === false ? (
          <GhostBtn
            onPress={() => router.push('/onboarding/environment')}
            label={t('setup.thinker.installLinux')}
            style={s.installLinux}
          />
        ) : null}

        <PrimaryBtn
          onPress={() => void commit()}
          disabled={busy}
          label={t('setup.thinker.continue')}
          style={s.continueBtn}
        />
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
  rowBetween: { alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  card: {
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  cardOn: { borderColor: C.accent },
  cardDesc: { lineHeight: 17 },
  warn: { lineHeight: 17, marginTop: 8 },
  diagHead: { alignItems: 'center', gap: 8 },
  diagBody: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.borderSoft },
  diagLine: { marginBottom: 8 },
  diagBtns: { flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  diagBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: C.bgHover },
  diagScroll: {
    maxHeight: 240,
    backgroundColor: C.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSoft,
    padding: 10,
  },
  diagText: { lineHeight: 15 },
  diagHint: { lineHeight: 16, marginTop: 6 },
  logBox: {
    maxHeight: 220,
    marginTop: 8,
    backgroundColor: C.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSoft,
    padding: 10,
  },
  progress: { alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 4 },
  error: { lineHeight: 18, marginTop: 8 },
  cta: { marginTop: 14 },
  installLinux: { marginTop: 8 },
  continueBtn: { marginTop: 14 },
})
