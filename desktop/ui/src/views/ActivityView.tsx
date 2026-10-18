/**
 * Activity — the merged run timeline across every bot: board tasks, cron
 * runs and delegations from the shared ledger (moch.runs.timeline through
 * crew.ts), newest first and grouped by day. A row opens the owning bot's
 * home thread. Interrupted is a state of its own, never painted as failure.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Clock, GitBranch, KanbanSquare, Loader } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { openHomeThread } from '../lib/chat'
import { accentFor } from '../lib/fleet'
import { displayBotName, refreshRuns, runsAtom, type RunEntry } from '../lib/crew'
import { locale, tr, type Locale } from '../lib/strings'
import type { ViewId } from '../app'

type ActStatus = 'completed' | 'failed' | 'interrupted' | 'running' | 'other'

/**
 * Interrupted outranks the failure test on purpose: a cancelled run that
 * carries an error string was still interrupted, not failed. The wire
 * vocabulary is wide (kanban done/ready/blocked, cron completed/failed,
 * delegation states), so anything unrecognized renders as neutral "other"
 * with its raw status text instead of being forced into a wrong bucket.
 */
function classifyRun(run: RunEntry): ActStatus {
  const s = run.status.toLowerCase()
  if (/interrupt|cancel|abort/.test(s)) return 'interrupted'
  if (!!run.error || /fail|error|timeout/.test(s)) return 'failed'
  if (/done|complete|succeed|success|^ok$/.test(s)) return 'completed'
  if (/running|active|progress|claimed|dispatch|start/.test(s)) return 'running'
  return 'other'
}

const STATUS: Record<ActStatus, { key: string; color: string }> = {
  completed: { key: 'activity.status.completed', color: 'var(--green-soft)' },
  failed: { key: 'activity.status.failed', color: 'var(--red)' },
  interrupted: { key: 'activity.status.interrupted', color: 'var(--text-dim)' },
  running: { key: 'activity.status.running', color: 'var(--amber)' },
  other: { key: '', color: 'var(--text-faint)' },
}

type DayKey = 'today' | 'yesterday' | 'earlier'
const DAY_ORDER: DayKey[] = ['today', 'yesterday', 'earlier']

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** The rail's grouping vocabulary: calendar Today, Yesterday, then earlier. */
function dayKeyFor(ts: number | undefined): DayKey {
  if (!ts) return 'earlier'
  const d = new Date(ts)
  const now = new Date()
  if (sameDay(d, now)) return 'today'
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(d, y)) return 'yesterday'
  return 'earlier'
}

/** Rows inside Today and Yesterday show a clock time; older rows show the date. */
function fmtTime(ts: number | undefined, day: DayKey, loc: Locale): string {
  if (!ts) return ''
  const d = new Date(ts)
  const tag = loc === 'ar' ? 'ar' : undefined
  try {
    return day === 'earlier'
      ? d.toLocaleDateString(tag, { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function ActivityView({ onOpen }: { onOpen?: (v: ViewId) => void }) {
  const runs = useStore(runsAtom)
  const loc = useStore(locale) // subscribe so every label re-renders on locale change
  const [loaded, setLoaded] = useState(false)

  // Fresh on entry, then kept current with no manual control: refresh when
  // the window regains focus, when the tab becomes visible, and on a slow
  // poll while visible so a run that finishes mid-visit still shows up.
  useEffect(() => {
    let alive = true
    const load = () => {
      void refreshRuns(200).finally(() => { if (alive) setLoaded(true) })
    }
    load()
    const onWinFocus = () => load()
    const onVis = () => { if (!document.hidden) load() }
    const timer = setInterval(() => { if (!document.hidden) load() }, 30000)
    window.addEventListener('focus', onWinFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', onWinFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // The RPC already merges newest first; grouping preserves that order.
  const groups = useMemo(() => {
    const byDay = new Map<DayKey, RunEntry[]>(DAY_ORDER.map((k) => [k, [] as RunEntry[]]))
    for (const r of runs) byDay.get(dayKeyFor(r.ts))!.push(r)
    return DAY_ORDER.map((key) => ({ key, rows: byDay.get(key)! })).filter((g) => g.rows.length > 0)
  }, [runs])

  const open = async (profile: string) => {
    try {
      await openHomeThread(profile === 'default' ? null : profile)
    } catch {
      // Route to the thread pane anyway; the next send re-anchors to the bot.
    }
    onOpen?.('chat')
  }

  return (
    <main className="focus">
      <div className="focus-head">
        <span style={{ fontWeight: 650, fontSize: 15 }}>{tr('activity.title')}</span>
        {loaded ? (
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{tr('activity.count', { n: runs.length })}</span>
        ) : null}
      </div>
      <div className="focus-body">
        {!loaded ? (
          <div className="empty" style={{ padding: '80px 20px' }}>
            <Loader size={22} color="var(--text-faint)" style={{ animation: 'spin 0.9s linear infinite' }} />
            <div className="empty-sub">{tr('activity.loading')}</div>
          </div>
        ) : runs.length === 0 ? (
          <div className="empty" style={{ padding: '90px 20px' }}>
            <Activity size={30} color="var(--text-faint)" />
            <div className="empty-title">{tr('activity.empty.title')}</div>
            <div className="empty-sub">{tr('activity.empty.sub')}</div>
          </div>
        ) : (
          <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', padding: '0 16px 40px' }}>
            {groups.map((g) => (
              <section key={g.key}>
                <div className="row-section">{tr(`activity.day.${g.key}`)}</div>
                {g.rows.map((r) => (
                  <RunRow key={r.id} run={r} day={g.key} loc={loc} onOpen={() => void open(r.profile)} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function RunRow({ run, day, loc, onOpen }: {
  run: RunEntry
  day: DayKey
  loc: Locale
  onOpen: () => void
}) {
  const st = classifyRun(run)
  const meta = STATUS[st]
  const Icon: LucideIcon = run.source === 'cron' ? Clock : run.source === 'delegate' ? GitBranch : KanbanSquare
  const bot = displayBotName(run.profile)
  const statusLabel = st === 'other' ? run.status : tr(meta.key)
  const dot: React.CSSProperties = st === 'interrupted'
    ? { width: 7, height: 7, borderRadius: '50%', background: 'transparent', border: `1.5px solid ${meta.color}`, flexShrink: 0 }
    : { width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }
  return (
    <button
      className="row"
      onClick={onOpen}
      title={run.error ? `${run.title} — ${run.error}` : `${tr(`activity.source.${run.source}`)} · ${run.title}`}
      aria-label={tr('activity.row.open', { name: bot })}
    >
      <Icon size={14} color="var(--text-faint)" style={{ flexShrink: 0 }} />
      <span className="row-title" style={{ color: st === 'failed' ? 'var(--red)' : 'var(--text)' }}>{run.title}</span>
      <span className="row-meta" style={{ color: accentFor(run.profile) }}>{bot}</span>
      <span className="row-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: meta.color }}>
        {st === 'running'
          ? <Loader size={11} style={{ flexShrink: 0, animation: 'spin 0.9s linear infinite' }} />
          : <span style={dot} />}
        {statusLabel}
      </span>
      <span className="row-meta">{fmtTime(run.ts, day, loc)}</span>
    </button>
  )
}
