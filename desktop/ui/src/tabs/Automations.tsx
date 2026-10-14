/** Automations — cron.manage list/pause/resume/remove/add + run-now via
 *  slash.exec '/cron run <job_id>' (the RN screen's exact mechanism:
 *  automations.tsx line 146). */
import { useEffect, useRef, useState } from 'react'
import type { Job, RpcRef } from '../types'

function toMs(ts?: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  return ts > 1e12 ? ts : ts * 1000
}
function relIn(ts?: number): string {
  const ms = toMs(ts)
  if (!ms) return ''
  const s = Math.floor((ms - Date.now()) / 1000)
  if (s <= 0) return 'due'
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`
  return `in ${Math.floor(s / 86400)}d`
}

export default function AutomationsTab({ rpc }: { rpc: RpcRef }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [name, setName] = useState(''); const [schedule, setSchedule] = useState('every 30m'); const [prompt, setPrompt] = useState('')
  const cronSession = useRef('')

  const load = async () => { try { setJobs((await rpc.current!('cron.manage', { action: 'list', include_disabled: true })).jobs ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])

  /** slash.exec needs a live session id — mint one lazily and reuse it. */
  const cronSlash = async (command: string) => {
    if (!cronSession.current) {
      const s = await rpc.current!('session.create', { title: 'automations', cols: 120, source: 'mobile' })
      cronSession.current = s.session_id
    }
    return rpc.current!('slash.exec', { session_id: cronSession.current, command })
  }

  const add = async () => {
    if (!name.trim() || !prompt.trim()) return
    setErr('')
    try { await rpc.current!('cron.manage', { action: 'add', name: name.trim(), schedule, prompt }); setName(''); setPrompt(''); load() } catch (e) { setErr(String(e)) }
  }
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr('')
    try { await fn(); await load() } catch (e) { setErr(String(e)) } finally { setBusy('') }
  }

  return (
    <div className="page">
      <div className="pagehead"><h2>Automations</h2><span className="pill dim">{jobs.filter((j) => j.enabled !== false).length} running</span><span className="spacer" /><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <div className="row"><input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} /><input placeholder="schedule (every 30m, every monday 9:00…)" value={schedule} onChange={(e) => setSchedule(e.target.value)} /></div>
        <textarea placeholder="prompt — what should run" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row"><button className="primary" onClick={add}>Create automation</button></div>
      </div>
      {jobs.map((j) => (
        <div key={j.job_id} className="card">
          <div className="row">
            <strong>{j.name ?? j.job_id}</strong>
            {j.enabled === false ? <span className="pill warn">paused</span> : <span className="pill ok">running</span>}
            {j.schedule && <span className="pill dim">{j.schedule}</span>}
            {j.next_run ? <span className="pill dim">{relIn(typeof j.next_run === 'string' ? Date.parse(j.next_run) / 1000 : j.next_run)}</span> : null}
            <span className="spacer" />
            <button className="ghost" disabled={!!busy} onClick={() => act(`run:${j.job_id}`, () => cronSlash(`/cron run ${j.job_id}`))}>{busy === `run:${j.job_id}` ? 'running…' : 'run now'}</button>
            <button className="ghost" disabled={!!busy} onClick={() => act(`t:${j.job_id}`, () => rpc.current!('cron.manage', { action: j.enabled === false ? 'resume' : 'pause', name: j.job_id }))}>
              {j.enabled === false ? 'resume' : 'pause'}
            </button>
            <button className="ghost danger" disabled={!!busy} onClick={() => act(`rm:${j.job_id}`, () => rpc.current!('cron.manage', { action: 'remove', name: j.job_id }))}>remove</button>
          </div>
          {j.prompt && <p className="dim">{j.prompt}</p>}
        </div>
      ))}
      {jobs.length === 0 && <div className="empty"><p>No automations yet.</p></div>}
    </div>
  )
}
