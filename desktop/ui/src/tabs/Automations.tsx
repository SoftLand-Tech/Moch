/**
 * Automations — cron jobs, phone parity with app/(tabs)/automations.tsx:
 * cron.manage list (include_disabled — without it paused jobs vanish and
 * could never be resumed), pause/resume/remove and add. RUN-NOW and EDIT
 * go through slash.exec '/cron …', which needs a live session id — ONE
 * shared 'automation' session is reused across commands and recreated
 * only when missing or dead (A1; the phone created one per command).
 * prompt_preview is capped at 100 chars server-side (#108): the editor
 * fetches the FULL prompt via cron.manage action:'get', and a
 * schedule-only edit never re-sends --prompt (the backend overwrites the
 * stored prompt whenever --prompt is present — worst case with the
 * truncated preview). Edit flags are shell-quoted; schedules contain
 * spaces ("every 30m").
 */
import { useEffect, useRef, useState } from 'react'
import type { CronJob, RpcRef } from '../types'
import Markdown from '../Markdown'

/** B1 cold-start mount load: the first load races the socket dial — App
 *  assigns rpcRef.current synchronously inside dial() BEFORE connect(), so
 *  an early load hard-rejects ('gateway not connected') until the socket
 *  opens. A connection-class failure therefore keeps the 2s cadence for
 *  the whole 30s window (a retry that starts clears the error banner in
 *  load, and only a new failure re-arms it); any other failure keeps the
 *  single 5s-later retry. Returns the unmount cleanup that clears every
 *  pending timer. */
type LoadResult = { ok: boolean; err?: unknown }

/** Connection-type failure (Models.tsx isConnErr parity): rpc not attached,
 *  or the client's own not-connected/closed/connect errors. */
function isConnErr(rpc: RpcRef, e: unknown): boolean {
  if (!rpc.current) return true
  return /not connected|websocket|socket|superseded|connect|closed|econn|network/i.test(String(e))
}

function mountLoad(rpc: RpcRef, load: () => Promise<LoadResult>): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let alive = true
  let retries = 1
  const deadline = Date.now() + 30_000
  const later = (fn: () => void, ms: number) => { if (alive) timers.push(setTimeout(fn, ms)) }
  const go = () => {
    if (!alive) return
    if (!rpc.current) {
      if (Date.now() < deadline) later(go, 2000)
      return
    }
    void load().then((res) => {
      if (!alive || res.ok) return
      if (isConnErr(rpc, res.err) && Date.now() < deadline) { later(go, 2000); return }
      if (retries > 0) { retries -= 1; later(go, 5000) }
    })
  }
  go()
  return () => { alive = false; for (const t of timers) clearTimeout(t) }
}

/** #3: cron.manage wraps the tool JSON in an RPC SUCCESS even when the tool
 *  failed — the gateway does `_ok(rid, json.loads(cronjob(...)))`
 *  (methods_tools.py) and tools/registry.py tool_error emits
 *  `{"success": false, "error": ...}`. So a resolved call can still be a
 *  failure: read the envelope before toasting. */
const cronEnvelopeErr = (res: unknown): string | null => {
  if (res && typeof res === 'object' && (res as Record<string, unknown>).success === false) {
    return String((res as Record<string, unknown>).error ?? 'cron.manage reported failure')
  }
  return null
}

/** #4: slash.exec RESOLVES with the printed output even on failure — /cron
 *  CLI handlers mark errors "(x_x) Failed to … job: …"
 *  (hermes_cli/cli_commands_mixin.py). */
const isSlashFail = (out: string): boolean =>
  /\(x_x\)|failed to (update|create|run|pause|resume|remove)/i.test(out)

/** A1: does this failure mean the reused session id no longer exists
 *  (gateway restart / expired session)? Phone parity: chat.ts matches
 *  "session not found" (rpc error id 4001). */
const isUnknownSession = (e: unknown): boolean => /session not found|unknown session/i.test(String(e))

/** Shell-quote a value for /cron edit flags (RN automations.tsx shq). */
const shq = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Future-relative chip for next_run (RN `when`): due / in 12m / in 3h /
 *  in 2d. types.ts relTime is past-oriented ("2h" = ago), so the phone's
 *  future variant lives here. */
