/**
 * Crew — kanban board + merged run ledger, phone parity with
 * app/(tabs)/crew.tsx: tasks grouped into Ready / Working / Blocked /
 * Done columns; clicking a task expands it to Complete (human override —
 * the server force-completes past live claims) and Reassign chips
 * (Moch = the 'default' profile + fleet roster; frozen bots are refused
 * server-side, disabled here). moch.runs.timeline (limit 40) is the
 * page-level run ledger footer the phone renders under the board — one
 * cheap RPC, so it is always shown. The create box always sends an
 * idempotency key (the server dedupes retries); assignee is REQUIRED
 * gateway-side (the dispatcher only spawns assigned rows).
 */
import { useEffect, useMemo, useState } from 'react'
import { relTime, type FleetProfile, type FleetStatus, type RpcRef, type Run, type Task } from '../types'
import Markdown from '../Markdown'

/** Board columns (RN COLUMNS) — unknown statuses bucket into Ready. */
const COLUMNS: { key: string; label: string }[] = [
  { key: 'ready', label: 'Ready' },
  { key: 'running', label: 'Working' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
]

const colOf = (t: Task): string =>
  t.status === 'running' ? 'running'
    : t.status === 'blocked' ? 'blocked'
      : t.status === 'done' || t.status === 'complete' ? 'done'
        : 'ready'

const isDone = (t: Task): boolean => t.status === 'done' || t.status === 'complete'

/** Status pill tone (Mocheme: ok=green, warn=amber). */
const statusPill = (t: Task): string => {
  const s = t.status ?? ''
  if (s === 'done' || s === 'complete') return 'pill ok'
  if (s === 'blocked') return 'pill warn'
  if (s === 'running') return 'pill'
  return 'pill dim'
}

/** 'default' renders as Moch (RN crew.moch); missing assignee → unassigned. */
const assigneeLabel = (a?: string): string => (!a ? 'unassigned' : a === 'default' ? 'Moch' : a)

/** Retry-safe create key (RN newIdempotencyKey — the server dedupes on it). */
const newIdempotencyKey = (): string => `desk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Ledger run → pill tone (failed/blocked get the warn wash, red on phone). */
const runPill = (r: Run): string => {
  const s = r.status ?? ''
  if (s === 'failed' || s === 'blocked' || s === 'error') return 'pill warn'
  if (s === 'done' || s === 'complete' || s === 'succeeded' || s === 'ok') return 'pill ok'
  return 'pill dim'
}

export default function CrewTab({ rpc }: { rpc: RpcRef }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [roster, setRoster] = useState<FleetProfile[]>([])
  const [frozenStatus, setFrozenStatus] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const [actionErr, setActionErr] = useState('')
  // create box
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('default')
  const [busy, setBusy] = useState(false)
  // expanded task actions
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyTask, setBusyTask] = useState<string | null>(null)

  const load = async () => {
    const r = rpc.current; if (!r) return
    setErr('')
    try {
      setTasks((await r('moch.kanban.tasks', { limit: 120 })).tasks ?? [])
    } catch (e) { setErr(String(e)) }
    // The ledger needs the fleet runtime armed — the board alone is still
    // useful, so a timeline failure is silent (RN parity).
    try { setRuns((await r('moch.runs.timeline', { limit: 40 })).runs ?? []) } catch { /* optional */ }
    try {
      const lst = await r('profiles.list', {})
      setRoster(lst.profiles ?? lst.items ?? (Array.isArray(lst) ? lst : []))
    } catch { /* picker falls back to Moch alone */ }
    const fs: FleetStatus | null = await r('moch.fleet.status', {}).catch(() => null)
    setFrozenStatus(new Set((fs?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name)))
  }
  useEffect(() => { if (rpc.current) void load() }, [])

  /** Frozen = fleet status OR the profile row's own flag (Bots tab parity). */
  const frozenSet = useMemo(() => {
    const s = new Set(frozenStatus)
    for (const p of roster) if (p.frozen) s.add(p.name)
    return s
  }, [frozenStatus, roster])

  /** Assignee chips: Moch (the launch profile) + every fleet bot. */
  const assignees = useMemo(
    () => [{ name: 'default', label: 'Moch' }, ...roster.map((p) => ({ name: p.name, label: p.name }))],
    [roster],
  )

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {}
    for (const t of tasks) (m[colOf(t)] ??= []).push(t)
    return m
  }, [tasks])

  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true); setActionErr('')
    try {
      await rpc.current!('moch.kanban.create', {
        title: title.trim(),
        body: body.trim(),
        assignee, // required — the dispatcher only spawns assigned rows
        idempotency_key: newIdempotencyKey(),
      })
      setTitle(''); setBody('')
      await load()
    } catch (e) {
      setActionErr(`Action failed: ${String(e)}`)
    } finally { setBusy(false) }
  }

  const complete = async (t: Task) => {
    if (!t.id || busyTask) return
    setBusyTask(t.id); setActionErr('')
    try {
      await rpc.current!('moch.kanban.complete', {
        task_id: t.id,
        summary: 'completed from the desktop (human override)',
      })
      setExpanded(null)
      await load()
    } catch (e) {
      setActionErr(`Action failed: ${String(e)}`)
    } finally { setBusyTask(null) }
  }

  const reassign = async (t: Task, to: string) => {
    if (!t.id || busyTask || to === t.assignee) return
    setBusyTask(t.id); setActionErr('')
    try {
      await rpc.current!('moch.kanban.assign', { task_id: t.id, assignee: to })
      await load()
    } catch (e) {
      setActionErr(`Action failed: ${String(e)}`)
    } finally { setBusyTask(null) }
  }

  return (
    <div className="page">
      <div className="pagehead"><h2>Crew</h2><button className="ghost" onClick={() => void load()}>refresh</button></div>
      <p className="dim">Tasks are dispatched to their assignee — a created task starts within ~a minute.</p>
      {err && <div className="err">{err}</div>}
      {actionErr && <div className="err">{actionErr}</div>}

      <div className="card form">
        <input placeholder="task title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="body — what should be done (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="assignrow">
          <span className="assignlabel">ASSIGN TO</span>
          <div className="row">
            {assignees.map((a) => (
              <button key={a.name} type="button" className={`chip${assignee === a.name ? ' on' : ''}`}
                disabled={frozenSet.has(a.name)} onClick={() => setAssignee(a.name)}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => void create()} disabled={!title.trim() || busy}>
            {busy ? 'Putting on board…' : 'Put on board'}
          </button>
        </div>
      </div>

      {tasks.length === 0 && !err && (
        <div className="empty"><div className="mochi">(●ᴗ●)</div><p>Nothing on the board — put a task on it above.</p></div>
      )}

      {COLUMNS.map((col) => {
        const list = byStatus[col.key] ?? []
        return (
          <div key={col.key} className="card">
            <div className="colhead"><h3>{col.label}</h3><span className="pill">{list.length}</span></div>
            {list.length === 0 ? (
              <p className="colempty">—</p>
            ) : (
              list.map((t, i) => {
                const key = t.id ?? `i${i}`
                const open = expanded === key
                const done = isDone(t)
                const isBusy = !!t.id && busyTask === t.id
                return (
                  <div key={key} className={`task${open ? ' open' : ''}`}>
                    <button type="button" className="taskhead"
                      onClick={() => { setActionErr(''); setExpanded(open ? null : key) }}>
                      <strong>{t.title ?? t.id}</strong>
                      <span className="taskmeta">
                        <span className="pill">{assigneeLabel(t.assignee)}</span>
                        {(t.status ?? t.state) && <span className={statusPill(t)}>{t.status ?? t.state}</span>}
                        {t.id && <span className="taskid">{t.id.slice(0, 8)}</span>}
                      </span>
                    </button>
                    {open && t.body && <div className="dim taskbody"><Markdown text={t.body} /></div>}
                    {open && !done && (
                      <>
                        <div className="row mt8">
                          <button type="button" className="primary" disabled={!t.id || isBusy} onClick={() => void complete(t)}>
                            {isBusy ? '…' : 'Complete'}
                          </button>
                        </div>
                        <div className="assignrow">
                          <span className="assignlabel">REASSIGN</span>
                          <div className="row">
                            {assignees.map((a) => (
                              <button key={a.name} type="button"
                                className={`chip${t.assignee === a.name ? ' on' : ''}`}
                                disabled={isBusy || !t.id || frozenSet.has(a.name) || a.name === t.assignee}
                                onClick={() => void reassign(t, a.name)}>
                                {a.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )
      })}

      {/* Run ledger — merged kanban + cron + delegation runs. Page-level
          footer on the phone (crew.tsx ListFooterComponent); cheap single
          RPC, so no collapse needed. */}
      <div className="card">
        <div className="colhead"><h3>Run ledger</h3><span className="pill">{runs.length}</span></div>
        {runs.length === 0 ? (
          <p className="colempty">No runs recorded yet.</p>
        ) : (
          <div className="ledger">
            {runs.map((r, i) => (
              <div key={`${r.source}-${r.id}-${i}`} className="lrow" title={r.error || undefined}>
                <span className="lsrc">{r.source}</span>
                <span className="ltitle">{r.title || r.id}{r.profile ? ` · @${r.profile}` : ''}</span>
                <span className={runPill(r)}>{r.status}</span>
                <span className="lwhen">{relTime(r.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
