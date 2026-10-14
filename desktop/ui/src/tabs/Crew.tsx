/** Crew — kanban tasks, phone parity: moch.kanban.tasks/create/complete/assign
 *  (assign params per crew.tsx: {task_id, assignee}). */
import { useEffect, useState } from 'react'
import type { RpcRef, Task } from '../types'

export default function CrewTab({ rpc }: { rpc: RpcRef }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState('')
  const [assigning, setAssigning] = useState<string | null>(null)
  const [assignTo, setAssignTo] = useState('')

  const load = async () => {
    try { setTasks((await rpc.current!('moch.kanban.tasks', { limit: 120 })).tasks ?? []) } catch (e) { setErr(String(e)) }
    try {
      const r = await rpc.current!('profiles.list', {})
      const rows = r.profiles ?? r.items ?? []
      setProfiles(rows.map((p: { name: string }) => p.name).filter((n: string) => n && n !== 'default'))
    } catch { }
  }
  useEffect(() => { if (rpc.current) load() }, [])

  const create = async () => {
    if (!title.trim()) return
    try {
      await rpc.current!('moch.kanban.create', { title: title.trim(), body: body.trim(), assignee: assignee.trim() || undefined, idempotency_key: `desk-${Date.now()}` })
      setTitle(''); setBody(''); setAssignee(''); load()
    } catch (e) { setErr(String(e)) }
  }
  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try { await fn(); load() } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="page">
      <div className="pagehead"><h2>Crew</h2><span className="pill dim">{tasks.length} tasks</span><span className="spacer" /><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <div className="row">
          <input placeholder="task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input placeholder="assignee (bot name, optional)" list="crew-profiles" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
          <datalist id="crew-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
        <textarea placeholder="body — what should be done" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row"><button className="primary" onClick={create}>Create task</button></div>
      </div>
      {tasks.map((t, i) => (
        <div key={t.id ?? i} className="card">
          <div className="row">
            <strong>{t.title ?? t.id}</strong>
            {t.assignee && <span className="pill ok">→ {t.assignee}</span>}
            {t.status && <span className="pill dim">{t.status}</span>}
            <span className="spacer" />
            {assigning === (t.id ?? '') ? (
              <>
                <input list="crew-profiles" placeholder="assign to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} />
                <button className="primary" onClick={async () => { await act(() => rpc.current!('moch.kanban.assign', { task_id: t.id, assignee: assignTo.trim() })); setAssigning(null); setAssignTo('') }}>assign</button>
                <button className="ghost" onClick={() => setAssigning(null)}>cancel</button>
              </>
            ) : (
              <button className="ghost" onClick={() => { setAssigning(t.id ?? ''); setAssignTo(t.assignee ?? '') }}>assign</button>
            )}
            <button className="ghost danger" onClick={() => act(() => rpc.current!('moch.kanban.complete', { task: t.id ?? t.title }))}>complete</button>
          </div>
          {t.body && <p className="dim">{t.body}</p>}
        </div>
      ))}
      {tasks.length === 0 && <div className="empty"><p>No tasks on the board.</p></div>}
    </div>
  )
}
