import { useState } from 'react'
import {
  IconCheck,
  IconFileText,
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
  step?: number
  total?: number
  steps: TaskStep[]
}

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
  // Still accepted (App.tsx passes it); the fake "Tools & Integrations" card it served was removed.
  onViewAllTools?: () => void
}) {
  // 'files' tab was removed; keep it in the union so a stale value falls back to 'activity'.
  const [activeTab, setActiveTab] = useState<'activity' | 'tools' | 'log' | 'files'>('activity')
  const [toolSearch, setToolSearch] = useState('')

  if (!open) return null

  const tab: 'activity' | 'tools' | 'log' = activeTab === 'files' ? 'activity' : activeTab

  const task = activeTask
  const hasTask = !!task && (!!task.title || task.steps.length > 0)
  const showStepBar = !!task && typeof task.step === 'number' && typeof task.total === 'number'
  const stepsDone = task ? task.steps.filter((s) => s.done).length : 0
  const stepsTotal = task ? task.steps.length : 0

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
            <span className="status-label">{agentWorking ? 'Agent is working…' : 'Agent idle'}</span>
          </div>
          {agentWorking && <span className="live-badge">Live</span>}
        </div>

        {hasTask && task ? (
          <>
            <div className="active-task-box">
              <div className="active-task-icon">
                <IconTerminal width={15} height={15} />
              </div>
              <div className="active-task-meta">
                <h4>{task.title}</h4>
                <p>{task.subtitle}</p>
              </div>
            </div>

            {showStepBar && (
              <div className="progress-section">
                <div className="progress-meta">
                  <span>Step {task.step} of {task.total}</span>
                  <span>{Math.round((task.step! / Math.max(1, task.total!)) * 100)}%</span>
                </div>
                <div className="progress-bar-track">
                  <div className="progress-bar-fill" style={{ transform: `scaleX(${task.step! / Math.max(1, task.total!)})` }} />
                </div>
              </div>
            )}

            {!showStepBar && stepsTotal > 0 && (
              <div className="dim" style={{ fontSize: 12, padding: '4px 2px' }}>
                {stepsDone} of {stepsTotal} steps done
              </div>
            )}

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
          </>
        ) : (
          <div className="dim" style={{ padding: '8px 2px' }}>
            <div>No active task.</div>
            <div style={{ opacity: 0.75 }}>Tool activity from the agent's current turn appears here.</div>
          </div>
        )}
      </div>

      {/* ── Segmented Control & Tab Content ── */}
      <div className="r-card segmented-card">
        <div className="segmented-tabs">
          {(['activity', 'tools', 'log'] as const).map((t) => (
            <button
              key={t}
              className={`seg-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setActiveTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="segmented-content">
          {tab === 'activity' && (
            <div className="activity-feed">
              {activityEvents.length === 0 ? (
                <div className="dim" style={{ padding: '10px 2px' }}>
                  Nothing yet — tool calls show up here live.
                </div>
              ) : (
                activityEvents.map((ev) => (
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
                ))
              )}
            </div>
          )}

          {tab === 'tools' && (
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

          {tab === 'log' && (
            <div className="terminal-mini">
              {logTail ? (
                <>
                  <div className="dim" style={{ fontSize: 11, padding: '2px 2px 6px' }}>
                    boot-time snapshot — not live
                  </div>
                  <pre><code>{logTail}</code></pre>
                </>
              ) : (
                <div className="dim" style={{ padding: '10px 2px' }}>
                  No log snapshot — full log at desktop/.hermes-serve.log
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
