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
    <div className="moa-root">
      <style>{css}</style>
      <header className="moa-head">
        <h2>Automations</h2>
        <span className="moa-sub">Scheduled jobs run on your computer — they work even when this app is closed.</span>
        <button className="moa-btn moa-headadd" onClick={() => void load()} disabled={!online} aria-label="Refresh automations">Refresh</button>
        <button className="moa-btn moa-accent" onClick={openAdd} aria-label="New automation">＋ New automation</button>
      </header>

      {status ? <div className="moa-toast" role="status">{status}</div> : null}

      {error ? (
        <div className="moa-errrow" role="alert">
          <span>{error}</span>
          <button className="moa-btn" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {!online && loaded && !error ? (
        <div className="moa-empty" role="status">
          <p className="moa-emptyTitle">Not connected</p>
          <p className="moa-emptyBody">Automations live on your computer. Connect, then retry.</p>
          <button className="moa-btn" onClick={() => void load()}>Retry</button>
        </div>
      ) : !loaded ? (
        <div className="moa-spin" aria-label="Loading automations" />
      ) : jobs.length === 0 && !error ? (
        <div className="moa-empty">
          <p className="moa-emptyTitle">No automations yet</p>
          <p className="moa-emptyBody">Schedule your first job here, or create one from chat with /cron add</p>
          <button className="moa-btn moa-accent" onClick={openAdd}>New automation</button>
        </div>
      ) : (
        <div className="moa-scroller">
          <table className="moa-table">
            <thead>
              <tr>
                <th className="moa-th moa-w-toggle">Enabled</th>
                <th className="moa-th">Name</th>
                <th className="moa-th">Schedule</th>
                <th className="moa-th">Next run</th>
                <th className="moa-th">Last status</th>
                <th className="moa-th moa-w-actions" aria-label="Actions" />
                <th className="moa-th moa-w-chev" aria-label="Details" />
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
                      className={`moa-row${selected === j.job_id ? ' moa-sel' : ''}${paused ? ' moa-paused' : ''}`}
                      onClick={() => setSelected(j.job_id)}
                    >
                      <td className="moa-td moa-w-toggle">
                        <button
                          className={`moa-toggle${paused ? ' moa-toggleOff' : ''}`}
                          disabled={busy}
                          title={paused ? 'Resume' : 'Pause'}
                          aria-label={paused ? `Resume ${j.name ?? j.job_id}` : `Pause ${j.name ?? j.job_id}`}
                          onClick={(e) => { e.stopPropagation(); void toggle(j) }}
                        >
                          <span className="moa-knob" />
                        </button>
                      </td>
                      <td className="moa-td moa-name" title={j.prompt_preview ?? j.name ?? j.job_id}>
                        {j.name ?? j.job_id}
                        {j.prompt_preview ? <span className="moa-prompt">{j.prompt_preview}</span> : null}
                      </td>
                      <td className="moa-td moa-mono">{j.schedule ?? '—'}</td>
                      <td className="moa-td">{paused ? <span className="moa-chipPaused">paused</span> : j.next_run_at ? when(j.next_run_at) : '—'}</td>
                      <td className="moa-td">{j.last_status ?? '—'}</td>
                      <td className="moa-td moa-w-actions">
                        {busy ? (
                          <span className="moa-spinSm" aria-label="Working" />
                        ) : (
                          <>
                            <button className="moa-btn" onClick={(e) => { e.stopPropagation(); void runNow(j) }}>Run now</button>
                            <button className="moa-btn" onClick={(e) => { e.stopPropagation(); void openEdit(j) }}>Edit</button>
                            <button className="moa-btn moa-danger" onClick={(e) => { e.stopPropagation(); remove(j) }}>Delete</button>
                          </>
                        )}
                      </td>
                      <td className="moa-td moa-w-chev">
                        <button
                          className="moa-chev"
                          aria-label={open ? `Collapse ${j.name ?? j.job_id}` : `Expand ${j.name ?? j.job_id}`}
                          aria-expanded={open}
                          onClick={(e) => { e.stopPropagation(); setSelected(j.job_id); setExpanded(open ? null : j.job_id) }}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="moa-detail">
                        <td colSpan={7}>
                          <div className="moa-grid">
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
          <label className="moa-field">
            <span className="moa-label">Name</span>
            {form.jobId ? (
              <span className="moa-locked">{form.name || form.jobId}</span>
            ) : (
              <input className="moa-input" value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Morning brief" />
            )}
          </label>
          <label className="moa-field">
            <span className="moa-label">Schedule</span>
            <input className="moa-input moa-mono" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} placeholder='cron expression or "every 30m"' />
          </label>
          <label className="moa-field">
            <span className="moa-label">Prompt</span>
            <textarea className="moa-input moa-promptBox" rows={5} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="What the agent should do on each run" />
          </label>
          {form.promptDegraded ? (
            <p className="moa-degraded">The full prompt could not be loaded — the box holds a truncated preview. Saving keeps it only if you edited it.</p>
          ) : null}
          <div className="moa-dialogBtns">
            <button className="moa-btn" onClick={() => { if (!form.saving) setForm(null) }}>Cancel</button>
            <button className="moa-btn moa-accent" disabled={form.saving} onClick={() => void saveForm()}>{form.jobId ? 'Save' : 'Create'}</button>
          </div>
        </Dialog>
      ) : null}

      {confirm ? (
        <Dialog onClose={() => setConfirm(null)} title={confirm.title} small>
          <p className="moa-confirmBody">{confirm.body}</p>
          <div className="moa-dialogBtns">
            <button className="moa-btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="moa-btn moa-dangerSolid" onClick={() => { const c = confirm; setConfirm(null); void c.run() }}>{confirm.action}</button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function Detail(props: { label: string; value: string; copy?: () => void; danger?: boolean }): React.JSX.Element {
  return (
    <div className="moa-detailItem">
      <span className="moa-detailLabel">{props.label}</span>
      <span className={`moa-detailValue${props.danger ? ' moa-detailDanger' : ''}`}>{props.value}</span>
      {props.copy ? <button className="moa-btn" onClick={props.copy}>Copy</button> : null}
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
    <div className="moa-scrim" onClick={props.onClose}>
      <div className={`moa-card${props.small ? ' moa-cardSm' : ''}`} role="dialog" aria-modal aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div className="moa-cardHead">
          <strong>{props.title}</strong>
          <button className="moa-x" aria-label="Close" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

const css = `
.moa-root { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--moch-text); font-family: var(--moch-font); }
.moa-head { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--moch-border); }
.moa-head h2 { margin: 0; font-size: 15px; }
.moa-sub { color: var(--moch-text-dim); font-size: 12px; }
.moa-head .moa-btn.moa-headadd { margin-left: auto; }
.moa-scroller { flex: 1; overflow: auto; min-height: 0; }
.moa-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.moa-th { position: sticky; top: 0; z-index: 1; background: var(--moch-bg-card); color: var(--moch-text-faint); text-align: left; font-weight: 500; padding: 0 10px; height: 30px; border-bottom: 1px solid var(--moch-border); white-space: nowrap; }
.moa-row { height: var(--moch-row-h, 32px); cursor: default; }
.moa-row:hover { background: var(--moch-bg-hover); }
.moa-row.moa-sel { background: var(--moch-accent-soft); }
.moa-row.moa-paused .moa-name { color: var(--moch-text-dim); }
.moa-td { padding: 0 10px; border-bottom: 1px solid var(--moch-border-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; }
.moa-name { font-weight: 500; }
.moa-prompt { display: block; color: var(--moch-text-faint); font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.moa-mono { font-family: var(--moch-mono); font-size: 11.5px; }
.moa-w-toggle { width: 64px; }
.moa-w-actions { width: 1%; white-space: nowrap; }
.moa-w-chev { width: 34px; }
.moa-toggle { width: 28px; height: 16px; border-radius: 8px; border: none; background: var(--moch-accent); position: relative; cursor: pointer; padding: 0; }
.moa-toggleOff { background: var(--moch-text-faint); }
.moa-knob { position: absolute; top: 2px; left: 14px; width: 12px; height: 12px; border-radius: 6px; background: var(--moch-bg); transition: left 120ms ease; }
.moa-toggleOff .moa-knob { left: 2px; }
.moa-btn { background: transparent; color: var(--moch-text-dim); border: 1px solid var(--moch-border); border-radius: 5px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
.moa-btn:hover { color: var(--moch-text); border-color: var(--moch-text-faint); }
.moa-btn.moa-accent { background: var(--moch-accent); color: var(--moch-bg); border-color: transparent; }
.moa-btn.moa-danger { color: var(--moch-red); }
.moa-btn.moa-dangerSolid { background: var(--moch-red); color: var(--moch-bg); border-color: transparent; }
.moa-chev { background: none; border: none; color: var(--moch-text-faint); cursor: pointer; padding: 2px 6px; font-size: 11px; }
.moa-chipPaused { color: var(--moch-text-faint); font-size: 11px; border: 1px solid var(--moch-border); border-radius: 8px; padding: 0 6px; }
.moa-detail td { background: var(--moch-bg-card); padding: 10px 16px 12px 74px; }
.moa-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 18px; }
.moa-detailItem { display: flex; align-items: center; gap: 8px; min-width: 0; }
.moa-detailLabel { color: var(--moch-text-faint); font-size: 11px; flex: none; }
.moa-detailValue { font-family: var(--moch-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moa-detailDanger { color: var(--moch-red); }
.moa-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; color: var(--moch-text-dim); }
.moa-emptyTitle { margin: 0; color: var(--moch-text); font-size: 16px; font-weight: 600; }
.moa-emptyBody { margin: 0 0 8px; font-size: 12.5px; text-align: center; }
.moa-errrow { display: flex; align-items: center; gap: 12px; padding: 8px 16px; color: var(--moch-red); font-size: 12.5px; border-bottom: 1px solid var(--moch-border-soft); }
.moa-errrow span { flex: 1; }
.moa-spin { width: 22px; height: 22px; margin: 48px auto; border: 2px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: moa-rot 800ms linear infinite; }
.moa-spinSm { display: inline-block; width: 13px; height: 13px; border: 1.5px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: moa-rot 800ms linear infinite; }
@keyframes moa-rot { to { transform: rotate(360deg); } }
.moa-toast { position: fixed; left: 16px; bottom: 16px; z-index: 40; background: var(--moch-bg-elev); border: 1px solid var(--moch-border); color: var(--moch-text); font-size: 12.5px; padding: 7px 12px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
.moa-scrim { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.45); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px; }
.moa-card { background: var(--moch-bg-card); border: 1px solid var(--moch-border); border-radius: 10px; width: 460px; max-width: 100%; max-height: 82vh; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); }
.moa-cardSm { width: 360px; }
.moa-cardHead { display: flex; align-items: center; }
.moa-cardHead strong { font-size: 14px; flex: 1; }
.moa-x { background: none; border: none; color: var(--moch-text-faint); cursor: pointer; font-size: 12px; padding: 2px 6px; }
.moa-field { display: flex; flex-direction: column; gap: 4px; }
.moa-label { color: var(--moch-text-faint); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.moa-input { background: var(--moch-bg); color: var(--moch-text); border: 1px solid var(--moch-border); border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit; }
.moa-input.moa-mono { font-family: var(--moch-mono); font-size: 12px; }
.moa-promptBox { resize: vertical; }
.moa-locked { color: var(--moch-text-dim); font-size: 13px; padding: 6px 0; }
.moa-degraded { margin: 0; color: var(--moch-amber, #f5a524); font-size: 12px; }
.moa-dialogBtns { display: flex; justify-content: flex-end; gap: 8px; }
.moa-confirmBody { margin: 0; color: var(--moch-text-dim); font-size: 13px; overflow-wrap: anywhere; }
.moa-root :focus-visible { outline: 2px solid var(--moch-accent); outline-offset: 1px; }
`
