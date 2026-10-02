/**
 * Live model/provider state + the interactive model-switch flow.
 *
 * Everything here rides the gateway's own picker contract (do not guess these):
 *  - `model.options` — provider inventory for the picker, layered over the
 *    session's live provider when `session_id` is given. Rows carry
 *    `models`, `featured_models`, `capabilities`, `pricing`,
 *    `unavailable_models`, `authenticated`, `key_env`.
 *  - `config.set { key: 'model', value, session_id }` — the ONE setter. The
 *    value string carries the /model flags the gateway already parses
 *    (`--provider X`, `--session`, `--global`, `--once`), so scope is just
 *    part of the value. A guarded switch answers `confirm_required` +
 *    `confirm_message`; the retry sends `confirm_expensive_model: true`.
 *    A switch while the agent runs answers `deferred: true` (applies next turn).
 *  - `model.save_key { slug, api_key, session_id }` — store a provider key
 *    from the picker instead of sending people to a terminal.
 *
 * Contract source of truth:
 *   ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.generated.ts
 */
import { atom } from 'nanostores'
import { log } from './log'

// src/lib/gateway pulls react-native storage, which plain node (scripts/)
// cannot load — so it is imported lazily and scripts can inject a fake with
// _useGatewayForTests() before calling anything that talks to the wire.
type GatewayModule = typeof import('./gateway')
let gwOverride: GatewayModule | null = null
/** Scripts inject a fake gateway module here; real apps never call this. */
export function _useGatewayForTests(g: GatewayModule | null) { gwOverride = g }
async function gw(): Promise<GatewayModule> {
  return gwOverride ?? import('./gateway')
}

// ── Wire shapes (subsets of the generated contract) ────────────────────────

export interface ModelCapability {
  fast: boolean
  reasoning: boolean
}

export interface ModelPricing {
  input: string
  output: string
  cache?: string | null
  free: boolean
}

export interface ProviderOption {
  slug: string
  name: string
  models?: string[]
  total_models?: number | null
  is_current?: boolean | null
  is_user_defined?: boolean | null
  source?: string | null
  aliases?: string[] | null
  auth_type?: string | null
  authenticated?: boolean | null
  key_env?: string | null
  warning?: string | null
  featured_models?: string[] | null
  capabilities?: Record<string, ModelCapability> | null
  pricing?: Record<string, ModelPricing> | null
  pricing_pending?: boolean | null
  free_tier?: boolean | null
  free_tier_pending?: boolean | null
  unavailable_models?: string[] | null
}

export interface ModelOptions {
  providers: ProviderOption[]
  model?: string
  provider?: string
}

export interface SessionInfoLite {
  model?: string
  provider?: string
  reasoning_effort?: string
}

/** Persistence scope for a switch — maps 1:1 to the gateway's /model flags. */
export type ModelScope = 'session' | 'global' | 'once'

// ── State ──────────────────────────────────────────────────────────────────

/** The active session's live model id (e.g. "glm-5.3-flash"). */
export const liveModel = atom<string>('')
/** The active session's live provider slug (e.g. "zai"). */
export const liveProvider = atom<string>('')
/** The active session's live reasoning effort (e.g. "high") — the main lever
 *  on how long the thinking phase lasts, applied live by config.set. */
export const liveReasoning = atom<string>('')
/** Whether thinking blocks render in the chat — mirrors the gateway's
 *  `reasoning` display config. Server-side `hide` also stops streaming the
 *  deltas at all; this gate additionally hides blocks already sitting in
 *  the transcript, which the server-side switch alone never touches. */
export const liveReasoningDisplay = atom<'show' | 'hide'>('show')
/** Cached `model.options` payload — refetched with `force` when stale. */
export const modelOptions = atom<ModelOptions | null>(null)
export const modelOptionsLoading = atom<boolean>(false)

