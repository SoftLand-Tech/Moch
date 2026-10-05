import React, { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../src/components/Icon'
import { PairForm } from '../src/components/PairForm'
import { MochiStage } from '../src/components/Mascot'
import { servers as serversStore, switchToServer, connConfig } from '../src/lib/gateway'
import { C, useStyles } from '../src/lib/theme'

export default function Onboarding() {
  const s = useStyles(makeS)
  const saved = useStore(serversStore)
  const active = useStore(connConfig)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [switchErr, setSwitchErr] = useState<string | null>(null)

  // A returning user (saved pairing) goes straight to chat — the tabs render
  // the connecting state and the global overlay reports progress. Onboarding
  // is only for first pairings.
  const redirected = useRef(false)
  useEffect(() => {
    if (!redirected.current && active) {
      redirected.current = true
      router.replace('/(tabs)/chat')
    }
  }, [active])
  const pick = async (id: string) => {
    setSwitchingId(id)
    setSwitchErr(null)
    try {
      await switchToServer(id)
      router.replace('/(tabs)/chat')
    } catch (e) {
      setSwitchErr(e instanceof Error ? e.message : 'Could not connect')
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {/* Mochi opens the app the way the splash leaves him: mid wake-up
            loop — asleep, stretch, awake, back to sleep while you pair. */}
        <MochiStage state="mochi-waking-up" size={168} marginBottom={0} />
        <Text style={s.kicker}>SELF-HOSTED AGENT</Text>
        <Text style={s.title}>Moch</Text>
        <Text style={s.sub}>Your agent, in your pocket.</Text>

        <PairForm onPaired={() => router.replace('/(tabs)/chat')} />

        {saved.length > 0 ? (
          <View style={s.savedBlock}>
            <Text style={s.label}>YOUR COMPUTERS</Text>
            {saved.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt).map((sv) => (
              <Pressable
                key={sv.id}
                style={({ pressed }) => [s.savedRow, pressed && s.pressed]}
                onPress={() => void pick(sv.id)}
                accessibilityRole="button"
                accessibilityLabel={`Connect to ${sv.name}`}
              >
                {switchingId === sv.id ? (
                  <ActivityIndicator size="small" color={C.accent} />
                ) : (
                  <Icon name="desktop-outline" size={20} color={C.textDim} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.savedName} numberOfLines={1}>{sv.name}</Text>
                  <Text style={s.savedHost} numberOfLines={1}>{sv.tls ? 'WSS' : 'WS'} · paired {new Date(sv.addedAt).toLocaleDateString()}</Text>
                </View>
                <Icon name="chevron-forward" size={16} color={C.textFaint} />
              </Pressable>
            ))}
            {switchErr ? <Text style={s.error}>{switchErr}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  pressed: { opacity: 0.6 },
  content: { padding: 24, paddingBottom: 40 },
  kicker: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 2.5, marginBottom: 10, marginTop: 20 },
  title: { color: C.text, fontSize: 46, fontWeight: '800', lineHeight: 52, marginBottom: 10 },
  sub: { color: C.textDim, fontSize: 15, marginBottom: 26, lineHeight: 21 },
  savedBlock: { marginTop: 18 },
  label: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  savedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 16, paddingVertical: 14, marginBottom: 8, minHeight: 60,
  },
  savedName: { color: C.text, fontSize: 15, fontWeight: '700' },
  savedHost: { color: C.textFaint, fontSize: 12, marginTop: 2 },
  error: { color: C.red, fontSize: 13, marginTop: 8, lineHeight: 18 },
})
