/**
 * Interactive model picker — provider → model → scope, restyled to the
 * redesign mockup's `renderModelPickerSheet`:
 *
 *   SheetCard + grabber
 *   ├─ title + "Provider → Model → Scope" subtitle + close
 *   ├─ provider chip strip (accent border/bg on the selected provider)
 *   ├─ model rows (mono id, ACTIVE pill, capability tag, mono price; the
 *   │  chosen row washes in accentSoft with an accent border)
 *   ├─ "Apply Scope" + three scope pills (selected = accent fill)
 *   └─ Done · Use <model>
 *
 * Backed entirely by the gateway's picker contract: `model.options` for the
 * inventory, `config.set { key: 'model', value: "<model> --provider <slug>
 * <--scope>" }` to apply (see src/lib/modelState.ts), `model.save_key` for
 * providers the gateway knows but that have no key yet (ProviderKeyForm).
 * The step state machine (provider → model → scope), the search filter, the
 * guarded-switch confirm, and every loading/error path are preserved; the
 * OpenCode branch (ocMode / ocOneShot) keeps its provider-grouped inventory
 * and one-tap apply against the OpenCode server.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, View, Pressable, ScrollView, StyleSheet } from 'react-native'
// BUG-133: RN core's KeyboardAvoidingView with `behavior: undefined` on
// Android renders a passthrough View (zero avoidance), and inside a Modal the
// OS never resizes either — the keyboard rose straight over this sheet's
// filter input and the API-key form. RNKC's KAV as the Modal's full-screen
// root is the connectors-proven shape (exact lift, no frame math).
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Icon } from './Icon'
import { ProviderKeyForm } from './ProviderKeyForm'
import { showAlert } from './AlertDialog'
import { Field, HeaderButton, Kicker, Pill, PrimaryBtn, SheetCard, SheetGrabber, Spinner, Txt } from './ui'
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
import {
  ocSessionFor, ocRememberSession, ocSessionDirectory, readOcDefaultPick,
  saveOcDefaultPick, applyOcDefaultPick,
} from '../lib/opencodeChat'
import type { OcDefaultPick } from '../lib/ocDefaultPick'
import { slashLabel } from '../lib/slash'
import { log } from '../lib/log'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr, useDir } from '../lib/strings'
import { LOCALES, translate } from '../lib/i18n'

type Step = 'provider' | 'model' | 'scope'

/**
 * Session titles that only mean "not named yet". `activeTitle` keeps whatever
 * language the chat was created in (and a later locale switch changes what
 * tr() returns), so the sentinel covers the raw literal AND the placeholder in
 * every shipped locale — a minted OpenCode session must never inherit it.
 */
const NEW_CHAT_TITLES = new Set<string>([
  'New chat',
  ...LOCALES.map((l) => translate(l.id, 'sidebar.newChat')),
])

