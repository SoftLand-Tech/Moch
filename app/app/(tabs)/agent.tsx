import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Switch, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Icon } from '../../src/components/Icon'
import { isConnected as isConnectedAtom, retryNow, rpc } from '../../src/lib/gateway'
import { activeSession, ensureSession, sessionsById } from '../../src/lib/chat'
import {
  liveModel, liveProvider, fetchModelOptions, liveReasoningDisplay, modelOptions,
  modelOptionsLoading, rankProviders, disconnectProvider, fetchReasoningPrefs,
  applyReasoning, fetchDefaultModel, saveProviderKey, REASONING_EFFORTS,
  type ProviderOption, type ReasoningEffort, type ReasoningScope, type ReasoningPrefs,
} from '../../src/lib/modelState'
import { log } from '../../src/lib/log'
import { C, useStyles } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'
import { ModelPickerSheet } from '../../src/components/ModelPickerSheet'
import { showAlert } from '../../src/components/AlertDialog'
import { ProviderKeyForm } from '../../src/components/ProviderKeyForm'

export default function Controls() {
  const s = useStyles(makeS)
  const online = useStore(isConnectedAtom)
  const sid = useStore(activeSession)
  const model = useStore(liveModel)
  const provider = useStore(liveProvider)
  const options = useStore(modelOptions)
  const optsLoading = useStore(modelOptionsLoading)
  const showReasoning = useStore(liveReasoningDisplay)

  const [effort, setEffort] = useState<string>('')
  const [prefs, setPrefs] = useState<ReasoningPrefs | null>(null)
  const [defaultModel, setDefaultModel] = useState<{ model: string; provider: string } | null>(null)
  /** Where an effort pick lands — 'global' persists it as the everywhere default. */
  const [effortScope, setEffortScope] = useState<ReasoningScope>('global')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Provider to land on when the picker opens ("Pick a model" from a row). */
  const [pickerSlug, setPickerSlug] = useState<string | null>(null)
  const [keyFor, setKeyFor] = useState<ProviderOption | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  /** Provider search — filters rows and forces the collapsed group open. */
  const [providerQuery, setProviderQuery] = useState('')
  /** "Not set up" starts collapsed — it can be dozens of rows. */
  const [unconfiguredOpen, setUnconfiguredOpen] = useState(false)

  const refresh = React.useCallback(async () => {
    if (!online) return
    // BUG-013: a provisional (unsent) chat has no server identity —
    // session-scoped reads skip rather than minting one; global defaults
    // show until a real chat exists.
    const liveSid = sid && !sessionsById.get()[sid]?.provisional ? sid : null
    // Both reasoning layers (saved default + this chat's effective value) and
    // the saved everywhere-default model, alongside the provider inventory —
    // this screen is the preferences home, so it reads everything it can edit.
    try { setPrefs(await fetchReasoningPrefs(liveSid)) } catch { /* prefs degrade to null */ }
    try { setDefaultModel(await fetchDefaultModel()) } catch { /* stays null */ }
    try {
      await fetchModelOptions(liveSid, { force: true })
    } catch (err) {
      log('warn', 'agent', `model.options failed: ${String(err)}`)
    }
  }, [online, sid])

  useEffect(() => {
    setLoading(true)
    void (async () => {
      try {
        // BUG-013: visiting this tab must not mint a server session for an
        // unsent chat — resolve the live id WITHOUT creating. Session-scoped
        // reads above skip until a real chat exists; explicit picks still
        // create on demand (ensureSession's default).
        await ensureSession({ create: false })
        await refresh()
      } catch {
        /* offline banner path */
      }
    })().finally(() => setLoading(false))
  }, [refresh])

  // Pills follow the session's effective value; `prefs.effective` is the same
  // read the gateway serves, so the two never disagree after a refresh.
  useEffect(() => {
    if (prefs?.effective) setEffort(prefs.effective)
  }, [prefs])

  const setAndSave = async (v: string) => {
    const prev = effort
    setEffort(v)
    setSaving(`effort:${v}`)
    try {
      const res = await applyReasoning({ value: v as ReasoningEffort, scope: effortScope, sessionId: sid })
      if (res.value !== v) setEffort(res.value)
      await refresh()
    } catch (e) {
      setEffort(prev)
      void showAlert('Failed to save', e instanceof Error ? e.message : '')
    } finally {
      setSaving(null)
    }
  }

  const toggleReasoning = async (next: boolean) => {
    // Optimistic: the chat screen renders from the same atom, so hiding
    // takes effect the moment the switch flips — no round-trip wait.
    const prev = liveReasoningDisplay.get()
    liveReasoningDisplay.set(next ? 'show' : 'hide')
    try {
      // `config.set reasoning show|hide` is the documented toggle verb; it
      // writes the server's display config, so it already applies everywhere.
      await rpc('config.set', { key: 'reasoning', value: next ? 'show' : 'hide', ...(sid ? { session_id: sid } : {}) })
    } catch (e) {
      liveReasoningDisplay.set(prev)
      void showAlert('Failed to save', e instanceof Error ? e.message : '')
    }
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  const providers = React.useMemo(() => rankProviders(options?.providers ?? []), [options])
  const connected = React.useMemo(() => providers.filter((p) => p.authenticated), [providers])
  const unconfigured = React.useMemo(() => providers.filter((p) => !p.authenticated), [providers])

  const pq = providerQuery.trim().toLowerCase()
  const matches = (p: ProviderOption) => !pq || p.name.toLowerCase().includes(pq) || p.slug.includes(pq)
  const shownConnected = React.useMemo(() => connected.filter(matches), [connected, pq])
  const shownUnconfigured = React.useMemo(() => unconfigured.filter(matches), [unconfigured, pq])
  // Searching implies browsing: keep the collapsed group forced open while typing.
  const unconfiguredVisible = unconfiguredOpen || !!pq

  /** Connect a provider from this screen; null = connected, string = why not. */
  const connectKey = async (apiKey: string): Promise<string | null> => {
    if (!keyFor) return 'No provider selected'
    setSavingKey(true)
    try {
      const freshSid = sid ?? (await ensureSession())
      await saveProviderKey(keyFor.slug, apiKey, freshSid)
      await fetchModelOptions(freshSid, { force: true })
      const slug = keyFor.slug
      setKeyFor(null)
      // Freshly connected → land straight on its models to pick one.
      setPickerSlug(slug)
      setPickerOpen(true)
      return null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', 'agent', `model.save_key failed: ${msg}`)
      return msg
    } finally {
      setSavingKey(false)
    }
  }

  const tapProvider = (p: ProviderOption) => {
    if (!p.authenticated) {
      // api_key providers connect right here; OAuth/etc must run on the host.
      if (p.auth_type === 'api_key') {
        setKeyFor(p)
      } else {
        // BUG-053: no dead CLI references — the npm `moch` package is
        // deprecated; sign-in flows live on the computer's agent settings.
        void showAlert(p.name, p.warning ?? 'This provider signs in another way (OAuth or a host tool) — set it up on the computer, in the agent\'s own settings screen.')
      }
      return
    }
    const count = p.total_models ?? p.models?.length ?? 0
    void showAlert(p.name, `Connected · ${count} model${count === 1 ? '' : 's'}`, [
      { text: 'Pick a model', onPress: () => { setPickerSlug(p.slug); setPickerOpen(true) } },
      { text: 'Disconnect', style: 'destructive', onPress: () => confirmDisconnect(p) },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const confirmDisconnect = (p: ProviderOption) => {
    void showAlert(
      `Disconnect ${p.name}?`,
      'Removes its saved key from the server. Your chats keep working on your other providers.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => { void doDisconnect(p) } },
      ],
    )
  }

  const doDisconnect = async (p: ProviderOption) => {
    setBusySlug(p.slug)
    try {
      await disconnectProvider(p.slug)
      await fetchModelOptions(sid, { force: true }).catch(() => {})
    } catch (e) {
      void showAlert('Disconnect failed', e instanceof Error ? e.message : String(e))
    } finally {
      setBusySlug(null)
    }
  }

  const openPickerFromCard = () => {
    setPickerSlug(null)
    setPickerOpen(true)
  }

  const body = !online ? (
    <View style={s.root}>
      <Text style={s.offline}>Not connected</Text>
      <Pressable style={({ pressed }) => [s.retry, pressed && s.pressed]} onPress={() => { void retryNow().catch(() => {}) }}>
        <Text style={s.retryText}>Reconnect</Text>
      </Pressable>
    </View>
  ) : (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 40 }}>
      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>MODEL</Text>
          {loading ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        <Pressable
          style={({ pressed }) => [s.modelCard, pressed && s.pressed]}
          onPress={openPickerFromCard}
          accessibilityLabel={`Current model ${model || 'default'}. Tap to change`}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.modelName} numberOfLines={1}>{model || 'default'}</Text>
            <Text style={s.modelSub}>
              {provider ? `${provider} · ` : ''}tap to pick a provider, model and scope
            </Text>
          </View>
          <View style={s.modelChevron}>
            <Icon name="options-outline" size={16} color={C.accent} />
            <Text style={s.modelChevronText}>CHANGE</Text>
          </View>
        </Pressable>
        {defaultModel?.model ? (
          <Text style={s.defaultLine} numberOfLines={1}>
            Saved everywhere: {defaultModel.model}
            {defaultModel.provider && defaultModel.provider !== 'unknown' ? ` · ${defaultModel.provider}` : ''}
          </Text>
        ) : null}
        <Text style={s.hint}>
          “This chat” switches the conversation now; “Everywhere” saves the new
          default on the server; “Next reply only” tries it for one turn.
        </Text>
      </View>

      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>PROVIDERS</Text>
          {optsLoading ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        <View style={s.searchWrap}>
          <Icon name="search" size={15} color={C.textFaint} />
          <TextInput
            style={s.search}
            value={providerQuery}
            onChangeText={setProviderQuery}
            placeholder="Search providers…"
            placeholderTextColor={C.textFaint}
            accessibilityLabel="Filter providers"
          />
          {providerQuery ? (
            <Pressable
              hitSlop={6}
              style={({ pressed }) => [s.clear, pressed && s.pressed]}
              onPress={() => setProviderQuery('')}
              accessibilityLabel="Clear provider search"
            >
              <Icon name="close-circle" size={15} color={C.textFaint} />
            </Pressable>
          ) : null}
        </View>
        {shownConnected.map((p) => (
          <React.Fragment key={p.slug}>
            <ProviderRow
              p={p}
              busy={busySlug === p.slug}
              currentModel={p.slug === provider ? model : ''}
              onPress={() => tapProvider(p)}
            />
            {keyFor?.slug === p.slug ? (
              <View style={{ marginBottom: 10 }}>
                <ProviderKeyForm provider={keyFor} busy={savingKey} onSave={connectKey} onCancel={() => setKeyFor(null)} />
              </View>
            ) : null}
          </React.Fragment>
        ))}
        {unconfigured.length && !pq ? (
          <Pressable
            style={({ pressed }) => [s.collapseCard, pressed && s.pressed]}
            onPress={() => setUnconfiguredOpen((v) => !v)}
            accessibilityLabel={unconfiguredOpen ? 'Hide providers not set up' : `Show ${unconfigured.length} providers not set up`}
          >
            <Text style={s.collapseTitle}>Not set up</Text>
            <Text style={s.collapseSub}>{unconfigured.length} available</Text>
            <Icon name={unconfiguredOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.textFaint} />
          </Pressable>
        ) : null}
        {unconfiguredVisible ? shownUnconfigured.map((p) => (
          <React.Fragment key={p.slug}>
            <ProviderRow p={p} busy={false} currentModel="" onPress={() => tapProvider(p)} />
            {keyFor?.slug === p.slug ? (
              <View style={{ marginBottom: 10 }}>
                <ProviderKeyForm provider={keyFor} busy={savingKey} onSave={connectKey} onCancel={() => setKeyFor(null)} />
              </View>
            ) : null}
          </React.Fragment>
        )) : null}
        {pq && !shownConnected.length && !shownUnconfigured.length ? (
          <Text style={s.empty}>No providers match “{providerQuery}”.</Text>
        ) : null}
        {!providers.length && !optsLoading ? (
          <Text style={s.empty}>No provider inventory yet — reconnect or reopen this screen.</Text>
        ) : null}
        <Text style={s.hint}>
          Tap a provider to connect it with an API key (stored on your server) or
          to disconnect one. OAuth providers are set up on the computer.
        </Text>
      </View>

      <View>
        <View style={s.sectionRow}>
          <Text style={s.section}>REASONING EFFORT</Text>
          {saving?.startsWith('effort:') ? <ActivityIndicator color={C.accent} size="small" /> : null}
        </View>
        {prefs ? (
          <Text style={s.defaultLine}>
            Default: {prefs.global || '—'}
            {prefs.effective && prefs.global && prefs.effective !== prefs.global ? ` · This chat: ${prefs.effective}` : ''}
          </Text>
        ) : null}
        <View style={s.scopeRow}>
          <Text style={s.scopeLabel}>SAVE AS</Text>
          {(['global', 'session'] as const).map((sc) => (
            <Pressable
              key={sc}
              style={({ pressed }) => [s.scopePill, effortScope === sc && s.scopePillOn, pressed && s.pressed]}
              onPress={() => setEffortScope(sc)}
              accessibilityLabel={sc === 'global' ? 'Save thinking everywhere' : 'Save thinking in this chat'}
              accessibilityState={{ selected: effortScope === sc }}
            >
              <Text style={[s.scopeText, effortScope === sc && s.scopeTextOn]}>
                {sc === 'global' ? 'Everywhere' : 'This chat'}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={s.effortRow}>
          {REASONING_EFFORTS.map((e) => (
            <Pressable
              key={e}
              style={({ pressed }) => [s.effortPill, effort === e && s.effortOn, pressed && s.pressed]}
              onPress={() => void setAndSave(e)}
              accessibilityLabel={`Reasoning effort ${e}`}
              accessibilityState={{ selected: effort === e }}
              hitSlop={4}
            >
              <Text style={[s.effortText, effort === e && s.effortTextOn]}>{e}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.hint}>
          {effortScope === 'global'
            ? 'Saved on the server — new chats and every device start on this level. “none” turns thinking off.'
            : 'Only this conversation; new chats keep the saved default. “none” turns thinking off.'}
        </Text>
      </View>

      <View>
        <Text style={s.section}>SHOW REASONING</Text>
        <View style={s.toggleRow}>
          <Text style={s.toggleLabel}>Show thinking in the chat</Text>
          <Switch
            value={showReasoning === 'show'}
            onValueChange={(v) => void toggleReasoning(v)}
            trackColor={{ true: C.accent, false: C.border }}
            accessibilityLabel="Show reasoning"
          />
        </View>
        <Text style={s.hint}>Saved on the server — applies to every chat.</Text>
      </View>
    </ScrollView>
  )

  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell title="Models" showBrand>
        {body}
      </ScreenShell>
      <ModelPickerSheet open={pickerOpen} initialSlug={pickerSlug} onClose={() => setPickerOpen(false)} />
    </SafeAreaView>
  )
}

function ProviderRow({
  p, onPress, currentModel, busy,
}: { p: ProviderOption; onPress: () => void; currentModel: string; busy: boolean }) {
  const s = useStyles(makeS)
  const count = p.total_models ?? p.models?.length ?? 0
  const status = p.authenticated
    ? `Connected · ${count} model${count === 1 ? '' : 's'}${currentModel ? ` · ${currentModel}` : ''}`
    : p.auth_type === 'api_key'
      ? 'Not connected · tap to add an API key'
      : 'Set up on the computer'
  return (
    <Pressable
      style={({ pressed }) => [s.providerCard, pressed && s.pressed]}
      onPress={onPress}
      accessibilityLabel={`Provider ${p.name}, ${status}`}
    >
      <View style={{ flex: 1 }}>
        <View style={s.providerTitleLine}>
          <Text style={s.providerName} numberOfLines={1}>{p.name}</Text>
          {p.is_current ? <Text style={s.badge}>ACTIVE</Text> : null}
        </View>
        <Text style={s.providerSub} numberOfLines={1}>{status}</Text>
      </View>
      {busy ? <ActivityIndicator size="small" color={C.accent} /> : <Icon name="chevron-forward" size={16} color={C.textFaint} />}
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  pressed: { opacity: 0.6 },
  offline: { color: C.textDim, textAlign: 'center', marginTop: 80, fontSize: 15 },
  retry: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, marginHorizontal: 40, marginTop: 16, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  retryText: { color: C.onAccent, fontWeight: '800' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginBottom: 10 },
  empty: { color: C.textFaint, fontSize: 13, padding: 8 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 10,
    backgroundColor: C.inputBg, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 40,
  },
  search: { flex: 1, color: C.text, fontSize: 14.5, paddingVertical: 9 },
  clear: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  collapseCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed',
    paddingHorizontal: 14, paddingVertical: 12, minHeight: 52, marginBottom: 8, marginTop: 2,
  },
  collapseTitle: { color: C.textDim, fontSize: 14, fontWeight: '700' },
  collapseSub: { color: C.textFaint, fontSize: 12, flex: 1 },
  modelCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 15, paddingVertical: 14, minHeight: 68,
  },
  modelName: { color: C.text, fontSize: 16, fontWeight: '700' },
  modelSub: { color: C.textFaint, fontSize: 12, marginTop: 3 },
  modelChevron: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  modelChevronText: { color: C.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  defaultLine: { color: C.textDim, fontSize: 12, marginTop: 8 },
  providerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 12, minHeight: 62, marginBottom: 8,
  },
  providerTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  providerName: { color: C.text, fontSize: 14.5, fontWeight: '600', flexShrink: 1 },
  providerSub: { color: C.textFaint, fontSize: 11.5, marginTop: 2 },
  badge: { color: C.accent, fontSize: 9.5, fontWeight: '800', letterSpacing: 1 },
  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  scopeLabel: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, marginRight: 2 },
  scopePill: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18,
    backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border,
  },
  scopePillOn: { backgroundColor: C.accent, borderColor: C.accent },
  scopeText: { color: C.textDim, fontSize: 12.5, fontWeight: '700' },
  scopeTextOn: { color: C.onAccent, fontWeight: '800' },
  effortRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  effortPill: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 22, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, minHeight: 44, justifyContent: 'center' },
  effortOn: { backgroundColor: C.accent, borderColor: C.accent },
  effortText: { color: C.textDim, fontSize: 13.5, fontWeight: '600' },
  effortTextOn: { color: C.onAccent, fontWeight: '800' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, minHeight: 56 },
  toggleLabel: { color: C.text, fontSize: 14.5, flex: 1 },
  hint: { color: C.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
})
