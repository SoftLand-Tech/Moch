/**
 * Cron knocks, desktop edition — the phone polls cron/executions.db
 * in-process; the desktop UI polls the gateway's cron list over the socket
 * and knocks (system notification + inbox-worthy status) when a job's
 * last-run outcome changes. Delivery is app-open-only by design; the cron
 * ticker itself fires inside the gateway regardless.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { rpc, isConnected } from './gateway'

interface CronJob {
  id?: string
  name?: string
  job_id?: string
  schedule?: string
  prompt?: string
  prompt_preview?: string
  enabled?: boolean
  paused?: boolean
  paused_at?: string | null
  last_status?: string
  last_run_at?: number | string | null
  next_run_at?: number | string | null
}

interface Knock {
  name: string
  status: string
  at: number
}

const knocks = new Map<string, Knock>()
let armed = false

function jobKey(j: CronJob): string {
  return String(j.job_id ?? j.id ?? j.name ?? '')
}

function jobStatus(j: CronJob): string {
  return String(j.last_status ?? '').toLowerCase()
}

function parseAt(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return 0
}

async function notify(title: string, body: string): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-notification')
    let granted = await mod.isPermissionGranted()
    if (!granted) {
      granted = (await mod.requestPermission()) === 'granted'
    }
    if (granted) mod.sendNotification({ title, body })
  } catch {
    /* preview track or unavailable — silent */
  }
}

async function pollOnce(): Promise<void> {
  let jobs: CronJob[] = []
  try {
    const res = await rpc<{ jobs?: CronJob[] }>('cron.manage', { action: 'list', include_disabled: true }, 15000)
    jobs = res.jobs ?? []
  } catch {
    return // offline or older gateway — never knock on errors
  }
  for (const j of jobs) {
    const key = jobKey(j)
    if (!key) continue
    const status = jobStatus(j)
    const at = parseAt(j.last_run_at)
    const prev = knocks.get(key)
    if (!prev) {
      // Seed silently so the app-open baseline never knocks retroactively.
      knocks.set(key, { name: key, status, at })
      continue
    }
    if (status && status !== prev.status && (at === 0 || at >= prev.at)) {
      knocks.set(key, { name: key, status, at: at || prev.at })
      const good = /complete|success|ok|done/.test(status)
      const name = String(j.name ?? key)
      void notify(
        good ? `${name} finished` : `${name}: ${status}`,
        String(j.prompt_preview ?? j.prompt ?? j.schedule ?? 'Automation ran').slice(0, 140),
      )
    } else if (at > prev.at) {
      knocks.set(key, { name: key, status, at })
    }
  }
}

/** Arm the knock poller once per app run. */
export function armKnocks(): void {
  if (armed) return
  armed = true
  void pollOnce()
  setInterval(() => {
    if (!document.hidden && isConnected.get()) void pollOnce()
  }, 60_000)
}

/** React hook: arms knocks when the gateway is up. */
export function useKnocks(): void {
  const connected = useStore(isConnected)
  const wasConnected = useRef(false)
  useEffect(() => {
    if (connected && !wasConnected.current) armKnocks()
    wasConnected.current = connected
  }, [connected])
}
