/**
 * Desktop Automations — a dense table over the exact engine calls the phone
 * screen makes (app/app/(tabs)/automations.tsx): `cron.manage`
 * list/add/get/remove/pause/resume, plus `slash.exec` /cron run|edit for
 * run-now and edit (edit flags are shell-quoted). No logic lives here.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { rpc, isConnected } from '../../../../../app/src/lib/gateway'
import { ensureSession } from '../../../../../app/src/lib/chat'
import { IconMoch } from '../shell/icons'
import { runningAutomationCount, countRunningJobs } from '../../../../../app/src/lib/automationsState'

interface Job {
  job_id: string
  name?: string
  schedule?: string
  prompt_preview?: string
  repeat?: string | null
  deliver?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  last_fire_error?: string | null
  last_delivery_error?: string | null
  enabled?: boolean
  state?: string | null
  paused_reason?: string | null
}

/** Shell-quote a value for /cron edit flags — schedules contain spaces ("every 30m"). */
function shq(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  if (diff < 0) return 'due'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`
  return `in ${Math.round(diff / 86_400_000)}d`
}

function fmtFull(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  try {
    return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

interface FormState {
  jobId: string | null
  name: string
  schedule: string
  prompt: string
  /** The prompt exactly as loaded from the gateway — the save dirty-check compares against it. */
  loadedPrompt: string | null
  /** The full fetch failed; the field holds the 100-char preview. */
  promptDegraded: boolean
  saving: boolean
}

interface ConfirmState {
  title: string
  body: string
  action: string
  run: () => Promise<void>
}

export default function Automations(): React.JSX.Element {
  const online = useStore(isConnected)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const load = useCallback(async () => {
    if (!online) {
      setLoaded(true)
      return
    }
    setError(null)
    try {
      // include_disabled: without it paused jobs are omitted — a toggle UI
      // would lose the job it just paused (and could never resume it).
      const res = await rpc<{ jobs?: Job[] }>('cron.manage', { action: 'list', include_disabled: true })
      setJobs(res?.jobs ?? [])
      // The shell's automations row mirrors every load here, so pause /
      // resume / remove / add update it instantly.
      runningAutomationCount.set(countRunningJobs(res?.jobs ?? []))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load automations')
    } finally {
      setLoaded(true)
    }
  }, [online])

  useEffect(() => {
    setLoaded(false)
    void load()
  }, [load])

  // Transient status line ("Saved", "Queued to run") fades after a few seconds.
  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(null), 4000)
    return () => clearTimeout(t)
  }, [status])

  /** Run a /cron subcommand through slash.exec; it needs a live session id. */
  const cronSlash = useCallback(async (command: string): Promise<string> => {
    const sid = await ensureSession()
    const r = await rpc<{ output?: string }>('slash.exec', { session_id: sid, command })
    return (r?.output ?? '').trim()
  }, [])

  const withBusy = async (jobId: string, fn: () => Promise<void>) => {
    setBusyJob(jobId)
    try {
      await fn()
    } catch (e) {
      setStatus(`Action failed — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyJob(null)
    }
  }

  const toggle = (j: Job) =>
    withBusy(j.job_id, async () => {
      const action = j.enabled === false ? 'resume' : 'pause'
      await rpc('cron.manage', { action, name: j.job_id })
      setStatus(action === 'pause' ? `Paused “${j.name ?? j.job_id}”` : `Resumed “${j.name ?? j.job_id}”`)
      await load()
    })

  const runNow = (j: Job) =>
    withBusy(j.job_id, async () => {
      const out = await cronSlash(`/cron run ${j.job_id}`)
      setStatus(out.split('\n')[0] || `Queued “${j.name ?? j.job_id}” to run`)
    })

  const remove = (j: Job) =>
    setConfirm({
      title: 'Delete this automation?',
      body: j.name ?? j.job_id,
      action: 'Delete',
      run: async () => {
        await withBusy(j.job_id, async () => {
          await rpc('cron.manage', { action: 'remove', name: j.job_id })
          setStatus(`Deleted “${j.name ?? j.job_id}”`)
          await load()
        })
      },
    })

  const saveForm = async () => {
    if (!form) return
    const schedule = form.schedule.trim()
    const prompt = form.prompt.trim()
    const name = form.name.trim()
    // An unmodified prompt is omitted from the edit command — the backend's
    // /cron edit overwrites the stored prompt whenever --prompt is present,
    // so a schedule-only edit must never re-send it (least of all the
    // truncated preview).
    const promptUnchanged = !!form.jobId && form.loadedPrompt !== null && prompt === form.loadedPrompt.trim()
    if (!schedule || (!prompt && !promptUnchanged) || (!form.jobId && !name)) {
      setStatus('Name, schedule and prompt are all needed.')
      return
    }
    setForm({ ...form, saving: true })
    try {
      if (form.jobId) {
        // /cron edit has no --name; schedule + prompt are the editable levers.
        const promptFlag = promptUnchanged ? '' : ` --prompt ${shq(prompt)}`
        const out = await cronSlash(`/cron edit ${form.jobId} --schedule ${shq(schedule)}${promptFlag}`)
        setStatus(out.split('\n')[0] || 'Updated')
      } else {
        await rpc('cron.manage', { action: 'add', name, schedule, prompt })
        setStatus(`Created “${name}”`)
      }
      setForm(null)
      await load()
    } catch (e) {
      setStatus(`${form.jobId ? 'Edit' : 'Create'} failed — ${e instanceof Error ? e.message : String(e)}`)
      setForm({ ...form, saving: false })
    }
  }

  const openAdd = () => setForm({ jobId: null, name: '', schedule: '', prompt: '', loadedPrompt: null, promptDegraded: false, saving: false })

  // prompt_preview is truncated at 100 chars — opening the editor from it and
  // saving would silently rewrite the stored prompt to the truncated text.
  // Fetch the full prompt via cron.manage 'get'; the preview is only a
  // fallback (with a banner saying so, and the save dirty-check keeps it from
  // being written back).
  const openEdit = async (j: Job) => {
    setForm({ jobId: j.job_id, name: j.name ?? '', schedule: j.schedule ?? '', prompt: j.prompt_preview ?? '', loadedPrompt: null, promptDegraded: false, saving: false })
    try {
      const r = await rpc<{ job?: { prompt?: string } }>('cron.manage', { action: 'get', name: j.job_id })
      const full = r?.job?.prompt
      if (typeof full !== 'string') throw new Error('cron.manage get: no job in response')
      setForm((f) => (f && f.jobId === j.job_id ? { ...f, prompt: full, loadedPrompt: full } : f))
    } catch {
      // Older gateway (no 'get' action) or the RPC failed: keep the preview,
      // mark the form degraded so the user knows it is truncated.
      setForm((f) => (f && f.jobId === j.job_id ? { ...f, loadedPrompt: j.prompt_preview ?? '', promptDegraded: true } : f))
    }
  }

  const copyId = async (j: Job) => {
    try {
      await navigator.clipboard.writeText(j.job_id)
      setStatus('Job ID copied')
    } catch {
      setStatus('Copy failed')
    }
  }

  return (
    <div className="mos-root">
      <style>{css}</style>
      <header className="mos-head">
        <h2>Automations</h2>
        <span className="mos-sub">Scheduled jobs run on your computer — they work even when this app is closed.</span>
        <button className="mos-btn mos-spring" onClick={() => void load()} disabled={!online} aria-label="Refresh automations">Refresh</button>
        <button className="mos-btn mos-accent" onClick={openAdd} aria-label="New automation">＋ New automation</button>
      </header>

      {status ? <div className="mos-toast" role="status">{status}</div> : null}

      {error ? (
        <div className="mos-errrow" role="alert">
          <span>{error}</span>
          <button className="mos-btn" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {!online && loaded && !error ? (
        <div className="mos-empty" role="status">
          <IconMoch size={56} />
          <p className="mos-emptyTitle">Not connected</p>
          <p className="mos-emptyBody">Automations live on your computer. Connect, then retry.</p>
          <button className="mos-btn" onClick={() => void load()}>Retry</button>
        </div>
      ) : !loaded ? (
        <div className="mos-spin" aria-label="Loading automations" />
      ) : jobs.length === 0 && !error ? (
        <div className="mos-empty">
          <IconMoch size={56} />
          <p className="mos-emptyTitle">No automations yet</p>
          <p className="mos-emptyBody">Schedule your first job here, or create one from chat with /cron add</p>
          <button className="mos-btn mos-accent" onClick={openAdd}>New automation</button>
        </div>
      ) : (
        <div className="mos-scroller">
          <table className="mos-table">
            <thead>
              <tr>
                <th className="mos-th mos-w-toggle">Enabled</th>
                <th className="mos-th">Name</th>
                <th className="mos-th">Schedule</th>
                <th className="mos-th">Next run</th>
                <th className="mos-th">Last status</th>
                <th className="mos-th mos-w-actions" aria-label="Actions" />
                <th className="mos-th mos-w-chev" aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const paused = j.enabled === false || j.state === 'paused'
                const busy = busyJob === j.job_id
                const open = expanded === j.job_id
                const lastError = j.last_fire_error || j.last_delivery_error || j.last_error
                return (
                  <React.Fragment key={j.job_id}>
                    <tr
                      className={`mos-row${selected === j.job_id ? ' mos-sel' : ''}${paused ? ' mos-paused' : ''}`}
                      onClick={() => setSelected(j.job_id)}
                    >
                      <td className="mos-td mos-w-toggle">
                        <button
                          className={`mos-toggle${paused ? ' mos-toggleOff' : ''}`}
                          disabled={busy}
                          title={paused ? 'Resume' : 'Pause'}
                          aria-label={paused ? `Resume ${j.name ?? j.job_id}` : `Pause ${j.name ?? j.job_id}`}
                          onClick={(e) => { e.stopPropagation(); void toggle(j) }}
                        >
                          <span className="mos-knob" />
                        </button>
                      </td>
                      <td className="mos-td mos-name" title={j.prompt_preview ?? j.name ?? j.job_id}>
                        {j.name ?? j.job_id}
                        {j.prompt_preview ? <span className="mos-subline">{j.prompt_preview}</span> : null}
                      </td>
                      <td className="mos-td mos-mono">{j.schedule ?? '—'}</td>
                      <td className="mos-td">{paused ? <span className="mos-badge">paused</span> : j.next_run_at ? when(j.next_run_at) : '—'}</td>
                      <td className="mos-td">{j.last_status ?? '—'}</td>
                      <td className="mos-td mos-w-actions">
                        {busy ? (
                          <span className="mos-spinSm" aria-label="Working" />
                        ) : (
                          <>
                            <button className="mos-btn" onClick={(e) => { e.stopPropagation(); void runNow(j) }}>Run now</button>
                            <button className="mos-btn" onClick={(e) => { e.stopPropagation(); void openEdit(j) }}>Edit</button>
                            <button className="mos-btn mos-danger" onClick={(e) => { e.stopPropagation(); remove(j) }}>Delete</button>
                          </>
                        )}
                      </td>
                      <td className="mos-td mos-w-chev">
                        <button
                          className="mos-chev"
                          aria-label={open ? `Collapse ${j.name ?? j.job_id}` : `Expand ${j.name ?? j.job_id}`}
                          aria-expanded={open}
                          onClick={(e) => { e.stopPropagation(); setSelected(j.job_id); setExpanded(open ? null : j.job_id) }}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="mos-detail">
                        <td colSpan={7}>
                          <div className="mos-grid">
                            <Detail label="Job ID" value={j.job_id} copy={() => { void copyId(j) }} />
                            <Detail label="Next run" value={fmtFull(j.next_run_at)} />
                            <Detail label="Last run" value={fmtFull(j.last_run_at)} />
                            <Detail label="Repeat" value={j.repeat ?? '—'} />
                            <Detail label="Deliver" value={j.deliver ?? '—'} />
                            {j.paused_reason ? <Detail label="Paused because" value={j.paused_reason} /> : null}
                            {lastError ? <Detail label="Last error" value={String(lastError).slice(0, 300)} danger /> : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {form ? (
        <Dialog onClose={() => { if (!form.saving) setForm(null) }} title={form.jobId ? 'Edit automation' : 'New automation'}>
          <label className="mos-field">
            <span className="mos-label">Name</span>
            {form.jobId ? (
              <span className="mos-locked">{form.name || form.jobId}</span>
            ) : (
              <input className="mos-input" value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Morning brief" />
            )}
          </label>
          <label className="mos-field">
            <span className="mos-label">Schedule</span>
            <input className="mos-input mos-mono" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} placeholder='cron expression or "every 30m"' />
          </label>
          <label className="mos-field">
            <span className="mos-label">Prompt</span>
            <textarea className="mos-input" rows={5} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="What the agent should do on each run" />
          </label>
          {form.promptDegraded ? (
            <p className="mos-degraded">The full prompt could not be loaded — the box holds a truncated preview. Saving keeps it only if you edited it.</p>
          ) : null}
          <div className="mos-dialogBtns">
            <button className="mos-btn" onClick={() => { if (!form.saving) setForm(null) }}>Cancel</button>
            <button className="mos-btn mos-accent" disabled={form.saving} onClick={() => void saveForm()}>{form.jobId ? 'Save' : 'Create'}</button>
          </div>
        </Dialog>
      ) : null}

      {confirm ? (
        <Dialog onClose={() => setConfirm(null)} title={confirm.title} small>
          <p className="mos-confirmBody">{confirm.body}</p>
          <div className="mos-dialogBtns">
            <button className="mos-btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="mos-btn mos-dangerSolid" onClick={() => { const c = confirm; setConfirm(null); void c.run() }}>{confirm.action}</button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function Detail(props: { label: string; value: string; copy?: () => void; danger?: boolean }): React.JSX.Element {
  return (
    <div className="mos-detailItem">
      <span className="mos-detailLabel">{props.label}</span>
      <span className={`mos-detailValue${props.danger ? ' mos-detailDanger' : ''}`}>{props.value}</span>
      {props.copy ? <button className="mos-btn" onClick={props.copy}>Copy</button> : null}
    </div>
  )
}

export function Dialog(props: { title: string; small?: boolean; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const onClose = props.onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="mos-scrim" onClick={props.onClose}>
      <div className={`mos-card${props.small ? ' mos-cardSm' : ''}`} role="dialog" aria-modal aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div className="mos-cardHead">
          <strong>{props.title}</strong>
          <button className="mos-x" aria-label="Close" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

const css = `
/* Local to Automations: the shared table kit (desktop.css) covers the rest. */
.mos-w-toggle { width: 64px; }
.mos-w-chev { width: 34px; }
.mos-chev { background: none; border: none; color: var(--moch-text-faint); cursor: pointer; padding: 2px 6px; font-size: 11px; }
.mos-detail td { background: var(--moch-bg-card); padding: 10px 16px 12px 74px; }
.mos-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 18px; }
.mos-detailItem { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mos-detailLabel { color: var(--moch-text-faint); font-size: 11px; flex: none; }
.mos-detailValue { font-family: var(--moch-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mos-detailDanger { color: var(--moch-red); }
.mos-locked { color: var(--moch-text-dim); font-size: 13px; padding: 6px 0; }
.mos-degraded { margin: 0; color: var(--moch-amber); font-size: 12px; }
`
