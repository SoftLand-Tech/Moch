import { useStore } from '@nanostores/react'
import { Bot, Cpu, FolderOpen, Globe, PanelRight, Search } from 'lucide-react'
import { gatewayInfo, isConnected } from '../lib/gateway'
import { anyBusy, pendingCount } from '../lib/chat'
import { fleetProfiles, fleetStatusAtom } from '../lib/fleet'
import { locale, tr } from '../lib/strings'
import { openExternal, revealPath } from '../lib/shell-ops'

export default function StatusBar({
  connected, port, botCount, activeBot, onToggleStage, stageOpen, onOpenPalette,
}: {
  connected: boolean
  port: number | null
  botCount: number
  activeBot: string | null
  onToggleStage: () => void
  stageOpen: boolean
  onOpenPalette: () => void
}) {
  const busy = useStore(anyBusy)
  const pending = useStore(pendingCount)
  const fleet = useStore(fleetStatusAtom)
  const info = useStore(gatewayInfo)
  const bots = useStore(fleetProfiles)
  useStore(locale) // subscribe so labels re-render when the language changes

  return (
    <footer className="statusbar">
      <span className={`statusbar-item${connected ? '' : ' clickable'}`} title={connected ? `gateway on 127.0.0.1:${port}` : 'gateway offline'}>
        <span className={`status-dot ${connected ? 'ok' : 'bad'}`} />
        {connected ? tr('status.runtime.local') : tr('status.offline')}
      </span>
      <span className="statusbar-item clickable" onClick={onOpenPalette} title="Command palette (Ctrl+K)">
        <Search size={11} /> ⌘K
      </span>
      <span className="statusbar-item" title={`${botCount} bots on this machine — fleet runtime ${fleet?.fleetEnabled ? 'armed' : 'off'}`}>
        <Bot size={11} /> {botCount} {tr(botCount === 1 ? 'status.bots.one' : 'status.bots.many')}
        {fleet && fleet.queue.active > 0 ? ` · ${fleet.queue.active}/${fleet.queue.slots} ${tr('status.turns')}` : ''}
      </span>
      {busy ? (
        <span className="statusbar-item" style={{ color: 'var(--accent)' }}>
          <span className="status-dot warn" /> agent working
        </span>
      ) : null}
      {pending > 0 ? (
        <span className="statusbar-item" style={{ color: 'var(--amber)' }}>
          {pending} waiting on you
        </span>
      ) : null}
      {activeBot ? (
        <span className="statusbar-item" style={{ color: 'var(--accent)' }}>@{activeBot}</span>
      ) : null}
      <span className="grow" />
      {info?.workspace ? (
        <button className="statusbar-item clickable" onClick={() => void revealPath(info.workspace!)} title={`Workspace: ${info.workspace} — click to open`}>
          <FolderOpen size={11} /> {tr('status.workspace')}
        </button>
      ) : null}
      <span className="statusbar-item" title="Everything runs on this machine — no cloud, no relay">
        <Cpu size={11} /> {tr('status.fullyLocal')}
      </span>
      <button className="statusbar-item clickable" onClick={onToggleStage} title="Toggle the stage pane">
        <PanelRight size={11} /> {stageOpen ? 'hide stage' : 'stage'}
      </button>
    </footer>
  )
}
