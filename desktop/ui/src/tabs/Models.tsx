/** Models — provider inventory + keys + reasoning effort. Round 5 mirrors
 *  the RN Models screen (app/app/(tabs)/agent.tsx over app/src/lib/
 *  modelState.ts): provider cards with an authenticated pill, a per-provider
 *  inline API-key form for unconfigured api_key rows (model.save_key),
 *  disconnect (model.disconnect, two-step confirm), the saved default model
 *  line (config.get {key:'provider'}), and the reasoning-effort pill row the
 *  RN screen owns (config.get/config.set {key:'reasoning'}; vocabulary =
 *  modelState.ts REASONING_EFFORTS). Effort writes pass scope:'global' —
 *  this tab holds no chat session id, and modelState.ts (BH-000088) says a
 *  sessionless scoped write must never masquerade as a per-chat pick. */
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
}
/** The gateway's /reasoning vocabulary (modelState.ts REASONING_EFFORTS —
 *  must stay a subset of what config.set reasoning accepts or it 4002s). */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** Picker order (modelState.ts rankProviders): current, configured, rest. */
function rankProviders(ps: ProviderOption[]): ProviderOption[] {
  const score = (p: ProviderOption) =>
    (p.is_current ? 0 : 1) + (p.authenticated ? 0 : 8) + ((p.total_models ?? p.models?.length ?? 0) > 0 ? 0 : 4)
  return [...ps].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
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

  const load = async () => {
    try {
      const r = await rpc.current!('model.options', { include_unconfigured: true })
      setProviders(rankProviders(r.providers ?? []))
      setLive({
        model: typeof r?.model === 'string' ? r.model : '',
        provider: typeof r?.provider === 'string' ? r.provider : '',
      })
    } catch (e) {
      setErr(String(e))
    }
  }

  useEffect(() => {
    if (!rpc.current) return
    void load()
    rpc.current!('config.get', { key: 'reasoning' })
      .then((r: { value?: string }) => { if (typeof r?.value === 'string' && r.value) setEffort(r.value) })
      .catch(() => { /* effort row just stays unselected */ })
    rpc.current!('config.get', { key: 'provider' })
      .then((r: { model?: string; provider?: string }) => setDefaultModel({
        model: typeof r?.model === 'string' ? r.model : '',
        provider: typeof r?.provider === 'string' ? r.provider : '',
      }))
      .catch(() => { /* default line stays hidden */ })
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

  return (
    <div className="page">
      <div className="pagehead"><h2>Models</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}

      {/* Live + saved-default model — the RN screen's MODEL card. */}
      <div className="card">
        <div className="row">
          <strong>{live.model || 'default'}</strong>
          {live.provider && live.provider !== 'unknown' && <span className="pill dim">{live.provider}</span>}
        </div>
        {defaultModel?.model ? (
          <p className="dim">
            Saved everywhere: {defaultModel.model}
            {defaultModel.provider && defaultModel.provider !== 'unknown' ? ` · ${defaultModel.provider}` : ''}
          </p>
        ) : null}
      </div>

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
      {providers.length === 0 && <div className="empty"><p>No provider inventory yet — try refresh.</p></div>}
    </div>
  )
}
