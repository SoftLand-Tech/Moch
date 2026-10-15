/** Models — provider inventory + keys + default-model picker + reasoning effort.
 *  Round 6 mirrors the RN Models screen (app/app/(tabs)/agent.tsx over
 *  app/src/lib/modelState.ts + ModelPickerSheet.tsx): provider cards with an
 *  authenticated pill, a per-provider inline API-key form for unconfigured
 *  api_key rows (model.save_key), disconnect (model.disconnect, two-step
 *  confirm), the saved default model line (config.get {key:'provider'}), and
 *  the reasoning-effort pill row the RN screen owns (config.get/config.set
 *  {key:'reasoning'}; vocabulary = modelState.ts REASONING_EFFORTS). Effort
 *  writes pass scope:'global' — this tab holds no chat session id, and
 *  modelState.ts (BH-000088) says a sessionless scoped write must never
 *  masquerade as a per-chat pick.
 *
 *  Default-model picker (new): the desktop gateway is the SAME embedded
 *  gateway the phone runs (runtime.py → app/python-runtime/moch/
 *  gateway_server.py → hermes_cli.inventory.build_model_options_payload with
 *  featured/capabilities/pricing=True), so `model.options` rows carry the full
 *  per-provider catalog (`models`, `featured_models`, `capabilities`,
 *  `unavailable_models`) — the same candidate source ModelPickerSheet uses.
 *  A pick applies the phone's EXACT wire shape (modelState.ts buildModelValue
 *  + applyModel): `config.set { key:'model', value:"<model> --provider <slug>
 *  --global", session_id }`. The value string carries the scope flag the
 *  gateway parses for /model; scope:'global' as a separate param is reasoning/
 *  yolo-only. The gateway REFUSES a sessionless model set (4001 —
 *  methods_config_set.py _set_model), so a pick first mints a scratch session
 *  via `session.create` (same shape the Automations tab already uses). A
 *  guarded switch answers `confirm_required` + `confirm_message`; the retry
 *  sends `confirm_expensive_model: true`.
 *
 *  M-b1: the initial loads (model.options, reasoning effort, saved default)
 *  used to run once on mount — if the socket was still connecting, the rows
 *  stayed empty forever. Now a boot attempt that finds rpc.current null or a
 *  connection-type rejection retries every 2s for up to 30s; the timer is
 *  cleared on success and unmount. */
import { useEffect, useState } from 'react'

/** RpcRef shape App passes every tab (inlined — types.ts is owned elsewhere). */
type RpcRef = { current: ((m: string, p?: any) => Promise<any>) | null }
/** model.options provider row (modelState.ts ProviderOption subset). */
type ProviderOption = {
  slug: string
  name: string
  models?: string[]
  total_models?: number | null
  is_current?: boolean | null
  auth_type?: string | null
  authenticated?: boolean | null
  key_env?: string | null
  warning?: string | null
  featured_models?: string[] | null
  capabilities?: Record<string, { fast: boolean; reasoning: boolean }> | null
  unavailable_models?: string[] | null
}
/** config.set {key:'model'} response envelope (modelState.ts interpretModelSwitch subset). */
type ModelSetRes = {
  value?: string | boolean | null
  warning?: string | null
  confirm_required?: boolean | null
  confirm_message?: string | null
  scope?: string | null
  deferred?: boolean | null
}
/** The gateway's /reasoning vocabulary (modelState.ts REASONING_EFFORTS —
 *  must stay a subset of what config.set reasoning accepts or it 4002s). */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** M-b1 retry cadence: every 2s, give up after 30s (socket cold-start). */
const RETRY_MS = 2000
const RETRY_WINDOW_MS = 30000

/** Connection-type failure (M-b1): rpc not attached yet, or the client's own
 *  not-connected/closed/connect errors (json-rpc-gateway.ts defaults:
 *  "gateway not connected", "WebSocket connection failed", superseded, closed). */
function isConnErr(rpc: RpcRef, e: unknown): boolean {
  if (!rpc.current) return true
  return /not connected|websocket|socket|superseded|connect|closed|econn|network/i.test(String(e))
}

