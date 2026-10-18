import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { CalendarClock, CircleAlert, Clock, Pencil, Pause, Play, Plus, Trash, X, Zap } from 'lucide-react'
import {
  AUTOMATION_TEMPLATES, createAutomation, deleteAutomation, errMsg, fmtWhen, getAutomation,
  listAutomationRuns, listAutomations, runAutomationNow, setAutomationEnabled, updateAutomation,
  type CronJob, type CronRun,
} from '../lib/automations'
import { isConnected } from '../lib/gateway'
import { locale, tr } from '../lib/strings'

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

/** Ledger statuses map onto the same dot vocabulary the rest of the shell uses. */
function runDot(status: string): string {
  if (/error|fail/i.test(status)) return 'bad'
  if (/success|ok|complete/i.test(status)) return 'ok'
  if (/claim|run|start|progress/i.test(status)) return 'warn'
  return 'idle'
}

function fmtTs(ms: number | null): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString(locale.get() === 'ar' ? 'ar' : undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString()
  }
}

export default function AutomationsView() {
  const connected = useStore(isConnected)
  const lang = useStore(locale) // order 15: every tr() here re-renders on a locale switch
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fullPrompts, setFullPrompts] = useState<Record<string, string>>({})
  const [fetchingPrompt, setFetchingPrompt] = useState(false)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const [runsByJob, setRunsByJob] = useState<Record<string, CronRun[]>>({})
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [modal, setModal] = useState<ModalState | null>(null)
  const [saveError, setSaveError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedRef = useRef<CronJob | null>(null)

  const selected = jobs.find((j) => j.id === selectedId) ?? null
  selectedRef.current = selected

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

  /** Past runs for one job, newest first — the merged ledger has no per-job filter. */
  const loadRuns = useCallback(async (job: CronJob) => {
    setRunsLoading(true)
    try {
      const runs = await listAutomationRuns(job)
      setRunsByJob((prev) => ({ ...prev, [job.id]: runs }))
      setRunsError('')
    } catch (e) {
      setRunsError(errMsg(e))
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  // Slow poll (never faster than 30s) keeps next-run times and history fresh.
  useEffect(() => {
    const tick = () => {
      if (!connected) return
      void refresh(true)
      const job = selectedRef.current
      if (job) void loadRuns(job)
    }
    const t = setInterval(tick, 60_000)
    // Background tabs throttle timers to ~1/min; catch up the moment the
    // surface is looked at again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [connected, refresh, loadRuns])

  // Selecting a job pulls its history (and the FULL prompt — list ships a 100-char preview).
  useEffect(() => {
    if (!selected) return
    void loadRuns(selected)
    if (fullPrompts[selected.id] === undefined) {
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
    }
  }, [selected, fullPrompts, loadRuns])

  // Escape closes the modal.
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  const act = async (job: CronJob, what: string, fn: () => Promise<void>, after?: () => void) => {
    setBusy(what)
    setActionError('')
    try {
      await fn()
      after?.()
      await refresh(true)
      await loadRuns(job)
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
    const job = selected
    void act(job, 'delete', () => deleteAutomation(job.id), () => setSelectedId(null))
  }

  const promptText = selected ? (fullPrompts[selected.id] ?? selected.prompt) : ''
  const runs = selected ? runsByJob[selected.id] : undefined

  return (
    <>
      <aside className="ctx" data-locale={lang}>
        <div className="ctx-head">
          <span className="ctx-title">{tr('routines.head')}</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title={tr('routines.new')} onClick={() => openNew()}>
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {loading ? (
            <div style={{ padding: '14px 12px', display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)' }}>
              <span className="spinner" style={{ width: 12, height: 12 }} /> {tr('routines.loading')}
            </div>
          ) : listError ? (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6 }}>
              <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {listError}
            </div>
          ) : jobs.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              {tr('routines.empty')}
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
                <span className={`status-dot ${j.enabled ? 'ok' : 'idle'}`} title={j.enabled ? tr('routines.enabled') : tr('routines.paused')} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span className="row-title" title={j.name}>{j.name}</span>
                  <span className="row-sub" style={{ maxWidth: 'none' }}>
                    {tr('routines.next', { when: fmtWhen(j.nextRun) || tr('routines.next.none') })}
                  </span>
                </div>
                <span className="chip" style={{ cursor: 'default', padding: '2px 8px' }} title={j.schedule}>
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
              <button className="btn sm" disabled={busy !== ''} onClick={() => void act(selected, 'run', () => runAutomationNow(selected.id))}>
                {busy === 'run' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Zap size={13} />} {tr('routines.runNow')}
              </button>
              <button
                className="btn sm"
                disabled={busy !== ''}
                onClick={() => void act(selected, 'toggle', () => setAutomationEnabled(selected.id, !selected.enabled))}
                title={selected.enabled ? tr('routines.pause.hint') : tr('routines.resume.hint')}
              >
                {busy === 'toggle' ? (
                  <span className="spinner" style={{ width: 11, height: 11 }} />
                ) : selected.enabled ? (
                  <Pause size={13} />
                ) : (
                  <Play size={13} />
                )}
                {selected.enabled ? tr('routines.pause') : tr('routines.resume')}
              </button>
              <button className="btn sm" disabled={busy !== ''} onClick={openEdit}>
                <Pencil size={13} /> {tr('routines.edit')}
              </button>
              <button
                className={`btn sm${confirmDelete ? ' danger' : ''}`}
                disabled={busy !== ''}
                onClick={armDelete}
                title={confirmDelete ? tr('routines.delete.hint') : tr('routines.delete.hint2')}
              >
                {busy === 'delete' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Trash size={13} />}
                {confirmDelete ? tr('routines.delete.confirm') : tr('routines.delete')}
              </button>
            </div>
            <div className="focus-body">
              {actionError ? (
                <div style={{ padding: '10px 22px', fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6, borderBottom: '1px solid var(--border-soft)' }}>
                  <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {actionError}
                </div>
              ) : null}
              <Field label={tr('routines.schedule')}>
                <span className="chip" style={{ cursor: 'default' }}>
                  <Clock size={11} /> {selected.schedule}
                </span>
                {!selected.enabled ? (
                  <span className="text-faint" style={{ marginInlineStart: 8, fontSize: 'var(--text-xs)' }}>{tr('routines.pausedNote')}</span>
                ) : null}
              </Field>
              <Field label={tr('routines.prompt')}>
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
                    <span className="spinner" style={{ width: 11, height: 11 }} /> {tr('routines.prompt.loading')}
                  </div>
                ) : (
                  <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>{tr('routines.prompt.none')}</span>
                )}
              </Field>
              <Field label={tr('routines.deliver')}>
                <span className="chip" style={{ cursor: 'default' }}>{selected.deliver ?? tr('routines.deliver.local')}</span>
              </Field>
              {selected.skills.length ? (
                <Field label={tr('routines.skills')}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {selected.skills.map((s) => (
                      <span key={s} className="chip" style={{ cursor: 'default' }}>{s}</span>
                    ))}
                  </div>
                </Field>
              ) : null}
              <Field label={tr('routines.history')}>
                {runsError ? (
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6 }}>
                    <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {runsError}
                  </div>
                ) : runs === undefined || (runsLoading && runs.length === 0) ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)', fontSize: 'var(--text-sm)' }}>
                    <span className="spinner" style={{ width: 11, height: 11 }} /> {tr('routines.history.loading')}
                  </div>
                ) : runs.length === 0 ? (
                  <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>{tr('routines.history.empty')}</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {runs.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0',
                          borderBottom: '1px solid var(--border-soft)', fontSize: 'var(--text-sm)',
                        }}
                      >
                        <span className={`status-dot ${runDot(r.status)}`} style={{ alignSelf: 'center' }} />
                        <span style={{ color: 'var(--text-dim)', minWidth: 70 }}>{r.status}</span>
                        <span style={{ color: 'var(--text-faint)', fontSize: 'var(--text-xs)' }}>{fmtTs(r.ts)}</span>
                        {r.error ? (
                          <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', overflowWrap: 'anywhere' }}>{r.error}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </Field>
              {selected.nextRun ? (
                <Field label={tr('routines.nextRun')}>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{fmtWhen(selected.nextRun)}</span>
                </Field>
              ) : null}
            </div>
          </>
        ) : (
          <div className="empty">
            <CalendarClock size={34} color="var(--text-faint)" />
            <div className="empty-title">{tr('routines.empty.title')}</div>
            <div className="empty-sub">{tr('routines.empty.sub')}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
              {AUTOMATION_TEMPLATES.map((t) => (
                <button
                  key={t.labelKey}
                  className="btn"
                  style={{ flexDirection: 'column', gap: 3, padding: '12px 16px', maxWidth: 200, textAlign: 'left' }}
                  onClick={() => openNew(t)}
                >
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', whiteSpace: 'normal' }}>{tr(t.labelKey)}</span>
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)' }}>{t.schedule}</span>
                </button>
              ))}
            </div>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => openNew()}>
              <Plus size={14} /> {tr('routines.new')}
            </button>
          </div>
        )}
      </main>

      {modal ? (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-head">
              <span>{modal.job ? tr('routines.modal.edit', { name: modal.job.name }) : tr('routines.new')}</span>
              <button className="btn ghost sm" onClick={() => setModal(null)} aria-label={tr('routines.close')}>
                <X size={14} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={labelStyle}>{tr('routines.schedule')}</div>
                <input
                  className="input"
                  placeholder="every 30m"
                  value={modal.schedule}
                  onChange={(e) => setModal({ ...modal, schedule: e.target.value })}
                  autoFocus
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 5 }}>
                  {tr('routines.modal.schedule.hint')}
                </div>
              </div>
              <div>
                <div style={labelStyle}>{tr('routines.prompt')}</div>
                <textarea
                  className="input"
                  rows={6}
                  placeholder={tr('routines.modal.prompt.ph')}
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
              <button className="btn ghost" onClick={() => setModal(null)}>{tr('routines.modal.cancel')}</button>
              <button
                className="btn primary"
                disabled={!modal.schedule.trim() || !modal.prompt.trim() || busy === 'save'}
                onClick={() => void save()}
              >
                {busy === 'save' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
                {modal.job ? tr('routines.modal.save') : tr('routines.modal.create')}
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
