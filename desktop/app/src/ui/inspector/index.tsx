/** Right inspector — the live run panel ("Moch is working…"). Renders the
 * active session's real engine state: progress card, todo checklist, the
 * Activity/Tools/Terminal/Files tabs over the shared tool log, and MCP
 * tiles. Presentation only — every number comes from the shared atoms in
 * app/src/lib. */
import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  activeSession,
  activeStoredId,
  activeTitle,
  agentBusy,
  sessionLoadings,
  sessionsById,
  todos,
  tools,
  type TodoItem,
  type ToolItem,
} from '../../../../../app/src/lib/chat'
import {
  loadMcpServers,
  mcpListError,
  mcpLoading,
  mcpRuntime,
  mcpServers,
  type McpRuntime,
  type McpServer,
} from '../../../../../app/src/lib/mcpState'
import { connectionState, everConnected } from '../../core/boot'
import { setShellLayout } from '../shell/state'
import {
  IconBrowser,
  IconChip,
  IconFiles,
  IconMoch,
  IconSearch,
  IconTerminal,
} from '../shell/icons'
import {
  fileRows,
  mcpDot,
  progressOf,
  relative,
  runActivity,
  toolCounts,
  type ActivityRow,
  type DotTone,
  type FileRow,
  type ToolKind,
} from './activity'
import './inspector.css'

export { fileRows, progressOf, runActivity, toolCounts } from './activity'

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'tools', label: 'Tools' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
] as const

type TabId = (typeof TABS)[number]['id']

const KIND_ICON: Record<ToolKind, (p: { size?: number }) => React.JSX.Element> = {
  shell: IconTerminal,
  file: IconFiles,
  search: IconSearch,
  web: IconBrowser,
  other: IconChip,
}

const KIND_LABEL: Record<ToolKind, string> = {
  shell: 'shell command',
  file: 'file edit',
  search: 'search',
  web: 'web',
  other: 'tool call',
}

export default function Inspector(): React.JSX.Element {
  const connected = useStore(everConnected) || useStore(connectionState) === 'open'
  const storedId = useStore(activeStoredId)
  const loading = useStore(sessionLoadings)[storedId] === true

  // The MCP list is cached by the Connectors surface too; seed it once so
  // the tiles exist before the operator ever opens that screen.
  const serverCount = useStore(mcpServers).length
  useEffect(() => {
    if (connected && serverCount === 0) void loadMcpServers()
  }, [connected, serverCount])

  if (!connected) {
    return (
      <EmptyPanel
        headline="Not connected"
        hint="Pair this app with your computer to see live runs."
        action={{ label: 'Open Settings', screen: 'settings' }}
      />
    )
  }
  if (storedId === '' || storedId.startsWith('new:')) {
    return (
      <EmptyPanel
        headline="Moch is idle"
        hint="Start a task and its live progress appears here."
        action={{ label: 'Start a task', screen: 'chat' }}
      />
    )
  }
  if (loading) {
    return (
      <div className="ins-root">
        <header className="ins-head">
          <span className="ins-head__status">Loading session…</span>
        </header>
        <div className="ins-card ins-card--empty">
          <p className="ins-note">Fetching this session's transcript…</p>
        </div>
      </div>
    )
  }
  return <RunPanel />
}

function RunPanel(): React.JSX.Element {
  const busy = useStore(agentBusy)
  const title = useStore(activeTitle)
  const liveId = useStore(activeSession)
  const sessions = useStore(sessionsById)
  const createdAtMs = liveId !== null ? (sessions[liveId]?.createdAtMs ?? 0) : 0

  return (
    <div className="ins-root">
      <header className="ins-head">
        <span className="ins-head__status">{busy ? 'Moch is working…' : 'Moch is idle'}</span>
        {busy ? (
          <span className="ins-live">
            <span className="ins-live__dot" aria-hidden />
            LIVE
          </span>
        ) : null}
      </header>

      <section className="ins-card ins-session">
        <div className="ins-session__title">{title !== '' ? title : 'Untitled session'}</div>
        <div className="ins-session__sub">
          {createdAtMs > 0 ? `Started ${relative(createdAtMs)}` : 'Live session'}
        </div>
      </section>

      <ProgressCard />
      <Checklist />
      <Tabs />
      <Integrations />
    </div>
  )
}

