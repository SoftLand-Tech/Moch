import React, { useEffect, useState } from 'react'
import { View, StyleSheet, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
// BUG-133 pattern (scrollable forms): the key inputs must ride the IME —
// under edge-to-edge the OS never resizes this app, so a plain ScrollView
// would leave them under the keyboard.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { router } from 'expo-router'
import { useStore } from '@nanostores/react'
import { Card, Field, GhostBtn, Pill, PrimaryBtn, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import { thinkerAtom } from '../../src/lib/thinker'
import { onboardedAtom } from '../../src/lib/aboutMe'
import type { ProviderOption } from '../../src/lib/modelState'
import {
  ocProviderCatalog,
  ocConnectProvider,
  ocModelCount,
  ocUnreachable,
  mochProviders,
  mochSaveKey,
} from '../../src/lib/onboardingProviders'

/**
 * Onboarding step 3 — providers/auth, OpenCode-aware (mockup 18).
 *
 * The copy and the flow follow the picked thinker: OpenCode's free models need
 * no account at all (its integration list is there for people who want one
 * specific provider); Moch needs one key before it can think, and a save takes
 * effect on live chats immediately (rpc_thinker refreshes them — no restart
 * caveat). Skipping is always allowed; providers can be added or changed later
 * in Settings. This screen only saves keys — it never mutates onboarding state,
 * so it also works opened from Settings outside the wizard.
 */
export default function ProvidersStep() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const thinker = useStore(thinkerAtom)
  // Settings opens this same screen outside the wizard: there the exits go
  // BACK (never into "STEP 4 OF 4"), and the step kicker would be a lie.
  const inWizard = !onboardedAtom.get()
  const exit = () => {
    if (inWizard) router.push('/onboarding/about')
    else if (router.canDismiss()) router.dismiss()
    else router.replace('/(tabs)/settings')
  }
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        {inWizard ? (
          <Txt
            size={10.5}
            weight="800"
            color={C.accent}
            style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 0.84 }]}
          >
            {t('setup.providers.kicker')}
          </Txt>
        ) : null}
        <Txt size={19} weight="800">{t('setup.providers.title')}</Txt>
      </View>
      <KeyboardAwareScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Txt size={11.5} color={C.textDim} style={s.sub}>
          {thinker === 'opencode' ? t('setup.providers.sub.opencode') : t('setup.providers.sub.moch')}
        </Txt>

        {thinker === 'opencode' ? <OpencodeProviders /> : <MochProviders />}

        <View style={[s.actions, { flexDirection: dir.row }]}>
          <GhostBtn
            onPress={exit}
            label={inWizard ? t('common.skip') : t('setup.providers.backSettings')}
            style={s.skipBtn}
          />
          <PrimaryBtn
            onPress={exit}
            label={inWizard ? t('common.continue') : t('common.done')}
            style={s.continueBtn}
          />
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  )
}

