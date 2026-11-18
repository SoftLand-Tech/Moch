/**
 * API-key entry for a provider the gateway knows but that has no key yet.
 * Presentational only — the parent owns the `model.save_key` RPC and whatever
 * follows a successful connect (picker advance, inventory refresh, …). Used by
 * the ModelPickerSheet's inline flow and the Models screen's Providers section.
 *
 * BUG-133: this form only renders inside an avoiding parent — the Models
 * screen's KeyboardAwareScrollView, the picker's full-screen KeyboardAvoidingView
 * or the setup/onboarding scroll forms. Never mount it outside one of those.
 */
import React, { useState } from 'react'
import { View, Pressable, StyleSheet } from 'react-native'
import { C, useStyles } from '../lib/theme'
import { useDir, useT } from '../lib/strings'
import type { ProviderOption } from '../lib/modelState'
import { Field, PrimaryBtn, Spinner, Txt } from './ui'

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
  const t = useT()
  const dir = useDir()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const inFlight = busy || saving
  const canSave = !!value.trim() && !inFlight

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
      <Txt size={12.5} weight="700" numberOfLines={2}>
        {t('agent.key.title', { name: provider.name })}
      </Txt>
      <Txt size={11} color={C.textDim} numberOfLines={2}>
        {provider.key_env ? t('agent.key.hintEnv', { env: provider.key_env }) : t('agent.key.hint')}
      </Txt>
      <View style={[s.row, { flexDirection: dir.row }]}>
        <Field
          value={value}
          onChangeText={(text) => {
            setValue(text)
            if (error) setError('')
          }}
          placeholder={t('agent.key.placeholder')}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          mono
          ltr
          editable={!inFlight}
          returnKeyType="done"
          onSubmitEditing={() => { void save() }}
          accessibilityLabel={t('agent.key.a11y')}
          wrapStyle={s.field}
          style={s.input}
        />
        <PrimaryBtn
          small
          label={t('agent.key.save')}
          accessibilityLabel={t('agent.key.saveA11y')}
          onPress={() => { void save() }}
          disabled={!canSave}
          style={s.saveBtn}
        >
          {inFlight ? <Spinner size="small" color={C.onAccent} /> : undefined}
        </PrimaryBtn>
      </View>
      <View style={[s.foot, { flexDirection: dir.row }]}>
        {error ? (
          <Txt size={11} color={C.amber} style={s.error} numberOfLines={3}>
            {t('agent.key.error', { error })}
          </Txt>
        ) : (
          <View style={s.fill} />
        )}
        <Pressable
          onPress={onCancel}
          disabled={inFlight}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('agent.key.cancelA11y')}
          style={({ pressed }) => [s.cancel, pressed && s.pressed, inFlight && s.disabled]}
        >
          <Txt size={11.5} weight="600" color={C.textFaint}>
            {t('common.cancel')}
          </Txt>
        </Pressable>
      </View>
    </View>
  )
}

const makeS = () => StyleSheet.create({
  wrap: { gap: 6, paddingTop: 8 },
  row: { alignItems: 'center', gap: 6 },
  field: { flex: 1 },
  input: { fontSize: 12.5, paddingVertical: 7, paddingHorizontal: 9, minHeight: 36 },
  saveBtn: { paddingVertical: 7, paddingHorizontal: 12 },
  foot: { alignItems: 'center', gap: 8, minHeight: 16 },
  error: { flex: 1, lineHeight: 15 },
  fill: { flex: 1 },
  cancel: { paddingVertical: 2, paddingHorizontal: 2 },
  pressed: { opacity: 0.55 },
  disabled: { opacity: 0.45 },
})
