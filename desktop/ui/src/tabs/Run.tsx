/** Run — local runtime status. Moved from App.tsx (round 4 tab-file
 *  refactor); the one inline style became a token-free utility class. */
import { useState } from 'react'
import type { Cfg, RpcRef } from '../types'

export default function RunTab({ cfg, rpc }: { cfg: Cfg | null; rpc: RpcRef }) {
  const [ping, setPing] = useState<string>('')
  return (
    <div className="page">
      <div className="pagehead"><h2>Run locally</h2></div>
      <div className="card">
        <div className="row"><span className="dim">mode</span><strong>{cfg?.mode}</strong></div>
        <div className="row"><span className="dim">gateway</span><code>{cfg?.wsUrl || '—'}</code></div>
        <div className="row"><span className="dim">token</span><code>{cfg?.token ? '•••• held by this app' : '—'}</code></div>
        <p className="dim mt8">
          The shell spawns the hermes fork (<code>app/hermes-src</code>) on 127.0.0.1:9118 and falls back to
          the machine serve on 9119. Sessions and providers live in the same <code>~/.hermes</code> as the CLI.
        </p>
        <div className="row"><button className="primary" onClick={async () => { try { const r = await rpc.current!('gateway.ping', {}); setPing(r?.ok === true ? 'gateway ok' : JSON.stringify(r)) } catch (e) { setPing(String(e)) } }}>ping gateway</button>{ping && <span className="pill ok">{ping}</span>}</div>
      </div>
    </div>
  )
}
