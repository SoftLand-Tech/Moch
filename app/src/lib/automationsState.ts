import { atom } from 'nanostores'
import { isConnected, rpc } from './gateway'

/**
 * How many automations are currently active — the sidebar's little Mochi row
 * next to "Automations". Paused and canceled jobs don't count.
 */
export const runningAutomationCount = atom(0)

/** A minimal slice of the cron job shape (the screen owns the full type). */
export interface CronJobLite {
  enabled?: boolean
  state?: string | null
}

/** Active = not paused (disabled/paused) and not canceled. */
export function countRunningJobs(jobs: CronJobLite[]): number {
  return jobs.filter((j) => {
    if (j.enabled === false) return false
    const st = (j.state ?? '').toLowerCase()
    return st !== 'paused' && !st.includes('cancel')
  }).length
}

/**
 * Re-count from the gateway. The automations screen mirrors its own loads
 * into the store; this covers everywhere else (connect, background poll) so
 * the row is fresh before the screen is ever visited.
 */
export async function refreshRunningAutomations(): Promise<void> {
  if (!isConnected.get()) return
  try {
    const res = await rpc<{ jobs?: CronJobLite[] }>('cron.manage', { action: 'list', include_disabled: true })
    runningAutomationCount.set(countRunningJobs(res?.jobs ?? []))
  } catch {
    // Keep the previous count — the next refresh (poll or screen visit) retries.
  }
}
