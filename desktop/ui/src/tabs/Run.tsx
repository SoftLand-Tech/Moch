/** Run — local runtime status: mode, gateway, home, ping latency, log tail. */
import { useState } from 'react'
import type { Cfg, RpcRef } from '../types'

export default function RunTab({ cfg, rpc }: { cfg: Cfg | null; rpc: RpcRef }) {
  const [ping, setPing] = useState('')
  const doPing = async () => {
    setPing('…')
    const t0 = Date.now()
    try {
      const r = await rpc.current!('gateway.ping', {})
      setPing(r?.ok === true ? `ok · ${Date.now() - t0}ms` : JSON.stringify(r))
    } catch (e) { setPing(String(e)) }
  }
  const mode = cfg?.mode ?? '…'
  return (
    <div className="page">
      <div className="pagehead"><h2>Run locally</h2><span className={`pill ${mode === 'fork' ? 'ok' : mode === 'attached' ? 'warn' : ''}`}>{mode}</span></div>
      <div className="card">
        <div className="row"><span className="dim">gateway</span><code>{cfg?.wsUrl || '—'}</code></div>
        <div className="row"><span className="dim">runtime home</span><code>{cfg?.home || '—'}</code></div>
        <div className="row"><span className="dim">token</span><code>{cfg?.token ? '•••• held by this app' : '—'}</code></div>
        <p className="dim" style={{ marginTop: 8 }}>
          The shell runs the phone's embedded gateway (app/python-runtime) over your hermes fork
          (app/hermes-src) in a Moch-owned home — fully local, no relay, nothing external.
        </p>
        <div className="row"><button className="primary" onClick={doPing}>ping gateway</button>{ping && <span className="pill ok">{ping}</span>}</div>
      </div>
      {cfg?.logTail && (
        <details className="card logtail-card">
          <summary className="dim">runtime log (tail)</summary>
          <pre>{cfg.logTail}</pre>
        </details>
      )}
    </div>
  )
}
