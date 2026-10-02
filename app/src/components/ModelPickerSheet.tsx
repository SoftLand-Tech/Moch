/**
 * Interactive model picker — provider → model → scope.
 *
 * Backed entirely by the gateway's picker contract: `model.options` for the
 * inventory, `config.set { key: 'model', value: "<model> --provider <slug>
 * <--scope>" }` to apply (see src/lib/modelState.ts), `model.save_key` for
 * providers the gateway knows but that have no key yet (ProviderKeyForm).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { ProviderKeyForm } from './ProviderKeyForm'
import { showAlert } from './AlertDialog'
import * as Haptics from 'expo-haptics'
import { useStore } from '@nanostores/react'
import {
  fetchModelOptions, rankProviders, rankModels, applyModel, saveProviderKey,
  liveModel, liveProvider, modelOptions, modelOptionsLoading,
  type ProviderOption, type ModelScope,
} from '../lib/modelState'
import { ensureSession, activeLiveId, pushLocalMessage } from '../lib/chat'
import { slashLabel } from '../lib/slash'
import { log } from '../lib/log'
import { C, useStyles } from '../lib/theme'

type Step = 'provider' | 'model' | 'scope'

export function ModelPickerSheet({
  open, onClose, initialSlug,
}: { open: boolean; onClose: () => void; initialSlug?: string | null }) {
  const s = useStyles(makeS)
  const options = useStore(modelOptions)
  const loading = useStore(modelOptionsLoading)
  const curModel = useStore(liveModel)
  const curProvider = useStore(liveProvider)

  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<ProviderOption | null>(null)
  const [query, setQuery] = useState('')
  const [model, setModel] = useState('')
  const [applying, setApplying] = useState(false)
  const [keyFor, setKeyFor] = useState<ProviderOption | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  /** Set when the open-path refresh fails — surfaced in the sheet, not just the log. */
  const [loadError, setLoadError] = useState('')
  const seq = useRef(0)

  // Fresh inventory each time the sheet opens (cheap; also re-layers the
  // session's live provider after resumes). Cached rows render instantly —
  // the spinner only gates a true first open — and the session id comes
  // from activeLiveId(): a plain store read in the steady state (no boot
  // RPC on the open path), while optimistic new-chat/switch windows resolve
  // to a REAL live id so a pending/temp key is never sent as session_id.
  // The apply/save paths ensure a session where one is actually required.
  // initialSlug (Providers section → "pick a model") skips the provider
  // list and lands directly on that provider's models when it's usable.
  useEffect(() => {
    if (!open) return
    setStep('provider')
    setProvider(null)
    setModel('')
    setQuery('')
    setKeyFor(null)
    setLoadError('')
    void (async () => {
      try {
        const fresh = await fetchModelOptions(await activeLiveId(), { force: true })
        const preset = initialSlug ? fresh.providers.find((p) => p.slug === initialSlug) : null
        if (preset?.authenticated) {
          setProvider(preset)
          setQuery('')
          setStep('model')
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Could not load models')
        log('warn', 'model', `model.options failed: ${String(err)}`)
      }
    })()
  }, [open, initialSlug])

  const providers = useMemo(() => rankProviders(options?.providers ?? []), [options])
  const configured = useMemo(() => providers.filter((p) => p.authenticated), [providers])
  const unconfigured = useMemo(() => providers.filter((p) => !p.authenticated), [providers])

  const q = query.trim().toLowerCase()
  const match = (text: string) => !q || text.toLowerCase().includes(q)

  const shownProviders = useMemo(
    () => configured.filter((p) => match(p.name) || match(p.slug)),
    [configured, q],
  )
  const shownUnconfigured = useMemo(
    () => unconfigured.filter((p) => match(p.name) || match(p.slug)),
    [unconfigured, q],
  )
  const shownModels = useMemo(() => {
    if (!provider) return []
    return rankModels(provider).filter((m) => match(m))
  }, [provider, q])

  const pickProvider = (p: ProviderOption) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    if (!p.authenticated) {
      setKeyFor(p)
      return
    }
    setKeyFor(null)
    setProvider(p)
    setQuery('')
    setStep('model')
  }

  const pickModel = (m: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setModel(m)
    setStep('scope')
  }

  /** Connect a provider from the picker; null = connected, string = why not. */
  const saveKey = async (apiKey: string): Promise<string | null> => {
    if (!keyFor) return 'No provider selected'
    setSavingKey(true)
    try {
      const sid = await ensureSession()
      await saveProviderKey(keyFor.slug, apiKey, sid)
      const fresh = await fetchModelOptions(sid, { force: true })
      const now = fresh.providers.find((p) => p.slug === keyFor.slug)
      if (now?.authenticated) {
        setKeyFor(null)
        setProvider(now)
        setQuery('')
        setStep('model')
      } else {
        setKeyFor(null)
      }
      return null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', 'model', `model.save_key failed: ${msg}`)
      return msg
    } finally {
      setSavingKey(false)
    }
  }

  const apply = async (scope: ModelScope) => {
    if (!provider || !model || applying) return
    setApplying(true)
    try {
      const sid = await ensureSession()
      let res = await applyModel({ sessionId: sid, model, provider: provider.slug, scope })
      if ('needsConfirm' in res) {
        // Guarded switch (expensive model / catalog warning). The gateway
        // wrote nothing yet — ask, then retry with the confirm flag.
        setApplying(false)
        const confirmMessage: string = res.message
        const pick = await showAlert('Confirm switch', confirmMessage, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Use it', style: 'default' },
        ])
        if (pick.text !== 'Use it') return
        setApplying(true)
        res = await applyModel({ sessionId: sid, model, provider: provider.slug, scope, confirmed: true })
      }
      if ('model' in res) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        const where = res.scope === 'global'
          ? 'everywhere (new default)'
          : res.scope === 'once'
            ? 'next reply only'
            : 'this chat'
        const lines = [`Model switched to ${res.model} (${provider.name}) — ${where}.`]
        if (res.deferred) lines.push('The agent is mid-turn, so it lands on the next turn.')
        if (res.warning) lines.push(res.warning)
        pushLocalMessage(lines.join('\n'), 'assistant', { name: slashLabel('model'), variant: 'success' })
        onClose()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', 'model', `switch failed: ${msg}`)
      pushLocalMessage(`Model switch failed — ${msg.replace(/^config\.set:\s*/, '')}`, 'assistant', { name: slashLabel('model'), variant: 'error' })
    } finally {
      setApplying(false)
    }
  }

  const headerTitle = step === 'provider' ? 'Model' : step === 'model' ? (provider?.name ?? 'Models') : model

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={onClose} accessibilityLabel="Close model picker" />
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.head}>
            {step !== 'provider' ? (
              <Pressable
                style={({ pressed }) => [s.back, pressed && s.iconPressed]}
                hitSlop={8}
                onPress={() => (step === 'scope' ? setStep('model') : setStep('provider'))}
                accessibilityLabel="Back"
              >
                <Icon name="chevron-back" size={20} color={C.textDim} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={s.headTitle} numberOfLines={1}>{headerTitle}</Text>
              <Text style={s.headSub} numberOfLines={1}>
                {curModel ? `Now: ${curModel}${curProvider ? ` · ${curProvider}` : ''}` : 'Tap a provider, then a model'}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [s.close, pressed && s.iconPressed]}
              hitSlop={8}
              onPress={onClose}
              accessibilityLabel="Close"
            >
              <Icon name="close" size={20} color={C.textDim} />
            </Pressable>
          </View>

          {loadError ? (
            <Text style={s.loadWarning}>
              Couldn't refresh the model inventory ({loadError}). Showing the last known list.
            </Text>
          ) : null}

          {/* Search (provider + model steps) */}
          {step !== 'scope' && !keyFor ? (
            <View style={s.searchWrap}>
              <Icon name="search" size={15} color={C.textFaint} />
              <TextInput
                style={s.search}
                value={query}
                onChangeText={setQuery}
                placeholder={step === 'provider' ? 'Filter providers…' : 'Filter models…'}
                placeholderTextColor={C.textFaint}
                accessibilityLabel={step === 'provider' ? 'Filter providers' : 'Filter models'}
              />
              {query ? (
                <Pressable
                  hitSlop={6}
                  style={({ pressed }) => [s.clear, pressed && s.iconPressed]}
                  onPress={() => setQuery('')}
                  accessibilityLabel="Clear filter"
                >
                  <Icon name="close-circle" size={15} color={C.textFaint} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {loading && !options ? (
            <View style={s.center}><ActivityIndicator color={C.accent} /></View>
          ) : step === 'provider' ? (
            <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
              {shownProviders.map((p) => <ProviderRow key={p.slug} p={p} onPress={() => pickProvider(p)} currentModel={p.slug === curProvider ? curModel : ''} />)}
              {shownUnconfigured.length ? (
                <Text style={s.sectionLabel}>Not set up</Text>
              ) : null}
              {shownUnconfigured.map((p) => <ProviderRow key={p.slug} p={p} onPress={() => pickProvider(p)} currentModel="" />)}
              {!shownProviders.length && !shownUnconfigured.length && !loading ? (
                <Text style={s.empty}>No providers match “{query}”.</Text>
              ) : null}
              <View style={{ height: 24 }} />
            </ScrollView>
          ) : step === 'model' && provider ? (
            <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
              {provider.warning ? <Text style={s.providerWarning}>{provider.warning}</Text> : null}
              {shownModels.map((m) => (
                <ModelRow
                  key={m}
                  m={m}
                  p={provider}
                  isCurrent={provider.slug === curProvider && m === curModel}
                  disabled={(provider.unavailable_models ?? []).includes(m)}
                  onPress={() => pickModel(m)}
                />
              ))}
              {!shownModels.length ? <Text style={s.empty}>No models match “{query}”.</Text> : null}
              <View style={{ height: 24 }} />
            </ScrollView>
          ) : keyFor ? (
            <View style={{ paddingBottom: 8 }}>
              <ProviderKeyForm provider={keyFor} busy={savingKey} onSave={saveKey} onCancel={() => setKeyFor(null)} />
            </View>
          ) : null}

          {/* Scope step — the whole reason this sheet exists */}
          {step === 'scope' && provider ? (
            <View style={s.scopeWrap}>
              <Text style={s.scopeLead}>Use <Text style={s.scopeModel}>{model}</Text> …</Text>
              <ScopeCard
                icon="chatbubble-ellipses-outline"
                title="In this chat"
                sub="Switches this conversation now. Everything else keeps the current default."
                disabled={applying}
                onPress={() => { void apply('session') }}
              />
              <ScopeCard
                icon="globe-outline"
                title="Everywhere (new default)"
                sub="Persists on the server: new chats and other apps start on this model."
                disabled={applying}
                onPress={() => { void apply('global') }}
              />
              <ScopeCard
                icon="arrow-forward-outline"
                title="Next reply only"
                sub="One turn with this model, then right back to the current one."
                disabled={applying}
                onPress={() => { void apply('once') }}
              />
              {applying ? (
                <View style={s.applying}>
                  <ActivityIndicator size="small" color={C.accent} />
                  <Text style={s.applyingText}>Switching…</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function ProviderRow({ p, onPress, currentModel }: { p: ProviderOption; onPress: () => void; currentModel: string }) {
  const s = useStyles(makeS)
  const count = p.total_models ?? p.models?.length ?? 0
  return (
    <Pressable style={({ pressed }) => [s.row, pressed && s.rowPressed]} onPress={onPress} accessibilityLabel={`Provider ${p.name}`}>
      <View style={{ flex: 1 }}>
        <View style={s.rowTitleLine}>
          <Text style={s.rowTitle} numberOfLines={1}>{p.name}</Text>
          {p.is_current ? <Text style={s.badge}>ACTIVE</Text> : null}
        </View>
        <Text style={s.rowSub} numberOfLines={1}>
          {count ? `${count} model${count === 1 ? '' : 's'}` : 'no catalog'}
          {currentModel ? ` · ${currentModel}` : ''}
          {p.free_tier ? ' · free tier' : ''}
        </Text>
      </View>
      <Icon name="chevron-forward" size={16} color={C.textFaint} />
    </Pressable>
  )
}

function ModelRow({
  m, p, isCurrent, disabled, onPress,
}: { m: string; p: ProviderOption; isCurrent: boolean; disabled: boolean; onPress: () => void }) {
  const s = useStyles(makeS)
  const cap = p.capabilities?.[m]
  const price = p.pricing?.[m]
  const priceText = price
    ? price.free
      ? 'free'
      : price.input || price.output
        ? `${
            price.input ? `in ${price.input}` : ''
          }${price.input && price.output ? ' · ' : ''}${price.output ? `out ${price.output}` : ''}`
        : ''
    : ''
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.rowPressed, disabled && s.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={`Model ${m}${isCurrent ? ', current' : ''}`}
    >
      <View style={{ flex: 1 }}>
        <View style={s.rowTitleLine}>
          <Text style={[s.rowTitle, isCurrent && { color: C.accent }]} numberOfLines={1}>{m}</Text>
          {cap?.fast ? <Text style={s.chip}>⚡ fast</Text> : null}
          {cap?.reasoning ? <Text style={s.chip}>🧠 reasoning</Text> : null}
        </View>
        <Text style={s.rowSub} numberOfLines={1}>
          {[priceText, disabled ? 'currently unavailable' : ''].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {isCurrent ? <Icon name="checkmark" size={17} color={C.accent} /> : null}
    </Pressable>
  )
}

function ScopeCard({
  icon, title, sub, onPress, disabled,
}: { icon: keyof typeof Ionicons.glyphMap; title: string; sub: string; onPress: () => void; disabled?: boolean }) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.scopeCard, pressed && s.rowPressed, disabled && s.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={title}
    >
      <Icon name={icon} size={18} color={C.accent} />
      <View style={{ flex: 1 }}>
        <Text style={s.scopeTitle}>{title}</Text>
        <Text style={s.scopeSub}>{sub}</Text>
      </View>
      <Icon name="arrow-forward" size={15} color={C.textFaint} />
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  scrim: { backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '82%',
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8 },
  headTitle: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  headSub: { color: C.textFaint, fontSize: 12, marginTop: 1 },
  back: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  clear: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { opacity: 0.55 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 14, marginBottom: 6,
    backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 40,
  },
  search: { flex: 1, color: C.text, fontSize: 14.5, paddingVertical: 9 },
  list: { paddingHorizontal: 6 },
  center: { padding: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 11, borderRadius: 12, minHeight: 52,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowDisabled: { opacity: 0.4 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowTitle: { color: C.text, fontSize: 14.5, fontWeight: '600', flexShrink: 1 },
  rowSub: { color: C.textFaint, fontSize: 11.5, marginTop: 2 },
  badge: { color: C.accent, fontSize: 9.5, fontWeight: '800', letterSpacing: 1 },
  chip: { color: C.textDim, fontSize: 10.5, backgroundColor: C.bgCard, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 },
  sectionLabel: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4 },
  providerWarning: { color: C.amber, fontSize: 11.5, lineHeight: 16, paddingHorizontal: 12, paddingBottom: 6 },
  loadWarning: { color: C.amber, fontSize: 11.5, lineHeight: 16, paddingHorizontal: 14, paddingBottom: 6 },
  empty: { color: C.textFaint, fontSize: 13, textAlign: 'center', padding: 24 },
  scopeWrap: { paddingHorizontal: 14, paddingBottom: 6, gap: 8 },
  scopeLead: { color: C.textDim, fontSize: 13, marginBottom: 2 },
  scopeModel: { color: C.text, fontWeight: '700' },
  scopeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.bgCard, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 13, paddingVertical: 12, minHeight: 64,
  },
  scopeTitle: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  scopeSub: { color: C.textFaint, fontSize: 11.5, marginTop: 2, lineHeight: 15.5 },
  applying: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  applyingText: { color: C.textDim, fontSize: 12.5 },
})
