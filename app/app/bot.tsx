import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ScreenShell } from '../src/components/ScreenShell'
import { C, useStyles } from '../src/lib/theme'
import { rpc } from '../src/lib/gateway'
import { refreshFleet, setActiveBot } from '../src/lib/fleet'
import { tr, isRTL } from '../src/lib/strings'

/**
 * Bot detail (M9.2): SOUL viewer/editor, description, freeze, chat hand-off,
 * delete wizard (§2.7/§2.1 — tombstone stops schedules by construction;
 * kanban reassignment lands with M9.4 and the wizard says so).
 */
export default function BotDetail() {
  const s = useStyles(makeS)
  const router = useRouter()
  const { name } = useLocalSearchParams<{ name?: string }>()
  const bot = name ?? ''
  const [soul, setSoul] = useState<string>('')
  const [desc, setDesc] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(0)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!bot) return
    try {
      const res = await rpc<{ result?: { soul?: string; description?: string } }>(
        'profiles.describe', { profile: bot }, 15000)
      const r = (res as { result?: { soul?: string; description?: string } }).result ?? res
      setSoul((r as { soul?: string }).soul ?? '')
      setDesc((r as { description?: string }).description ?? '')
    } catch {
      // profile listing stays authoritative; editor starts blank on failure
    } finally {
      setLoading(false)
    }
  }, [bot])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await rpc('profiles.configure', { profile: bot, soul, description: desc }, 20000)
      setSavedAt(Date.now())
      void refreshFleet()
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async () => {
    if (confirmDelete < 2 || deleting) return
    setDeleting(true)
    try {
      await rpc('moch.profiles.delete', { profile: bot, confirm: true }, 20000)
      await setActiveBot(null)
      void refreshFleet()
      router.back()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell
        title={bot || 'Bot'}
        showBrand
        right={
          <Pressable
            accessibilityLabel={tr("bot.chat", { name: bot })}
            onPress={async () => {
              await setActiveBot(bot)
              router.navigate({ pathname: '/(tabs)/chat', params: { botProfile: bot } } as never)
            }}
            hitSlop={8}
          >
            <Ionicons name="chatbubble-outline" size={22} color={C.textDim} />
          </Pressable>
        }
      >
        {loading ? (
          <ActivityIndicator style={s.spin} />
        ) : (
          <ScrollView contentContainerStyle={s.body}>
            <Pressable onPress={() => router.back()} hitSlop={8} style={s.backRow}>
              <Ionicons name="chevron-back" size={18} color={C.textDim} />
              <Text style={s.backText}>{tr("fleet.detail.back")}</Text>
            </Pressable>
            <Text style={s.label}>{tr("bot.job")}</Text>
            <TextInput style={s.input} value={desc} onChangeText={setDesc}
                       placeholder="What is this bot for?" placeholderTextColor={C.textFaint} />

            <Text style={s.label}>{tr("bot.soul")}</Text>
            <TextInput
              style={[s.input, s.soulInput]}
              value={soul}
              onChangeText={setSoul}
              multiline
              textAlignVertical="top"
            />

            <View style={s.rowBtns}>
              {savedAt ? <Text style={s.saved}>{tr("bot.saved")}</Text> : null}
              <Pressable accessibilityRole="button" style={[s.btn, saving && s.disabled]} onPress={save} disabled={saving}>
                {saving ? <ActivityIndicator size="small" /> : <Text style={s.btnText}>{tr("bot.save")}</Text>}
              </Pressable>
            </View>

            <View style={s.danger}>
              <Text style={s.dangerTitle}>{tr("bot.delete.title")}</Text>
              <Text style={s.dangerBody}>{tr("bot.delete.body")}</Text>
              <Pressable
                accessibilityRole="button"
                style={[s.deleteBtn, confirmDelete > 0 && s.deleteArmed]}
                onPress={() => {
                  if (confirmDelete === 0) { setConfirmDelete(1); return }
                  if (confirmDelete === 1) { setConfirmDelete(2); void doDelete() }
                }}
                disabled={deleting}
              >
                {deleting ? <ActivityIndicator size="small" /> : (
                  <Text style={s.deleteText}>
                    {confirmDelete === 0 ? tr("bot.delete.cta")
                      : confirmDelete === 1 ? tr("bot.delete.confirm")
                        : tr("bot.delete.doing")}
                  </Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        )}
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    spin: { marginTop: 24 },
    body: { padding: 16, paddingBottom: 40 },
    backRow: { flexDirection: isRTL() ? 'row-reverse' : 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
    backText: { color: C.textDim, fontSize: 13 },
    label: { color: C.textDim, fontSize: 12, marginTop: 14, marginBottom: 6 },
    input: {
      color: C.text,
      backgroundColor: C.inputBg,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
    },
    soulInput: { minHeight: 180, textAlignVertical: 'top', lineHeight: 19 },
    rowBtns: { flexDirection: isRTL() ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
    saved: { color: C.green, fontSize: 12 },
    btn: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },
    disabled: { opacity: 0.5 },
    btnText: { color: C.onAccent, fontWeight: '600', fontSize: 13 },
    danger: { marginTop: 36, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: 16 },
    dangerTitle: { color: C.red, fontSize: 13, fontWeight: '700' },
    dangerBody: { color: C.textDim, fontSize: 12, lineHeight: 18, marginTop: 6 },
    deleteBtn: {
      marginTop: 10, borderWidth: 1, borderColor: C.red, borderRadius: 10,
      alignItems: 'center', paddingVertical: 10,
    },
    deleteArmed: { backgroundColor: C.redSoft },
    deleteText: { color: C.red, fontWeight: '600', fontSize: 13 },
  })
