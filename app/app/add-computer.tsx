import React from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../src/components/Icon'
import { PairForm } from '../src/components/PairForm'
import { C, useStyles } from '../src/lib/theme'

/**
 * Pair an additional computer without forgetting the current one.
 * The new machine connects immediately; the old one stays in the saved list.
 */
export default function AddComputer() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Pressable
          style={({ pressed }) => [s.back, pressed && s.pressed]}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to settings"
        >
          <Icon name="chevron-back" size={22} color={C.text} />
          <Text style={s.backText}>Settings</Text>
        </Pressable>
        <Text style={s.title}>Add a computer</Text>
        <Text style={s.sub}>Scan the QR from that machine — the current one stays saved, and you can switch any time in Settings.</Text>

        <PairForm onPaired={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  pressed: { opacity: 0.6 },
  content: { padding: 24, paddingBottom: 40 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10, minHeight: 44 },
  backText: { color: C.text, fontSize: 15, fontWeight: '600' },
  title: { color: C.text, fontSize: 32, fontWeight: '800', marginBottom: 10 },
  sub: { color: C.textDim, fontSize: 15, lineHeight: 21, marginBottom: 24 },
})
