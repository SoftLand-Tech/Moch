import React, { useEffect, useState } from 'react'
import { View, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
// BUG-133: the provider search + inline API-key form had no avoidance (form
// and everything below sat under the IME), and the missing
// keyboardShouldPersistTaps ate the first tap on provider rows while the
// keyboard was open (BUG-027 class). KeyboardAwareScrollView keeps the list
// above the keys, scrolls the focused field in, and delivers taps.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useStore } from '@nanostores/react'
import { Icon } from '../../src/components/Icon'
import { isConnected as isConnectedAtom, retryNow, rpc } from '../../src/lib/gateway'
import { activeSession, ensureSession, sessionsById } from '../../src/lib/chat'
import {
  liveModel, liveProvider, fetchModelOptions, liveReasoningDisplay, modelOptions,
  modelOptionsLoading, rankProviders, disconnectProvider, fetchReasoningPrefs,
  applyReasoning, fetchDefaultModel, saveProviderKey, liveWriteSid, REASONING_EFFORTS,
  type ProviderOption, type ReasoningEffort, type ReasoningScope, type ReasoningPrefs,
} from '../../src/lib/modelState'
import { log } from '../../src/lib/log'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import { ScreenShell } from '../../src/components/ScreenShell'
import { ModelPickerSheet } from '../../src/components/ModelPickerSheet'
import { showAlert } from '../../src/components/AlertDialog'
import { ProviderKeyForm } from '../../src/components/ProviderKeyForm'
import { Card, Divider, Field, Kicker, Pill, PrimaryBtn, Spinner, Toggle, Txt } from '../../src/components/ui'

/** Reasoning levels render four per row (mockup grid), labels localized. */
const EFFORT_LABEL_KEYS: Record<string, string> = {
  none: 'agent.effort.none',
  minimal: 'agent.effort.minimal',
  low: 'agent.effort.low',
  medium: 'agent.effort.medium',
  high: 'agent.effort.high',
  xhigh: 'agent.effort.xhigh',
  max: 'agent.effort.max',
  ultra: 'agent.effort.ultra',
}

export default function Controls() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
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

  const effortLabel = (value: string) => (EFFORT_LABEL_KEYS[value] ? t(EFFORT_LABEL_KEYS[value]) : value)

  const refresh = React.useCallback(async () => {
    if (!online) return
    // BUG-013: a provisional (unsent) chat has no server identity —
    // session-scoped reads skip rather than minting one; global defaults
    // show until a real chat exists. (BH-000088: liveWriteSid is the same
    // rule the WRITE paths below use — one shared predicate.)
    const liveSid = liveWriteSid(sid, sid ? sessionsById.get()[sid] : undefined)
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
      // BH-000088: the raw `sid` is the window's `pending:new:…` key while a
      // new chat is unsent — the gateway holds no such session, its setters
      // treat a sessionless scoped write as GLOBAL (the pick silently
      // rewrites the profile-wide default, and a hardened server 4001s), so
      // it must never reach the wire. Global picks need no session; a
      // session-scoped pick CREATES the chat on demand (the BUG-013
      // comment's promise), and a failed create blocks the pick with a hint
      // instead of confirming a write that never landed where it claims.
      let target = liveWriteSid(sid, sid ? sessionsById.get()[sid] : undefined)
      if (!target && effortScope === 'session') {
        try {
          target = await ensureSession()
        } catch {
          throw new Error(t('agent.alert.chatNotReady'))
        }
      }
      const res = await applyReasoning({ value: v as ReasoningEffort, scope: effortScope, sessionId: target ?? undefined })
      if (res.value !== v) setEffort(res.value)
      await refresh()
    } catch (e) {
      setEffort(prev)
      void showAlert(t('agent.alert.saveFailed'), e instanceof Error ? e.message : '')
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
      // BH-000088: still never send a provisional window's raw id — the
      // session pin is simply omitted until the chat is real.
      const liveSid = liveWriteSid(sid, sid ? sessionsById.get()[sid] : undefined)
      await rpc('config.set', { key: 'reasoning', value: next ? 'show' : 'hide', ...(liveSid ? { session_id: liveSid } : {}) })
    } catch (e) {
      liveReasoningDisplay.set(prev)
      void showAlert(t('agent.alert.saveFailed'), e instanceof Error ? e.message : '')
    }
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  const providers = React.useMemo(() => rankProviders(options?.providers ?? []), [options])
  const connected = React.useMemo(() => providers.filter((p) => p.authenticated), [providers])
  const unconfigured = React.useMemo(() => providers.filter((p) => !p.authenticated), [providers])

  const pq = providerQuery.trim().toLowerCase()
  const shownConnected = React.useMemo(
    () => connected.filter((p) => !pq || p.name.toLowerCase().includes(pq) || p.slug.includes(pq)),
    [connected, pq],
  )
  const shownUnconfigured = React.useMemo(
    () => unconfigured.filter((p) => !pq || p.name.toLowerCase().includes(pq) || p.slug.includes(pq)),
    [unconfigured, pq],
  )
  // Searching implies browsing: keep the collapsed group forced open while typing.
  const unconfiguredVisible = unconfiguredOpen || !!pq

  /** Connect a provider from this screen; null = connected, string = why not. */
  const connectKey = async (apiKey: string): Promise<string | null> => {
    if (!keyFor) return t('agent.noProvider')
    setSavingKey(true)
    try {
      // BH-000088: same rule as every write here — a provisional window's
      // id is not a wire-able session id; create the chat if needed.
      const freshSid = liveWriteSid(sid, sid ? sessionsById.get()[sid] : undefined) ?? (await ensureSession())
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

  const openPickerFor = (slug: string | null) => {
    setPickerSlug(slug)
    setPickerOpen(true)
  }

  const tapProvider = (p: ProviderOption) => {
    if (!p.authenticated) {
      // API-key providers connect inline; OAuth/CLI logins run in the built-in Terminal.
      if (p.auth_type === 'api_key') {
        setKeyFor(p)
      } else {
        // BUG-053: provider-supplied setup guidance wins; the fallback points
        // to the built-in Terminal rather than the removed pairing flow.
        void showAlert(p.name, p.warning ?? t('agent.providers.oauthHint'))
      }
      return
    }
    // Connected rows open their model list directly (mockup's "Pick a model").
    openPickerFor(p.slug)
  }

  const confirmDisconnect = (p: ProviderOption) => {
    void showAlert(
      t('agent.alert.disconnectTitle', { name: p.name }),
      t('agent.alert.disconnectBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('agent.alert.disconnectCta'), style: 'destructive', onPress: () => { void doDisconnect(p) } },
      ],
    )
  }

  const doDisconnect = async (p: ProviderOption) => {
    setBusySlug(p.slug)
    try {
      await disconnectProvider(p.slug)
      await fetchModelOptions(liveWriteSid(sid, sid ? sessionsById.get()[sid] : undefined) ?? undefined, { force: true }).catch(() => {})
    } catch (e) {
      void showAlert(t('agent.alert.disconnectFailed'), e instanceof Error ? e.message : String(e))
    } finally {
      setBusySlug(null)
    }
  }

  const openPickerFromCard = () => openPickerFor(null)

  // "Provider · scope" line under the mono model id. The saved-everywhere
  // default comes from config.yaml; a live model that differs is a
  // session/once-scoped pick.
  const providerLabel = provider
    ? (options?.providers.find((p) => p.slug === provider)?.name ?? provider)
    : ''
  const scopeLabel = model
    ? defaultModel?.model
      ? (defaultModel.model === model ? t('agent.model.savedEverywhere') : t('agent.model.thisChat'))
      : ''
    : t('agent.model.tapChange')
  const modelSub = [providerLabel, scopeLabel].filter(Boolean).join(' · ')

  const effortRows = React.useMemo(() => {
    const rows: ReasoningEffort[][] = []
    for (let i = 0; i < REASONING_EFFORTS.length; i += 4) rows.push(REASONING_EFFORTS.slice(i, i + 4))
    return rows
  }, [])

  const renderUnconfiguredRow = (p: ProviderOption) => {
    const open = keyFor != null && keyFor.slug === p.slug
    return (
      <React.Fragment key={p.slug}>
        <UnconfiguredProviderRow p={p} open={open} onPress={() => tapProvider(p)} />
        {open && keyFor ? (
          <View style={s.keyFormWrap}>
            <ProviderKeyForm provider={keyFor} busy={savingKey} onSave={connectKey} onCancel={() => setKeyFor(null)} />
          </View>
        ) : null}
      </React.Fragment>
    )
  }

  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell title={t('agent.title')} showBrand>
        <KeyboardAwareScrollView
          style={s.root}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
        >
          {!online ? (
            <Card style={s.offlineCard}>
              <View style={[s.offlineRow, { flexDirection: dir.row }]}>
                <Txt size={12.5} weight="700" color={C.amber} style={s.flex} numberOfLines={2}>
                  {t('agent.offline')}
                </Txt>
                <PrimaryBtn
                  small
                  label={t('agent.reconnect')}
                  onPress={() => { void retryNow().catch(() => {}) }}
                  style={s.offlineBtn}
                />
              </View>
            </Card>
          ) : null}

          {/* ── Model ───────────────────────────────────────────────────── */}
          <View style={[s.kickerRow, { flexDirection: dir.row }]}>
            <Kicker style={s.firstKicker}>{t('agent.model.kicker')}</Kicker>
            {loading ? <Spinner /> : null}
          </View>
          <Card
            onPress={openPickerFromCard}
            accessibilityLabel={t('agent.model.a11y', { model: model || t('agent.model.default') })}
          >
            <View style={[s.modelRow, { flexDirection: dir.row }]}>
              <View style={s.modelText}>
                <Txt mono ltr size={13.5} weight="700" numberOfLines={1}>
                  {model || t('agent.model.default')}
                </Txt>
                <Txt size={11.5} color={C.textDim} numberOfLines={1} style={s.modelSub}>
                  {modelSub}
                </Txt>
              </View>
              <PrimaryBtn
                small
                label={t('agent.model.change')}
                accessibilityLabel={t('agent.model.changeA11y')}
                onPress={openPickerFromCard}
                style={s.changeBtn}
              />
            </View>
          </Card>
          {defaultModel?.model && defaultModel.model !== model ? (
            <Txt size={11.5} color={C.textFaint} numberOfLines={1} style={s.defaultLine}>
              {t('agent.model.savedEverywhereLine', { model: defaultModel.model })}
              {defaultModel.provider && defaultModel.provider !== 'unknown' ? ` · ${defaultModel.provider}` : ''}
            </Txt>
          ) : null}

          {/* ── Providers ───────────────────────────────────────────────── */}
          <View style={[s.kickerRow, { flexDirection: dir.row }]}>
            <Kicker>{t('agent.providers.kicker')}</Kicker>
            {optsLoading ? <Spinner /> : null}
          </View>
          <View style={[s.filterRow, { flexDirection: dir.row }]}>
            <Field
              value={providerQuery}
              onChangeText={setProviderQuery}
              placeholder={t('agent.providers.filter')}
              accessibilityLabel={t('agent.providers.filterA11y')}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              wrapStyle={s.flex}
            />
            {providerQuery ? (
              <Pressable
                hitSlop={8}
                onPress={() => setProviderQuery('')}
                accessibilityRole="button"
                accessibilityLabel={t('agent.providers.clear')}
                style={({ pressed }) => [s.clearBtn, pressed && s.pressed]}
              >
                <Icon name="close-circle" size={16} color={C.textFaint} />
              </Pressable>
            ) : null}
          </View>

          {shownConnected.length ? (
            <Card style={s.providerCard}>
              {shownConnected.map((p, i) => (
                <React.Fragment key={p.slug}>
                  {i > 0 ? <Divider style={s.providerDivider} /> : null}
                  <ConnectedProviderRow
                    p={p}
                    busy={busySlug === p.slug}
                    onPick={() => openPickerFor(p.slug)}
                    onDisconnect={() => confirmDisconnect(p)}
                  />
                </React.Fragment>
              ))}
            </Card>
          ) : null}

          {unconfigured.length && !pq ? (
            <Card style={s.notSetupCard}>
              <Pressable
                style={({ pressed }) => [s.notSetupHead, { flexDirection: dir.row }, pressed && s.pressed]}
                onPress={() => setUnconfiguredOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: unconfiguredOpen }}
                accessibilityLabel={
                  unconfiguredOpen
                    ? t('agent.providers.hideNotSetUp')
                    : t('agent.providers.showNotSetUp', { n: unconfigured.length })
                }
              >
                <Txt size={12} weight="700" color={C.textDim} style={s.flex}>
                  {t('agent.providers.notSetUp', { n: unconfigured.length })}
                </Txt>
                <Icon name={unconfiguredOpen ? 'chevron-up' : dir.icon.forward} size={15} color={C.textFaint} />
              </Pressable>
              {unconfiguredVisible ? (
                <View>
                  <Divider style={s.notSetupDivider} />
                  {shownUnconfigured.map(renderUnconfiguredRow)}
                </View>
              ) : null}
            </Card>
          ) : null}

          {pq && shownUnconfigured.length ? (
            <Card style={s.providerCard}>{shownUnconfigured.map(renderUnconfiguredRow)}</Card>
          ) : null}

          {pq && !shownConnected.length && !shownUnconfigured.length ? (
            <Txt size={12.5} color={C.textFaint} style={s.empty}>
              {t('agent.providers.noMatch', { query: providerQuery })}
            </Txt>
          ) : null}
          {!providers.length && !optsLoading ? (
            <Txt size={12.5} color={C.textFaint} style={s.empty}>
              {t('agent.providers.empty')}
            </Txt>
          ) : null}

          {/* ── Reasoning effort ────────────────────────────────────────── */}
          <View style={[s.kickerRow, { flexDirection: dir.row }]}>
            <Kicker>{t('agent.reasoning.kicker')}</Kicker>
            {saving?.startsWith('effort:') ? <Spinner /> : null}
          </View>
          <Card>
            {prefs ? (
              <Txt size={11.5} color={C.textDim} style={s.prefsLine} numberOfLines={2}>
                {t('agent.reasoning.default', { value: prefs.global ? effortLabel(prefs.global) : '—' })}
                {prefs.effective && prefs.global && prefs.effective !== prefs.global
                  ? ` · ${t('agent.reasoning.thisChat', { value: effortLabel(prefs.effective) })}`
                  : ''}
              </Txt>
            ) : null}
            <View style={[s.scopeRow, { flexDirection: dir.row }]}>
              {(['global', 'session'] as const).map((sc) => {
                const on = effortScope === sc
                return (
                  <Pressable
                    key={sc}
                    onPress={() => setEffortScope(sc)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={sc === 'global' ? t('agent.reasoning.scopeGlobalA11y') : t('agent.reasoning.scopeSessionA11y')}
                    style={({ pressed }) => [s.scopePill, on && s.scopePillOn, pressed && s.pressed]}
                  >
                    <Txt size={11} weight="700" color={on ? C.accent : C.textDim}>
                      {sc === 'global' ? t('agent.reasoning.scopeGlobal') : t('agent.reasoning.scopeSession')}
                    </Txt>
                  </Pressable>
                )
              })}
            </View>
            <View style={s.effortGrid}>
              {effortRows.map((row) => (
                <View key={row.join('-')} style={[s.effortRow, { flexDirection: dir.row }]}>
                  {row.map((e) => {
                    const on = effort === e
                    return (
                      <Pressable
                        key={e}
                        onPress={() => void setAndSave(e)}
                        hitSlop={2}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={t('agent.reasoning.effortA11y', { level: effortLabel(e) })}
                        style={({ pressed }) => [s.effortPill, on && s.effortPillOn, pressed && s.pressed]}
                      >
                        <Txt size={11.5} weight="700" color={on ? C.onAccent : C.text} numberOfLines={1}>
                          {effortLabel(e)}
                        </Txt>
                      </Pressable>
                    )
                  })}
                </View>
              ))}
            </View>
          </Card>

          {/* ── Show reasoning ──────────────────────────────────────────── */}
          <Card>
            <View style={[s.toggleRow, { flexDirection: dir.row }]}>
              <View style={s.flex}>
                <Txt size={13} weight="700">{t('agent.reasoning.showTitle')}</Txt>
                <Txt size={11} color={C.textDim} style={s.subLine} numberOfLines={2}>
                  {t('agent.reasoning.showSub')}
                </Txt>
              </View>
              <Toggle
                value={showReasoning === 'show'}
                onChange={(v) => void toggleReasoning(v)}
                accessibilityLabel={t('agent.reasoning.showA11y')}
                style={dir.rtl ? s.toggleRtl : undefined}
              />
            </View>
          </Card>
        </KeyboardAwareScrollView>
      </ScreenShell>
      <ModelPickerSheet
        open={pickerOpen}
        initialSlug={pickerSlug}
        onClose={() => {
          setPickerOpen(false)
          setPickerSlug(null)
          // The sheet may have written the global default (or a session pick);
          // refresh so the saved-everywhere line and the model card are honest.
          void refresh()
        }}
      />
    </SafeAreaView>
  )
}

function ConnectedProviderRow({
  p,
  busy,
  onPick,
  onDisconnect,
}: {
  p: ProviderOption
  busy: boolean
  onPick: () => void
  onDisconnect: () => void
}) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const count = p.total_models ?? p.models?.length ?? 0
  const status = count === 1
    ? t('agent.providers.connectedOne', { n: count })
    : t('agent.providers.connectedMany', { n: count })
  return (
    <View style={[s.providerRow, { flexDirection: dir.row }]}>
      <Pressable
        style={({ pressed }) => [s.providerMain, { flexDirection: dir.row }, pressed && s.pressed]}
        onPress={onPick}
        accessibilityRole="button"
        accessibilityLabel={t('agent.providers.rowA11y', { name: p.name, status })}
      >
        <View style={s.flex}>
          <View style={[s.providerNameLine, { flexDirection: dir.row }]}>
            <Txt size={13} weight="700" numberOfLines={1} style={s.providerName}>{p.name}</Txt>
            {p.is_current ? <Pill kind="accent">{t('agent.providers.active')}</Pill> : null}
          </View>
          <Txt size={11} color={C.greenSoft} numberOfLines={1} style={s.providerSub}>{status}</Txt>
        </View>
      </Pressable>
      {busy ? (
        <Spinner />
      ) : (
        <View style={[s.providerActions, { flexDirection: dir.row }]}>
          <Pill
            kind="accent"
            onPress={onPick}
            accessibilityLabel={t('agent.providers.pickModelA11y', { name: p.name })}
          >
            {t('agent.providers.pickModel')}
          </Pill>
          <Pressable
            onPress={onDisconnect}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('agent.providers.disconnectA11y', { name: p.name })}
            style={({ pressed }) => [s.disconnectLink, pressed && s.pressed]}
          >
            <Txt size={11} color={C.textFaint}>{t('agent.providers.disconnect')}</Txt>
          </Pressable>
        </View>
      )}
    </View>
  )
}

