/**
 * Shared types + plumbing for the Moch Desktop tabs.
 * Extracted verbatim from App.tsx when tabs moved to src/tabs/* (round 4).
 * RPC shapes mirror the RN app contracts (app/src/lib/fleet.ts etc.).
 */

export type Cfg = { wsUrl: string; token: string; mode: string; home?: string; logTail?: string }
export type Tab = 'chat' | 'bots' | 'crew' | 'automations' | 'skills' | 'models' | 'run'

/** The RPC handle App passes into every tab (the gateway client's request fn). */
export type RpcRef = { current: ((m: string, p?: any) => Promise<any>) | null }

export type Block = { id: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'status'; text: string; live?: boolean; meta?: string }
export type SessionRow = {
  /** Durable id — the one session.resume takes (sessionRowMeta.ts). */
  id?: string
  session_id?: string; stored_session_id?: string
  title?: string; preview?: string
  /** Unix SECONDS, fractional. */
  started_at?: number
  message_count?: number
  profile?: string
}

export type FleetProfile = { name: string; description?: string; soul?: string; frozen?: boolean; gateHeld?: boolean; model?: { provider: string; default: string } }
export type FleetQueueEntry = { home: string; priority: string; seq: number; queued_s: number }
export type FleetStatus = {
  fleetEnabled: boolean
  queue?: { slots: number; active: number; waiting?: FleetQueueEntry[] }
  profiles?: { name: string; frozen: boolean; gateHeld: boolean }[]
}
export type LaunchSkill = { name: string; description: string; path: string }

/** moch.profiles.seed result — per-item copy outcome ('copied' = clean). */
export type SeedResult = {
  profile: string
  userMemory: string | null
  memory: string | null
  skills: { name: string; result: string }[]
}
/** True when any seeded item was NOT copied (missing/skipped-exists/…) — fleet.ts. */
export function seedHasSkips(seed: SeedResult): boolean {
  const bad = (v: string | null) => v !== null && v !== 'copied'
  return bad(seed.userMemory) || bad(seed.memory) ||
    seed.skills.some((s) => s.result !== 'copied')
}

/** Create-checklist for new bots (BUG-139 on the phone): what launch context
 *  to copy as FILES via moch.profiles.seed — never prompt-stuffing. */
export type CreateChecklist = {
  /** Copy launch USER.md ("ideas about me") — default ON. */
  copyUserMemory: boolean
  /** Copy launch MEMORY.md too — default OFF (noisy accumulated history). */
  copyMemory: boolean
  /** Selected launch skill names to copy (moch.profiles.seed). */
  skills: string[]
}
export const DEFAULT_CHECKLIST: CreateChecklist = { copyUserMemory: true, copyMemory: false, skills: [] }

export type Job = { job_id: string; name?: string; schedule?: string; prompt?: string; enabled?: boolean; next_run?: string }
export type Task = { id?: string; title?: string; body?: string; assignee?: string; status?: string; state?: string }
export type Provider = { slug?: string; name?: string; provider?: string; authenticated?: boolean; auth_type?: string; model?: string; default?: string }

/** started_at is unix seconds; normalize defensively (sessionList.ts toMs). */
export function toMs(ts?: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  if (ts > 1e12) return ts
  return ts * 1000
}
export function relTime(ts?: number): string {
  const ms = toMs(ts)
  if (!ms) return ''
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Shell debug tap — desktop/.dbg.log (POST /dbg, fire-and-forget). */
export function dbg(what: string, extra: Record<string, unknown> = {}) {
  fetch('/dbg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: Date.now(), what, ...extra }) }).catch(() => {})
}
export const ev = (e: unknown): { type: string; session_id?: string; payload: any } => e as any

/* ══ Round 5 — Crew + Automations (phone parity) ══ */

/** moch.runs.timeline row — the merged kanban/cron/delegation run ledger
 *  (rpc_fleet.py moch_runs_timeline: newest-first VIEW, not a store).
 *  ts is unix seconds (fractional); source ∈ kanban | cron | delegate. */
export type Run = {
  source: string
  id: string
  profile: string
  title: string
  status: string
  ts?: number
  error?: string
  board?: string
}

/** cron.manage 'list' row. prompt_preview is capped at 100 chars
 *  server-side (phone #108) — the FULL prompt only comes via
 *  action:'get'. next_run_at/last_* are ISO strings; next_run is the
 *  older desktop spelling, kept defensively. */
export type CronJob = {
  job_id: string
  name?: string
  schedule?: string
  prompt_preview?: string
  prompt?: string
  repeat?: string | null
  deliver?: string | null
  next_run_at?: string | null
  next_run?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  last_fire_error?: string | null
  last_delivery_error?: string | null
  enabled?: boolean
  state?: string | null
  paused_reason?: string | null
}
