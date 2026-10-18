/**
 * Automations — scheduled prompts over the gateway's cron surface
 * (`cron.manage`). The wire shape drifts between gateway generations
 * (id|job_id|name row keys, add|create, delete|remove, enabled|paused), so
 * every row is normalized and every mutation tries its action aliases,
 * falling through on "unknown action" errors only — real failures surface
 * verbatim. Job-bound actions address a job through the `name` param
 * carrying its job_id (the same contract as the mobile app); the running
 * gateway's strict params reject `id`/`job_id` extras.
 */
import { rpc } from './gateway'

export interface CronJob {
  id: string
  name: string
  /** Plain-language schedule as stored, e.g. "every 30m". */
  schedule: string
  /** Preview from list (≤100 chars on this gateway); the full text only after getAutomation(). */
  prompt: string
  /** Full stored prompt when known (cron.manage get). */
  promptFull: string | null
  deliver: string | null
  enabled: boolean
  nextRun: string | null
  lastStatus: string | null
  lastError: string | null
  skills: string[]
}

export interface AutomationDraft {
  name?: string
  schedule: string
  prompt: string
  deliver?: string
  skills?: string[]
}

type Rec = Record<string, unknown>

const asRec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function isUnknownActionError(e: unknown): boolean {
  return /unknown\s+(cron\s+)?action|unsupported\s+action|action\s+not\s+(supported|found)/i.test(errMsg(e))
}

/** cron.manage results carry tool-level failures in-band ({error, success:false}) — surface them as throws. */
function check(res: unknown, what: string): Rec {
  const r = asRec(res)
  const err = str(r.error)
  if (err) throw new Error(err)
  if (r.success === false) throw new Error(`${what} failed`)
  return r
}

async function cron(params: Rec, timeoutMs = 20000): Promise<Rec> {
  return check(await rpc<unknown>('cron.manage', params, timeoutMs), 'cron.manage')
}

export function normalizeCronJob(raw: unknown): CronJob | null {
  const r = asRec(raw)
  const id = str(r.job_id) ?? str(r.id) ?? str(r.name)
  if (!id) return null
  let enabled = true
  if (typeof r.enabled === 'boolean') enabled = r.enabled
  else if (typeof r.paused === 'boolean') enabled = !r.paused
  else if (r.paused_at != null) enabled = false
  const skills = strArr(r.skills)
  const single = str(r.skill)
  const promptFull = typeof r.prompt === 'string' ? r.prompt : null
  return {
    id,
    name: str(r.name) ?? id,
    schedule: str(r.schedule) ?? str(r.cron) ?? '—',
    prompt: promptFull ?? str(r.prompt_preview) ?? '',
    promptFull,
    deliver: str(r.deliver),
    enabled,
    nextRun: str(r.next_run_at) ?? str(r.next_run) ?? str(r.nextRunAt),
    lastStatus: str(r.last_status) ?? str(r.status),
    lastError: str(r.last_error) ?? str(r.last_fire_error) ?? str(r.last_delivery_error),
    skills: single && !skills.includes(single) ? [...skills, single] : skills,
  }
}

export async function listAutomations(): Promise<CronJob[]> {
  const res = await rpc<unknown>('cron.manage', { action: 'list', include_disabled: true }, 15000)
  const r = check(res, 'cron list')
  const rows: unknown[] = Array.isArray(r.jobs)
    ? r.jobs
    : Array.isArray(r.items)
      ? r.items
      : Array.isArray(res)
        ? (res as unknown[])
        : []
  return rows.map(normalizeCronJob).filter((j): j is CronJob => j !== null)
}

/** Full stored prompt for one job (cron.manage get — the mobile-only extension this fork ships). */
export async function getAutomation(id: string): Promise<CronJob | null> {
  try {
    const r = await cron({ action: 'get', name: id })
    return normalizeCronJob(r.job ?? asRec(r.result).job)
  } catch {
    return null
  }
}

async function createRaw(d: AutomationDraft): Promise<Rec> {
  const params: Rec = { schedule: d.schedule, prompt: d.prompt }
  if (d.name) params.name = d.name
  if (d.deliver) params.deliver = d.deliver
  if (d.skills?.length) params.skills = d.skills
  try {
    // This gateway's create action is 'add'; other generations call it 'create'.
    return await cron({ action: 'add', ...params })
  } catch (e) {
    if (!isUnknownActionError(e)) throw e
    return await cron({ action: 'create', ...params })
  }
}

export async function createAutomation(d: AutomationDraft): Promise<void> {
  await createRaw(d)
}

