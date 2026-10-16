/**
 * Titlebar — the FINAL-design top bar: brand left, task chip + working
 * status center, the three agent surface cards (Mochi / Code / Browser),
 * and search + settings right.
 */
import { useStore } from '@nanostores/react'
import { Search, Settings, Microchip, Globe, SquareTerminal } from 'lucide-react'
import { activeTitle, agentBusy, activeSession } from '../lib/chat'
import { browserStatus } from '../lib/cdp'
import { terminalLive } from '../lib/ptyClient'
import { fleetProfiles } from '../lib/fleet'

function AgentCard({ icon: Icon, name, state, tone }: { icon: typeof Globe; name: string; state: string; tone: 'run' | 'think' | 'idle' }) {
  const color = tone === 'idle' ? 'var(--text-faint)' : tone === 'think' ? 'var(--amber)' : 'var(--green)'
  return (
    <div className="agcard">
      <Icon size={13} color={color} />
      <div>
        <b>{name}</b>
        <span style={{ color }}>{state}</span>
      </div>
    </div>
  )
}

export default function Titlebar({ onSearch, onSettings }: { onSearch: () => void; onSettings: () => void }) {
  const title = useStore(activeTitle)
  const busy = useStore(agentBusy)
  const hasSession = useStore(activeSession)
  const browser = useStore(browserStatus)
  const termLive = useStore(terminalLive)
  const bots = useStore(fleetProfiles)

  return (
    <div className="tbar">
      <div className="tbar-brand">
        <img src="/mochi/mochi-greeting.svg" alt="" width={30} height={30} style={{ borderRadius: 8, background: 'var(--bg-elev)' }} />
        <div>
          <b>Moch</b>
          <span>Your personal AI agent</span>
        </div>
      </div>

      {hasSession ? (
        <div className="tbar-task">
          <span className="tchip"><span className={busy ? 'lamp run' : 'lamp'}></span>Task: {title || 'New task'}</span>
          <span className="tstate">{busy ? '● Working…' : '○ Idle'}</span>
        </div>
      ) : <div className="tbar-task" />}

      <div className="tbar-cards">
        <AgentCard icon={Microchip} name="Mochi" state={busy ? 'Writing' : 'Idle'} tone={busy ? 'run' : 'idle'} />
        <AgentCard icon={SquareTerminal} name="Code" state={termLive ? 'Running' : 'Idle'} tone={termLive ? 'run' : 'idle'} />
        <AgentCard icon={Globe} name="Browser" state={browser.running ? 'Running' : 'Idle'} tone={browser.running ? 'run' : 'idle'} />
      </div>

      <div className="tbar-right">
        <button className="tbtn" onClick={onSearch} title="Search (Ctrl+K)"><Search size={15} /></button>
        <button className="tbtn" onClick={onSettings} title="Settings"><Settings size={15} /></button>
        <div className="tavatar" title={`${bots.length} bots on this machine`}>
          <img src="/mochi/mochi-greeting.svg" alt="" width={26} height={26} style={{ borderRadius: '50%' }} />
        </div>
      </div>
    </div>
  )
}
