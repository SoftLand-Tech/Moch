/**
 * ContextPanel — the Rakazo-shaped right pane: the machine's dock as tabs
 * (Terminal / Browser / Files). Each tab mounts the existing surface
 * unchanged; the panel only owns the tab strip.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { Folder, FolderOpen, FileText, Globe, RefreshCw, SquareTerminal } from 'lucide-react'
import { invoke } from '../lib/tauri'
import { workspaceDir } from '../lib/gateway'
import { locale, tr } from '../lib/strings'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'

type Tab = 'terminal' | 'browser' | 'files'

const TABS: { id: Tab; icon: typeof Globe; label: () => string }[] = [
  { id: 'terminal', icon: SquareTerminal, label: () => tr('nav.terminal') },
  { id: 'browser', icon: Globe, label: () => tr('nav.browser') },
  { id: 'files', icon: Folder, label: () => tr('nav.files') },
]

export default function ContextPanel() {
  const [tab, setTab] = useState<Tab>('terminal')
  useStore(locale) // subscribe so tab labels re-render when the language changes

  return (
    <section className="rk-ctx" aria-label={tr('nav.terminal')}>
      <div className="rk-tabs" role="tablist">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`rk-tab${tab === id ? ' on' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={13} /> {label()}
          </button>
        ))}
      </div>
      <div className="rk-ctxbody" role="tabpanel">
        {tab === 'terminal' ? <TerminalPane compact /> : null}
        {tab === 'browser' ? <BrowserPane compact /> : null}
        {tab === 'files' ? <FilesTab /> : null}
      </div>
    </section>
  )
}

interface FsEntry { name: string; path: string; dir: boolean; size: number; modified: number }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/* The workspace browser, as shipped on the old workbench's Files tab. */
function FilesTab() {
  const ws = useStore(workspaceDir)
  useStore(locale)
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [err, setErr] = useState('')
  const dir: string | undefined = cwd ?? ws ?? undefined

  useEffect(() => {
    if (!dir) return
    let cancelled = false
    invoke<FsEntry[]>('fs_list', { path: dir })
      .then((list) => { if (!cancelled) { setEntries(list); setErr('') } })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [dir])

  if (!ws) return <div className="rk-empty">{tr('files.waiting')}</div>

  return (
    <div className="rk-files">
      <div className="rk-crumb" title={dir}>
        <FolderOpen size={13} />
        <span className="mono">{dir}</span>
        <button
          className="msg-action"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => setCwd(undefined)}
          title={ws}
        >
          <RefreshCw size={11} />
        </button>
      </div>
      {err ? <div className="rk-empty" style={{ color: 'var(--red)' }}>{err}</div> : null}
      <div className="rk-filelist">
        {entries.map((e) => (
          <button
            key={e.path}
            className={`rk-frow${e.dir ? ' isdir' : ''}`}
            onClick={() => e.dir && setCwd(e.path)}
            title={e.dir ? e.name : `${e.name} — ${fmtSize(e.size)}`}
          >
            {e.dir ? <FolderOpen size={13} color="var(--acc2)" /> : <FileText size={13} color="var(--text-faint)" />}
            <span className="fname">{e.name}</span>
            {!e.dir ? <span className="fsize">{fmtSize(e.size)}</span> : null}
          </button>
        ))}
        {entries.length === 0 && !err ? <div className="rk-empty">{tr('files.empty')}</div> : null}
      </div>
    </div>
  )
}