/** The three apply scopes, in mockup pill order. */
const SCOPES: { key: ModelScope; labelKey: string; hintKey: string }[] = [
  { key: 'session', labelKey: 'chrome.model.scopeSession', hintKey: 'chrome.model.scopeSessionHint' },
  { key: 'global', labelKey: 'chrome.model.scopeGlobal', hintKey: 'chrome.model.scopeGlobalHint' },
  { key: 'once', labelKey: 'chrome.model.scopeOnce', hintKey: 'chrome.model.scopeOnceHint' },
]

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
  /** Fired after a pick lands — the chip keeps this model. `All sessions`
   *  also updates the app default and is not a per-chat pin. */
  onPicked?: (modelID: string, scope?: 'chat' | 'all') => void
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  // The sheet's copy must follow a language switch while it is open.
  useStore(localeAtom)
  const options = useStore(modelOptions)
  const loading = useStore(modelOptionsLoading)
  const curModel = useStore(liveModel)
  const curProvider = useStore(liveProvider)

  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<ProviderOption | null>(null)
  const [query, setQuery] = useState('')
  const [model, setModel] = useState('')
  const [scope, setScope] = useState<ModelScope>('session')
  const [applying, setApplying] = useState(false)
  const [keyFor, setKeyFor] = useState<ProviderOption | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  /** Set when the open-path refresh fails — surfaced in the sheet, not just the log. */
  const [loadError, setLoadError] = useState('')
  // ── OpenCode mode state (ocMode only) ──
  const [ocList, setOcList] = useState<OcModel[] | null>(null)
  const [ocLoading, setOcLoading] = useState(false)
  const [ocErr, setOcErr] = useState('')
  const [ocDefault, setOcDefault] = useState<OcModel | null>(null)
  /** Explicit OpenCode scope: per-chat pick (default) or the app-wide default. */
  const [ocScope, setOcScope] = useState<'chat' | 'all'>('chat')
  const [ocSavedDefault, setOcSavedDefault] = useState<OcDefaultPick | null>(null)

  // OpenCode open-path: inventory + current default in one go. Loading and
  // errors render in-sheet with honest copy. One-shot has no server: the
  // inventory is the CLI and there is no default to fetch.
  useEffect(() => {
    if (!open || !ocMode) return
    setQuery('')
    setOcErr('')
    setOcList(null)
    setOcDefault(null)
    setOcScope('chat')
    setOcSavedDefault(null)
    setOcLoading(true)
    void readOcDefaultPick()
      .then((pick) => { if (pick) setOcSavedDefault(pick) })
      .catch(() => {})
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
          const [list, def, saved] = await Promise.all([ocModels(), ocDefaultModel(), readOcDefaultPick()])
          setOcList(list ?? [])
          setOcDefault(def ?? null)
          setOcSavedDefault(saved)
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
              : tr('chrome.model.ocSwitchFailed'),
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
  // list and lands directly on that provider's models when it's usable;
  // otherwise the sheet preselects the current provider (mockup shows the
  // provider chips with a model list already open).
  useEffect(() => {
    if (!open || ocMode) return // OpenCode mode has its own open-path above
    setStep('provider')
    setProvider(null)
    setModel('')
    setScope('session')
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
        let pick: ProviderOption | null = null
        if (initialSlug) {
          const preset = fresh.providers.find((p) => p.slug === initialSlug)
          if (preset?.authenticated) pick = preset
        } else {
          // Prefer the chat's live provider, then the best connected one.
          pick =
            fresh.providers.find((p) => p.slug === liveProvider.get() && p.authenticated) ??
            rankProviders(fresh.providers).find((p) => p.authenticated) ??
            null
        }
        if (pick) {
          setProvider(pick)
          setQuery('')
          setStep('model')
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : tr('chrome.model.loadFailed'))
        log('warn', 'model', `model.options failed: ${String(err)}`)
      }
    })()
  }, [open, initialSlug, ocMode])

  const providers = useMemo(() => rankProviders(options?.providers ?? []), [options])
  const configured = useMemo(() => providers.filter((p) => p.authenticated), [providers])
  const unconfigured = useMemo(() => providers.filter((p) => !p.authenticated), [providers])

  const q = query.trim().toLowerCase()
  const match = useCallback((text: string) => !q || text.toLowerCase().includes(q), [q])

  const shownProviders = useMemo(
    () => configured.filter((p) => match(p.name) || match(p.slug)),
    [configured, match],
  )
  const shownUnconfigured = useMemo(
    () => unconfigured.filter((p) => match(p.name) || match(p.slug)),
    [unconfigured, match],
  )
  const shownModels = useMemo(() => {
    if (!provider) return []
    return rankModels(provider).filter((m) => match(m))
  }, [provider, match])

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

  /** Apply an OpenCode model. `This chat` keeps the pre-existing per-chat
   *  semantics (mint on demand for a brand-new chat). `All sessions` stores
   *  the app default for NEW chats, applies it to the current OC session when
   *  one already exists, and never mints a session just to change a default. */
  const pickOcModel = async (m: OcModel) => {
    if (applying) return
    setApplying(true)
    setOcErr('')
    const scopeNow = ocScope
    try {
      if (scopeNow === 'all') {
        const pick: OcDefaultPick = { providerID: m.providerID, modelID: m.modelID, id: m.id }
        await saveOcDefaultPick(pick)
        setOcSavedDefault(pick)
        // A current OC session (server mode only) switches now; a chat with
        // no OC session mints nothing — the default lands on its first mint.
        // When a real session was switched, record it as that chat's current
        // pick too so the chip survives the next launch.
        let switchedCurrent = false
        if (!ocOneShot && ocSessionId) {
          const ocId = await ocSessionFor(ocSessionId)
          if (ocId) {
            await ocSetModel(ocId, m.providerID, m.id)
            switchedCurrent = true
          }
        }
        onPicked?.(
          ocOneShot ? `${m.providerID}/${m.modelID}` : m.modelID,
          switchedCurrent ? 'chat' : 'all',
        )
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        onClose()
        return
      }
      if (ocOneShot) {
        onPicked?.(`${m.providerID}/${m.modelID}`, 'chat')
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
        if (!mapKey) throw new Error(tr('chrome.model.chatNotReady'))
        // The placeholder "New chat" would name the OC session forever
        // (chat.ts skips it when titling the first send for the same reason) —
        // matched in every locale, since the title may have been minted before
        // a language switch.
        const t = activeTitle.get()
        const sessionTitle =
          t && !NEW_CHAT_TITLES.has(t)
            ? t.slice(0, 80)
            : tr('chrome.model.ocDefaultTitle')
        // BUG-149: file the minted session under the selected project (or the
        // embedded workspace) — the SAME helper the turn mint uses, so the two
        // paths can never disagree on directory.
        const created = await ocCreateSession(sessionTitle, await ocSessionDirectory())
        if (!created?.id) throw new Error(tr('chrome.model.ocNoSession'))
        await ocRememberSession(mapKey, created.id)
        // Every newly minted OC session gets the app default first (best-effort),
        // then this chat's explicit pick below wins.
        await applyOcDefaultPick(created.id)
        // The drawer's oc list caches for 15s — a minted session must be
        // visible immediately (runOcSubmit invalidates for the same reason).
        invalidateOcSessionsCache()
        ocId = created.id
      }
      await ocSetModel(ocId, m.providerID, m.id)
      onPicked?.(m.modelID, 'chat')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setOcDefault(m)
      onClose()
    } catch (err) {
      setOcErr(err instanceof OcError ? describeOcError(err) : err instanceof Error ? err.message : tr('chrome.model.ocSwitchFailed'))
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

  // "Now:" line — what the chat is on this moment (mockup subtitle stays the
  // fixed spec line; the live model is a compact line under the header).
  const ocNowModel = ocCur ? (ocList?.find(ocIsCurrent)?.modelID ?? ocCurBare) : ''
  const nowLine = ocMode
    ? (ocCur
      ? tr(ocCurProvider ? 'chrome.model.nowProvider' : 'chrome.model.now', {
        model: ocNowModel,
        provider: ocCurProvider,
      })
      : '')
    : (curModel
      ? tr(curProvider ? 'chrome.model.nowProvider' : 'chrome.model.now', {
        model: curModel,
        provider: curProvider,
      })
      : step === 'provider' ? tr('chrome.model.pickPrompt') : '')

  const pickProvider = (p: ProviderOption) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    if (!p.authenticated) {
      setKeyFor(p)
      return
    }
    setKeyFor(null)
    setProvider(p)
    setModel('')
    setQuery('')
    setStep('model')
  }

  const pickModel = (m: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setModel(m)
    setStep('scope')
  }

  const pickScope = (sc: ModelScope) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setScope(sc)
  }

  /** Connect a provider from the picker; null = connected, string = why not. */
  const saveKey = async (apiKey: string): Promise<string | null> => {
    if (!keyFor) return tr('chrome.model.noProvider')
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

  const apply = async (applyScope: ModelScope) => {
    if (!provider || !model || applying) return
    setApplying(true)
    try {
      const sid = await ensureSession()
      let res = await applyModel({ sessionId: sid, model, provider: provider.slug, scope: applyScope })
      if ('needsConfirm' in res) {
        // Guarded switch (expensive model / catalog warning). The gateway
        // wrote nothing yet — ask, then retry with the confirm flag.
        setApplying(false)
        const confirmMessage: string = res.message
        const pick = await showAlert(tr('chrome.model.confirmTitle'), confirmMessage, [
          { text: tr('common.cancel'), style: 'cancel' },
          { text: tr('chrome.model.useIt'), style: 'default' },
        ])
        if (pick.style !== 'default') return
        setApplying(true)
        res = await applyModel({ sessionId: sid, model, provider: provider.slug, scope: applyScope, confirmed: true })
      }
      if ('model' in res) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        const where = res.scope === 'global'
          ? tr('chrome.model.whereGlobal')
          : res.scope === 'once'
            ? tr('chrome.model.whereOnce')
            : tr('chrome.model.whereSession')
        const lines = [tr('chrome.model.switched', { model: res.model, provider: provider.name, where })]
        if (res.deferred) lines.push(tr('chrome.model.deferred'))
        if (res.warning) lines.push(res.warning)
        pushLocalMessage(lines.join('\n'), 'assistant', { name: slashLabel('model'), variant: 'success' })
        onClose()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', 'model', `switch failed: ${msg}`)
      pushLocalMessage(
        tr('chrome.model.switchFailed', { why: msg.replace(/^config\.set:\s*/, '') }),
        'assistant',
        { name: slashLabel('model'), variant: 'error' },
      )
    } finally {
      setApplying(false)
    }
  }

  const scopeMeta = SCOPES.find((sc) => sc.key === scope) ?? SCOPES[0]
  const filterTarget = ocMode ? 'models' : step === 'provider' ? 'providers' : 'models'
  const filterPlaceholder = filterTarget === 'providers'
    ? tr('chrome.model.searchProviders')
    : tr('chrome.model.searchModels')
  const filterLabel = filterTarget === 'providers'
    ? tr('chrome.model.filterProviders')
    : tr('chrome.model.filterModels')
  const showSearch = !keyFor && (ocMode || (!loading || options != null))

  const renderChips = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={s.chipsScroll}
      contentContainerStyle={[s.chips, { flexDirection: dir.row }]}
    >
      {providers.map((p) => {
        const active = provider?.slug === p.slug
        return (
          <Pressable
            key={p.slug}
            style={({ pressed }) => [
              s.chip,
              active && s.chipOn,
              pressed && s.pressed,
            ]}
            onPress={() => pickProvider(p)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tr('chrome.model.providerA11y', { name: p.name })}
          >
            <Txt
              size={11}
              weight="700"
              color={active ? C.accent : p.authenticated ? C.textDim : C.textFaint}
              numberOfLines={1}
            >
              {p.name}
            </Txt>
          </Pressable>
        )
      })}
    </ScrollView>
  )

  const renderProviderRow = (p: ProviderOption) => {
    const count = p.total_models ?? p.models?.length ?? 0
    const subParts = [
      count
        ? (count === 1 ? tr('chrome.model.modelCountOne', { n: count }) : tr('chrome.model.modelCountMany', { n: count }))
        : tr('chrome.model.noCatalog'),
      p.slug === curProvider && curModel ? curModel : '',
      p.free_tier ? tr('chrome.model.freeTier') : '',
      !p.authenticated ? tr('chrome.model.notSetUp') : '',
    ].filter(Boolean)
    return (
      <Pressable
        key={p.slug}
        style={({ pressed }) => [s.providerRow, { flexDirection: dir.row }, pressed && s.rowPressed]}
        onPress={() => pickProvider(p)}
        accessibilityRole="button"
        accessibilityLabel={tr('chrome.model.providerA11y', { name: p.name })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={[s.titleLine, { flexDirection: dir.row }]}>
            <Txt size={13} weight="700" color={C.text} numberOfLines={1} style={s.titleFlex}>
              {p.name}
            </Txt>
            {p.is_current ? (
              <Pill kind="accent" style={s.activePill} textStyle={s.activePillText}>
                {tr('chrome.model.active')}
              </Pill>
            ) : null}
          </View>
          <Txt size={10.5} color={C.textDim} numberOfLines={1}>{subParts.join(' · ')}</Txt>
        </View>
        <Icon name={dir.icon.forward} size={14} color={C.textFaint} />
      </Pressable>
    )
  }

  const renderModelRow = (m: string) => {
    const p = provider
    if (!p) return null
    const cap = p.capabilities?.[m]
    const price = p.pricing?.[m]
    const tags = [
      cap?.fast ? tr('chrome.model.tagFast') : '',
      cap?.reasoning ? tr('chrome.model.tagReasoning') : '',
    ].filter(Boolean)
    const priceText = price
      ? price.free
        ? tr('chrome.model.free')
        : [price.input, price.output].filter(Boolean).join(' / ')
      : ''
    const disabled = (p.unavailable_models ?? []).includes(m)
    const isCurrent = p.slug === curProvider && m === curModel
    const selected = m === model
    return (
      <Pressable
        key={m}
        style={({ pressed }) => [
          s.modelRow,
          { flexDirection: dir.row },
          selected && s.modelRowOn,
          pressed && s.rowPressed,
          disabled && s.rowDisabled,
        ]}
        onPress={() => pickModel(m)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={isCurrent
          ? tr('chrome.model.modelA11yCurrent', { id: m })
          : tr('chrome.model.modelA11y', { id: m })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={[s.titleLine, { flexDirection: dir.row }]}>
            <Txt size={12} weight="700" mono color={C.text} numberOfLines={1} style={s.titleFlex}>
              {m}
            </Txt>
            {isCurrent ? (
              <Pill kind="accent" style={s.activePill} textStyle={s.activePillText}>
                {tr('chrome.model.active')}
              </Pill>
            ) : null}
          </View>
          <Txt size={10.5} color={C.textDim} numberOfLines={1} style={s.rowSub}>
            {[tags.join(' · '), disabled ? tr('chrome.model.unavailable') : ''].filter(Boolean).join(' · ')}
          </Txt>
        </View>
        {priceText ? (
          <Txt size={10} color={C.textFaint} mono numberOfLines={1}>{priceText}</Txt>
        ) : null}
      </Pressable>
    )
  }

  const renderOcModelRow = (m: OcModel) => {
    const isCurrent = ocIsCurrent(m)
    return (
      <Pressable
        key={`${m.providerID}/${m.modelID}`}
        style={({ pressed }) => [
          s.modelRow,
          { flexDirection: dir.row },
          isCurrent && s.modelRowOn,
          pressed && s.rowPressed,
          applying && s.rowDisabled,
        ]}
        onPress={() => { void pickOcModel(m) }}
        disabled={applying}
        accessibilityRole="button"
        accessibilityState={{ selected: isCurrent }}
        accessibilityLabel={isCurrent
          ? tr('chrome.model.modelA11yCurrent', { id: m.modelID })
          : tr('chrome.model.modelA11y', { id: m.modelID })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={[s.titleLine, { flexDirection: dir.row }]}>
            <Txt size={12} weight="700" mono color={C.text} numberOfLines={1} style={s.titleFlex}>
              {m.modelID}
            </Txt>
            {isCurrent ? (
              <Pill kind="accent" style={s.activePill} textStyle={s.activePillText}>
                {tr('chrome.model.active')}
              </Pill>
            ) : null}
          </View>
          {m.name && m.name !== m.modelID ? (
            <Txt size={10.5} color={C.textDim} numberOfLines={1} style={s.rowSub}>{m.name}</Txt>
          ) : null}
        </View>
      </Pressable>
    )
  }

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.flex} behavior="padding">
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]}
          onPress={onClose}
          accessibilityLabel={tr('common.close')}
        />
        <SheetCard style={s.pickerSheet}>
          <SheetGrabber />
          <View style={[s.head, { flexDirection: dir.row }]}>
            <View style={s.headText}>
              <Txt size={14} weight="800" color={C.text} numberOfLines={1}>
                {tr('chrome.model.title')}
              </Txt>
              <Txt size={11} color={C.textDim} numberOfLines={1}>
                {ocMode ? tr('chrome.model.subtitleOc') : tr('chrome.model.subtitle')}
              </Txt>
            </View>
            <HeaderButton onPress={onClose} style={s.headBtn} accessibilityLabel={tr('common.close')}>
              <Icon name="close" size={14} color={C.textDim} />
            </HeaderButton>
          </View>

          {nowLine ? (
            <Txt size={10.5} color={C.textFaint} numberOfLines={1} style={s.nowLine}>{nowLine}</Txt>
          ) : null}

          {ocMode && ocSavedDefault ? (
            <Txt size={10.5} color={C.textFaint} numberOfLines={1} style={s.nowLine}>
              {tr('chrome.model.ocDefault', {
                model: ocSavedDefault.modelID,
                provider: ocSavedDefault.providerID,
              })}
            </Txt>
          ) : null}

          {!ocMode && loadError ? (
            <Txt size={11.5} color={C.amber} style={s.warning}>
              {tr('chrome.model.loadWarning', { why: loadError })}
            </Txt>
          ) : null}

          {showSearch ? (
            <View style={[s.searchRow, { flexDirection: dir.row }]}>
              <Field
                value={query}
                onChangeText={setQuery}
                placeholder={filterPlaceholder}
                style={s.searchInput}
                wrapStyle={s.searchField}
                accessibilityLabel={filterLabel}
              />
              {query ? (
                <Pressable
                  hitSlop={6}
                  style={({ pressed }) => [s.clear, pressed && s.pressed]}
                  onPress={() => setQuery('')}
                  accessibilityLabel={tr('chrome.model.clearFilter')}
                >
                  <Icon name="close" size={14} color={C.textFaint} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {keyFor ? (
            <ScrollView style={s.body} contentContainerStyle={s.bodyContent} keyboardShouldPersistTaps="handled">
              <ProviderKeyForm
                provider={keyFor}
                busy={savingKey}
                onSave={saveKey}
                onCancel={() => setKeyFor(null)}
              />
            </ScrollView>
          ) : ocMode ? (
            // ── OpenCode mode: provider-grouped model list, one tap applies ──
            ocLoading ? (
              <View style={s.center}><Spinner /></View>
            ) : (
              <ScrollView style={s.body} contentContainerStyle={s.bodyContent} keyboardShouldPersistTaps="handled">
                {ocErr ? <Txt size={11.5} color={C.amber} style={s.warning}>{ocErr}</Txt> : null}
                {applying ? (
                  <View style={[s.applying, { flexDirection: dir.row }]}>
                    <Spinner size="small" />
                    <Txt size={11.5} color={C.textDim}>{tr('chrome.model.switching')}</Txt>
                  </View>
                ) : null}
                <Kicker style={s.scopeKicker}>{tr('chrome.model.applyScope')}</Kicker>
                <View style={[s.scopeRow, { flexDirection: dir.row }]}>
                  {(['chat', 'all'] as const).map((sc) => {
                    const on = ocScope === sc
                    return (
                      <Pressable
                        key={sc}
                        style={({ pressed }) => [s.scopePill, on && s.scopePillOn, pressed && s.pressed]}
                        onPress={() => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                          setOcScope(sc)
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={tr(sc === 'chat' ? 'chrome.model.scopeSession' : 'chrome.model.scopeGlobal')}
                      >
                        <Txt size={10.5} weight="700" color={on ? C.onAccent : C.textDim} center numberOfLines={1}>
                          {tr(sc === 'chat' ? 'chrome.model.scopeSession' : 'chrome.model.scopeGlobal')}
                        </Txt>
                      </Pressable>
                    )
                  })}
                </View>
                <Txt size={11} color={C.textFaint} style={s.scopeHint}>
                  {tr(ocScope === 'all' ? 'chrome.model.ocScopeAllHint' : 'chrome.model.scopeSessionHint')}
                </Txt>
                {ocGroups.map((g) => (
                  <View key={g.provider}>
                    <Kicker>{g.provider}</Kicker>
                    {g.models.map(renderOcModelRow)}
                  </View>
                ))}
                {!ocGroups.length ? (
                  <Txt size={13} color={C.textFaint} center style={s.empty}>
                    {tr('chrome.model.noModelsMatch', { query: query.trim() })}
                  </Txt>
                ) : null}
                <View style={{ height: 12 }} />
              </ScrollView>
            )
          ) : loading && !options ? (
            <View style={s.center}><Spinner /></View>
          ) : (
            <>
              {renderChips()}
              <ScrollView style={s.body} contentContainerStyle={s.bodyContent} keyboardShouldPersistTaps="handled">
                {step === 'provider' || !provider ? (
                  <View>
                    {shownProviders.map(renderProviderRow)}
                    {shownUnconfigured.length ? (
                      <Kicker>{tr('chrome.model.notSetUp')}</Kicker>
                    ) : null}
                    {shownUnconfigured.map(renderProviderRow)}
                    {!shownProviders.length && !shownUnconfigured.length && !loading ? (
                      <Txt size={13} color={C.textFaint} center style={s.empty}>
                        {tr('chrome.model.noProvidersMatch', { query: query.trim() })}
                      </Txt>
                    ) : null}
                  </View>
                ) : (
                  <View>
                    {provider.warning ? (
                      <Txt size={11.5} color={C.amber} style={s.warning}>{provider.warning}</Txt>
                    ) : null}
                    {shownModels.map(renderModelRow)}
                    {!shownModels.length ? (
                      <Txt size={13} color={C.textFaint} center style={s.empty}>
                        {tr('chrome.model.noModelsMatch', { query: query.trim() })}
                      </Txt>
                    ) : null}
                  </View>
                )}

                <Kicker style={s.scopeKicker}>{tr('chrome.model.applyScope')}</Kicker>
                <View style={[s.scopeRow, { flexDirection: dir.row }]}>
                  {SCOPES.map((sc) => {
                    const on = scope === sc.key
                    return (
                      <Pressable
                        key={sc.key}
                        style={({ pressed }) => [s.scopePill, on && s.scopePillOn, pressed && s.pressed]}
                        onPress={() => pickScope(sc.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={tr(sc.labelKey)}
                      >
                        <Txt size={10.5} weight="700" color={on ? C.onAccent : C.textDim} center numberOfLines={1}>
                          {tr(sc.labelKey)}
                        </Txt>
                      </Pressable>
                    )
                  })}
                </View>
                <Txt size={11} color={C.textFaint} style={s.scopeHint}>{tr(scopeMeta.hintKey)}</Txt>

                {applying ? (
                  <View style={[s.applying, { flexDirection: dir.row }]}>
                    <Spinner size="small" />
                    <Txt size={11.5} color={C.textDim}>{tr('chrome.model.switching')}</Txt>
                  </View>
                ) : null}
                <PrimaryBtn
                  onPress={() => { void apply(scope) }}
                  disabled={!provider || !model || applying}
                  style={s.done}
                  label={model ? tr('chrome.model.done', { model }) : tr('common.done')}
                />
                <View style={{ height: 12 }} />
              </ScrollView>
            </>
          )}
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  // Bound THIS sheet only: the shared SheetCard is also used by settings,
  // connectors and the bot switcher, none of which should start clipping.
  pickerSheet: { flexShrink: 1, overflow: 'hidden' },
  head: { alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 },
  headText: { flex: 1, minWidth: 0 },
  headBtn: { width: 26, height: 26, borderRadius: 8 },
  nowLine: { marginBottom: 6, flexShrink: 0 },
  warning: { lineHeight: 16, marginBottom: 6 },
  searchRow: { alignItems: 'center', gap: 6, marginBottom: 8, flexShrink: 0 },
  searchField: { flex: 1 },
  searchInput: { fontSize: 12.5, paddingVertical: 7, minHeight: 32 },
  clear: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  chipsScroll: { flexGrow: 0, flexShrink: 0, minHeight: 28 },
  chips: { gap: 5, paddingBottom: 8, alignItems: 'center' },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  body: { flexShrink: 1, minHeight: 0 },
  bodyContent: { paddingBottom: 4 },
  center: { paddingVertical: 32, alignItems: 'center' },
  providerRow: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 11,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 5,
    minHeight: 46,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowDisabled: { opacity: 0.4 },
  titleLine: { alignItems: 'center', gap: 6 },
  titleFlex: { flexShrink: 1 },
  activePill: { paddingHorizontal: 6, paddingVertical: 1 },
  activePillText: { fontSize: 9 },
  rowSub: { marginTop: 2 },
  modelRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 11,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 5,
    minHeight: 46,
  },
  modelRowOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  scopeKicker: { marginTop: 8, marginBottom: 6 },
  scopeRow: { gap: 5, marginBottom: 8 },
  scopePill: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 6,
    minHeight: 30,
    borderRadius: 9,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  scopePillOn: { backgroundColor: C.accent, borderColor: C.accent },
  scopeHint: { lineHeight: 15, marginBottom: 10 },
  applying: { alignItems: 'center', gap: 8, paddingVertical: 6 },
  done: { width: '100%' },
  empty: { paddingVertical: 20 },
})
