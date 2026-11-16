import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { MochiStage } from '../src/components/Mascot'
import { connectThisPhone, connect, loadSavedConfig, type ConnConfig } from '../src/lib/gateway'
import { getEmbeddedGateway } from '../src/lib/mochiRuntime'
import { C, useStyles } from '../src/lib/theme'
import { loadOnboarded, onboardedAtom } from '../src/lib/aboutMe'
import { useStore } from '@nanostores/react'

/**
 * Entry screen — local only (2026-11-15).
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
  const [phase, setPhase] = useState<'starting' | 'error'>('starting')
  const [detail, setDetail] = useState('')
  const [legacy, setLegacy] = useState<ConnConfig | null>(null)
  const onboarded = useStore(onboardedAtom)
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => { void openAgent() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.body}>
        <MochiStage state={phase === 'error' ? 'mochi-confused' : 'mochi-waking-up'} size={168} marginBottom={8} />
        <Text style={s.kicker}>YOUR AGENT, ON THIS PHONE</Text>
        <Text style={s.title}>Moch</Text>
        {phase === 'starting' ? (
          <>
            <Text style={s.sub}>Starting your agent…</Text>
            <ActivityIndicator color={C.accent} style={{ marginTop: 18 }} />
            <Text style={s.hint}>First launch takes a minute — the runtime is unpacking itself.</Text>
          </>
        ) : (
          <>
            <Text style={s.sub}>The agent couldn't start.</Text>
            <Text style={s.error} numberOfLines={4}>{detail}</Text>
            <Pressable style={({ pressed }) => [s.btn, pressed && s.pressed]} onPress={() => void retry()} accessibilityRole="button">
              <Text style={s.btnText}>Try again</Text>
            </Pressable>
            <Pressable style={s.link} onPress={() => router.replace('/(tabs)/chat')} accessibilityRole="button">
              <Text style={s.linkText}>Open Moch anyway</Text>
            </Pressable>
          </>
        )}

        {legacy ? (
          <View style={s.notice}>
            <Text style={s.noticeTitle}>Remote pairing is gone</Text>
            <Text style={s.noticeBody}>
              This build runs the agent on your phone only. The saved computer
              {' '}{legacy.name || legacy.host} is no longer used — you can forget it in Settings → Runtime.
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1, padding: 24, paddingTop: 18, justifyContent: 'flex-start' },
  kicker: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 2.5, marginBottom: 10, marginTop: 10 },
  title: { color: C.text, fontSize: 46, fontWeight: '800', lineHeight: 52, marginBottom: 10 },
  sub: { color: C.textDim, fontSize: 15, lineHeight: 21, marginBottom: 8 },
  hint: { color: C.textFaint, fontSize: 12.5, lineHeight: 18, marginTop: 14 },
  error: { color: C.red, fontSize: 12.5, lineHeight: 18, marginTop: 6, marginBottom: 18 },
  btn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  pressed: { opacity: 0.7 },
  btnText: { color: C.onAccent, fontSize: 15, fontWeight: '800' },
  link: { paddingVertical: 14, alignItems: 'center' },
  linkText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
  notice: { marginTop: 26, backgroundColor: C.bgCard, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14 },
  noticeTitle: { color: C.amber, fontSize: 13, fontWeight: '800', marginBottom: 4 },
  noticeBody: { color: C.textDim, fontSize: 12.5, lineHeight: 18 },
})
