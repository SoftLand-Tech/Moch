import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { CalendarClock, CircleAlert, Clock, Pencil, Pause, Play, Plus, Trash, X, Zap } from 'lucide-react'
import {
  AUTOMATION_TEMPLATES, createAutomation, deleteAutomation, errMsg, fmtWhen, getAutomation,
  listAutomations, runAutomationNow, setAutomationEnabled, updateAutomation, type CronJob,
} from '../lib/automations'
import { isConnected } from '../lib/gateway'

interface ModalState {
  job: CronJob | null
  schedule: string
  prompt: string
}

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 650,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  marginBottom: 6,
}

export default function AutomationsView() {
  const connected = useStore(isConnected)
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fullPrompts, setFullPrompts] = useState<Record<string, string>>({})
  const [fetchingPrompt, setFetchingPrompt] = useState(false)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const [modal, setModal] = useState<ModalState | null>(null)
  const [saveError, setSaveError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selected = jobs.find((j) => j.id === selectedId) ?? null

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const list = await listAutomations()
      setJobs(list)
      setListError('')
      setSelectedId((prev) => {
        if (prev && list.some((j) => j.id === prev)) return prev
        return list[0]?.id ?? null
      })
    } catch (e) {
      setListError(errMsg(e))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  // Slow poll (never faster than 30s) keeps next-run times fresh.
  useEffect(() => {
    const t = setInterval(() => {
      if (connected) void refresh(true)
    }, 60_000)
    return () => clearInterval(t)
  }, [connected, refresh])

  // Opening a job pulls the FULL prompt (list ships a 100-char preview).
  useEffect(() => {
    if (!selected) return
    if (fullPrompts[selected.id] !== undefined) return
    let cancelled = false
    setFetchingPrompt(true)
    void getAutomation(selected.id)
      .then((j) => {
        if (!cancelled && j) setFullPrompts((prev) => ({ ...prev, [j.id]: j.promptFull ?? j.prompt }))
      })
      .finally(() => {
        if (!cancelled) setFetchingPrompt(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, fullPrompts])

  // Escape closes the modal.
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  const runAction = async (what: string, fn: () => Promise<void>, after?: () => void) => {
    setBusy(what)
    setActionError('')
    try {
      await fn()
      after?.()
      await refresh(true)
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setBusy('')
    }
  }

  const openNew = (prefill?: { schedule: string; prompt: string }) => {
    setSaveError('')
    setModal({ job: null, schedule: prefill?.schedule ?? '', prompt: prefill?.prompt ?? '' })
  }

  const openEdit = () => {
    if (!selected) return
    setSaveError('')
    setModal({
      job: selected,
      schedule: selected.schedule === '—' ? '' : selected.schedule,
      prompt: fullPrompts[selected.id] ?? selected.prompt,
    })
  }

  const save = async () => {
    if (!modal) return
    const schedule = modal.schedule.trim()
    const prompt = modal.prompt.trim()
    if (!schedule || !prompt) return
    setBusy('save')
    setSaveError('')
    try {
      if (modal.job) {
        await updateAutomation(modal.job.id, {
          schedule,
          prompt,
          deliver: modal.job.deliver ?? undefined,
          skills: modal.job.skills,
          name: modal.job.name,
        })
      } else {
        await createAutomation({ schedule, prompt })
      }
      setModal(null)
      setFullPrompts({})
      await refresh(true)
    } catch (e) {
      setSaveError(errMsg(e))
    } finally {
      setBusy('')
    }
  }

  const armDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3500)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmDelete(false)
    if (!selected) return
    void runAction('delete', () => deleteAutomation(selected.id), () => setSelectedId(null))
  }

  const promptText = selected ? (fullPrompts[selected.id] ?? selected.prompt) : ''

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">Automations</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title="New automation" onClick={() => openNew()}>
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {loading ? (
            <div style={{ padding: '14px 12px', display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)' }}>
              <span className="spinner" style={{ width: 12, height: 12 }} /> loading…
            </div>
          ) : listError ? (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6 }}>
              <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {listError}
            </div>
          ) : jobs.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Nothing runs on a schedule yet.
            </div>
          ) : (
            jobs.map((j) => (
              <div
                key={j.id}
                className={`row${selectedId === j.id ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(j.id)}
                onKeyDown={(e) => e.key === 'Enter' && setSelectedId(j.id)}
              >
                <span className={`status-dot ${j.enabled ? 'ok' : 'idle'}`} title={j.enabled ? 'enabled' : 'paused'} />
                <span className="row-title" title={j.name}>{j.name}</span>
                <span className="chip" style={{ cursor: 'default', padding: '2px 8px' }} title={`schedule: ${j.schedule}`}>
                  <Clock size={10} /> {j.schedule}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="focus">
        {selected ? (
          <>
            <div className="focus-head">
              <CalendarClock size={16} color="var(--accent)" />
              <span style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selected.name}
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn sm" disabled={busy !== ''} onClick={() => void runAction('run', () => runAutomationNow(selected.id))}>
                {busy === 'run' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Zap size={13} />} Run now
              </button>
              <button
                className="btn sm"
                disabled={busy !== ''}
                onClick={() => void runAction('toggle', () => setAutomationEnabled(selected.id, !selected.enabled))}
                title={selected.enabled ? 'Pause this job' : 'Resume this job'}
              >
                {busy === 'toggle' ? (
                  <span className="spinner" style={{ width: 11, height: 11 }} />
                ) : selected.enabled ? (
                  <Pause size={13} />
                ) : (
                  <Play size={13} />
                )}
                {selected.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="btn sm" disabled={busy !== ''} onClick={openEdit}>
                <Pencil size={13} /> Edit
              </button>
              <button
                className={`btn sm${confirmDelete ? ' danger' : ''}`}
                disabled={busy !== ''}
                onClick={armDelete}
                title={confirmDelete ? 'Tap again to delete for real' : 'Delete (two-tap)'}
              >
                {busy === 'delete' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Trash size={13} />}
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
            <div className="focus-body">
              {actionError ? (
                <div style={{ padding: '10px 22px', fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6, borderBottom: '1px solid var(--border-soft)' }}>
                  <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {actionError}
                </div>
              ) : null}
              <Field label="Schedule">
                <span className="chip" style={{ cursor: 'default' }}>
                  <Clock size={11} /> {selected.schedule}
                </span>
                {!selected.enabled ? (
                  <span className="text-faint" style={{ marginLeft: 8, fontSize: 'var(--text-xs)' }}>paused — resume to re-arm</span>
                ) : null}
              </Field>
              <Field label="Prompt">
                {promptText ? (
                  <div
                    style={{
                      fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                      userSelect: 'text', background: 'var(--bg-card)', border: '1px solid var(--border-soft)',
                      borderRadius: 'var(--radius)', padding: '10px 12px',
                    }}
                  >
                    {promptText}
                  </div>
                ) : fetchingPrompt ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)', fontSize: 'var(--text-sm)' }}>
                    <span className="spinner" style={{ width: 11, height: 11 }} /> loading the full prompt…
                  </div>
                ) : (
                  <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>No prompt stored.</span>
                )}
              </Field>
              <Field label="Deliver">
                <span className="chip" style={{ cursor: 'default' }}>{selected.deliver ?? 'local'}</span>
              </Field>
              {selected.skills.length ? (
                <Field label="Skills">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {selected.skills.map((s) => (
                      <span key={s} className="chip" style={{ cursor: 'default' }}>{s}</span>
                    ))}
                  </div>
                </Field>
              ) : null}
              <Field label="Last run">
                {selected.lastStatus ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      className={`status-dot ${
                        /error|fail/i.test(selected.lastStatus) ? 'bad' : /success|ok|complete/i.test(selected.lastStatus) ? 'ok' : 'idle'
                      }`}
                    />
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{selected.lastStatus}</span>
                    {selected.lastError ? (
                      <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--red)' }}>{selected.lastError}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>hasn't run yet</span>
                )}
              </Field>
              {selected.nextRun ? (
                <Field label="Next run">
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{fmtWhen(selected.nextRun)}</span>
                </Field>
              ) : null}
            </div>
          </>
        ) : (
          <div className="empty">
            <CalendarClock size={34} color="var(--text-faint)" />
            <div className="empty-title">Nothing runs on a schedule yet</div>
            <div className="empty-sub">
              Automations are prompts that fire on a schedule — the agent runs locally and delivers the result.
              Start from a template or write your own.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
              {AUTOMATION_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  className="btn"
                  style={{ flexDirection: 'column', gap: 3, padding: '12px 16px', maxWidth: 200, textAlign: 'left' }}
                  onClick={() => openNew(t)}
                >
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', whiteSpace: 'normal' }}>{t.label}</span>
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)' }}>{t.schedule}</span>
                </button>
              ))}
            </div>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => openNew()}>
              <Plus size={14} /> New automation
            </button>
          </div>
        )}
      </main>

      {modal ? (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-head">
              <span>{modal.job ? `Edit — ${modal.job.name}` : 'New automation'}</span>
              <button className="btn ghost sm" onClick={() => setModal(null)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={labelStyle}>Schedule</div>
                <input
                  className="input"
                  placeholder="every 30m"
                  value={modal.schedule}
                  onChange={(e) => setModal({ ...modal, schedule: e.target.value })}
                  autoFocus
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 5 }}>
                  Plain language — e.g. “every 30m”, “in 45m”, “every monday 9:00”.
                </div>
              </div>
              <div>
                <div style={labelStyle}>Prompt</div>
                <textarea
                  className="input"
                  rows={6}
                  placeholder="What should run? Keep it self-contained — cron runs can't ask questions."
                  value={modal.prompt}
                  onChange={(e) => setModal({ ...modal, prompt: e.target.value })}
                />
              </div>
              {saveError ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6 }}>
                  <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {saveError}
                </div>
              ) : null}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!modal.schedule.trim() || !modal.prompt.trim() || busy === 'save'}
                onClick={() => void save()}
              >
                {busy === 'save' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
                {modal.job ? 'Save changes' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border-soft)' }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}
