import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
// BUG-133 pattern (scrollable forms): the key inputs must ride the IME —
// under edge-to-edge the OS never resizes this app, so a plain ScrollView
// would leave them under the keyboard.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { thinkerAtom } from '../../src/lib/thinker'
import { onboardedAtom } from '../../src/lib/aboutMe'
import { useStore } from '@nanostores/react'
import { ProviderKeyForm } from '../../src/components/ProviderKeyForm'
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
 * Onboarding step 3 — providers/auth, OpenCode-aware.
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
      <KeyboardAwareScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {inWizard ? <Text style={s.kicker}>STEP 3 OF 4</Text> : null}
        <Text style={s.title}>Plug in a brain</Text>
        <Text style={s.sub}>
          {thinker === 'opencode'
            ? 'OpenCode works out of the box with free models — no account needed. Add a key only if you want a specific provider.'
            : 'Moch needs one provider key to think. Pick a provider, paste a key.'}
        </Text>

        {thinker === 'opencode' ? <OpencodeProviders /> : <MochProviders />}

        <Pressable style={s.btn} onPress={exit} accessibilityRole="button">
          <Text style={s.btnText}>{inWizard ? 'Continue' : 'Done'}</Text>
        </Pressable>
        <Pressable style={s.skip} onPress={exit} accessibilityRole="button">
          <Text style={s.skipText}>{inWizard ? 'Skip for now' : 'Back to Settings'}</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  )
}

