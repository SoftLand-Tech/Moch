import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import { MochiStage } from '../src/components/Mascot'
import { connectThisPhone, connect, connConfig, loadSavedConfig, type ConnConfig } from '../src/lib/gateway'
import { getEmbeddedGateway } from '../src/lib/mochiRuntime'
import { C, useStyles } from '../src/lib/theme'

/**
 * Onboarding — local only (2026-11-15).
 *
 * This build has no remote pairing: the agent is the embedded runtime on this
 * device. The screen waits for the loopback gateway, dials it, then opens
 * chat. A saved config from the remote era may still be on disk; it is never
 * dialed, and a one-time notice names it so the user can forget it.
 */
export default function Onboarding() {
  const s = useStyles(makeS)
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
    return () => { mounted.current = false }
  }, [])

  const openAgent = async () => {
    setPhase('starting')
    setDetail('')
    try {
      await connectThisPhone()
      if (!mounted.current) return
      router.replace('/(tabs)/chat')
    } catch (e) {
      if (!mounted.current) return
      setDetail(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  useEffect(() => {
    // Reached from the cfg branch's Stack after a successful boot? The layout
    // already dialed the phone — this screen is only the pre-config boot
    // surface, so hand straight to chat instead of dialing twice.
    if (connConfig.get()) {
      router.replace('/(tabs)/chat')
      return
    }
    void openAgent()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The layout's boot dial can land while this screen is already mounted (it
  // renders inside the cfg-null branch). Follow it into chat; never leave the
  // user staring at "Starting…" over a live connection.
  useFocusEffect(
    React.useCallback(() => {
      if (connConfig.get()) router.replace('/(tabs)/chat')
    }, []),
  )

  const retry = async () => {
    // A retry may follow a killed runtime: re-read its live host/token instead
    // of trusting the failed attempt's snapshot.
    setPhase('starting')
    setDetail('')
    const gw = await getEmbeddedGateway().catch(() => null)
    if (gw?.running && gw.ready && gw.port && gw.token) {
      try {
        await connect({ host: `127.0.0.1:${gw.port}`, token: gw.token, tls: false, name: 'This phone' })
        if (mounted.current) router.replace('/(tabs)/chat')
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
