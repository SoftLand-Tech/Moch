/** Run — local runtime status. Round 5: mode badge (the shell's fork /
 *  attached / error states — same .badge variants the sidebar brand uses),
 *  gateway URL, runtime home, masked token, latency ping (Date.now diff),
 *  and the shell's log tail in a collapsible <pre>. */
import { useState } from 'react'

/** Cfg + RpcRef inlined — types.ts is owned by a concurrent pass. */
type Cfg = { wsUrl: string; token: string; mode: string; home?: string; logTail?: string }
type RpcRef = { current: ((m: string, p?: any) => Promise<any>) | null }

export default function RunTab({ cfg, rpc }: { cfg: Cfg | null; rpc: RpcRef }) {
  const [ping, setPing] = useState('')
  const [pingErr, setPingErr] = useState('')

  const doPing = async () => {
    setPing('')
    setPingErr('')
    const t0 = Date.now()
    try {
      const r = await rpc.current!('gateway.ping', {})
      if (r?.ok === true) setPing(`${Date.now() - t0} ms`)
      else setPing(JSON.stringify(r))
    } catch (e) {
      setPingErr(String(e))
    }
  }

  const mode = cfg?.mode ?? '…'
  /** fork = green (default .badge), attached = amber, anything else = red. */
  const badge = mode === 'fork' ? '' : mode === 'attached' ? 'attached' : 'error'

  return (
    <div className="page">
      <div className="pagehead"><h2>Run locally</h2></div>
      <div className="card">
        <div className="row">
          <span className="dim">mode</span>
          <span className={`badge ${badge}`}>{mode}</span>
        </div>
        <div className="row"><span className="dim">gateway</span><code>{cfg?.wsUrl || '—'}</code></div>
        <div className="row"><span className="dim">home</span><code>{cfg?.home || '—'}</code></div>
        <div className="row"><span className="dim">token</span><code>{cfg?.token ? `•••• ${cfg.token.length}-char token held by this app` : '—'}</code></div>
        <div className="row mt8">
          <button className="primary" onClick={doPing}>ping gateway</button>
          {ping && <span className="pill ok">{ping}</span>}
          {pingErr && <span className="pill warn">{pingErr}</span>}
        </div>
        <p className="dim mt8">
          The shell runs the phone’s embedded gateway (<code>app/python-runtime</code>) over your hermes
          fork (<code>app/hermes-src</code>) on 127.0.0.1:9118, falling back to the machine’s serve on
          9119 — fully local, no relay. Sessions and providers live in a Moch-owned runtime home.
        </p>
      </div>
      {cfg?.logTail ? (
        <details className="card">
          <summary className="dim">runtime log (tail)</summary>
          <div className="md"><pre><code>{cfg.logTail}</code></pre></div>
        </details>
      ) : null}
    </div>
  )
}
