/** Tools — Skills + Connectors under one roof. */
import { useState } from 'react'
import SkillsView from './SkillsView'
import ConnectorsView from './ConnectorsView'

export default function ToolsView({ onOpen }: { onOpen?: (v: 'connectors' | 'skills') => void }) {
  void onOpen
  const [tab, setTab] = useState<'skills' | 'connectors'>('skills')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="wb-tabs" style={{ background: 'var(--bg)', padding: '10px 18px 0' }}>
        <button className={`wtab${tab === 'skills' ? ' on' : ''}`} onClick={() => setTab('skills')}>Skills</button>
        <button className={`wtab${tab === 'connectors' ? ' on' : ''}`} onClick={() => setTab('connectors')}>Connectors</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'skills' ? 'block' : 'none' }}><SkillsView /></div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'connectors' ? 'block' : 'none' }}><ConnectorsView /></div>
    </div>
  )
}
