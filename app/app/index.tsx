import React, { useEffect, useRef, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { MochiMark } from '../src/components/MochiMark'
import { Card, GhostBtn, PrimaryBtn, Txt } from '../src/components/ui'
import { C, useStyles } from '../src/lib/theme'
import { useDir, useT } from '../src/lib/strings'
import { connectThisPhone, connect, loadSavedConfig, type ConnConfig } from '../src/lib/gateway'
import { getEmbeddedGateway } from '../src/lib/mochiRuntime'
import { loadOnboarded, onboardedAtom } from '../src/lib/aboutMe'

/**
 * Entry screen (mockup 14) — local only (2026-11-15).
 *
 * Boots the embedded runtime and then either resumes chat (returning user) or
 * starts the four-step onboarding: environment → thinker → providers → about
 * you.
 *
 * No remote pairing: a saved config from the remote era may still be on disk,
 * but it is never dialed. A one-time notice names it so it can be forgotten.
 */
export default function Onboarding() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [phase, setPhase] = useState<'starting' | 'error'>('starting')
  const [detail, setDetail] = useState('')
  const [legacy, setLegacy] = useState<ConnConfig | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void loadSavedConfig()
      .then((c) => {
        if (mounted.current && c && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(c.host)) setLegacy(c)
      })
      .catch(() => {})
    void loadOnboarded()
    return () => { mounted.current = false }
  }, [])

  // Returning users never wait on this screen: the chat renders from local
  // caches while the embedded runtime boots behind it (the native side
  // starts CPython at process creation). The ONLY thing this path waits for
  // is the persisted onboarded flag — not the agent. connectThisPhone is
  // idempotent and the root layout's boot IIFE also dials, so a
  // fire-and-forget here is just the fastest first attempt. First-run users
  // keep the waiting surface — their next step is the environment wizard,
  // which needs the runtime anyway.
  useEffect(() => {
    let alive = true
    void loadOnboarded().then(() => {
      if (!alive || !onboardedAtom.get()) return
      router.replace('/(tabs)/chat')
      void connectThisPhone().catch(() => {})
    })
    return () => { alive = false }
  }, [])

  const openAgent = async () => {
    setPhase('starting')
    setDetail('')
    try {
      await connectThisPhone()
      if (!mounted.current) return
      // Returning user → chat. First run → the four-step wizard.
      if (onboardedAtom.get()) router.replace('/(tabs)/chat')
      else router.replace('/onboarding/environment')
    } catch (e) {
      if (!mounted.current) return
      setDetail(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  useEffect(() => { void openAgent() }, [])

  const retry = async () => {
    setPhase('starting')
    setDetail('')
    const gw = await getEmbeddedGateway().catch(() => null)
    if (gw?.running && gw.ready && gw.port && gw.token) {
      try {
        await connect({ host: `127.0.0.1:${gw.port}`, token: gw.token, tls: false, name: 'This phone' })
        if (mounted.current) {
          if (onboardedAtom.get()) router.replace('/(tabs)/chat')
          else router.replace('/onboarding/environment')
        }
        return
      } catch (e) {
        setDetail(e instanceof Error ? e.message : String(e))
      }
    }
    setPhase('error')
  }

  const legacyName = legacy ? legacy.name || legacy.host : ''

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.body}>
        <MochiMark size={112} mood={phase === 'error' ? 'sleepy' : 'happy'} />
        <Txt
          size={10.5}
          weight="800"
          color={C.accent}
          center
          style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 1.26 }]}
        >
          {t('setup.entry.kicker')}
        </Txt>
        <Txt size={32} weight="800" center style={[s.title, { letterSpacing: dir.rtl ? 0 : -0.96 }]}>
          Moch
        </Txt>

        {phase === 'starting' ? (
          <>
            <View style={[s.pill, { flexDirection: dir.row }]}>
              <View style={s.pillDot} />
              <Txt size={12.5} weight="600">{t('setup.entry.starting')}</Txt>
            </View>
            <Txt size={11.5} color={C.textFaint} center style={s.hint}>
              {t('setup.entry.hint')}
            </Txt>
          </>
        ) : (
          <>
            <Card style={s.errCard}>
              <Txt size={13} weight="700" color={C.red} style={s.errTitle}>
                {t('setup.entry.gatewayFailed')}
              </Txt>
              {detail ? (
                <Txt size={11.5} color={C.textDim} numberOfLines={4}>
                  {detail}
                </Txt>
              ) : null}
            </Card>
            {legacy ? (
              <Card style={s.legacyCard}>
                <Txt size={11.5} weight="700" color={C.amber} style={s.legacyTitle}>
                  {t('setup.entry.legacy.title')}
                </Txt>
                <Txt size={11} color={C.textDim}>
                  {t('setup.entry.legacy.body', { name: legacyName })}
                </Txt>
              </Card>
            ) : null}
            <PrimaryBtn
              onPress={() => void retry()}
              label={t('setup.entry.tryAgain')}
              style={s.primary}
            />
            <GhostBtn
              onPress={() => router.replace('/(tabs)/chat')}
              label={t('setup.entry.openAnyway')}
              style={s.ghost}
            />
          </>
        )}

        {/* A legacy config can surface before the boot already failed — the
            notice is not tied to the error phase. */}
        {phase === 'starting' && legacy ? (
          <Card style={[s.legacyCard, s.legacyStandalone]}>
            <Txt size={11.5} weight="700" color={C.amber} style={s.legacyTitle}>
              {t('setup.entry.legacy.title')}
            </Txt>
            <Txt size={11} color={C.textDim}>
              {t('setup.entry.legacy.body', { name: legacyName })}
            </Txt>
          </Card>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  body: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: {
    textTransform: 'uppercase',
    marginTop: 14,
  },
  title: {
    marginTop: 2,
    marginBottom: 14,
  },
  pill: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  pillDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: C.accent },
  hint: { marginTop: 12, maxWidth: 240 },
  errCard: {
    width: '100%',
    backgroundColor: C.redSoft,
    borderColor: 'rgba(255,90,90,0.35)',
  },
  errTitle: { marginBottom: 3 },
  legacyCard: {
    width: '100%',
    backgroundColor: C.amberSoft,
    borderColor: 'rgba(245,165,36,0.3)',
    marginBottom: 14,
  },
  legacyStandalone: { marginTop: 18, marginBottom: 0 },
  legacyTitle: { marginBottom: 3 },
  primary: { width: '100%', marginBottom: 8, marginTop: 2 },
  ghost: { width: '100%' },
})
