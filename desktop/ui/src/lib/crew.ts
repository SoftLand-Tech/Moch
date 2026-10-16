/**
 * Crew state — the kanban board + run ledger the Crew view renders.
 * Same RPC vocabulary as the phone app; normalization lives here so the
 * views stay dumb. Errors from board reads land in `crewError` (rendered
 * as a small banner); actions throw so the caller can show inline errors.
 */

import { atom } from 'nanostores'
import { rpc } from './gateway'

export type TaskStatus = 'ready' | 'running' | 'blocked' | 'done'

export interface Task {
  id: string
  title: string
  assignee: string
  status: TaskStatus
  priority?: string
  body?: string
  createdAt?: number
  completedAt?: number
}

export type RunSource = 'kanban' | 'cron' | 'delegate'

export interface RunEntry {
  source: RunSource
  id: string
  profile: string
  title: string
  status: string
  ts?: number
  error?: string
}

export const tasksAtom = atom<Task[]>([])
export const runsAtom = atom<RunEntry[]>([])
export const crewError = atom<string>('')

/** 'default' is the main agent — everywhere in the UI it shows as "Mochi". */
export function displayBotName(name: string | null | undefined): string {
  return !name || name === 'default' ? 'Mochi' : name
}

/** The gateway sends a wider status vocabulary than the board shows. */
export function normalizeStatus(s: unknown): TaskStatus {
  const v = typeof s === 'string' ? s.toLowerCase() : ''
  if (v === 'done' || v === 'complete' || v === 'completed') return 'done'
  if (v === 'running' || v === 'active' || v === 'in_progress') return 'running'
  if (v === 'blocked' || v === 'block') return 'blocked'
  return 'ready'
}

/** Timestamps arrive as seconds or ms depending on the caller — normalize. */
function toMs(ts: unknown): number | undefined {
  const n = typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined
  if (n === undefined) return undefined
  return n < 1e12 ? n * 1000 : n
}

interface RawTask {
  id?: unknown; title?: unknown; assignee?: unknown; status?: unknown
  priority?: unknown; body?: unknown; createdAt?: unknown; completedAt?: unknown
}

function normalizeTask(t: RawTask): Task {
  return {
    id: String(t.id ?? ''),
    title: typeof t.title === 'string' && t.title ? t.title : 'Untitled task',
    assignee: typeof t.assignee === 'string' && t.assignee ? t.assignee : 'default',
    status: normalizeStatus(t.status),
    priority: typeof t.priority === 'string' ? t.priority : undefined,
    body: typeof t.body === 'string' ? t.body : undefined,
    createdAt: toMs(t.createdAt),
    completedAt: toMs(t.completedAt),
  }
}

interface RawRun {
  source?: unknown; id?: unknown; profile?: unknown; title?: unknown
  status?: unknown; ts?: unknown; error?: unknown
}

function normalizeRun(r: RawRun): RunEntry {
  const src = typeof r.source === 'string' ? r.source : 'kanban'
  return {
    source: src === 'cron' ? 'cron' : src === 'delegate' ? 'delegate' : 'kanban',
    id: String(r.id ?? `${r.profile ?? 'x'}-${r.ts ?? Date.now()}`),
    profile: typeof r.profile === 'string' && r.profile ? r.profile : 'default',
    title: typeof r.title === 'string' && r.title ? r.title : 'Untitled run',
    status: typeof r.status === 'string' ? r.status : '',
    ts: toMs(r.ts),
    error: typeof r.error === 'string' ? r.error : undefined,
  }
}

export function runFailed(run: RunEntry): boolean {
  return !!run.error || /fail|error|blocked|cancel/i.test(run.status)
}

export function newIdempotencyKey(): string {
  return `moch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function fmtWhen(ts: number | undefined): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(ts).toISOString()
  }
}

export async function refreshTasks(): Promise<void> {
  try {
    const res = await rpc<{ tasks?: RawTask[] }>('moch.kanban.tasks', { limit: 120 }, 10000)
    tasksAtom.set((res.tasks ?? []).map(normalizeTask))
    crewError.set('')
  } catch (e) {
    crewError.set(e instanceof Error ? e.message : String(e))
  }
}

export async function refreshRuns(): Promise<void> {
  try {
    const res = await rpc<{ runs?: RawRun[] }>('moch.runs.timeline', { limit: 25 }, 10000)
    runsAtom.set((res.runs ?? []).map(normalizeRun))
  } catch {
    /* the ledger is secondary — keep the last rows on a gateway hiccup */
  }
}

export async function refreshCrew(): Promise<void> {
  await Promise.all([refreshTasks(), refreshRuns()])
}

export async function createTask(input: { title: string; body?: string; assignee: string }): Promise<void> {
  await rpc('moch.kanban.create', {
    title: input.title,
    body: input.body ?? '',
    assignee: input.assignee,
    idempotency_key: newIdempotencyKey(),
  }, 10000)
  await refreshTasks()
}

export async function assignTask(taskId: string, assignee: string): Promise<void> {
  await rpc('moch.kanban.assign', { task_id: taskId, assignee }, 10000)
  await refreshTasks()
}

export async function completeTask(taskId: string, summary: string): Promise<void> {
  await rpc('moch.kanban.complete', { task_id: taskId, summary }, 15000)
  await refreshTasks()
}
