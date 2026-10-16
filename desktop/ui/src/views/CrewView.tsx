import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import {
  Check, CircleCheck, CircleDot, Clock, GitBranch, KanbanSquare, Loader,
  OctagonAlert, Plus, RefreshCw, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { accentFor, fleetProfiles } from '../lib/fleet'
import {
  assignTask, completeTask, createTask, crewError, displayBotName, fmtWhen,
  refreshCrew, runFailed, runsAtom, tasksAtom,
  type RunEntry, type Task, type TaskStatus,
} from '../lib/crew'

const COLUMNS: { id: TaskStatus; label: string; icon: LucideIcon; color: string }[] = [
  { id: 'ready', label: 'Ready', icon: CircleDot, color: 'var(--accent)' },
  { id: 'running', label: 'Working', icon: Loader, color: 'var(--amber)' },
  { id: 'blocked', label: 'Blocked', icon: OctagonAlert, color: 'var(--red)' },
  { id: 'done', label: 'Done', icon: CircleCheck, color: 'var(--green-soft)' },
]

type Filter = 'all' | TaskStatus

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function CrewView() {
  const tasks = useStore(tasksAtom)
  const runs = useStore(runsAtom)
  const err = useStore(crewError)
  const bots = useStore(fleetProfiles)
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [actionErr, setActionErr] = useState('')

  // Load now, then poll every 20s while the view is visible.
  useEffect(() => {
    void refreshCrew()
    const t = setInterval(() => { if (!document.hidden) void refreshCrew() }, 20000)
    const onVis = () => { if (!document.hidden) void refreshCrew() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const byStatus = useMemo(() => {
    const m: Record<TaskStatus, Task[]> = { ready: [], running: [], blocked: [], done: [] }
    for (const t of tasks) m[t.status].push(t)
    m.ready.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    m.running.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    m.blocked.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    m.done.sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0))
    return m
  }, [tasks])

  const botNames = useMemo(
    () => (bots.length ? bots.map((b) => b.name) : ['default']),
    [bots],
  )

  const manualRefresh = async () => {
    setRefreshing(true)
    try { await refreshCrew() } finally { setRefreshing(false) }
  }

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">Crew</span>
          <span className="row-meta" style={{ marginRight: 4 }}>{tasks.length} tasks</span>
        </div>
        <div className="ctx-body">
          <div className="row-section">Columns</div>
          {COLUMNS.map((c) => (
            <div
              key={c.id}
              className={`row${filter === c.id ? ' active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setFilter((f) => (f === c.id ? 'all' : c.id))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setFilter((f) => (f === c.id ? 'all' : c.id))}
              title={`Highlight the ${c.label.toLowerCase()} column`}
            >
              <c.icon size={14} color={c.color} />
              <span className="row-title">{c.label}</span>
              <span className="row-meta">{byStatus[c.id].length}</span>
            </div>
          ))}
          <div className="row-section">Quick filters</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 10px' }}>
            <button className={`chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
              All · {tasks.length}
            </button>
            {COLUMNS.map((c) => (
              <button key={c.id} className={`chip${filter === c.id ? ' active' : ''}`} onClick={() => setFilter(c.id)}>
                {c.label} · {byStatus[c.id].length}
              </button>
            ))}
          </div>
          <div className="row-section">How it works</div>
          <div style={{ padding: '2px 12px 8px', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.55 }}>
            Agents pick tasks from Ready — Mochi by default, or any bot you assign.
            Runs from the board, cron and delegates land in the ledger below.
          </div>
        </div>
      </aside>

      <main className="focus">
        <div className="focus-head">
          <span style={{ fontWeight: 650, fontSize: 15 }}>Task board</span>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {tasks.length} task{tasks.length === 1 ? '' : 's'} · {botNames.length} hand{botNames.length === 1 ? '' : 's'}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={refreshing} title="Refresh the board and ledger" onClick={() => void manualRefresh()}>
            <RefreshCw size={13} style={refreshing ? { animation: 'spin 0.8s linear infinite' } : undefined} /> Refresh
          </button>
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New task
          </button>
        </div>
        {err ? <div style={{ padding: '6px 18px 8px', fontSize: 12, color: 'var(--red)' }}>{err}</div> : null}
        {actionErr ? <div style={{ padding: err ? '0 18px 8px' : '6px 18px 8px', fontSize: 12, color: 'var(--red)' }}>{actionErr}</div> : null}

        <div className="focus-body" style={{ overflow: 'hidden' }}>
          {tasks.length === 0 && !err ? (
            <div className="empty">
              <KanbanSquare size={30} color="var(--text-faint)" />
              <div className="empty-title">The board is clear</div>
              <div className="empty-sub">
                Tasks you add here are picked up by your agents — Mochi by default,
                or any bot you assign.
              </div>
              <button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> New task</button>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: 1, minHeight: 200, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, padding: '14px 16px 10px' }}>
                {COLUMNS.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex', flexDirection: 'column', minHeight: 0,
                      borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
                      border: '1px solid var(--border-soft)',
                      opacity: filter !== 'all' && filter !== c.id ? 0.4 : 1,
                      transition: 'opacity 140ms',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--border-soft)' }}>
                      <c.icon size={14} color={c.color} />
                      <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-dim)' }}>{c.label}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-faint)', background: 'var(--bg-elev)', borderRadius: 999, padding: '1px 8px' }}>
                        {byStatus[c.id].length}
                      </span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {byStatus[c.id].length === 0 ? (
                        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', textAlign: 'center', padding: '12px 4px', border: '1px dashed var(--border-soft)', borderRadius: 'var(--radius)' }}>
                          Empty
                        </div>
                      ) : (
                        byStatus[c.id].map((t) => (
                          <TaskCard key={t.id} task={t} bots={botNames} onError={setActionErr} />
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <RunLedger runs={runs} />
            </div>
          )}
        </div>
      </main>

      {creating ? (
        <NewTaskModal bots={botNames} onClose={() => setCreating(false)} onError={setActionErr} />
      ) : null}
    </>
  )
}

// ── task card ───────────────────────────────────────────────────────────────

function TaskCard({ task, bots, onError }: { task: Task; bots: string[]; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const done = task.status === 'done'

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); onError('')
    try { await fn() } catch (e) { onError(errText(e)) } finally { setBusy(false) }
  }

  return (
    <div
      onClick={() => setOpen((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && setOpen((v) => !v)}
      style={{
        borderRadius: 'var(--radius)', background: 'var(--bg-elev)',
        border: `1px solid ${open ? 'var(--accent)' : 'var(--border-soft)'}`,
        padding: '9px 11px', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 7,
        opacity: done ? 0.7 : 1,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: done ? 'var(--text-dim)' : 'var(--text)', lineHeight: 1.35, textDecoration: done ? 'line-through' : 'none', wordBreak: 'break-word' }}>
        {task.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          className="chip"
          style={{ cursor: 'inherit', gap: 5, padding: '2px 9px 2px 3px' }}
          title={`Assigned to ${displayBotName(task.assignee)}`}
        >
          <span className="avatar" style={{ width: 16, height: 16, fontSize: 7, borderRadius: '50%', background: accentFor(task.assignee) }}>
            {displayBotName(task.assignee).slice(0, 2)}
          </span>
          {displayBotName(task.assignee)}
        </span>
        {task.priority ? (
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{task.priority}</span>
        ) : null}
        {busy ? <span className="spinner" style={{ width: 10, height: 10, marginLeft: 'auto' }} /> : null}
      </div>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.5, wordBreak: 'break-word' }}>
            {task.body || <span style={{ color: 'var(--text-faint)' }}>No details.</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {!done ? (
              <button className="btn primary sm" disabled={busy} onClick={() => void act(() => completeTask(task.id, `Done: ${task.title}`))}>
                <Check size={12} /> Complete
              </button>
            ) : task.completedAt ? (
              <span style={{ fontSize: 11, color: 'var(--green-soft)' }}>Completed {fmtWhen(task.completedAt)}</span>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Reassign:</span>
            {bots.filter((b) => b !== task.assignee).map((b) => (
              <button
                key={b}
                className="chip"
                style={{ gap: 4, padding: '2px 8px 2px 3px' }}
                disabled={busy}
                title={`Move this task to ${displayBotName(b)}`}
                onClick={() => void act(() => assignTask(task.id, b))}
              >
                <span className="avatar" style={{ width: 14, height: 14, fontSize: 6.5, borderRadius: '50%', background: accentFor(b) }}>
                  {displayBotName(b).slice(0, 2)}
                </span>
                {displayBotName(b)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── run ledger ──────────────────────────────────────────────────────────────

function RunLedger({ runs }: { runs: RunEntry[] }) {
  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', flexShrink: 0, maxHeight: 236, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px 4px' }}>
        <span style={{ fontSize: 12, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Run ledger</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>kanban · cron · delegate</span>
      </div>
      <div style={{ minHeight: 52, maxHeight: 184, overflowY: 'auto', padding: '0 12px 10px' }}>
        {runs.length === 0 ? (
          <div style={{ padding: '8px 8px 2px', fontSize: 12, color: 'var(--text-faint)' }}>
            No runs yet — activity from the board, cron jobs and delegates lands here.
          </div>
        ) : (
          runs.map((r) => {
            const failed = runFailed(r)
            const Icon = r.source === 'cron' ? Clock : r.source === 'delegate' ? GitBranch : KanbanSquare
            return (
              <div
                key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5 }}
                title={r.error || r.title}
              >
                <Icon size={14} color={failed ? 'var(--red)' : 'var(--text-faint)'} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: failed ? 'var(--red)' : 'var(--text-dim)' }}>
                  {r.title}
                </span>
                <span style={{ fontSize: 11.5, color: accentFor(r.profile), whiteSpace: 'nowrap', flexShrink: 0 }}>@{displayBotName(r.profile)}</span>
                <span style={{ fontSize: 11, color: failed ? 'var(--red)' : 'var(--text-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>{r.status}</span>
                <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtWhen(r.ts)}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── new task modal ──────────────────────────────────────────────────────────

function NewTaskModal({ bots, onClose, onError }: { bots: string[]; onClose: () => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('default')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const create = async () => {
    if (!title.trim()) return
    setBusy(true); setErr(''); onError('')
    try {
      await createTask({ title: title.trim(), body: body.trim() || undefined, assignee })
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 520 }} role="dialog" aria-label="New task">
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <KanbanSquare size={15} color="var(--accent)" /> New task
          </span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 6 }}>Title</div>
            <input
              className="input"
              autoFocus
              placeholder="What needs doing?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) void create() }}
            />
          </div>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 6 }}>Details (optional)</div>
            <textarea
              className="input"
              rows={3}
              placeholder="Context, links, constraints — anything the agent needs."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 6 }}>Assign to</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {bots.map((b) => (
                <button
                  key={b}
                  className={`chip${assignee === b ? ' active' : ''}`}
                  style={{ gap: 5, padding: '3px 10px 3px 4px' }}
                  onClick={() => setAssignee(b)}
                >
                  <span className="avatar" style={{ width: 17, height: 17, fontSize: 7.5, borderRadius: '50%', background: accentFor(b) }}>
                    {displayBotName(b).slice(0, 2)}
                  </span>
                  {displayBotName(b)}
                </button>
              ))}
            </div>
          </div>
          {err ? <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div> : null}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void create()}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Plus size={13} />} Create task
          </button>
        </div>
      </div>
    </div>
  )
}