export async function deleteAutomation(id: string): Promise<void> {
  try {
    await cron({ action: 'delete', name: id })
  } catch (e) {
    if (!isUnknownActionError(e)) throw e
    await cron({ action: 'remove', name: id })
  }
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
  const action = enabled ? 'resume' : 'pause'
  try {
    await cron({ action, name: id })
    return
  } catch (e) {
    if (!isUnknownActionError(e)) throw e
  }
  // Fork without pause/resume: toggle through update.
  try {
    await cron({ action: 'update', name: id, enabled })
  } catch (e) {
    if (!isUnknownActionError(e)) throw e
    throw new Error(`this gateway does not support ${action}`)
  }
}

/** One cron execution from the merged run ledger (moch.runs.timeline, source "cron"). */
export interface CronRun {
  /** Execution id from cron/executions.db. */
  id: string
  /** Owning job — the ledger only carries it inside the title, as "job <job_id>". */
  jobId: string
  status: string
  /** Epoch ms; null when the ledger row carried no usable timestamp. */
  ts: number | null
  error: string | null
}

function normalizeCronRun(raw: unknown): CronRun | null {
  const r = asRec(raw)
  if (str(r.source) !== 'cron') return null
  const jobId = /^job (.+)$/.exec(str(r.title) ?? '')?.[1] ?? ''
  if (!jobId) return null
  const rawTs = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : null
  return {
    id: str(r.id) ?? `${jobId}-${rawTs ?? Date.now()}`,
    jobId,
    status: str(r.status) ?? '',
    ts: rawTs === null ? null : rawTs < 1e12 ? rawTs * 1000 : rawTs,
    error: str(r.error),
  }
}

/**
 * Past executions of one job, newest first, via the merged run ledger.
 * The ledger has no per-job filter (limit caps at 200 server-side), so this
 * pulls the widest window and matches rows to the job by id or name — the
 * same identity set cron.manage mutations already address.
 */
export async function listAutomationRuns(job: CronJob, keep = 30): Promise<CronRun[]> {
  const res = await rpc<{ runs?: unknown[] }>('moch.runs.timeline', { limit: 200 }, 15000)
  const rows = Array.isArray(res?.runs) ? res.runs : []
  return rows
    .map(normalizeCronRun)
    .filter((r): r is CronRun => r !== null)
    .filter((r) => r.jobId === job.id || r.jobId === job.name)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, keep)
}

export async function runAutomationNow(id: string): Promise<void> {
  for (const action of ['run_now', 'run']) {
    try {
      await cron({ action, name: id })
      return
    } catch (e) {
      if (!isUnknownActionError(e)) throw e
    }
  }
  throw new Error('run-now is not supported by this gateway')
}

export interface AutomationPatch {
  schedule: string
  prompt: string
  deliver?: string | null
  skills?: string[]
  name?: string
}

export async function updateAutomation(id: string, p: AutomationPatch): Promise<void> {
  const params: Rec = { name: id, schedule: p.schedule, prompt: p.prompt }
  if (p.deliver) params.deliver = p.deliver
  if (p.skills?.length) params.skills = p.skills
  try {
    await cron({ action: 'update', ...params })
    return
  } catch (e) {
    if (!isUnknownActionError(e)) throw e
  }
  // No update action: recreate under the same name, then drop the old job —
  // but only when the gateway minted a DIFFERENT id (an id match means the
  // same slot was rewritten in place; removing it would delete the fresh job).
  const created = await createRaw({
    name: p.name ?? id,
    schedule: p.schedule,
    prompt: p.prompt,
    deliver: p.deliver ?? undefined,
    skills: p.skills,
  })
  const newId = str(asRec(created.result).job_id) ?? str(created.job_id)
  if (newId === id) return
  if (!newId) throw new Error('editing is not supported by this gateway (update unavailable)')
  try {
    await cron({ action: 'remove', name: id })
  } catch {
    /* old row left behind — the list refresh will show both */
  }
}

/** Starter cards for the empty state — labelKey is the card, schedule+prompt prefill the modal. */
export const AUTOMATION_TEMPLATES: { labelKey: string; schedule: string; prompt: string }[] = [
  {
    labelKey: 'routines.tpl.day',
    schedule: 'every day 19:00',
    prompt: 'Summarize my day: what I worked on, what moved forward, and the one thing to pick up tomorrow.',
  },
  {
    labelKey: 'routines.tpl.deals',
    schedule: 'every 2h',
    prompt: 'Check my watchlist sources for new deals and flag anything worth acting on, with links.',
  },
  {
    labelKey: 'routines.tpl.journal',
    schedule: 'every friday 18:00',
    prompt: 'Write my weekly journal recap: highlights, what I learned, and what to change next week.',
  },
]

/** Defensive "when" formatting for next_run/last_run strings (ISO or not). */
export function fmtWhen(v: string | null): string {
  if (!v) return ''
  const t = Date.parse(v)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    if (d.getFullYear() > 1971) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return v
}
