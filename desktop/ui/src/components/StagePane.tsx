/**
 * The Stage: the live-work pane docked right of the chat. Tabs: Terminal,
 * Browser. The same panes the full views use — the Stage is just the dock.
 */
import { useState } from 'react'
import { Globe, SquareTerminal, X } from 'lucide-react'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'

export type StageTab = 'terminal' | 'browser'

export default function StagePane({ onClose, initialTab }: { onClose: () => void; initialTab?: StageTab }) {
  const [tab, setTab] = useState<StageTab>(initialTab ?? 'terminal')
  return (
    <section className="stage" aria-label="Stage">
      <div className="stage-tabs">
        <button className={`stage-tab${tab === 'terminal' ? ' active' : ''}`} onClick={() => setTab('terminal')}>
          <SquareTerminal size={13} /> Terminal
        </button>
        <button className={`stage-tab${tab === 'browser' ? ' active' : ''}`} onClick={() => setTab('browser')}>
          <Globe size={13} /> Browser
        </button>
        <div style={{ flex: 1 }} />
        <button className="stage-tab" onClick={onClose} title="Close the stage">
          <X size={13} />
        </button>
      </div>
      <div className="stage-body">
        {tab === 'terminal' ? <TerminalPane compact /> : <BrowserPane compact />}
      </div>
    </section>
  )
}