function ProgressCard(): React.JSX.Element | null {
  const list = useStore(todos)
  const p = useMemo(() => progressOf(list), [list])
  if (p.total === 0) return null
  return (
    <section className="ins-card ins-progress" aria-label={`Progress ${p.done} of ${p.total}, ${p.pct} percent`}>
      <div className="ins-progress__bar" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="ins-progress__fill" style={{ width: `${p.pct}%` }} />
      </div>
      <div className="ins-progress__meta">
        {p.done} of {p.total} · {p.pct}%
      </div>
    </section>
  )
}

function Checklist(): React.JSX.Element {
  const list = useStore(todos)
  return (
    <section className="ins-section" aria-label="Checklist">
      <h3 className="ins-section__title">Checklist</h3>
      {list.length === 0 ? (
        <p className="ins-note">No checklist for this run yet.</p>
      ) : (
        <ul className="ins-todos">
          {list.map((t, i) => (
            <TodoRow key={`${i}:${t.text}`} todo={t} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TodoRow(props: { todo: TodoItem }): React.JSX.Element {
  const done = props.todo.done === true
  return (
    <li className={done ? 'ins-todo ins-todo--done' : 'ins-todo'}>
      <span className="ins-todo__box" aria-hidden>
        {done ? '✓' : ''}
      </span>
      <span className="ins-todo__text">{props.todo.text}</span>
      {done ? <span className="ins-sr-only">(done)</span> : null}
    </li>
  )
}

function Tabs(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('activity')
  const toolLog = useStore(tools)
  const rows = useMemo(() => runActivity(toolLog), [toolLog])
  const files = useMemo(() => fileRows(toolLog), [toolLog])

  return (
    <section className="ins-section ins-tabsblock">
      <div className="mos-tabs mos-tabs--flat ins-tabs" role="tablist" aria-label="Run detail">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'mos-tab mos-tabOn' : 'mos-tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ins-tabbody" role="tabpanel">
        {tab === 'activity' ? <ActivityTab rows={rows} /> : null}
        {tab === 'tools' ? <ToolsTab rows={rows} log={toolLog} /> : null}
        {tab === 'terminal' ? <TerminalTab /> : null}
        {tab === 'files' ? <FilesTab rows={files} /> : null}
      </div>
    </section>
  )
}

function ActivityTab(props: { rows: ActivityRow[] }): React.JSX.Element {
  if (props.rows.length === 0) {
    return <EmptyLine text="No tool activity yet this run." />
  }
  return (
    <div className="ins-feed">
      {props.rows.map((r) => (
        <ToolRowView key={r.key} row={r} />
      ))}
    </div>
  )
}

function ToolsTab(props: { rows: ActivityRow[]; log: ToolItem[] }): React.JSX.Element {
  if (props.rows.length === 0) {
    return <EmptyLine text="No tools used yet this run." />
  }
  const counts = toolCounts(props.log)
  const summary = counts.map((c) => `${c.name} ×${c.count}`).join(' · ')
  return (
    <div className="ins-feed">
      <p className="ins-note ins-note--counts">{summary}</p>
      {props.rows.map((r) => (
        <ToolRowView key={r.key} row={r} />
      ))}
    </div>
  )
}

function TerminalTab(): React.JSX.Element {
  return (
    <div className="ins-card ins-card--empty">
      <p className="ins-note">The live PTY session lives on the Terminal screen.</p>
      <button className="btn" onClick={() => setShellLayout({ screen: 'terminal' })}>
        Open Terminal
      </button>
    </div>
  )
}

function FilesTab(props: { rows: FileRow[] }): React.JSX.Element {
  if (props.rows.length === 0) {
    return <EmptyLine text="No files touched yet this run." />
  }
  return (
    <div className="ins-feed">
      {props.rows.map((r) => (
        <div key={r.key} className="ins-file">
          <span className="ins-file__path">{r.path}</span>
          <span className="ins-file__meta">
            {r.tool}
            <Dot tone={r.status === 'failed' ? 'err' : r.status === 'running' ? 'work' : 'off'} />
          </span>
        </div>
      ))}
    </div>
  )
}

function ToolRowView(props: { row: ActivityRow }): React.JSX.Element {
  const Icon = KIND_ICON[props.row.kind]
  const tone: DotTone = props.row.status === 'failed' ? 'err' : props.row.status === 'running' ? 'work' : 'off'
  return (
    <div className="ins-tool" aria-label={`${props.row.name} ${props.row.status}`}>
      <span className="ins-tool__icon" title={KIND_LABEL[props.row.kind]}>
        <Icon size={13} />
      </span>
      <span className="ins-tool__main">
        <span className="ins-tool__name">{props.row.name}</span>
        {props.row.detail ? <span className="ins-tool__detail">{props.row.detail}</span> : null}
      </span>
      {props.row.durationS != null ? (
        <span className="ins-tool__dur">{props.row.durationS.toFixed(1)}s</span>
      ) : null}
      <Dot tone={tone} pulse={props.row.status === 'running'} />
    </div>
  )
}

function Integrations(): React.JSX.Element {
  const servers = useStore(mcpServers)
  const runtimes = useStore(mcpRuntime)
  const loading = useStore(mcpLoading)
  const error = useStore(mcpListError)

  return (
    <section className="ins-section" aria-label="Tools and integrations">
      <div className="ins-section__row">
        <h3 className="ins-section__title">Tools & Integrations</h3>
        <button className="ins-viewall" onClick={() => setShellLayout({ screen: 'connectors' })}>
          View all
        </button>
      </div>
      {error !== null ? (
        <p className="ins-note ins-note--err">{error}</p>
      ) : loading && servers.length === 0 ? (
        <p className="ins-note">Loading servers…</p>
      ) : servers.length === 0 ? (
        <p className="ins-note">No MCP servers connected.</p>
      ) : (
        <div className="ins-tiles">
          {servers.slice(0, 6).map((s) => (
            <McpTile key={s.name} server={s} runtime={runtimes[s.name]} />
          ))}
        </div>
      )}
    </section>
  )
}

function McpTile(props: { server: McpServer; runtime?: McpRuntime }): React.JSX.Element {
  const tone = mcpDot(props.runtime)
  const tools = props.runtime?.tools
  return (
    <div className="ins-tile" title={props.server.name}>
      <Dot tone={tone} />
      <span className="ins-tile__name">{props.server.name}</span>
      {tools != null ? <span className="ins-tile__count">{tools}</span> : null}
    </div>
  )
}

function Dot(props: { tone: DotTone; pulse?: boolean }): React.JSX.Element {
  const cls = ['ins-dot', `ins-dot--${props.tone}`, props.pulse ? 'ins-dot--pulse' : ''].filter(Boolean).join(' ')
  return <span className={cls} aria-hidden />
}

function EmptyLine(props: { text: string }): React.JSX.Element {
  return (
    <div className="ins-card ins-card--empty">
      <IconMoch size={22} />
      <p className="ins-note">{props.text}</p>
    </div>
  )
}

/** Whole-panel empty state: mascot, headline, one affordance. */
function EmptyPanel(props: {
  headline: string
  hint: string
  action: { label: string; screen: 'chat' | 'settings' }
}): React.JSX.Element {
  return (
    <div className="ins-root">
      <div className="ins-empty">
        <IconMoch size={44} />
        <h3 className="ins-empty__headline">{props.headline}</h3>
        <p className="ins-empty__hint">{props.hint}</p>
        <button className="btn primary" onClick={() => setShellLayout({ screen: props.action.screen })}>
          {props.action.label}
        </button>
      </div>
    </div>
  )
}