/** Feed the live atoms from any SessionLiveInfo (events, create/resume results). */
export function noteSessionInfo(info?: SessionInfoLite | null) {
  if (!info) return
  if (typeof info.model === 'string' && info.model) liveModel.set(info.model)
  if (typeof info.provider === 'string' && info.provider && info.provider !== 'unknown') {
    liveProvider.set(info.provider)
  }
  if (typeof info.reasoning_effort === 'string' && info.reasoning_effort) {
    liveReasoning.set(info.reasoning_effort)
  }
}

/**
 * Track the live model/provider from `session.info` events. Registered once
 * from hookChatEvents() — chat.ts already receives these for titles.
 */
let hooked = false
export function hookModelState() {
  if (hooked) return
  hooked = true
  void (async () => {
    const { onEvent } = await gw()
    onEvent((e) => {
      if (e.type !== 'session.info') return
      const p = (e.payload ?? {}) as Record<string, unknown>
      noteSessionInfo({
        model: typeof p.model === 'string' ? p.model : undefined,
        provider: typeof p.provider === 'string' ? p.provider : undefined,
        reasoning_effort: typeof p.reasoning_effort === 'string' ? p.reasoning_effort : undefined,
      })
    })
  })().catch((err) => log('warn', 'model', `hookModelState failed: ${String(err)}`))
}

// ── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Read the session's `reasoning` display config into the atom. Called when
 * the chat tab gains a session and by the Agent tab's refresh, so the
 * toggle and the chat renderer always agree on one source of truth.
 */
export async function fetchReasoningDisplay(sessionId?: string | null): Promise<'show' | 'hide'> {
  try {
    const { rpc } = await gw()
    const r = await rpc<{ value?: string; display?: string }>('config.get', {
      key: 'reasoning',
      ...(sessionId ? { session_id: sessionId } : {}),
    })
    const display = r?.display === 'hide' ? 'hide' : 'show'
    liveReasoningDisplay.set(display)
    return display
  } catch (err) {
    log('warn', 'model', `config.get reasoning failed: ${String(err)}`)
    return liveReasoningDisplay.get()
  }
}

/**
 * Provider inventory for the picker. Cached in the atom; pass `force` to
 * refresh (after save_key, or when the user pulls the sheet again much later).
 */
export async function fetchModelOptions(
  sessionId?: string | null,
  opts?: { force?: boolean; refresh?: boolean; includeUnconfigured?: boolean },
): Promise<ModelOptions> {
  if (!opts?.force && modelOptions.get()) return modelOptions.get()!
  modelOptionsLoading.set(true)
  try {
    const { rpc } = await gw()
    const res = await rpc<ModelOptions>('model.options', {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(opts?.refresh ? { refresh: true } : {}),
      ...(opts?.includeUnconfigured === false ? {} : { include_unconfigured: true }),
    })
    const normalized: ModelOptions = {
      providers: Array.isArray(res?.providers) ? res.providers : [],
      model: res?.model,
      provider: res?.provider,
    }
    modelOptions.set(normalized)
    noteSessionInfo({ model: normalized.model, provider: normalized.provider })
    return normalized
  } finally {
    modelOptionsLoading.set(false)
  }
}

export function invalidateModelOptions() {
  modelOptions.set(null)
}

// ── Switch flow ────────────────────────────────────────────────────────────

/** The /model flag the gateway parses out of the value string for each scope. */
export function scopeFlag(scope: ModelScope): string {
  return scope === 'global' ? '--global' : scope === 'once' ? '--once' : '--session'
}

/**
 * The `config.set model` value: "<model> [--provider <slug>] [--scope]".
 * The gateway's own parser tokenizes this exact format for /model, so the
 * picker produces the same request a typed `/model x --provider y --global`
 * would — one code path, no client-side persistence logic.
 */
export function buildModelValue(model: string, provider?: string | null, scope: ModelScope = 'session'): string {
  const parts = [model.trim()]
  if (provider && provider !== 'unknown') parts.push('--provider', provider.trim())
  parts.push(scopeFlag(scope))
  return parts.join(' ')
}

export interface ApplyModelResult {
  /** The model the gateway recorded (echoed back in `value`). */
  model: string
  /** Persistence scope the gateway actually used ("session" | "global" | "once"). */
  scope?: string
  /** True when the agent is mid-turn — the switch lands on the NEXT turn. */
  deferred: boolean
  warning?: string
}

