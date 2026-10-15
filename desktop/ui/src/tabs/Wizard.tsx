/** First-run setup — the desktop twin of the phone's "Use this phone" flow.
 *  Moved verbatim from App.tsx (round 4 tab-file refactor). */
import { useEffect, useState } from 'react'
import { dbg, type Cfg, type Provider, type RpcRef } from '../types'

export default function Wizard({ conn, cfg, rpc, onDone }: { conn: string; cfg: Cfg | null; rpc: RpcRef; onDone: () => void }) {
  const [step, setStep] = useState<'welcome' | 'boot' | 'provider'>('welcome')
  const [providers, setProviders] = useState<Provider[]>([])
  const [slug, setSlug] = useState(''); const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  /** Boot-step fallback: conn still not 'open' after 45s — offer Retry/Skip
   *  instead of an unlabeled spinner the user can't leave. */
  const [bootSlow, setBootSlow] = useState(false)

  useEffect(() => { if (step === 'boot' && conn === 'open') setStep('provider') }, [step, conn])

  useEffect(() => {
    if (step !== 'boot') return
    const t = setTimeout(() => setBootSlow(true), 45_000)
    return () => clearTimeout(t)
  }, [step])

  useEffect(() => {
    if (step !== 'provider' || conn !== 'open') return
    rpc.current!('model.options', { include_unconfigured: true })
      .then((r: any) => { setProviders(r.providers ?? []); setErr('') })
      .catch((e: any) => setErr(String(e)))
  }, [step, conn])

  const saveKey = async () => {
    if (saving || !slug.trim() || !key.trim()) return
    setSaving(true)
    setErr('')
    try {
      await rpc.current!('model.save_key', { slug: slug.trim(), api_key: key.trim() })
      setKey(''); setSlug('')
      const r = await rpc.current!<{ providers?: Provider[] }>('model.options', { include_unconfigured: true })
      setProviders(r.providers ?? [])
      dbg('setup:key-saved', { slug })
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }
  const finish = async () => {
    await fetch('/setup-done', { method: 'POST' }).catch(() => {})
    dbg('setup:done', {})
    onDone()
  }
  /** Boot-dead-end escape: the same onDone path as finish() but WITHOUT the
   *  /setup-done POST (setup stays marked unfinished — the wizard will offer
   *  itself again next launch). The runtime may still be booting; App shows
   *  its live connection state either way. */
  const skip = () => {
    dbg('setup:skip', {})
    onDone()
  }
  const connected = providers.some((p) => p.authenticated)

  if (cfg?.mode === 'error' || conn === 'error') {
    return (
      <div className="wizard">
        <img className="mochi-img" src="/brand/mochi-error.svg" alt="Mochi" />
        <h1>Moch couldn't start its runtime</h1>
        <p className="dim">The fork (app/hermes-src) failed to serve on 127.0.0.1:9118.</p>
        <pre className="logtail">{cfg?.logTail || 'no log'}</pre>
        <button className="primary" onClick={() => location.reload()}>Retry</button>
      </div>
    )
  }

  return (
    <div className="wizard">
      {step === 'welcome' && (
        <>
          <img className="mochi-img" src="/brand/mochi-greeting.svg" alt="Mochi" />
          <h1>Your own agent, on this PC.</h1>
          <p className="dim">
            Moch runs the agent <strong>locally inside this app</strong> — a private runtime with its own
            home, your keys, your sessions. No relay, no phone, nothing leaves this machine.
          </p>
          <button className="primary big-btn" onClick={() => setStep('boot')}>Set up Moch locally</button>
          <p className="dim small">This is the desktop twin of “Use this phone”.</p>
        </>
      )}
      {step === 'boot' && (
        <>
          <img className="mochi-img" src="/brand/mochi-deep-thinking.svg" alt="Mochi" />
          <h1>Starting your runtime…</h1>
          <p className="dim">Booting the agent from <code>app/hermes-src</code> in a Moch-owned home.</p>
          <p className="dim small">mode: {cfg?.mode ?? '…'} · gateway: {cfg?.wsUrl || '…'}</p>
          {bootSlow && (
            <>
              <p className="dim">Still starting… the runtime may still be booting — the app will show its connection state.</p>
              <div className="row">
                <button className="primary" onClick={() => location.reload()}>Retry</button>
                <button className="ghost" onClick={skip}>Skip →</button>
              </div>
            </>
          )}
        </>
      )}
      {step === 'provider' && (
        <>
          <img className="mochi-img" src="/brand/mochi-idea.svg" alt="Mochi" />
          <h1>Connect a model provider</h1>
          <p className="dim">The agent needs a provider key, stored locally in your Moch runtime.</p>
          {err && <div className="err">{err}</div>}
          <div className="providerlist">
            {providers.map((p, i) => (
              <div key={p.slug ?? p.name ?? i} className={`provider ${p.authenticated ? 'ok' : ''}`}>
                <span>{p.name ?? p.slug}</span>
                <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>{p.authenticated ? 'connected' : p.auth_type === 'api_key' ? 'api key' : '—'}</span>
              </div>
            ))}
          </div>
          <div className="card form">
            <div className="row">
              <input list="slugs" placeholder="provider (e.g. openai)" value={slug} onChange={(e) => setSlug(e.target.value)} />
              <datalist id="slugs">{providers.filter((p) => !p.authenticated && p.auth_type === 'api_key').map((p, i) => <option key={i} value={p.slug ?? p.name ?? ''} />)}</datalist>
              <input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="row">
              <button className="primary" disabled={saving || !slug.trim() || !key.trim()} onClick={saveKey}>
                {saving ? 'Saving…' : 'Save key'}
              </button>
              <button className="ghost" disabled={saving} onClick={finish}>{connected ? 'Finish ✓' : 'Skip for now'}</button>
            </div>
          </div>
          {connected && <p className="dim small">Provider connected — you're set. Finish to start chatting.</p>}
        </>
      )}
    </div>
  )
}
