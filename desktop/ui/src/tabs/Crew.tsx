/** Crew — kanban board. Moved verbatim from App.tsx (round 4 tab-file
 *  refactor); behavior identical. */
import { useEffect, useState } from 'react'
import type { RpcRef, Task } from '../types'

export default function CrewTab({ rpc }: { rpc: RpcRef }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [err, setErr] = useState('')
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState('')
  const load = async () => { try { setTasks((await rpc.current!('moch.kanban.tasks', { limit: 120 })).tasks ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  const create = async () => {
    if (!title.trim()) return
    try {
      await rpc.current!('moch.kanban.create', { title: title.trim(), body: body.trim(), assignee: assignee.trim() || undefined, idempotency_key: `desk-${Date.now()}` })
      setTitle(''); setBody(''); setAssignee(''); load()
    } catch (e) { setErr(String(e)) }
  }
  return (
    <div className="page">
      <div className="pagehead"><h2>Crew</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <input placeholder="task title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="assignee (bot name, optional)" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        <textarea placeholder="body — what should be done" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row"><button className="primary" onClick={create}>Create task</button></div>
      </div>
      {tasks.map((t, i) => (
        <div key={t.id ?? i} className="card">
          <div className="row">
            <strong>{t.title ?? t.id}</strong>
            {t.assignee && <span className="pill">→ {t.assignee}</span>}
            {t.status && <span className="pill dim">{t.status}</span>}
            <span className="spacer" />
            <button className="ghost" onClick={async () => { await rpc.current!('moch.kanban.complete', { task: t.id ?? t.title }).catch((e) => setErr(String(e))); load() }}>complete</button>
          </div>
          {t.body && <p className="dim">{t.body}</p>}
        </div>
      ))}
    </div>
  )
}
