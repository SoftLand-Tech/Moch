/**
 * ContextPanel — the active bot's computer, as the right pane. Three tabs
 * (Terminal / Browser / Files) over the existing surfaces.
 *
 * Keep-alive: every tab that has been opened once stays mounted; the slots
 * stack in one grid cell and switching tabs only toggles visibility, so the
 * xterm instance and its PTY session (and the browser screencast) survive
 * round trips without collapsing to a zero-size box, which xterm cannot
 * render into.
 *
 * Bot binding: tab choice is remembered per bot (persisted), and the
 * terminal + files panes are keyed by the active bot, so switching bots
 * mounts that bot's workspace root fresh. The browser pane is shared by
 * design — the user and the agents drive the same Chromium.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { Folder, Globe, SquareTerminal } from 'lucide-react'
import { workspaceDir } from '../lib/gateway'
import { activeBotName } from '../lib/fleet'
import { locale, tr } from '../lib/strings'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'
import FilesPane from './FilesPane'

type Tab = 'terminal' | 'browser' | 'files'
const TAB_IDS: Tab[] = ['terminal', 'browser', 'files']
const DEFAULT_TAB: Tab = 'terminal'

const TABS: { id: Tab; icon: typeof Globe; label: () => string }[] = [
  { id: 'terminal', icon: SquareTerminal, label: () => tr('nav.terminal') },
  { id: 'browser', icon: Globe, label: () => tr('nav.browser') },
  { id: 'files', icon: Folder, label: () => tr('nav.files') },
]

/** The default agent (no fleet bot selected) gets its own memory slot. */
const DEFAULT_BOT_KEY = '__mochi__'
const TAB_MEMORY_KEY = 'moch.desktop.ctx.tab.v1'

function readTabMemory(): Record<string, Tab> {
  try {
    const raw = localStorage.getItem(TAB_MEMORY_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Record<string, Tab> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (TAB_IDS.includes(v as Tab)) out[k] = v as Tab
    }
    return out
  } catch {
    return {}
  }
}

function recallTab(botKey: string): Tab {
  return readTabMemory()[botKey] ?? DEFAULT_TAB
}

function rememberTab(botKey: string, tab: Tab): void {
  try {
    const mem = readTabMemory()
    mem[botKey] = tab
    localStorage.setItem(TAB_MEMORY_KEY, JSON.stringify(mem))
  } catch {
    // storage unavailable — memory lasts the session instead
  }
}

export default function ContextPanel() {
  const workspace = useStore(workspaceDir)
  const bot = useStore(activeBotName)
  const botKey = bot ?? DEFAULT_BOT_KEY
  const [tab, setTab] = useState<Tab>(() => recallTab(botKey))
  const [mounted, setMounted] = useState<ReadonlySet<Tab>>(() => new Set([tab]))
  useStore(locale) // subscribe so tab labels re-render when the language changes

  // Switching bots restores that bot's remembered tab.
  useEffect(() => {
    const next = recallTab(botKey)
    setTab(next)
    setMounted((m) => (m.has(next) ? m : new Set(m).add(next)))
  }, [botKey])

  const select = (id: Tab) => {
    setTab(id)
    rememberTab(botKey, id)
    setMounted((m) => (m.has(id) ? m : new Set(m).add(id)))
  }

  return (
    <section className="rk-ctx" aria-label={tr('ctx.panel.aria')}>
      <div className="rk-tabs" role="tablist" aria-label={tr('ctx.panel.aria')}>
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            id={`ctx-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`ctx-panel-${id}`}
            className={`rk-tab${tab === id ? ' on' : ''}`}
            onClick={() => select(id)}
          >
            <Icon size={13} /> {label()}
          </button>
        ))}
      </div>
      <div className="rk-ctxbody">
        {TABS.map(({ id }) => (
          <div
            key={id}
            id={`ctx-panel-${id}`}
            role="tabpanel"
            aria-labelledby={`ctx-tab-${id}`}
            className={`rk-keep${tab === id ? ' on' : ''}`}
          >
            {mounted.has(id) && renderTab(id, botKey, workspace, tab === id)}
          </div>
        ))}
      </div>
    </section>
  )
}

function renderTab(id: Tab, botKey: string, workspace: string | null, active: boolean) {
  switch (id) {
    case 'terminal':
      // Keyed per bot: a different bot is a different computer, so its
      // terminal (and files pane) mount fresh against the workspace root.
      return <TerminalPane key={`term:${botKey}`} compact cwd={workspace ?? undefined} active={active} />
    case 'browser':
      return <BrowserPane compact />
    case 'files':
      return <FilesPane key={`files:${botKey}`} root={workspace} active={active} />
  }
}