/** Picker order (modelState.ts rankProviders): current, configured, rest. */
function rankProviders(ps: ProviderOption[]): ProviderOption[] {
  const score = (p: ProviderOption) =>
    (p.is_current ? 0 : 1) + (p.authenticated ? 0 : 8) + ((p.total_models ?? p.models?.length ?? 0) > 0 ? 0 : 4)
  return [...ps].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

/** Models of one provider, picker order (modelState.ts rankModels): featured
 *  first, then the rest alphabetically, unavailable dead last. */
function rankModels(p: ProviderOption): string[] {
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
  const coll = (list: string[]) => list.sort((a, b) => a.localeCompare(b))
  return [...coll(head), ...coll(body), ...coll(tail)]
}

/** The `config.set model` value: "<model> --provider <slug> --global" — the
 *  exact string buildModelValue(model, provider, 'global') puts on the wire
 *  (modelState.ts); the gateway tokenizes it with its own /model parser. */
function buildModelValue(model: string, slug: string): string {
  return [model.trim(), '--provider', slug.trim(), '--global'].join(' ')
}

export default function ModelsTab({ rpc }: { rpc: RpcRef }) {
  const [providers, setProviders] = useState<ProviderOption[]>([])
  /** Top-level model.options echo — the live model/provider pair. */
  const [live, setLive] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  /** Saved everywhere-default (config.get {key:'provider'}). */
  const [defaultModel, setDefaultModel] = useState<{ model: string; provider: string } | null>(null)
  const [effort, setEffort] = useState('')
  const [err, setErr] = useState('')
  const [effortErr, setEffortErr] = useState('')
  /** Slug of the provider whose inline key form is open. */
  const [keyFor, setKeyFor] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [keyErr, setKeyErr] = useState('')
  const [keyOk, setKeyOk] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  /** Slug pending its second (confirm) click on disconnect. */
  const [confirmSlug, setConfirmSlug] = useState('')
  const [busySlug, setBusySlug] = useState('')
  /** Default-model picker state. */
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [pickBusy, setPickBusy] = useState('')
  const [pickOk, setPickOk] = useState('')
  const [pickErr, setPickErr] = useState('')
  /** Guarded-switch confirm pending (confirm_required round-trip). */
  const [confirmPick, setConfirmPick] = useState<{ slug: string; model: string; message: string } | null>(null)
  /** M-b1: true while boot loads are waiting on the socket to come up. */
  const [waiting, setWaiting] = useState(false)

  /** Apply a model.options payload to state (shared by boot + refresh). */
  const applyOptions = (r: { providers?: ProviderOption[]; model?: unknown; provider?: unknown }) => {
    setProviders(rankProviders(r?.providers ?? []))
    setLive({
      model: typeof r?.model === 'string' ? r.model : '',
      provider: typeof r?.provider === 'string' ? r.provider : '',
    })
  }

  /** Re-read the saved everywhere-default (config.get {key:'provider'}). */
  const refreshDefault = () => {
    const r = rpc.current
    if (!r) return
    r('config.get', { key: 'provider' })
      .then((res: { model?: string; provider?: string }) => setDefaultModel({
        model: typeof res?.model === 'string' ? res.model : '',
        provider: typeof res?.provider === 'string' ? res.provider : '',
      }))
      .catch(() => { /* default line just keeps its last value */ })
  }

  /** Manual/post-action refresh: model.options + the saved default. */
  const load = async () => {
    const r = rpc.current
    if (!r) return
    try {
      applyOptions(await r('model.options', { include_unconfigured: true }))
      setErr('')
      refreshDefault()
    } catch (e) {
      setErr(String(e))
    }
  }

  /** M-b1 boot: attempt the initial loads; if the socket is still coming up
   *  (rpc.current null, or a connection-type rejection) retry every 2s for up
   *  to 30s. The timer is cleared on success and on unmount. */
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const attempt = async () => {
      if (stopped) return
      if (!rpc.current) {
        if (Date.now() - startedAt < RETRY_WINDOW_MS) {
          setWaiting(true)
          timer = setTimeout(() => void attempt(), RETRY_MS)
        } else {
          setWaiting(false)
        }
        return
      }
      let retry = false
      try {
        const r = await rpc.current('model.options', { include_unconfigured: true })
        if (stopped) return
        applyOptions(r)
        setErr('')
        setWaiting(false)
        // Cheap sibling reads ride the same success (M-b1 covers these too —
        // they used to fire once and could hit the same dead socket).
        rpc.current('config.get', { key: 'reasoning' })
          .then((res: { value?: string }) => { if (typeof res?.value === 'string' && res.value) setEffort(res.value) })
          .catch(() => { /* effort row just stays unselected */ })
        refreshDefault()
      } catch (e) {
        if (stopped) return
        if (isConnErr(rpc, e) && Date.now() - startedAt < RETRY_WINDOW_MS) {
          retry = true
          setWaiting(true)
        } else {
          setErr(String(e))
          setWaiting(false)
        }
      }
      if (retry && !stopped) timer = setTimeout(() => void attempt(), RETRY_MS)
    }
    void attempt()
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
  }, [])

  const pickEffort = async (v: string) => {
    const prev = effort
    setEffort(v)
    setEffortErr('')
    try {
      await rpc.current!('config.set', { key: 'reasoning', value: v, scope: 'global' })
    } catch (e) {
      setEffort(prev)
      setEffortErr(String(e))
    }
  }

  /** Make <model> the everywhere default: the phone's applyModel('global')
   *  wire shape. The gateway refuses sessionless model sets (4001), so mint a
   *  scratch session first (the Automations tab's session.create shape). */
  const pickModel = async (p: ProviderOption, m: string, confirmed = false) => {
    const r = rpc.current
    if (!r || pickBusy) return
    setPickBusy(`${p.slug}:${m}`)
    setPickErr('')
    setPickOk('')
    setConfirmPick(null)
    try {
      const cr: { session_id?: string } = await r('session.create', { title: 'model-pick', cols: 120, source: 'mobile' })
      const sid = cr?.session_id
      if (!sid) throw new Error('session.create returned no session_id')
      const res: ModelSetRes = await r('config.set', {
        key: 'model',
        value: buildModelValue(m, p.slug),
        session_id: sid,
        ...(confirmed ? { confirm_expensive_model: true } : {}),
      })
      if (res?.confirm_required && res?.confirm_message) {
        // Guarded switch (expensive model / catalog warning): the gateway
        // wrote nothing yet — ask, then retry with the confirm flag.
        setConfirmPick({ slug: p.slug, model: m, message: String(res.confirm_message) })
        return
      }
      const applied = typeof res?.value === 'string' && res.value ? res.value : m
      setPickOk(`Default model set to ${applied} — everywhere (new chats + the phone).${res?.warning ? ` ${res.warning}` : ''}`)
      await load()
    } catch (e) {
      setPickErr(String(e))
    } finally {
      setPickBusy('')
    }
  }

  const saveKey = async (p: ProviderOption) => {
    if (!keyValue.trim() || keyBusy) return
    setKeyBusy(true)
    setKeyErr('')
    setKeyOk('')
    try {
      await rpc.current!('model.save_key', { slug: p.slug, api_key: keyValue.trim() })
      setKeyFor('')
      setKeyValue('')
      setKeyOk(`${p.name} key saved — its models are switchable now.`)
      await load()
    } catch (e) {
      setKeyErr(String(e))
    } finally {
      setKeyBusy(false)
    }
  }

  const disconnect = async (p: ProviderOption) => {
    setBusySlug(p.slug)
    setConfirmSlug('')
    setErr('')
    setKeyOk('')
    try {
      await rpc.current!('model.disconnect', { slug: p.slug })
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusySlug('')
    }
  }

  const openKeyForm = (slug: string) => {
    setKeyFor(slug)
    setKeyValue('')
    setKeyErr('')
    setKeyOk('')
  }

  const connected = providers.filter((p) => p.authenticated).length

  // The everywhere default: prefer the live model.options echo, fall back to
  // the saved config (they diverge only under a session/once-scoped override).
  const currentModel = live.model || defaultModel?.model || ''
  const currentProvider =
    (live.provider && live.provider !== 'unknown' ? live.provider : '') ||
    (defaultModel?.provider && defaultModel.provider !== 'unknown' ? defaultModel.provider : '')
  const pickable = providers.filter((p) => p.authenticated)

  return (
    <div className="page">
      <div className="pagehead"><h2>Models</h2><button className="ghost" onClick={() => void load()}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      {waiting && <div className="notice">Connecting to the gateway — retrying every 2s for up to 30s…</div>}

      {/* Default model — the RN screen's MODEL card, now with the picker. */}
      <div className="card">
        <div className="row">
          <strong>Default model</strong>
          {currentModel ? (
            <span className="pill ok">{currentModel}{currentProvider ? ` · ${currentProvider}` : ''}</span>
          ) : (
            <span className="pill warn">none saved</span>
          )}
        </div>
        <p className="dim">Pick a model below to make it the everywhere default (config.set model --global).</p>
        {defaultModel?.model ? (
          <p className="dim">
            Saved everywhere: {defaultModel.model}
            {defaultModel.provider && defaultModel.provider !== 'unknown' ? ` · ${defaultModel.provider}` : ''}
          </p>
        ) : null}
        {pickOk && <div className="row mt8"><span className="pill ok">{pickOk}</span></div>}
        {pickErr && <div className="notice mt8">{pickErr}</div>}
        {confirmPick && (
          <div className="form mt8">
            <div className="notice">{confirmPick.message}</div>
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  const p = providers.find((x) => x.slug === confirmPick.slug)
                  if (p) void pickModel(p, confirmPick.model, true)
                }}
              >
                use it anyway
              </button>
              <button className="ghost" onClick={() => setConfirmPick(null)}>cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Per-provider model lists — ModelPickerSheet's model step, flattened. */}
      {pickable.length > 0 && <div className="sec">Pick a default · connected providers</div>}
      {pickable.map((p) => {
        const q = (filters[p.slug] ?? '').trim().toLowerCase()
        const unavailable = new Set(p.unavailable_models ?? [])
        const caps = p.capabilities ?? {}
        const shown = rankModels(p).filter((m) => !q || m.toLowerCase().includes(q))
        const curProviderHere = currentProvider === p.slug
        return (
          <div key={`pick-${p.slug}`} className="card">
            <div className="row">
              <strong>{p.name}</strong>
              <span className="pill dim">{p.total_models ?? p.models?.length ?? 0} models</span>
              {pickBusy.startsWith(`${p.slug}:`) && <span className="pill dim">switching…</span>}
            </div>
            <div className="row mt8">
              <input
                className="mini-search"
                placeholder={`Filter ${p.name} models…`}
                value={filters[p.slug] ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, [p.slug]: e.target.value }))}
              />
            </div>
            <div className="skillsbox mt8">
              {shown.map((m) => {
                const off = unavailable.has(m)
                const cap = caps[m]
                return (
                  <button
                    key={m}
                    className={`chip ${curProviderHere && currentModel === m ? 'on' : ''}`}
                    disabled={off || !!pickBusy}
                    title={off ? 'Currently unavailable on this provider' : `Set ${m} as the default`}
                    onClick={() => void pickModel(p, m)}
                  >
                    {m}{cap?.fast ? ' ⚡' : ''}{cap?.reasoning ? ' 🧠' : ''}
                  </button>
                )
              })}
              {shown.length === 0 && <span className="dim">No models match “{filters[p.slug]}”.</span>}
            </div>
          </div>
        )
      })}
      {providers.length > 0 && pickable.length === 0 && (
        <p className="dim">Connect a provider below to pick its models.</p>
      )}

      {/* Reasoning effort — the RN Models screen owns this control. */}
      <div className="card">
        <div className="row">
          <strong>Reasoning effort</strong>
          {effort && <span className="pill dim">default: {effort}</span>}
        </div>
        <p className="dim">Thinking level, saved as the everywhere default (config.set reasoning, global scope).</p>
        <div className="row mt8">
          {EFFORTS.map((e) => (
            <button key={e} className={`chip ${effort === e ? 'on' : ''}`} onClick={() => void pickEffort(e)}>{e}</button>
          ))}
        </div>
        {effortErr && <div className="notice mt8">{effortErr}</div>}
      </div>

      <div className="row">
        <strong>Providers</strong>
        <span className="pill dim">{connected} connected · {providers.length} total</span>
      </div>
      {keyOk && <div className="notice">{keyOk}</div>}
      {providers.map((p) => {
        const count = p.total_models ?? p.models?.length ?? 0
        const apiKeyable = !p.authenticated && p.auth_type === 'api_key'
        return (
          <div key={p.slug} className="card">
            <div className="row">
              <strong>{p.name}</strong>
              {p.is_current && <span className="pill">active</span>}
              <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>
                {p.authenticated ? 'connected' : 'not connected'}
              </span>
              {p.auth_type && <span className="pill dim">{p.auth_type.replace(/_/g, ' ')}</span>}
            </div>
            <p className="dim">{count} model{count === 1 ? '' : 's'} · <code>{p.slug}</code></p>
            {p.authenticated ? (
              <div className="row mt8">
                {busySlug === p.slug ? (
                  <span className="pill dim">disconnecting…</span>
                ) : confirmSlug === p.slug ? (
                  <>
                    <button className="ghost confirm" onClick={() => void disconnect(p)}>confirm disconnect</button>
                    <button className="ghost" onClick={() => setConfirmSlug('')}>cancel</button>
                  </>
                ) : (
                  <button className="ghost danger" onClick={() => setConfirmSlug(p.slug)}>disconnect</button>
                )}
              </div>
            ) : apiKeyable ? (
              keyFor === p.slug ? (
                <div className="form mt8">
                  <div className="row">
                    <input
                      type="password"
                      placeholder={p.key_env ? `${p.key_env} — paste key…` : 'Paste API key…'}
                      value={keyValue}
                      onChange={(e) => { setKeyValue(e.target.value); if (keyErr) setKeyErr('') }}
                    />
                  </div>
                  {keyErr && <div className="notice">{keyErr}</div>}
                  <div className="row">
                    <button className="primary" disabled={!keyValue.trim() || keyBusy} onClick={() => void saveKey(p)}>
                      {keyBusy ? 'saving…' : 'Save key'}
                    </button>
                    <button className="ghost" disabled={keyBusy} onClick={() => setKeyFor('')}>cancel</button>
                  </div>
                </div>
              ) : (
                <div className="row mt8">
                  <button className="ghost" onClick={() => openKeyForm(p.slug)}>add API key</button>
                </div>
              )
            ) : (
              <p className="dim">{p.warning ?? 'Signs in another way (OAuth or a host tool) — set it up on the computer, in the agent’s own settings.'}</p>
            )}
          </div>
        )
      })}
      {providers.length === 0 && !waiting && <div className="empty"><p>No provider inventory yet — try refresh.</p></div>}
    </div>
  )
}
