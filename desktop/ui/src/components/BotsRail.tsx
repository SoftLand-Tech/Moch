/**
 * BotsRail — the Rakazo-shaped left pane: brand, search, the live roster
 * from the fleet store, and the new-bot entry. The roster IS the desktop
 * home: picking a bot makes the center pane its one home thread.
 */
import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'
import { Plus, Search, Settings } from 'lucide-react'
import type { ViewId } from '../app'
import CreateBotOverlay from './CreateBotOverlay'
import {
  accentFor, activeBotAtom, botAvatar, botColor, fleetProfiles, fleetStatusAtom, setActiveBot,
} from '../lib/fleet'
import { isConnected } from '../lib/gateway'
import { locale, tr } from '../lib/strings'

/** One roster row: null name = the default agent ("Mochi"). */
interface RailBot {
  name: string | null
  description: string
  frozen: boolean
  working: boolean
  color?: string
  avatar?: string
}

function botStatus(b: RailBot): { dot: 'run' | 'idle' | 'frozen'; label: string } {
  if (b.frozen) return { dot: 'frozen', label: tr('shell.thread.frozen') }
  if (b.working) return { dot: 'run', label: tr('shell.thread.working') }
  return { dot: 'idle', label: tr('shell.thread.idle') }
}

export default function BotsRail({ onNav }: { onNav: (v: ViewId) => void }) {
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const bots = useStore(fleetProfiles)
  const fleet = useStore(fleetStatusAtom)
  const active = useStore(activeBotAtom)
  const connected = useStore(isConnected)
  useStore(locale) // subscribe so roster labels re-render when the language changes

  const rows = useMemo<RailBot[]>(() => {
    const working = (name: string) =>
      fleet?.queue.waiting.some((w) => w.home.includes(name)) ?? false
    const frozen = (name: string) =>
      fleet?.profiles.find((p) => p.name === name)?.frozen ?? false
    const all: RailBot[] = [
      { name: null, description: '', frozen: false, working: false },
      ...bots
        .filter((b) => b.name !== 'default')
        .map((b) => ({
          name: b.name,
          description: b.description,
          frozen: frozen(b.name) || !!b.frozen,
          working: working(b.name),
          color: botColor(b),
          avatar: botAvatar(b),
        })),
    ]
    const needle = q.trim().toLowerCase()
    return needle
      ? all.filter((r) => (r.name ?? tr('rail.mochi')).toLowerCase().includes(needle))
      : all
  }, [bots, fleet, q])

  const pick = (name: string | null) => {
    if (active !== name) void setActiveBot(name)
    onNav('chat')
  }

  return (
    <aside className="rk-rail" aria-label={tr('nav.fleet')}>
      <div className="rk-brand">
        <img src="/mochi/mochi-greeting.svg" alt="" width={28} height={28} />
        <b>Moch</b>
        <button
          className="rk-iconbtn"
          onClick={() => onNav('settings')}
          title={tr('nav.settings')}
          aria-label={tr('nav.settings')}
        >
          <Settings size={15} />
        </button>
      </div>

      <div className="rk-search">
        <Search size={13} />
        <input
          placeholder={tr('rail.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={tr('rail.search')}
        />
      </div>

      <div className="rk-roster">
        {rows.map((b) => {
          const name = b.name ?? tr('rail.mochi')
          const st = botStatus(b)
          const on = active === b.name
          return (
            <button
              key={b.name ?? ''}
              className={`rk-bot${on ? ' on' : ''}`}
              onClick={() => pick(b.name)}
              title={b.description || name}
              aria-current={on ? 'true' : undefined}
            >
              <span
                className="rk-avatar"
                style={{ background: b.name ? (b.color ?? accentFor(b.name)) : 'var(--text-faint)' }}
              >
                {b.avatar ? <img src={b.avatar} alt="" width={20} height={20} /> : name.slice(0, 2)}
              </span>
              <span className="rk-botname">{name}</span>
              <span className={`rk-dot ${st.dot}`} title={st.label} />
            </button>
          )
        })}
        {rows.length === 0 ? <div className="rk-norows">{tr('rail.nomatch')}</div> : null}
        {!connected ? <div className="rk-norows">{tr('fleet.offline')}</div> : null}
      </div>

      <button className="rk-newbot" onClick={() => setCreateOpen(true)} disabled={!connected}>
        <Plus size={14} /> {tr('fleet.create')}
      </button>

      {createOpen ? (
        <CreateBotOverlay
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => { setCreateOpen(false); pick(name) }}
        />
      ) : null}
    </aside>
  )
}
