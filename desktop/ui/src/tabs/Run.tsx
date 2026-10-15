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
  const [pinging, setPinging] = useState(false)

  const doPing = async () => {
    if (pinging || !rpc.current) return
    setPing(''); setPingErr(''); setPinging(true)
    const t0 = Date.now()
    // R1: a dead gateway must not hold the button for the default 120s
    // request timeout. The protocol client does accept a per-call
    // timeoutMs (json-rpc-gateway.ts request(method, params, timeoutMs)),
    // but the App-level rpc wrapper forwards only (method, params), so
    // race a 3s client-side cap here instead.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no reply within 3s')), 3000)
    })
    timeout.catch(() => { /* loser of the race — already surfaced */ })
    try {
      const call = rpc.current('gateway.ping', {})
      call.catch(() => { /* rejection is delivered via the race */ })
      const r = await Promise.race([call, timeout])
      if (r?.ok === true) setPing(`${Date.now() - t0} ms`)
      else setPing(JSON.stringify(r))
    } catch (e) {
      setPingErr(String(e))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      setPinging(false)
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
          <button className="primary" onClick={doPing} disabled={pinging}>
            {pinging ? 'pinging…' : 'ping gateway'}
          </button>
          {/* Honest reconnect affordance: the UI dials once at boot; when the
              gateway came up late (or moved), reloading re-runs the handshake. */}
          <button className="ghost" onClick={() => location.reload()}>Restart UI</button>
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
