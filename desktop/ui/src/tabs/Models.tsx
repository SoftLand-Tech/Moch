/** Models — provider connect/disconnect + the reasoning-effort setting
 *  (config key 'reasoning'; enum from modelState.ts REASONING_EFFORTS). */
import { useEffect, useState } from 'react'
import type { Provider, RpcRef } from '../types'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export default function ModelsTab({ rpc }: { rpc: RpcRef }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [err, setErr] = useState('')
  const [slug, setSlug] = useState(''); const [key, setKey] = useState('')
  const [effort, setEffort] = useState('')
  const [open, setOpen] = useState('')

  const load = async () => { try { setProviders((await rpc.current!('model.options', { include_unconfigured: true })).providers ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => {
    if (!rpc.current) return
    load()
    rpc.current!('config.get', { key: 'reasoning' }).then((r: { value?: string }) => setEffort(r?.value ?? '')).catch(() => { })
  }, [])

  const saveKey = async () => {
    if (!slug.trim() || !key.trim()) return
    setErr('')
    try {
      await rpc.current!('model.save_key', { slug: slug.trim(), api_key: key.trim() })
      setSlug(''); setKey(''); load()
    } catch (e) { setErr(String(e)) }
  }
  const setEffortRpc = async (v: string) => {
    setEffort(v)
    try { await rpc.current!('config.set', { key: 'reasoning', value: v }) } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="page">
      <div className="pagehead"><h2>Models</h2><span className="spacer" /><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}

      <div className="card">
        <div className="row"><span className="dim">Reasoning effort</span></div>
        <div className="row">
          {EFFORTS.map((e) => (
            <button key={e} className={`pill effort${effort === e ? ' on' : ''}`} onClick={() => setEffortRpc(e)}>{e}</button>
          ))}
        </div>
      </div>

      <div className="card form">
        <div className="row">
          <input list="model-slugs" placeholder="provider slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <datalist id="model-slugs">{providers.filter((p) => !p.authenticated && p.auth_type === 'api_key').map((p, i) => <option key={i} value={p.slug ?? p.name ?? ''} />)}</datalist>
          <input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="row"><button className="primary" onClick={saveKey}>Save key</button></div>
      </div>

      {providers.map((p, i) => {
        const id = p.slug ?? p.name ?? String(i)
        return (
          <div key={id} className="card">
            <div className="row">
              <strong>{p.name ?? p.slug}</strong>
              <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>{p.authenticated ? 'connected' : 'not connected'}</span>
              {p.auth_type === 'api_key' && !p.authenticated && <span className="pill dim">api key</span>}
              <span className="spacer" />
              {p.authenticated && (
                open === id ? (
                  <>
                    <button className="ghost danger" onClick={async () => { try { await rpc.current!('model.disconnect', { slug: p.slug }); setOpen(''); load() } catch (e) { setErr(String(e)) } }}>confirm disconnect</button>
                    <button className="ghost" onClick={() => setOpen('')}>cancel</button>
                  </>
                ) : <button className="ghost" onClick={() => setOpen(id)}>disconnect</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
