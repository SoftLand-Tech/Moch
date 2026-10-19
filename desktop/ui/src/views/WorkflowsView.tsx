/** Workflows — Automations + the Crew board under one roof. */
import { useState } from 'react'
import { useStore } from '@nanostores/react'
import AutomationsView from './AutomationsView'
import CrewView from './CrewView'
import { locale, tr } from '../lib/strings'

export default function WorkflowsView({ onOpen }: { onOpen?: (v: 'automations' | 'crew') => void }) {
  void onOpen
  useStore(locale)
  const [tab, setTab] = useState<'automations' | 'crew'>('automations')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="wb-tabs" style={{ background: 'var(--bg)', padding: '10px 18px 0' }}>
        <button className={`wtab${tab === 'automations' ? ' on' : ''}`} onClick={() => setTab('automations')}>{tr('nav.automations')}</button>
        <button className={`wtab${tab === 'crew' ? ' on' : ''}`} onClick={() => setTab('crew')}>{tr('nav.crew')}</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'automations' ? 'block' : 'none' }}><AutomationsView /></div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'crew' ? 'block' : 'none' }}><CrewView /></div>
    </div>
  )
}