export interface ApplyModelConfirm {
  needsConfirm: true
  message: string
}

/**
 * Pure interpretation of a `config.set model` response — split from the RPC
 * call so the confirm/deferred contract is unit-testable without a gateway.
 */
export function interpretModelSwitch(
  res: {
    value?: string | boolean | null
    warning?: string | null
    confirm_required?: boolean | null
    confirm_message?: string | null
    scope?: string | null
    deferred?: boolean | null
  } | null | undefined,
  fallbackModel: string,
  fallbackProvider?: string | null,
): ApplyModelResult | ApplyModelConfirm {
  // Guarded switch (expensive model, or a catalog warning): the gateway wrote
  // nothing yet. Retry with the confirm flag if the user agrees.
  if (res?.confirm_required && res?.confirm_message) {
    return { needsConfirm: true, message: String(res.confirm_message) }
  }
  const model = typeof res?.value === 'string' && res.value ? res.value : fallbackModel
  if (fallbackProvider && fallbackProvider !== 'unknown') liveProvider.set(fallbackProvider)
  liveModel.set(model)
  return {
    model,
    scope: typeof res?.scope === 'string' ? res.scope : undefined,
    deferred: res?.deferred === true,
    warning: res?.warning ?? undefined,
  }
}

/**
 * Switch model via `config.set`. The caller owns the confirm UI: when this
 * returns `needsConfirm`, show `message` and re-call with `confirmed: true`.
 */
export async function applyModel(params: {
  sessionId: string
  model: string
  provider?: string | null
  scope: ModelScope
  confirmed?: boolean
}): Promise<ApplyModelResult | ApplyModelConfirm> {
  const value = buildModelValue(params.model, params.provider, params.scope)
  const { rpc } = await gw()
  const res = await rpc<{
    key: string
    value?: string | boolean | null
    warning?: string | null
    confirm_required?: boolean | null
    confirm_message?: string | null
    scope?: string | null
    deferred?: boolean | null
  }>('config.set', {
    key: 'model',
    value,
    session_id: params.sessionId,
    ...(params.confirmed ? { confirm_expensive_model: true } : {}),
  })
  const out = interpretModelSwitch(res, params.model, params.provider)
  if ('model' in out) {
    out.scope = out.scope ?? params.scope
    log('info', 'model', `switch -> ${out.model} scope=${out.scope}${out.deferred ? ' (deferred)' : ''}`)
  }
  return out
}

// ── Credentials (unconfigured providers inside the picker) ─────────────────

/** Store an API key for a provider so its models become switchable. */
export async function saveProviderKey(slug: string, apiKey: string, sessionId?: string | null): Promise<ProviderOption> {
  const { rpc } = await gw()
  const res = await rpc<{ provider: ProviderOption }>('model.save_key', {
    slug,
    api_key: apiKey,
    ...(sessionId ? { session_id: sessionId } : {}),
  })
  invalidateModelOptions()
  return res?.provider
}

/** Remove every credential (env keys AND OAuth/pool state) for a provider. */
export async function disconnectProvider(slug: string): Promise<void> {
  const { rpc } = await gw()
  await rpc('model.disconnect', { slug })
  invalidateModelOptions()
}

// ── Reasoning preferences (thinking level / on-off) ────────────────────────

/**
 * The gateway's /reasoning vocabulary (hermes_constants parse_reasoning_effort;
 * 'none' means thinking disabled). Must stay a subset of what `config.set
 * reasoning` accepts or the gateway answers 4002.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface ReasoningPrefs {
  /** What the live chat uses right now (session override, else the saved default). */
  effective: string
  /** Profile-wide default persisted in the server's config.yaml ('' if unknown). */
  global: string
  /** Whether thinking blocks render — global display config, already persistent. */
  display: 'show' | 'hide'
}