function UnconfiguredProviderRow({
  p,
  open,
  onPress,
}: {
  p: ProviderOption
  open: boolean
  onPress: () => void
}) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const status = p.auth_type === 'api_key'
    ? t('agent.providers.notConnected')
    : t('agent.providers.hostSetup')
  return (
    <Pressable
      style={({ pressed }) => [s.unconfiguredRow, { flexDirection: dir.row }, pressed && s.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('agent.providers.rowA11y', { name: p.name, status })}
      accessibilityState={{ expanded: open }}
    >
      <View style={s.flex}>
        <Txt size={13} weight="700" numberOfLines={1} style={s.providerName}>{p.name}</Txt>
        <Txt size={11} color={C.textDim} numberOfLines={1} style={s.providerSub}>{status}</Txt>
      </View>
      <Icon name={open ? 'chevron-up' : dir.icon.forward} size={14} color={C.textFaint} />
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 18 },
  pressed: { opacity: 0.6 },
  flex: { flex: 1, minWidth: 0 },

  kickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  firstKicker: { marginTop: 2 },

  offlineCard: {
    backgroundColor: C.amberSoft,
    borderColor: 'rgba(245,165,36,0.35)',
  },
  offlineRow: { alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  offlineBtn: { paddingVertical: 5, paddingHorizontal: 10 },

  modelRow: { alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  modelText: { flex: 1, minWidth: 0 },
  modelSub: { marginTop: 2 },
  changeBtn: { paddingVertical: 7, paddingHorizontal: 12 },
  defaultLine: { marginTop: -2, marginBottom: 6, marginHorizontal: 2 },

  filterRow: { alignItems: 'center', gap: 8, marginBottom: 8 },
  clearBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },

  providerCard: { paddingVertical: 10, paddingHorizontal: 12 },
  providerDivider: { marginVertical: 8 },
  providerRow: { alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  providerMain: { flex: 1, minWidth: 0 },
  providerNameLine: { alignItems: 'center', gap: 7 },
  providerName: { flexShrink: 1 },
  providerSub: { marginTop: 2 },
  providerActions: { alignItems: 'center', gap: 8 },
  disconnectLink: { paddingVertical: 2 },

  notSetupCard: { paddingVertical: 10, paddingHorizontal: 12 },
  notSetupHead: { alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 30, paddingVertical: 2 },
  notSetupDivider: { marginTop: 8 },
  keyFormWrap: { paddingTop: 2, paddingBottom: 6 },

  unconfiguredRow: { alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 8 },

  empty: { padding: 8 },

  prefsLine: { marginBottom: 8 },
  scopeRow: { gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  scopePill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: 'transparent',
  },
  scopePillOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  effortGrid: { gap: 5 },
  effortRow: { gap: 5 },
  effortPill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgElev,
    minHeight: 32,
  },
  effortPillOn: { backgroundColor: C.accent, borderColor: C.accent },

  toggleRow: { alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  subLine: { marginTop: 2 },
  toggleRtl: { transform: [{ scaleX: -1 }] },
})