/** OpenCode thinker — the guest server's own integrations (free models need no key). */
function OpencodeProviders() {
  const s = useStyles(makeS)
  const [rows, setRows] = useState<{ id: string; name: string }[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [models, setModels] = useState<number | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
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
            ? "The OpenCode server isn't running — you can add providers later in Settings."
            : e instanceof Error ? e.message : 'Could not load providers.',
        )
      }
    })()
    return () => { alive = false }
  }, [])

  const save = async () => {
    const k = key.trim()
    if (!k || !picked || saving) return
    setSaving(true)
    setSaveErr(null)
    try {
      await ocConnectProvider(picked, k)
      setConnected((cur) => (cur.includes(picked) ? cur : [...cur, picked]))
      setPicked(null)
      setKey('')
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Could not save that key.')
    } finally {
      setSaving(false)
    }
  }

  if (rows === null && !loadErr) {
    return (
      <View style={s.progress}>
        <ActivityIndicator size="small" color={C.accent} />
        <Text style={s.progressText}>Asking the OpenCode server what it can connect to…</Text>
      </View>
    )
  }

  const pickedRow = (rows ?? []).find((r) => r.id === picked)

  return (
    <>
      {(rows ?? []).map((r) => {
        const done = connected.includes(r.id)
        return (
          <Pressable
            key={r.id}
            style={[s.card, picked === r.id && s.cardOn]}
            onPress={() => { setPicked((cur) => (cur === r.id ? null : r.id)); setKey(''); setSaveErr(null) }}
            accessibilityRole="button"
            accessibilityLabel={`${r.name}${done ? ', connected' : ''}`}
          >
            <View style={s.head}>
              <View style={[s.badge, { backgroundColor: C.bgHover }]}>
                <Icon name="flash-outline" size={18} color={C.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{r.name}</Text>
                {done ? <Text style={s.okTag}>connected</Text> : null}
              </View>
              {done ? <Icon name="checkmark-circle" size={20} color={C.greenSoft} /> : null}
            </View>
          </Pressable>
        )
      })}

      {rows !== null && rows.length === 0 && !loadErr ? (
        <Text style={s.warn}>Nothing here needs a key — the free models work without an account.</Text>
      ) : null}
      {loadErr ? <Text style={s.warn}>{loadErr}</Text> : null}
      {models !== null && !loadErr ? (
        <Text style={s.reassure}>{models} models available — the free ones need no key.</Text>
      ) : null}

      {pickedRow ? (
        <View style={s.keyForm}>
          <Text style={s.label}>PASTE YOUR {pickedRow.name.toUpperCase()} KEY</Text>
          <TextInput
            style={s.input}
            value={key}
            onChangeText={(t) => { setKey(t); if (saveErr) setSaveErr(null) }}
            placeholder="API key…"
            placeholderTextColor={C.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel={`${pickedRow.name} API key`}
          />
          {saveErr ? <Text style={s.error}>{saveErr}</Text> : null}
          <Pressable
            style={[s.saveBtn, (!key.trim() || saving) && s.saveOff]}
            onPress={() => { void save() }}
            disabled={!key.trim() || saving}
            accessibilityRole="button"
            accessibilityLabel={`Save ${pickedRow.name} key`}
          >
            {saving ? <ActivityIndicator size="small" color={C.onAccent} /> : <Text style={s.saveBtnText}>Save</Text>}
          </Pressable>
        </View>
      ) : null}
    </>
  )
}

/** Moch thinker — the gateway's provider inventory + model.save_key flow. */
function MochProviders() {
  const s = useStyles(makeS)
  const [providers, setProviders] = useState<ProviderOption[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
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
        setLoadErr(e instanceof Error ? e.message : 'Could not load providers.')
      }
    })()
    return () => { alive = false }
  }, [])

  if (providers === null && !loadErr) {
    return (
      <View style={s.progress}>
        <ActivityIndicator size="small" color={C.accent} />
        <Text style={s.progressText}>Loading providers…</Text>
      </View>
    )
  }

  const pickedProvider = (providers ?? []).find((p) => p.slug === picked)

  return (
    <>
      {(providers ?? []).map((p) => {
        const ready = !!p.authenticated
        return (
          <Pressable
            key={p.slug}
            style={[s.card, picked === p.slug && s.cardOn]}
            onPress={() => { setPicked((cur) => (cur === p.slug ? null : p.slug)) }}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}${ready ? ', ready' : ''}`}
          >
            <View style={s.head}>
              <View style={[s.badge, { backgroundColor: C.accentSoft }]}>
                <Icon name="flash-outline" size={18} color={C.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{p.name}</Text>
                {ready ? <Text style={s.okTag}>ready</Text> : null}
              </View>
              {ready ? <Icon name="checkmark-circle" size={20} color={C.greenSoft} /> : null}
            </View>
          </Pressable>
        )
      })}

      {providers !== null && providers.length === 0 && !loadErr ? (
        <Text style={s.warn}>The provider list came back empty — you can set this later in Settings.</Text>
      ) : null}
      {loadErr ? <Text style={s.warn}>{loadErr}</Text> : null}

      {pickedProvider ? (
        <ProviderKeyForm
          provider={pickedProvider}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={async (apiKey) => {
            setBusy(true)
            try {
              const opt = await mochSaveKey(pickedProvider.slug, apiKey)
              // saveProviderKey already invalidated the cached options atom;
              // swap the returned provider into the local list so the row
              // flips to "ready" without another RPC.
              if (opt) {
                setProviders((cur) => (cur ?? []).map((p) => (p.slug === opt.slug ? opt : p)))
                setSavedName(opt.name || pickedProvider.name)
              }
              setPicked(null)
              return null
            } catch (e) {
              return e instanceof Error ? e.message : 'save failed'
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {savedName ? (
        <View style={s.okCard}>
          <Icon name="checkmark-circle" size={18} color={C.greenSoft} />
          <Text style={s.okText}>{savedName} is connected — the key applies to your chats right away.</Text>
        </View>
      ) : null}
    </>
  )
}

// Visual language copied from thinker.tsx (kicker/title/sub/card/btn family);
// input + label from about.tsx, ok card from environment.tsx.
const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 48 },
  kicker: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.8, marginBottom: 8 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', lineHeight: 33, marginBottom: 8 },
  sub: { color: C.textDim, fontSize: 14, lineHeight: 20, marginBottom: 20 },
  card: { backgroundColor: C.bgCard, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, marginBottom: 12 },
  cardOn: { borderColor: C.accent },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  name: { color: C.text, fontSize: 17, fontWeight: '800' },
  okTag: { color: C.greenSoft, fontSize: 12, fontWeight: '700', marginTop: 2 },
  warn: { color: C.amber, fontSize: 12, lineHeight: 17, marginTop: 6 },
  reassure: { color: C.textFaint, fontSize: 12, lineHeight: 17, marginTop: 4 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  progressText: { color: C.textDim, fontSize: 12.5, flex: 1 },
  error: { color: C.red, fontSize: 12.5, lineHeight: 18, marginTop: 12 },
  keyForm: { backgroundColor: C.bgCard, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, marginBottom: 12 },
  label: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 6 },
  input: {
    backgroundColor: C.inputBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 48,
  },
  saveBtn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  saveOff: { opacity: 0.5 },
  saveBtnText: { color: C.onAccent, fontSize: 14.5, fontWeight: '800' },
  okCard: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: C.greenTint, borderRadius: 14, padding: 12, marginTop: 4 },
  okText: { color: C.textDim, fontSize: 12.5, lineHeight: 17, flex: 1 },
  btn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 20 },
  btnText: { color: C.onAccent, fontSize: 15.5, fontWeight: '800' },
  skip: { alignItems: 'center', paddingVertical: 16 },
  skipText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
})