/**
 * Read both reasoning layers in one go: the saved default (config.get without a
 * session reads config.yaml) and the session-effective value. Both calls are
 * cheap reads; failures degrade to '' rather than throwing so the Models
 * screen renders whatever it could learn.
 */
export async function fetchReasoningPrefs(sessionId?: string | null): Promise<ReasoningPrefs> {
  const { rpc } = await gw()
  const read = async (sid?: string | null) => {
    try {
      return await rpc<{ value?: string; display?: string }>('config.get', {
        key: 'reasoning',
        ...(sid ? { session_id: sid } : {}),
      })
    } catch (err) {
      log('warn', 'model', `config.get reasoning failed: ${String(err)}`)
      return null
    }
  }
  const [eff, glb] = await Promise.all([sessionId ? read(sessionId) : null, read(null)])
  const display = glb?.display === 'hide' || eff?.display === 'hide' ? 'hide' : 'show'
  liveReasoningDisplay.set(display)
  const effective = typeof eff?.value === 'string' && eff.value ? eff.value : ''
  if (effective) liveReasoning.set(effective)
  return {
    effective,
    global: typeof glb?.value === 'string' && glb.value ? glb.value : '',
    display,
  }
}

/** Where a reasoning pick lands — mirrors `scope` on ConfigSetParams (yolo/reasoning). */
export type ReasoningScope = 'session' | 'global'

/**
 * Apply a thinking level. `global` persists it as the profile default in
 * config.yaml (and updates the live session so it takes effect now); `session`
 * pins only this conversation. 'none' turns thinking off in either scope.
 */
export async function applyReasoning(params: {
  value: ReasoningEffort
  scope: ReasoningScope
  sessionId?: string | null
}): Promise<{ value: string }> {
  const { rpc } = await gw()
  const res = await rpc<{ key: string; value?: string | null }>('config.set', {
    key: 'reasoning',
    value: params.value,
    ...(params.scope === 'global' ? { scope: 'global' } : {}),
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
  })
  const value = typeof res?.value === 'string' && res.value ? res.value : params.value
  liveReasoning.set(value)
  return { value }
}

// ── Profile default model ──────────────────────────────────────────────────

/**
 * The server's saved startup model/provider (config.yaml) — what "Everywhere"
 * picks change. Distinguishes the default from the session's live model, which
 * may carry a session/once-scoped override.
 */
export async function fetchDefaultModel(): Promise<{ model: string; provider: string }> {
  try {
    const { rpc } = await gw()
    const r = await rpc<{ model?: string; provider?: string }>('config.get', { key: 'provider' })
    return {
      model: typeof r?.model === 'string' ? r.model : '',
      provider: typeof r?.provider === 'string' ? r.provider : '',
    }
  } catch (err) {
    log('warn', 'model', `config.get provider failed: ${String(err)}`)
    return { model: '', provider: '' }
  }
}

// ── Sorting helpers for the picker ──────────────────────────────────────────

/** Providers ordered for the picker: current, then configured, then the rest. */
export function rankProviders(providers: ProviderOption[]): ProviderOption[] {
  const score = (p: ProviderOption) =>
    (p.is_current ? 0 : 1) + (p.authenticated ? 0 : 8) + ((p.total_models ?? p.models?.length ?? 0) > 0 ? 0 : 4)
  return [...providers].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

/**
 * Models of one provider ordered for the picker: featured first, then the
 * rest alphabetically. Unavailable models go to the very end (the UI renders
 * them disabled) so the list still tells the truth about the catalog.
 */
export function rankModels(p: ProviderOption): string[] {
  const models = p.models ?? []
  const featured = new Set((p.featured_models ?? []).filter((m) => models.includes(m)))
  const unavailable = new Set(p.unavailable_models ?? [])
  const head: string[] = []
  const body: string[] = []
  const tail: string[] = []
  for (const m of models) {
    if (featured.has(m)) head.push(m)
    else if (unavailable.has(m)) tail.push(m)
    else body.push(m)
  }
  const coll: (a: string[]) => string[] = (list) => list.sort((a, b) => a.localeCompare(b))
  return [...coll(head), ...coll(body), ...coll(tail)]
}
