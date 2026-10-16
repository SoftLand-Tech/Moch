/**
 * TaskSidebar — the FINAL-design left column: New Task, the five nav
 * destinations, the LIVE agents section, and recent sessions. Replaces the
 * old sessions-only context column on the chat view.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import {
  Home, Bot, Wrench, GitBranch, History, MessageSquarePlus,
  Inbox, UsersRound, Plug,
} from 'lucide-react'
import type { ViewId } from '../app'
import { sessionOrder, sessionsById, newChat, activeSession, activeTitle } from '../lib/chat'
import { fleetProfiles, fleetStatusAtom } from '../lib/fleet'
import { agentBusy, pendingCount } from '../lib/chat'
import { isConnected } from '../lib/gateway'
import { displayBotName } from '../lib/crew'

const NAV: { id: ViewId; icon: typeof Home; label: string }[] = [
  { id: 'chat', icon: Home, label: 'Home' },
  { id: 'fleet', icon: Bot, label: 'Agents' },
  { id: 'skills', icon: Wrench, label: 'Tools' },
  { id: 'automations', icon: GitBranch, label: 'Workflows' },
  { id: 'history', icon: History, label: 'History' },
]

const MORE: { id: ViewId; icon: typeof Home; label: string }[] = [
  { id: 'inbox', icon: Inbox, label: 'Inbox' },
  { id: 'crew', icon: UsersRound, label: 'Crew' },
  { id: 'connectors', icon: Plug, label: 'Connectors' },
]

export default function TaskSidebar({ view, onNav }: { view: ViewId; onNav: (v: ViewId) => void }) {
  const order = useStore(sessionOrder)
  const byId = useStore(sessionsById)
  const bots = useStore(fleetProfiles)
  const fleet = useStore(fleetStatusAtom)
  const busy = useStore(agentBusy)
  const connected = useStore(isConnected)
  const pending = useStore(pendingCount)
  const active = useStore(activeSession)
  const title = useStore(activeTitle)
  const [q, setQ] = useState('')

  const recent = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return order
      .filter((r) => !needle || r.title.toLowerCase().includes(needle))
      .slice(0, 8)
  }, [order, q])

  const activeAgents = useMemo(() => {
    const list: { name: string; state: string; tone: 'run' | 'think' | 'idle' }[] = []
    if (busy) list.push({ name: 'Mochi', state: busy ? 'Thinking' : 'Idle', tone: busy ? 'think' : 'idle' })
    for (const b of bots) {
      if (b.name === 'default') continue
      const frozen = fleet?.profiles.find((p) => p.name === b.name)?.frozen
      if (frozen) continue
      // a bot with a running kanban claim shows as working (from fleet queue)
      const working = fleet?.queue.waiting.some((w) => w.home.includes(b.name))
      list.push({ name: displayBotName(b.name), state: working ? 'Working' : 'Idle', tone: working ? 'run' : 'idle' })
    }
    return list
  }, [bots, fleet, busy])

  const activeCount = activeAgents.filter((a) => a.tone !== 'idle').length

  return (
    <aside className="tsb">
      <button className="newtask" onClick={() => { void newChat(); onNav('chat') }} disabled={!connected}>
        <MessageSquarePlus size={15} /> New Task <span className="kbd">⌘K</span>
      </button>

      <nav className="tsb-nav">
        {NAV.map(({ id, icon: Icon, label }) => (
          <button key={id} className={`navitem${view === id ? ' on' : ''}`} onClick={() => onNav(id)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      {activeAgents.length ? (
        <>
          <div className="tsb-sec">Active</div>
          {activeAgents.map((a) => (
            <button key={a.name} className="agrow" onClick={() => onNav(a.name === 'Mochi' ? 'chat' : 'crew')}>
              <span className="sdot" style={{ background: a.tone === 'idle' ? 'var(--text-faint)' : a.tone === 'think' ? 'var(--amber)' : 'var(--green)' }} />
              <span className="aname">{a.name}</span>
              <span className="astate">{a.state}</span>
            </button>
          ))}
        </>
      ) : null}

      <div className="tsb-sec">Recent</div>
      <div className="tsb-recent">
        <div className="tsb-search">⌕ <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {recent.map((r) => {
          const liveId = active && byId[active]?.storedId === r.id ? active : undefined
          return (
            <button key={r.id} className={`rrow${liveId ? ' on' : ''}`} onClick={() => { void import('../lib/chat').then((m) => m.switchToSession(r.id)); onNav('chat') }}>
              <span className="rname">{r.title}</span>
              <span className="rwhen">{r.lastActive ? when(r.lastActive) : ''}</span>
            </button>
          )
        })}
        {recent.length === 0 ? <div className="rrow" style={{ color: 'var(--text-faint)' }}>{connected ? 'No conversations yet' : 'Offline'}</div> : null}
      </div>

      <div className="tsb-foot">
        <span className="ok">●</span> {activeCount || '0'} agents active
        {pending > 0 ? <span className="pbadge">{pending}</span> : null}
        <span className="grow" />
        <button className="mini" title="Inbox" onClick={() => onNav('inbox')}><Inbox size={13} /></button>
        <button className="mini" title="Crew" onClick={() => onNav('crew')}><UsersRound size={13} /></button>
        <button className="mini" title="Connectors" onClick={() => onNav('connectors')}><Plug size={13} /></button>
      </div>
    </aside>
  )
}

function when(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`
  return `${Math.round(d / 86_400_000)}d`
}
