/**
 * API-key entry for a provider the gateway knows but that has no key yet.
 * Presentational only — the parent owns the `model.save_key` RPC and whatever
 * follows a successful connect (picker advance, inventory refresh, …). Used by
 * the ModelPickerSheet's inline flow and the Models screen's Providers section.
 */
import React, { useState } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { C, useStyles } from '../lib/theme'
import type { ProviderOption } from '../lib/modelState'

export function ProviderKeyForm({
  provider,
  busy,
  onSave,
  onCancel,
}: {
  provider: ProviderOption
  busy: boolean
  /** Resolve with null on success, or an error string the form displays. */
  onSave: (apiKey: string) => Promise<string | null>
  onCancel: () => void
}) {
  const s = useStyles(makeS)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const inFlight = busy || saving

  const save = async () => {
    const key = value.trim()
    if (!key || inFlight) return
    setError('')
    setSaving(true)
    const err = await onSave(key).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    setSaving(false)
    // A success unmounts this form (the parent swaps the step/section), so an
    // error result is the only path that keeps the typed key for a retry.
    if (err != null) setError(err)
  }

  return (
    <View style={s.wrap}>
      <Text style={s.title}>{provider.name} needs an API key</Text>
      <Text style={s.hint}>
        {provider.key_env ? `Stored server-side as ${provider.key_env}.` : 'Stored server-side by your gateway.'}
      </Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={(t) => { setValue(t); if (error) setError('') }}
        placeholder="Paste API key…"
        placeholderTextColor={C.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        accessibilityLabel="API key"
      />
      {error ? <Text style={s.error}>Couldn't save — {error}</Text> : null}
      <View style={s.row}>
        <Pressable
          style={({ pressed }) => [s.btn, s.cancel, pressed && s.pressed]}
          onPress={onCancel}
          disabled={inFlight}
          accessibilityLabel="Cancel key"
        >
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[s.btn, s.save, (!value.trim() || inFlight) && s.saveOff]}
          onPress={() => { void save() }}
          disabled={!value.trim() || inFlight}
          accessibilityLabel="Save key"
        >
          {saving || busy ? (
            <ActivityIndicator size="small" color={C.onAccent} />
          ) : (
            <Text style={s.saveText}>Save & continue</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

const makeS = () => StyleSheet.create({
  wrap: { padding: 16, gap: 8, backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  title: { color: C.text, fontSize: 15, fontWeight: '700' },
  hint: { color: C.textFaint, fontSize: 12 },
  input: {
    backgroundColor: C.bgElev, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 12, paddingVertical: 11, minHeight: 46, fontSize: 14,
  },
  error: { color: C.amber, fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, borderRadius: 22, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  cancel: { backgroundColor: C.bgElev },
  cancelText: { color: C.textDim, fontWeight: '700', fontSize: 13.5 },
  save: { backgroundColor: C.accent },
  saveOff: { opacity: 0.5 },
  saveText: { color: C.onAccent, fontWeight: '800', fontSize: 13.5 },
  pressed: { opacity: 0.55 },
})
