/** Models — provider keys. Moved verbatim from App.tsx (round 4 tab-file
 *  refactor); behavior identical. */
import { useEffect, useState } from 'react'
import type { Provider, RpcRef } from '../types'

export default function ModelsTab({ rpc }: { rpc: RpcRef }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [err, setErr] = useState('')
  const [slug, setSlug] = useState(''); const [key, setKey] = useState('')
  const load = async () => { try { setProviders((await rpc.current!('model.options', { include_unconfigured: true })).providers ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  return (
    <div className="page">
      <div className="pagehead"><h2>Models</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <div className="row"><input placeholder="provider slug" value={slug} onChange={(e) => setSlug(e.target.value)} /><input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} /></div>
        <div className="row"><button className="primary" onClick={async () => { try { await rpc.current!('model.save_key', { slug: slug.trim(), api_key: key }); setSlug(''); setKey(''); load() } catch (e) { setErr(String(e)) } }}>Save key</button></div>
      </div>
      {providers.map((p, i) => (
        <div key={p.slug ?? p.name ?? i} className="card">
          <div className="row">
            <strong>{p.name ?? p.slug}</strong>
            <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>{p.authenticated ? 'connected' : 'not connected'}</span>
            {p.auth_type === 'api_key' && !p.authenticated && <span className="pill dim">api key</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
