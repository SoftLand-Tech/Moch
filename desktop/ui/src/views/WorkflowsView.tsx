/** Workflows — Automations + the Crew board under one roof. */
import { useState } from 'react'
import AutomationsView from './AutomationsView'
import CrewView from './CrewView'

export default function WorkflowsView({ onOpen }: { onOpen?: (v: 'automations' | 'crew') => void }) {
  void onOpen
  const [tab, setTab] = useState<'automations' | 'crew'>('automations')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="wb-tabs" style={{ background: 'var(--bg)', padding: '10px 18px 0' }}>
        <button className={`wtab${tab === 'automations' ? ' on' : ''}`} onClick={() => setTab('automations')}>Automations</button>
        <button className={`wtab${tab === 'crew' ? ' on' : ''}`} onClick={() => setTab('crew')}>Crew</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'automations' ? 'block' : 'none' }}><AutomationsView /></div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'crew' ? 'block' : 'none' }}><CrewView /></div>
    </div>
  )
}
