import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native'
// BUG-133: desc + multiline SOUL inputs had zero avoidance (Save row and the
// danger zone sat under the IME), and the missing keyboardShouldPersistTaps
// made the first tap on Save just dismiss the keyboard (RN default ≡ 'never').
// KeyboardAwareScrollView fixes both: viewport above the keys, focused field
// scrolled in, taps delivered while the IME is open.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ScreenShell } from '../src/components/ScreenShell'
import { showAlert } from '../src/components/AlertDialog'
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
  const [noProvider, setNoProvider] = useState(false)
  const [mirroring, setMirroring] = useState(false)

  const load = useCallback(async () => {
    if (!bot) return
    try {
      // BUG-108: the `profiles.*` family resolves `params["name"]`
      // (`tui_gateway/methods_profiles.py::_resolve_profile` — 4063 "name
      // required" otherwise); only the `moch.*` family takes `profile`. This
      // screen sent `profile`, so describe failed silently (the editor opened
      // blank for a bot that has a description and a SOUL) and configure was a
      // silent no-op on Save. `profiles.create` in fleet.ts has always used
      // `name` — this is the same contract.
      const res = await rpc<{ result?: { soul?: string; description?: string } }>(
        'profiles.describe', { name: bot }, 15000)
      const r = (res as { result?: { soul?: string; description?: string } }).result ?? res
      setSoul((r as { soul?: string }).soul ?? '')
      setDesc((r as { description?: string }).description ?? '')
      setNoProvider(!((r as { model?: { provider?: string } }).model?.provider))
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
      await rpc('profiles.configure', { name: bot, soul, description: desc }, 20000)
      setSavedAt(Date.now())
      void refreshFleet()
    } catch (e) {
      // #107: try/finally with no catch let the rejection escape as an
      // unhandled promise (silent on some surfaces) while the stale
      // "saved" indicator stayed up from an earlier success.
      setSavedAt(null)
      showAlert(tr('bot.save.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }

  const connectProvider = async () => {
    if (mirroring) return
    setMirroring(true)
    try {
      const res = await rpc<{ mirrored?: string[] }>(
        'moch.profiles.mirror_model_key', { profile: bot }, 15000)
      const keys = res.mirrored ?? []
      showAlert(
        keys.length ? 'Provider connected' : 'Nothing to mirror',
        keys.length
          ? `Mirrored ${keys.join(', ')} from your main bot. Try chatting now.`
          : 'Your main bot has no API keys to mirror. Add one in Connectors first.')
      setNoProvider(false)
    } catch (e) {
      showAlert('Mirror failed', e instanceof Error ? e.message : String(e))
    } finally {
      setMirroring(false)
    }
  }

  // BUG-110 (second cause): the guard used to read `confirmDelete < 2`, but the
  // second tap calls doDelete() from the render where confirmDelete is still 1 —
  // React state updates are async, so the guard returned immediately and the
  // delete never fired (the button then sat on "deleting…" until the screen was
  // remounted). Verified on device: two taps left the bot in /api/profiles while
  // the same RPC called directly returned {"deleted": "…"}. Only `deleting`
  // guards now; the armed tap is the confirmation.
  const doDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      await rpc('moch.profiles.delete', { profile: bot, confirm: true }, 20000)
      await setActiveBot(null)
      void refreshFleet()
      router.back()
    } catch (e) {
      // #107: surface the failure instead of swallowing it, and re-arm the
      // wizard — otherwise the button sat on "Tap again to confirm deletion"
      // with nothing to tap into.
      setConfirmDelete(0)
      showAlert(tr('bot.delete.failed', { why: e instanceof Error ? e.message : String(e) }))
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
          <KeyboardAwareScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
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

            {noProvider ? (
              <View style={s.noProviderBox}>
                <Text style={s.noProviderText}>
                  This bot has no AI provider yet — it can't answer until it shares
                  your main bot's model key.
                </Text>
                <Pressable accessibilityRole="button" style={s.btn} onPress={connectProvider} disabled={mirroring}>
                  {mirroring ? <ActivityIndicator size="small" /> : <Text style={s.btnText}>Use my provider</Text>}
                </Pressable>
              </View>
            ) : null}

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
          </KeyboardAwareScrollView>
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
    noProviderBox: { backgroundColor: C.amberSoft, borderRadius: 10, padding: 10, marginTop: 12, gap: 8 },
    noProviderText: { color: C.textDim, fontSize: 12, lineHeight: 17 },
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
