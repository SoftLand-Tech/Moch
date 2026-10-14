/** Automations — cron jobs. Moved verbatim from App.tsx (round 4 tab-file
 *  refactor); behavior identical. */
import { useEffect, useState } from 'react'
import type { Job, RpcRef } from '../types'

export default function AutomationsTab({ rpc }: { rpc: RpcRef }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState('')
  const [name, setName] = useState(''); const [schedule, setSchedule] = useState('every 30m'); const [prompt, setPrompt] = useState('')
  const load = async () => { try { setJobs((await rpc.current!('cron.manage', { action: 'list', include_disabled: true })).jobs ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  const add = async () => {
    if (!name.trim() || !prompt.trim()) return
    try { await rpc.current!('cron.manage', { action: 'add', name: name.trim(), schedule, prompt }); setName(''); setPrompt(''); load() } catch (e) { setErr(String(e)) }
  }
  return (
    <div className="page">
      <div className="pagehead"><h2>Automations</h2><button className="ghost" onClick={load}>refresh</button></div>
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
            {j.enabled === false && <span className="pill">paused</span>}
            {j.schedule && <span className="pill dim">{j.schedule}</span>}
            <span className="spacer" />
            <button className="ghost" onClick={async () => { await rpc.current!('cron.manage', { action: j.enabled === false ? 'resume' : 'pause', name: j.job_id }); load() }}>
              {j.enabled === false ? 'resume' : 'pause'}
            </button>
            <button className="ghost danger" onClick={async () => { await rpc.current!('cron.manage', { action: 'remove', name: j.job_id }); load() }}>remove</button>
          </div>
          {j.prompt && <p className="dim">{j.prompt}</p>}
        </div>
      ))}
    </div>
  )
}
