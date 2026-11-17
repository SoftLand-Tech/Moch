/**
 * Interactive model picker — provider → model → scope.
 *
 * Backed entirely by the gateway's picker contract: `model.options` for the
 * inventory, `config.set { key: 'model', value: "<model> --provider <slug>
 * <--scope>" }` to apply (see src/lib/modelState.ts), `model.save_key` for
 * providers the gateway knows but that have no key yet (ProviderKeyForm).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
// BUG-133: RN core's KeyboardAvoidingView with `behavior: undefined` on
// Android renders a passthrough View (zero avoidance), and inside a Modal the
// OS never resizes either — the keyboard rose straight over this sheet's
// filter input and the API-key form. RNKC's KAV as the Modal's full-screen
// root is the connectors-proven shape (exact lift, no frame math).
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
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
import { ensureSession, activeLiveId, activeStoredId, activeTitle, pushLocalMessage } from '../lib/chat'
import {
  ocModels, ocModelsOneShot, ocDefaultModel, ocSetModel, ocCreateSession, ocEnsureServer,
  OcError, describeOcError, type OcModel,
} from '../lib/opencodeClient'
import { invalidateOcSessionsCache } from '../lib/ocSessionsCache'
import { ocSessionFor, ocRememberSession } from '../lib/opencodeChat'
import { activeProjectIdAtom, projectsAtom } from '../lib/workspace'
import { pickProjectCwd } from '../lib/projectScope'
import { slashLabel } from '../lib/slash'
import { log } from '../lib/log'
import { C, useStyles } from '../lib/theme'

type Step = 'provider' | 'model' | 'scope'

export function ModelPickerSheet({
  open, onClose, initialSlug, ocMode = false, ocOneShot = false, ocSessionId = null, ocCurrent = null, onPicked,
}: {
  open: boolean
  onClose: () => void
  initialSlug?: string | null
  /**
   * OpenCode mode (OPENCODE-MODE): the inventory and the apply path go to
   * the OpenCode server (ocModels / ocSetModel), never the gateway's
   * model.* RPCs. The hermes path below is untouched.
   */
  ocMode?: boolean
  /**
   * One-shot flavor: no server exists, so the inventory is the `opencode
   * models` CLI and a pick is only recorded (applied per turn via `-m`).
   */
  ocOneShot?: boolean
  /** The chat's PERSISTENT id — resolved to an OC session via ocSessionFor. */
  ocSessionId?: string | null
  /**
   * The model THIS chat is on (its pick, else the default) — exactly what
   * the chat's chip shows, passed by the caller. Per-session switches never
   * touch GET /api/model/default, so the server default alone would check
   * the wrong row after a switch. Bare modelID (server-mode pick) or
   * `provider/model` (one-shot pick); null = fall back to the sheet's own
   * default fetch.
   */
  ocCurrent?: string | null
  /** Fired after a session-scoped pick lands — the chip keeps this model. */
  onPicked?: (modelID: string) => void
}) {
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
  // ── OpenCode mode state (ocMode only) ──
  const [ocList, setOcList] = useState<OcModel[] | null>(null)
  const [ocLoading, setOcLoading] = useState(false)
  const [ocErr, setOcErr] = useState('')
  const [ocDefault, setOcDefault] = useState<OcModel | null>(null)

  // OpenCode open-path: inventory + current default in one go. Loading and
  // errors render in-sheet with honest copy. One-shot has no server: the
  // inventory is the CLI and there is no default to fetch.
  useEffect(() => {
    if (!open || !ocMode) return
    setQuery('')
    setOcErr('')
    setOcList(null)
    setOcDefault(null)
    setOcLoading(true)
    void (async () => {
      try {
        if (ocOneShot) {
          const list = await ocModelsOneShot()
          setOcList(list ?? [])
        } else {
          // The server may be down on a fresh app open — the inventory
          // lives behind it. ensure is idempotent and cheap when healthy;
          // without this the picker showed an empty list until a message
          // had started the server.
          try { await ocEnsureServer() } catch {}
          const [list, def] = await Promise.all([ocModels(), ocDefaultModel()])
          setOcList(list ?? [])
          setOcDefault(def ?? null)
        }
      } catch (err) {
        setOcList([])
        // describeOcError: a 403 (quota/key) or 500 must never read as
        // "not running" — only a status-0 (network) error means that.
        setOcErr(
          err instanceof OcError
            ? describeOcError(err)
            : err instanceof Error
              ? err.message
              : 'Could not load models',
        )
        log('warn', 'opencode', `model list failed: ${String(err)}`)
      } finally {
        setOcLoading(false)
      }
    })()
  }, [open, ocMode, ocOneShot])

  // Fresh inventory each time the sheet opens (cheap; also re-layers the
  // session's live provider after resumes). Cached rows render instantly —
  // the spinner only gates a true first open. The session id is OPTIONAL
  // (#65/BUG-117): activeLiveId() resolves a real live id when one exists
  // (never a pending/temp key), and a dead provisional window or a
  // Settings-open with no chat resolves to null — the gateway serves the
  // global inventory — instead of throwing "New chat is not ready" into the
  // banner. The apply/save paths ensure a session where one is required.
  // initialSlug (Providers section → "pick a model") skips the provider
  // list and lands directly on that provider's models when it's usable.
  useEffect(() => {
    if (!open || ocMode) return // OpenCode mode has its own open-path above
    setStep('provider')
    setProvider(null)
    setModel('')
    setQuery('')
    setKeyFor(null)
    setLoadError('')
    void (async () => {
      try {
        // #65 / BUG-117: never gate the refresh on a live chat — a dead
        // provisional window made activeLiveId() throw ("New chat is not
        // ready") and the sheet opened with an internal-error banner.
        // session_id is optional in model.options; null = global inventory.
        const sid = await activeLiveId().catch(() => null)
        const fresh = await fetchModelOptions(sid, { force: true })
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
  }, [open, initialSlug, ocMode])

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

  // ── OpenCode mode: provider-grouped inventory + apply path ────────────────
  const ocGroups = useMemo(() => {
    const list = ocList ?? []
    const matchOc = (m: OcModel) =>
      !q ||
      m.modelID.toLowerCase().includes(q) ||
      m.providerID.toLowerCase().includes(q) ||
      (m.name ?? '').toLowerCase().includes(q)
    const order: string[] = []
    const byProvider = new Map<string, OcModel[]>()
    for (const m of list) {
      if (!matchOc(m)) continue
      const arr = byProvider.get(m.providerID)
      if (arr) arr.push(m)
      else {
        byProvider.set(m.providerID, [m])
        order.push(m.providerID)
      }
    }
    return order.map((p) => ({ provider: p, models: byProvider.get(p) ?? [] }))
  }, [ocList, q])

  /** Apply a model to this chat's OpenCode session, minting the session on
   * demand — a pick in a brand-new chat is a "first real action" (same
   * contract as the hermes apply path's ensureSession below). One-shot has
   * no session to apply to — the pick is recorded as `provider/model`
   * (SAFE_MODEL_RE in opencodeChat requires the slash; a bare modelID was
   * silently dropped from `-m` and the pick never applied). */
  const pickOcModel = async (m: OcModel) => {
    if (applying) return
    setApplying(true)
    setOcErr('')
    try {
      if (ocOneShot) {
        onPicked?.(`${m.providerID}/${m.modelID}`)
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        setOcDefault(m)
        onClose()
        return
      }
      let mapKey = ocSessionId
      let ocId = mapKey ? await ocSessionFor(mapKey) : null
      if (!ocId) {
        // No OC session yet (new chat, or server mode enabled after the fact):
        // mint one instead of bouncing the pick. A PROVISIONAL new-chat window
        // must re-key first — its pseudo `new:` storedId is never the mapKey
        // the first turn uses (sendPrompt resolves the real chat before
        // runOpencodeTurn), so remembering under it would orphan the pick on
        // an OC session no message ever lands in.
        await ensureSession()
        mapKey = activeStoredId.get() || mapKey
        if (!mapKey) throw new Error('This chat is not ready — try again in a moment')
        // The placeholder 'New chat' would name the OC session forever
        // (chat.ts skips it when titling the first send for the same reason).
        const t = activeTitle.get()
        // BUG-149: file the minted session under the selected project (same
        // resolution rule as createSession / the turn mint in opencodeChat).
        const projectCwd = pickProjectCwd(
          projectsAtom.get().map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
          activeProjectIdAtom.get(),
        )
        const created = await ocCreateSession(
          t && t !== 'New chat' ? t.slice(0, 80) : 'Moch chat',
          projectCwd,
        )
        if (!created?.id) throw new Error('OpenCode did not return a session id')
        await ocRememberSession(mapKey, created.id)
        // The drawer's oc list caches for 15s — a minted session must be
        // visible immediately (runOcSubmit invalidates for the same reason).
        invalidateOcSessionsCache()
        ocId = created.id
      }
      await ocSetModel(ocId, m.providerID, m.id)
      onPicked?.(m.modelID)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setOcDefault(m)
      onClose()
    } catch (err) {
      setOcErr(err instanceof OcError ? describeOcError(err) : err instanceof Error ? err.message : 'Model switch failed')
      log('warn', 'opencode', `model switch failed: ${String(err)}`)
    } finally {
      setApplying(false)
    }
  }

  // ── OpenCode mode: which row is "current"? ────────────────────────────────
  // The chat's own current model (ocCurrent — what its chip shows) wins;
  // the server default below only covers chats that never picked. Picks
  // are stored in TWO formats — server mode keeps the BARE modelID,
  // one-shot keeps `provider/model`. But modelIDs THEMSELVES may contain
  // slashes (OpenRouter-style `anthropic/claude-…`), so full-string matches
  // are tried FIRST; the provider/model split is only a fallback for picks
  // that genuinely carry a provider prefix. A bare pick matching more than
  // one provider's row is constrained to the server default's provider
  // when known (exactly one row checks, like the pre-ocCurrent behavior).
  const ocCur = ocCurrent ?? (ocDefault ? `${ocDefault.providerID}/${ocDefault.modelID}` : null)
  const ocCurBare = ocCur ? ocCur.slice(ocCur.indexOf('/') + 1) : ''
  // Provider for the "Now:" line: from the pick when it carries one, else
  // looked up in the inventory (bare picks don't record it).
  const ocCurProvider = !ocCur
    ? ''
    : ocCur.includes('/')
      ? ocCur.slice(0, ocCur.indexOf('/'))
      : ocList?.find((m) => m.modelID === ocCur)?.providerID
        ?? (ocDefault?.modelID === ocCur ? ocDefault.providerID : '')
        ?? ''
  const ocIsCurrent = (m: OcModel): boolean => {
    if (!ocCur) return false
    // Full-string matches first — handles slashed modelIDs verbatim.
    if (m.modelID === ocCur || m.id === ocCur || `${m.providerID}/${m.modelID}` === ocCur) return true
    // Prefixed pick (`provider/model`, one-shot format): bare part must
    // match AND the provider must agree.
    if (ocCur.includes('/') && ocCur.startsWith(`${m.providerID}/`)) return ocCurBare === m.modelID
    // Bare pick: match the modelID, and when the default's provider is
    // known and carries the same modelID, only that provider's row checks.
    if (m.modelID === ocCur) {
      if (ocDefault && !ocCur.includes('/') && ocDefault.modelID === ocCur) return m.providerID === ocDefault.providerID
      return true
    }
    return false
  }

  const headerTitle = ocMode
    ? 'Model'
    : step === 'provider' ? 'Model' : step === 'model' ? (provider?.name ?? 'Models') : model
  const headerSub = ocMode
    ? (ocCur
      // Show the MATCHED row's modelID when one matches (exact for slashed
      // ids), else the split fallback.
      ? `Now: ${ocList?.find(ocIsCurrent)?.modelID ?? ocCurBare}${ocCurProvider ? ` · ${ocCurProvider}` : ''}`
      : 'OpenCode models')
    : (curModel ? `Now: ${curModel}${curProvider ? ` · ${curProvider}` : ''}` : 'Tap a provider, then a model')

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

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.flex} behavior="padding">
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
                {headerSub}
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

          {!ocMode && loadError ? (
            <Text style={s.loadWarning}>
              Couldn't refresh the model inventory ({loadError}). Showing the last known list.
            </Text>
          ) : null}

          {/* Search (provider + model steps) */}
          {ocMode || (step !== 'scope' && !keyFor) ? (
            <View style={s.searchWrap}>
              <Icon name="search" size={15} color={C.textFaint} />
              <TextInput
                style={s.search}
                value={query}
                onChangeText={setQuery}
                placeholder={ocMode ? 'Filter models…' : step === 'provider' ? 'Filter providers…' : 'Filter models…'}
                placeholderTextColor={C.textFaint}
                accessibilityLabel={step === 'provider' && !ocMode ? 'Filter providers' : 'Filter models'}
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

          {ocMode ? (
            // ── OpenCode mode: provider-grouped model list, one tap applies ──
            ocLoading ? (
              <View style={s.center}><ActivityIndicator color={C.accent} /></View>
            ) : (
              <>
                {ocErr ? <Text style={s.loadWarning}>{ocErr}</Text> : null}
                <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
                  {ocGroups.map((g) => (
                    <View key={g.provider}>
                      <Text style={s.sectionLabel}>{g.provider}</Text>
                      {g.models.map((m) => (
                        <OcModelRow
                          key={`${m.providerID}/${m.modelID}`}
                          m={m}
                          isCurrent={ocIsCurrent(m)}
                          disabled={applying}
                          onPress={() => { void pickOcModel(m) }}
                        />
                      ))}
                    </View>
                  ))}
                  {!ocGroups.length ? <Text style={s.empty}>No models match “{query}”.</Text> : null}
                  <View style={{ height: 24 }} />
                </ScrollView>
                {applying ? (
                  <View style={s.applying}>
                    <ActivityIndicator size="small" color={C.accent} />
                    <Text style={s.applyingText}>Switching…</Text>
                  </View>
                ) : null}
              </>
            )
          ) : loading && !options ? (
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
}: { m: string; p: ProviderOption; isCurrent: boolean; disabled: boolean; onPress: () => void }) {  const s = useStyles(makeS)
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

/** One OpenCode model row — same visual language as ModelRow, OC data. */
function OcModelRow({
  m, isCurrent, disabled, onPress,
}: { m: OcModel; isCurrent: boolean; disabled: boolean; onPress: () => void }) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.rowPressed, disabled && s.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Model ${m.modelID}${isCurrent ? ', current' : ''}`}
    >
      <View style={{ flex: 1 }}>
        <View style={s.rowTitleLine}>
          <Text style={[s.rowTitle, isCurrent && { color: C.accent }]} numberOfLines={1}>{m.modelID}</Text>
        </View>
        {m.name && m.name !== m.modelID ? (
          <Text style={s.rowSub} numberOfLines={1}>{m.name}</Text>
        ) : null}
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