/** Moch thinker — the gateway's provider inventory + model.save_key flow. */
function MochProviders() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [providers, setProviders] = useState<ProviderOption[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedName, setSavedName] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await mochProviders()
        if (alive) setProviders(list)
      } catch (e) {
        if (!alive) return
        setProviders([])
        setLoadErr(e instanceof Error ? e.message : t('setup.providers.loadFailed'))
      }
    })()
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pickedProvider = (providers ?? []).find((p) => p.slug === picked) ?? null

  const save = async () => {
    if (!pickedProvider || busy || !key.trim()) return
    setBusy(true)
    setSaveErr(null)
    try {
      const opt = await mochSaveKey(pickedProvider.slug, key.trim())
      // saveProviderKey already invalidated the cached options atom;
      // swap the returned provider into the local list so the row
      // flips to "ready" without another RPC.
      if (opt) {
        setProviders((cur) => (cur ?? []).map((p) => (p.slug === opt.slug ? opt : p)))
        setSavedName(opt.name || pickedProvider.name)
      }
      setSaved(true)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (providers === null && !loadErr) {
    return (
      <View style={[s.progress, { flexDirection: dir.row }]}>
        <Spinner size="small" color={C.accent} />
        <Txt size={12.5} color={C.textDim} style={s.flex}>{t('setup.providers.loadingMoch')}</Txt>
      </View>
    )
  }

  return (
    <>
      <View style={s.rows}>
        {(providers ?? []).map((p) => {
          const ready = !!p.authenticated
          const on = picked === p.slug
          return (
            <Pressable
              key={p.slug}
              style={[s.row, { flexDirection: dir.row }, on && s.rowOn]}
              onPress={() => {
                setPicked(on ? null : p.slug)
                setKey('')
                setSaveErr(null)
                setSaved(false)
                setSavedName(null)
              }}
              accessibilityRole="button"
              accessibilityLabel={`${p.name}${ready ? `, ${t('common.ready')}` : ''}`}
            >
              <Txt size={12.5} weight="700" style={s.flex}>{p.name}</Txt>
              {ready ? (
                <Pill kind="green">{t('common.ready')}</Pill>
              ) : (
                <Txt size={11} color={C.textFaint}>{t('setup.providers.tapToAdd')}</Txt>
              )}
            </Pressable>
          )
        })}
      </View>

      {providers !== null && providers.length === 0 && !loadErr ? (
        <Txt size={11.5} color={C.amber} style={s.note}>{t('setup.providers.emptyMoch')}</Txt>
      ) : null}
      {loadErr ? <Txt size={11.5} color={C.amber} style={s.note}>{loadErr}</Txt> : null}

      {pickedProvider ? (
        <Card style={s.formCard}>
          <Txt size={12} weight="700" style={s.formTitle}>
            {t('setup.providers.keyTitle', { provider: pickedProvider.name })}
          </Txt>
          <View style={[s.keyRow, { flexDirection: dir.row }]}>
            <Field
              value={key}
              onChangeText={(v) => {
                setKey(v)
                if (saveErr) setSaveErr(null)
                if (saved) setSaved(false)
              }}
              placeholder={t('setup.providers.keyPlaceholder')}
              accessibilityLabel={t('setup.providers.keyA11y', { provider: pickedProvider.name })}
              secureTextEntry
              mono
              autoCapitalize="none"
              autoCorrect={false}
              style={s.keyInput}
              wrapStyle={s.keyField}
            />
            <PrimaryBtn
              onPress={() => void save()}
              disabled={!key.trim() || busy || saved}
              accessibilityLabel={saved ? t('setup.providers.saved') : t('setup.providers.save')}
            >
              {busy ? (
                <Spinner size="small" color={C.onAccent} />
              ) : (
                <Txt size={12.5} weight="700" color={C.onAccent}>
                  {saved ? t('setup.providers.saved') : t('setup.providers.save')}
                </Txt>
              )}
            </PrimaryBtn>
          </View>
          {saveErr ? (
            <Txt size={11.5} color={C.red} style={s.saveErr}>
              {t('setup.providers.saveFailed', { why: saveErr })}
            </Txt>
          ) : null}
        </Card>
      ) : null}

      {saved && savedName ? (
        <Txt size={11.5} color={C.greenSoft} style={s.applied}>
          {t('setup.providers.applied', { provider: savedName })}
        </Txt>
      ) : null}
    </>
  )
}

/** OpenCode thinker — the guest server's own integrations (free models need no key). */
function OpencodeProviders() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [rows, setRows] = useState<{ id: string; name: string }[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [models, setModels] = useState<number | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [connected, setConnected] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [catalog, count] = await Promise.all([
          ocProviderCatalog(),
          ocModelCount().catch(() => null),
        ])
        if (!alive) return
        setRows(catalog)
        setModels(count)
      } catch (e) {
        if (!alive) return
        setRows([])
        setLoadErr(
          ocUnreachable(e)
            ? t('setup.providers.ocUnreachable')
            : e instanceof Error
              ? e.message
              : t('setup.providers.loadFailed'),
        )
      }
    })()
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const k = key.trim()
    if (!k || !picked || saving) return
    setSaving(true)
    setSaveErr(null)
    try {
      await ocConnectProvider(picked, k)
      setConnected((cur) => (cur.includes(picked) ? cur : [...cur, picked]))
      setSaved(true)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const pickedRow = (rows ?? []).find((r) => r.id === picked)

  if (rows === null && !loadErr) {
    return (
      <View style={[s.progress, { flexDirection: dir.row }]}>
        <Spinner size="small" color={C.accent} />
        <Txt size={12.5} color={C.textDim} style={s.flex}>{t('setup.providers.loadingOc')}</Txt>
      </View>
    )
  }

  return (
    <>
      <View style={s.rows}>
        {(rows ?? []).map((r) => {
          const done = connected.includes(r.id)
          const on = picked === r.id
          return (
            <Pressable
              key={r.id}
              style={[s.row, { flexDirection: dir.row }, on && s.rowOn]}
              onPress={() => {
                setPicked(on ? null : r.id)
                setKey('')
                setSaveErr(null)
                setSaved(false)
              }}
              accessibilityRole="button"
              accessibilityLabel={`${r.name}${done ? `, ${t('common.connected')}` : ''}`}
            >
              <Txt size={12.5} weight="700" style={s.flex}>{r.name}</Txt>
              {done ? (
                <Pill kind="green">{t('common.connected')}</Pill>
              ) : (
                <Txt size={11} color={C.textFaint}>{t('setup.providers.tapToAdd')}</Txt>
              )}
            </Pressable>
          )
        })}
      </View>

      {rows !== null && rows.length === 0 && !loadErr ? (
        <Txt size={11.5} color={C.amber} style={s.note}>{t('setup.providers.emptyOc')}</Txt>
      ) : null}
      {loadErr ? <Txt size={11.5} color={C.amber} style={s.note}>{loadErr}</Txt> : null}
      {models !== null && !loadErr ? (
        <Txt size={11.5} color={C.textFaint} style={s.reassure}>
          {t('setup.providers.ocModels', { n: models })}
        </Txt>
      ) : null}

      {pickedRow ? (
        <Card style={s.formCard}>
          <Txt size={12} weight="700" style={s.formTitle}>
            {t('setup.providers.keyTitle', { provider: pickedRow.name })}
          </Txt>
          <View style={[s.keyRow, { flexDirection: dir.row }]}>
            <Field
              value={key}
              onChangeText={(v) => {
                setKey(v)
                if (saveErr) setSaveErr(null)
                if (saved) setSaved(false)
              }}
              placeholder={t('setup.providers.keyPlaceholder')}
              accessibilityLabel={t('setup.providers.keyA11y', { provider: pickedRow.name })}
              secureTextEntry
              mono
              autoCapitalize="none"
              autoCorrect={false}
              style={s.keyInput}
              wrapStyle={s.keyField}
            />
            <PrimaryBtn
              onPress={() => void save()}
              disabled={!key.trim() || saving || saved}
              accessibilityLabel={saved ? t('setup.providers.saved') : t('setup.providers.save')}
            >
              {saving ? (
                <Spinner size="small" color={C.onAccent} />
              ) : (
                <Txt size={12.5} weight="700" color={C.onAccent}>
                  {saved ? t('setup.providers.saved') : t('setup.providers.save')}
                </Txt>
              )}
            </PrimaryBtn>
          </View>
          {saveErr ? (
            <Txt size={11.5} color={C.red} style={s.saveErr}>
              {t('setup.providers.saveFailed', { why: saveErr })}
            </Txt>
          ) : null}
        </Card>
      ) : null}
    </>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 },
  kicker: { textTransform: 'uppercase' },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 28 },
  sub: { lineHeight: 17, marginBottom: 12 },
  flex: { flex: 1 },
  rows: { gap: 6, marginBottom: 10 },
  row: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgCard,
  },
  rowOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  note: { lineHeight: 17, marginBottom: 10 },
  reassure: { lineHeight: 17, marginBottom: 10 },
  progress: { alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 10 },
  formCard: { paddingVertical: 12 },
  formTitle: { marginBottom: 6 },
  keyRow: { alignItems: 'center', gap: 6 },
  keyField: { flex: 1, width: 'auto' },
  keyInput: { fontSize: 11.5, paddingVertical: 7, paddingHorizontal: 10, minHeight: 32 },
  saveErr: { lineHeight: 16, marginTop: 6 },
  applied: { lineHeight: 17, marginTop: 2, marginBottom: 4 },
  actions: { alignItems: 'stretch', gap: 8, marginTop: 8 },
  skipBtn: { flex: 1 },
  continueBtn: { flex: 2 },
})