const when = (iso?: string | null): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  if (diff < 0) return 'due'
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`
  return `in ${Math.round(diff / 86_400_000)}d`
}

/** Full locale timestamp for the expanded detail rows (RN fmtFull). */
const fmtFull = (iso?: string | null): string => {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  try {
    return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

type FormState = {
  /** null → add mode; set → edit mode (name locked: /cron edit has no --name). */
  jobId: string | null
  name: string
  schedule: string
  prompt: string
  /** Prompt exactly as loaded from the gateway ('get'); the save
   *  dirty-check compares against it so a schedule-only edit never
   *  re-sends --prompt. null while the 'get' fetch is in flight. */
  loadedPrompt: string | null
  /** The 'get' fetch failed: the field holds the 100-char preview. */
  promptDegraded: boolean
  saving: boolean
}

const ADD_FORM: FormState = {
  jobId: null, name: '', schedule: 'every 30m', prompt: '',
  loadedPrompt: null, promptDegraded: false, saving: false,
}

export default function AutomationsTab({ rpc }: { rpc: RpcRef }) {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [err, setErr] = useState('')
  /** Transient status line ("Paused …", "Job ID copied") — fades after 4s. */
  const [status, setStatus] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  /** job_id armed for a second-click delete confirm (Bots tab pattern). */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(ADD_FORM)
  /** A1: the ONE shared 'automation' session for run-now/edit (reused
   *  across commands; recreated only when missing or dead). */
  const autoSession = useRef<string | null>(null)
  /** #5: mutex around the ensure-session + command sequence (saveForm and
   *  run-now): without it two concurrent paths can both see
   *  autoSession===null and create duplicate 'automation' sessions. */
  const cronBusy = useRef(false)
  /** B2: armed-delete confirm timers, cleared on unmount. */
  const armTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => { for (const t of armTimers.current) clearTimeout(t) }, [])

  const listJobs = async (): Promise<CronJob[]> => {
    const res: any = await rpc.current!('cron.manage', { action: 'list', include_disabled: true })
    return res?.jobs ?? []
  }

  const load = async (): Promise<LoadResult> => {
    const r = rpc.current; if (!r) return { ok: false, err: new Error('gateway not connected') }
    setErr('')
    try {
      setJobs(await listJobs())
      return { ok: true }
    } catch (e) { setErr(String(e)); return { ok: false, err: e } }
  }
  useEffect(() => mountLoad(rpc, load), [])

  /** A2: silent refresh — update last_status/next-run without touching
   *  the error line or clobbering a just-shown status. */
  const refreshQuiet = async () => {
    if (!rpc.current) return
    try { setJobs(await listJobs()) } catch { /* keep the last view */ }
  }

  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(''), 4000)
    return () => clearTimeout(t)
  }, [status])

  const armDelete = (jobId: string) => {
    setConfirmDel(jobId)
    armTimers.current.push(setTimeout(() => setConfirmDel((c) => (c === jobId ? null : c)), 4000))
  }

  /** Run a /cron subcommand through slash.exec — it needs a live session id.
   *  A1: reuse the ONE 'automation' session instead of creating a throwaway
   *  per command (the drawer filled with dead sessions). Create only when
   *  we have none, or recreate once when the reused id turns out dead. */
  const cronSlash = async (command: string): Promise<string> => {
    const r = rpc.current!
    const exec = async (sid: string) => {
      const res: any = await r('slash.exec', { session_id: sid, command })
      return String(res?.output ?? '').trim()
    }
    if (autoSession.current) {
      try { return await exec(autoSession.current) } catch (e) {
        if (!isUnknownSession(e)) throw e
        autoSession.current = null
      }
    }
    const s: any = await r('session.create', { title: 'automation', cols: 120, source: 'mobile' })
    if (!s?.session_id) throw new Error('session.create returned no session_id')
    autoSession.current = s.session_id
    return exec(s.session_id)
  }

  const withBusy = async (jobId: string, fn: () => Promise<void>) => {
    setBusyJob(jobId); setErr('')
    try { await fn() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusyJob(null) }
  }

  const togglePause = (j: CronJob) => void withBusy(j.job_id, async () => {
    const action = j.enabled === false ? 'resume' : 'pause'
    const res: any = await rpc.current!('cron.manage', { action, name: j.job_id })
    // #3: a tool failure resolves as RPC success ({success:false, error}) —
    // surface the real error, never the green status toast.
    const fail = cronEnvelopeErr(res)
    if (fail) throw new Error(`${action} failed: ${fail}`)
    setStatus(action === 'pause' ? `Paused “${j.name ?? j.job_id}”` : `Resumed “${j.name ?? j.job_id}”`)
    await load()
  })

  const runNow = (j: CronJob) => void withBusy(j.job_id, async () => {
    // #5: never race saveForm (or another run) into the shared session.
    if (cronBusy.current) return
    cronBusy.current = true
    try {
      const out = await cronSlash(`/cron run ${j.job_id}`)
      // #4: slash.exec resolves with printed output — a failure carries the
      // "(x_x) Failed to …" marker and must not read as a green status.
      if (isSlashFail(out)) throw new Error(out.split('\n')[0] || `Failed to run “${j.name ?? j.job_id}”`)
      setStatus(out.split('\n')[0] || `Queued “${j.name ?? j.job_id}” to run`)
      await refreshQuiet() // A2: last_status / next-run pills update right away
    } finally { cronBusy.current = false }
  })

  const remove = (j: CronJob) => void withBusy(j.job_id, async () => {
    const res: any = await rpc.current!('cron.manage', { action: 'remove', name: j.job_id })
    const fail = cronEnvelopeErr(res) // #3: envelope, not the RPC promise
    if (fail) throw new Error(`remove failed: ${fail}`)
    setStatus(`Deleted “${j.name ?? j.job_id}”`)
    await load()
  })

  const copyId = async (j: CronJob) => {
    try {
      await navigator.clipboard.writeText(j.job_id)
      setStatus('Job ID copied')
    } catch { setStatus('Copy failed — job id is in the details row') }
  }

  /** #108: open the editor from the FULL prompt (cron.manage 'get'), with
   *  the truncated preview only as a degraded fallback. */
  const openEdit = async (j: CronJob) => {
    setErr(''); setConfirmDel(null); setExpanded(j.job_id)
    setForm({
      jobId: j.job_id, name: j.name ?? '', schedule: j.schedule ?? '',
      prompt: j.prompt_preview ?? j.prompt ?? '',
      loadedPrompt: null, promptDegraded: false, saving: false,
    })
    try {
      const r: any = await rpc.current!('cron.manage', { action: 'get', name: j.job_id })
      const full = r?.job?.prompt
      if (typeof full !== 'string') throw new Error('cron.manage get: no job in response')
      setForm((f) => (f.jobId === j.job_id ? { ...f, prompt: full, loadedPrompt: full } : f))
    } catch {
      // Older gateway (no 'get') or the RPC failed: keep the preview,
      // mark degraded — the dirty-check keeps it from being written back.
      setForm((f) => (f.jobId === j.job_id
        ? { ...f, loadedPrompt: j.prompt_preview ?? j.prompt ?? '', promptDegraded: true }
        : f))
    }
  }

  const saveForm = async () => {
    if (form.saving || cronBusy.current) return // #5: one session-touching action at a time
    const schedule = form.schedule.trim()
    const prompt = form.prompt.trim()
    const name = form.name.trim()
    // An unmodified prompt is omitted from the edit command entirely.
    const unchanged = !!form.jobId && form.loadedPrompt !== null && prompt === form.loadedPrompt.trim()
    if (!schedule || (!prompt && !unchanged) || (!form.jobId && !name)) {
      setErr('Name, schedule and prompt are all needed.')
      return
    }
    cronBusy.current = true // #5: guard the ensure-session + command sequence
    setForm({ ...form, saving: true }); setErr('')
    try {
      if (form.jobId) {
        // /cron edit has no --name; schedule + prompt are the editable levers.
        const promptFlag = unchanged ? '' : ` --prompt ${shq(prompt)}`
        const out = await cronSlash(`/cron edit ${form.jobId} --schedule ${shq(schedule)}${promptFlag}`)
        // #4: slash.exec RESOLVES with the printed output — a failed edit
        // answers "(x_x) Failed to update job: …" and must not read as a
        // success. Throwing keeps the form open with the user's edits.
        if (isSlashFail(out)) throw new Error(out.split('\n')[0] || 'Failed to update job')
        setStatus(out.split('\n')[0] || 'Updated')
      } else {
        const res: any = await rpc.current!('cron.manage', { action: 'add', name, schedule, prompt })
        // #3: a tool failure resolves as RPC success ({success:false, error}).
        const fail = cronEnvelopeErr(res)
        if (fail) throw new Error(`create failed: ${fail}`)
        setStatus(`Created “${name}”`)
      }
      setForm(ADD_FORM)
      await load()
    } catch (e) {
      // Failure keeps the form open with the edits intact (no ADD_FORM reset).
      setErr(e instanceof Error ? e.message : String(e))
      setForm((f) => (f.saving ? { ...f, saving: false } : f))
    } finally {
      cronBusy.current = false
    }
  }

  const editing = !!form.jobId
  const promptUnchanged = editing && form.loadedPrompt !== null && form.prompt.trim() === form.loadedPrompt.trim()
  const canSave = form.schedule.trim() !== ''
    && (form.prompt.trim() !== '' || promptUnchanged)
    && (editing || form.name.trim() !== '')

  return (
    <div className="page">
      <div className="pagehead"><h2>Automations</h2><button className="ghost" onClick={() => void load()}>refresh</button></div>
      <p className="dim">Scheduled jobs run on your local runtime, so they work even when this window is closed.</p>
      {status && <div className="okline">{status}</div>}
      {err && <div className="err">{err}</div>}

      <div className="card form">
        <div className="row">
          <strong>{editing ? 'Edit automation' : 'New automation'}</strong>
          {editing && <span className="pill dim">{form.jobId}</span>}
        </div>
        {editing ? (
          <div className="jrow"><span className="jlabel">NAME</span><span className="jvalue">{form.name || form.jobId}</span></div>
        ) : (
          <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        )}
        <input placeholder="schedule (every 30m, in 45m, every monday 9:00…)" value={form.schedule}
          onChange={(e) => setForm({ ...form, schedule: e.target.value })} />
        <span className="checkhint">Intervals: every 30m · every 2h — one-shot: in 45m — weekly: every monday 9:00</span>
        {editing && form.promptDegraded && (
          <div className="notice">
            Couldn't load the full prompt — the field shows the truncated preview. Saving without prompt changes is safe; editing the prompt here would rewrite it truncated.
          </div>
        )}
        <textarea placeholder="prompt — what should run (self-contained: jobs run in a fresh session with no chat context)"
          value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        <div className="row">
          <button className="primary" onClick={() => void saveForm()} disabled={!canSave || form.saving}>
            {form.saving ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}
          </button>
          {editing && (
            <button className="ghost" onClick={() => setForm(ADD_FORM)} disabled={form.saving}>cancel edit</button>
          )}
        </div>
      </div>

      {jobs.length === 0 && !err && (
        <div className="empty">
          <div className="mochi">(●ᴗ●)</div>
          <p>No automations yet — create one above, or from chat with /cron add.</p>
        </div>
      )}

      {jobs.map((j) => {
        const paused = j.enabled === false || j.state === 'paused'
        const open = expanded === j.job_id
        const isBusy = busyJob === j.job_id
        const next = j.next_run_at ?? j.next_run ?? null
        const armed = confirmDel === j.job_id
        const preview = j.prompt_preview ?? j.prompt ?? ''
        const lastError = j.last_fire_error || j.last_delivery_error || j.last_error
        return (
          <div key={j.job_id} className="card">
            <div className="row">
              <strong>{j.name ?? j.job_id}</strong>
              {paused ? (
                <span className="pill warn">paused</span>
              ) : next ? (
                <span className="pill ok" title={fmtFull(next)}>{when(next)}</span>
              ) : null}
              {j.schedule && <span className="pill dim">{j.schedule}</span>}
              {j.last_status && <span className="pill dim">last: {j.last_status}</span>}
              <span className="spacer" />
              <button className="ghost" onClick={() => { setExpanded(open ? null : j.job_id); setConfirmDel(null) }}>
                {open ? 'less' : 'details'}
              </button>
            </div>
            {preview && <div className={`dim jprompt${open ? ' open' : ''}`}><Markdown text={preview} /></div>}
            {open && (
              <div className="jdetails">
                <div className="jrow">
                  <span className="jlabel">Job ID</span>
                  <button type="button" className="jvalue copy" onClick={() => void copyId(j)} title="click to copy">
                    {j.job_id} ⧉
                  </button>
                </div>
                <div className="jrow">
                  <span className="jlabel">Next run</span>
                  <span className="jvalue">{next ? fmtFull(next) : '—'}</span>
                </div>
                <div className="jrow">
                  <span className="jlabel">Last run</span>
                  <span className="jvalue">{fmtFull(j.last_run_at)}</span>
                </div>
                {j.repeat && <div className="jrow"><span className="jlabel">Repeat</span><span className="jvalue">{j.repeat}</span></div>}
                {j.deliver && <div className="jrow"><span className="jlabel">Deliver</span><span className="jvalue">{j.deliver}</span></div>}
                {j.paused_reason && <div className="jrow"><span className="jlabel">Paused because</span><span className="jvalue">{j.paused_reason}</span></div>}
                {lastError && <div className="jrow"><span className="jlabel">Last error</span><span className="jvalue bad">{String(lastError).slice(0, 300)}</span></div>}
              </div>
            )}
            <div className="row mt8">
              <button className="ghost" disabled={!!busyJob} onClick={() => runNow(j)}>
                {isBusy ? '…' : 'run now'}
              </button>
              <button className="ghost" disabled={!!busyJob} onClick={() => togglePause(j)}>
                {paused ? 'resume' : 'pause'}
              </button>
              <button className="ghost" disabled={!!busyJob} onClick={() => void openEdit(j)}>edit</button>
              <button className={`ghost danger${armed ? ' confirm' : ''}`} disabled={!!busyJob}
                onClick={() => (armed ? remove(j) : armDelete(j.job_id))}>
                {armed ? 'sure? delete' : 'delete'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
