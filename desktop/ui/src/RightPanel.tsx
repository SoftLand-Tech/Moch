import { useState } from 'react'
import {
  IconCheck,
  IconDatabase,
  IconFileText,
  IconFiles,
  IconGitHub,
  IconSearch,
  IconTerminal,
  IconTools,
} from './Icons'
import type { LaunchSkill } from './types'

export type ActivityItem = {
  id: string | number
  kind: 'file' | 'command' | 'search' | 'write' | 'tool'
  title: string
  subtitle: string
  time: string
}

export type TaskStep = {
  label: string
  time?: string
  done?: boolean
  active?: boolean
}

export type ActiveTaskState = {
  title: string
  subtitle: string
  step: number
  total: number
  steps: TaskStep[]
}

const DEFAULT_STEPS: TaskStep[] = [
  { label: 'Read project structure', time: '2m ago', done: true },
  { label: 'Analyze requirements', time: '3m ago', done: true },
  { label: 'Create migration', time: '4m ago', active: true },
  { label: 'Update models' },
  { label: 'Build Filament resource' },
  { label: 'Add validation & policies' },
  { label: 'Run tests' },
  { label: 'Push to GitHub' },
]

export default function RightPanel({
  open,
  agentWorking,
  activeTask,
  activityEvents,
  skills,
  logTail,
  onViewAllTools,
}: {
  open: boolean
  agentWorking: boolean
  activeTask?: ActiveTaskState | null
  activityEvents: ActivityItem[]
  skills: LaunchSkill[]
  logTail?: string
  onViewAllTools: () => void
}) {
  const [activeTab, setActiveTab] = useState<'activity' | 'tools' | 'terminal' | 'files'>('activity')
  const [toolSearch, setToolSearch] = useState('')

  if (!open) return null

  const task = activeTask || {
    title: 'Build a Laravel feature',
    subtitle: 'Adding user profile settings with Filament...',
    step: 3,
    total: 8,
    steps: DEFAULT_STEPS,
  }

  const percent = Math.round((task.step / Math.max(1, task.total)) * 100)

  // Default mock activity items if none recorded yet
  const displayEvents: ActivityItem[] = activityEvents.length > 0 ? activityEvents : [
    { id: 1, kind: 'file', title: 'Read file', subtitle: 'app/Models/User.php', time: '4m ago' },
    { id: 2, kind: 'command', title: 'Run command', subtitle: 'php artisan make:migration create_user...', time: '5m ago' },
    { id: 3, kind: 'write', title: 'Write file', subtitle: 'database/migrations/2026_10_15_000...', time: '6m ago' },
    { id: 4, kind: 'search', title: 'Search', subtitle: 'Filament user profile', time: '7m ago' },
    { id: 5, kind: 'file', title: 'Read file', subtitle: 'app/Filament/Resources/UserResource.php', time: '8m ago' },
  ]

  const filteredSkills = skills.filter((s) =>
    !toolSearch || s.name.toLowerCase().includes(toolSearch.toLowerCase()) || (s.description ?? '').toLowerCase().includes(toolSearch.toLowerCase())
  )

  return (
    <aside className="right-panel">
      {/* ── Top Card: Live Task Progress ── */}
      <div className="r-card task-progress-card">
        <div className="r-card-header">
          <div className="status-indicator">
            <span className={`status-dot ${agentWorking ? 'pulse' : 'idle'}`} />
            <span className="status-label">{agentWorking ? 'Agent is working...' : 'Agent idle'}</span>
          </div>
          {agentWorking && <span className="live-badge">Live</span>}
        </div>

        <div className="active-task-box">
          <div className="active-task-icon">
            <IconTerminal width={15} height={15} />
          </div>
          <div className="active-task-meta">
            <h4>{task.title}</h4>
            <p>{task.subtitle}</p>
          </div>
        </div>

        <div className="progress-section">
          <div className="progress-meta">
            <span>Step {task.step} of {task.total}</span>
            <span>{percent}%</span>
          </div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
        </div>

        <div className="subtask-list">
          {task.steps.map((st, i) => (
            <div key={st.label + i} className={`subtask-item ${st.done ? 'done' : ''} ${st.active ? 'active' : ''}`}>
              <div className="subtask-icon">
                {st.done ? (
                  <span className="check-circle"><IconCheck width={11} height={11} /></span>
                ) : st.active ? (
                  <span className="spinner-circle" />
                ) : (
                  <span className="empty-circle" />
                )}
              </div>
              <span className="subtask-label">{st.label}</span>
              {st.time && <span className="subtask-time">{st.time}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* ── Segmented Control & Tab Content ── */}
      <div className="r-card segmented-card">
        <div className="segmented-tabs">
          {(['activity', 'tools', 'terminal', 'files'] as const).map((t) => (
            <button
              key={t}
              className={`seg-tab ${activeTab === t ? 'active' : ''}`}
              onClick={() => setActiveTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="segmented-content">
          {activeTab === 'activity' && (
            <div className="activity-feed">
              {displayEvents.map((ev) => (
                <div key={ev.id} className="activity-row">
                  <div className={`activity-icon-box ${ev.kind}`}>
                    {ev.kind === 'file' ? <IconFileText width={13} height={13} />
                      : ev.kind === 'command' ? <IconTerminal width={13} height={13} />
                      : ev.kind === 'search' ? <IconSearch width={13} height={13} />
                      : <IconTools width={13} height={13} />}
                  </div>
                  <div className="activity-meta">
                    <span className="activity-title">{ev.title}</span>
                    <span className="activity-subtitle">{ev.subtitle}</span>
                  </div>
                  <span className="activity-time">{ev.time}</span>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="tools-mini-list">
              <input
                type="text"
                className="mini-search"
                placeholder="Filter tools..."
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
              />
              <div className="tools-scroll">
                {filteredSkills.slice(0, 12).map((s) => (
                  <div key={s.name} className="mini-tool-item">
                    <span className="mini-tool-name">{s.name}</span>
                    <span className="mini-tool-desc">{s.description || 'Skill tool'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="terminal-mini">
              <pre><code>{logTail || 'No active terminal output...'}</code></pre>
            </div>
          )}

          {activeTab === 'files' && (
            <div className="files-mini-list">
              <div className="mini-file-row"><IconFileText width={12} height={12} /><span>SOUL.md</span></div>
              <div className="mini-file-row"><IconFileText width={12} height={12} /><span>MEMORY.md</span></div>
              <div className="mini-file-row"><IconFileText width={12} height={12} /><span>USER.md</span></div>
              <div className="mini-file-row"><IconFileText width={12} height={12} /><span>.moch-gateway.json</span></div>
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom Card: Tools & Integrations ── */}
      <div className="r-card integrations-card">
        <div className="integrations-head">
          <span className="integrations-title">Tools & Integrations</span>
          <button className="view-all-link" onClick={onViewAllTools}>View all</button>
        </div>
        <div className="integrations-grid">
          <div className="integration-tile">
            <IconGitHub width={16} height={16} />
            <span>GitHub</span>
          </div>
          <div className="integration-tile">
            <IconDatabase width={16} height={16} />
            <span>Database</span>
          </div>
          <div className="integration-tile">
            <IconTerminal width={16} height={16} />
            <span>Terminal</span>
          </div>
          <div className="integration-tile">
            <IconFiles width={16} height={16} />
            <span>Filesystem</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
