/**
 * WorkbenchPanel — the FINAL-design right region: Files / Browser /
 * Terminal / Diff tabs. Replaces the old StagePane on the chat view.
 * Files lists the workspace via the shell's fs_list; Diff tracks files the
 * agents edited this session (from patch/Edit tool events); Browser and
 * Terminal reuse the live panes.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { Folder, FolderOpen, FileText, X, GitCompare, RefreshCw } from 'lucide-react'
import { invoke } from '../lib/tauri'
import { workspaceDir } from '../lib/gateway'
import { changedFiles, changedOrder } from '../lib/chat'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'

type Tab = 'files' | 'browser' | 'terminal' | 'diff'

interface FsEntry { name: string; path: string; dir: boolean; size: number; modified: number }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function relPath(p: string, root: string | null): string {
  if (root && p.startsWith(root)) return p.slice(root.length).replace(/^\//, '')
  return p
}

export default function WorkbenchPanel({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<Tab>('files')
  const ws = useStore(workspaceDir)

  return (
    <section className="wb">
      <div className="wb-tabs">
        {([['files', 'Files'], ['browser', 'Browser'], ['terminal', 'Terminal'], ['diff', 'Diff']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} className={`wtab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
        {onClose ? <button className="wtab-x" onClick={onClose}><X size={13} /></button> : null}
      </div>
      <div className="wb-body">
        {tab === 'files' && <FilesTab root={ws} />}
        {tab === 'browser' && <BrowserPane compact />}
        {tab === 'terminal' && <TerminalPane compact />}
        {tab === 'diff' && <DiffTab root={ws} />}
      </div>
    </section>
  )
}

/* ── Files ─────────────────────────────────────────────────────────────── */

function FilesTab({ root }: { root?: string | null }) {
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [err, setErr] = useState('')
  const dir: string | undefined = cwd ?? root ?? undefined

  useEffect(() => {
    if (!dir) return
    let cancelled = false
    invoke<FsEntry[]>('fs_list', { path: dir })
      .then((list) => { if (!cancelled) { setEntries(list); setErr('') } })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [dir])

  if (!root) return <div className="wb-empty">waiting for the workspace…</div>

  return (
    <div className="wb-files">
      <div className="wb-crumb" title={dir}>
        <FolderOpen size={13} />
        <span className="mono">{dir}</span>
        <button className="msg-action" style={{ marginLeft: 'auto' }} onClick={() => setCwd(undefined)} title="Back to workspace root"><RefreshCw size={11} /> root</button>
      </div>
      {err ? <div className="wb-empty" style={{ color: 'var(--red)' }}>{err}</div> : null}
      <div className="wb-list">
        {entries.map((e) => (
          <button
            key={e.path}
            className={`frow${e.dir ? ' isdir' : ''}`}
            onClick={() => e.dir && setCwd(e.path)}
            title={e.dir ? 'Open folder' : `${e.name} — ${fmtSize(e.size)}`}
          >
            {e.dir ? <FolderOpen size={13} color="var(--acc2)" /> : <FileText size={13} color="var(--text-faint)" />}
            <span className="fname">{e.name}</span>
            {!e.dir ? <span className="fsize">{fmtSize(e.size)}</span> : null}
          </button>
        ))}
        {entries.length === 0 && !err ? <div className="wb-empty">empty folder</div> : null}
      </div>
    </div>
  )
}

/* ── Diff ──────────────────────────────────────────────────────────────── */

function DiffTab({ root }: { root?: string | null }) {
  const files = useStore(changedFiles)
  const order = useStore(changedOrder)
  const [sel, setSel] = useState<string | null>(null)

  const totalAdd = useMemo(() => order.reduce((n, p) => n + (files.get(p)?.add ?? 0), 0), [files, order])
  const totalDel = useMemo(() => order.reduce((n, p) => n + (files.get(p)?.del ?? 0), 0), [files, order])
  const selected = sel ? files.get(sel) : null

  return (
    <div className="wb-diff">
      <div className="wb-diff-head">
        <span>Changed files</span>
        <span className="num"><span className="add">+{totalAdd}</span> <span className="del">−{totalDel}</span></span>
      </div>
      {order.length === 0 ? (
        <div className="wb-empty">
          <GitCompare size={22} color="var(--text-faint)" />
          <div>Files your agents edit land here.<br />Select one to view its diff.</div>
        </div>
      ) : (
        <>
          <div className="wb-list">
            {order.map((p) => {
              const f = files.get(p)!
              return (
                <button key={p} className={`frow${sel === p ? ' on' : ''}`} onClick={() => setSel(p)}>
                  <FileText size={13} color="var(--text-faint)" />
                  <span className="fname">{relPath(p, root ?? null)}</span>
                  <span className="num"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
                </button>
              )
            })}
          </div>
          {selected?.patch ? (
            <div className="wb-diffview mono">
              {selected.patch.split('\n').map((line, i) => (
                <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx'}>{line}</span>
              ))}
            </div>
          ) : sel ? (
            <div className="wb-empty" style={{ padding: 14 }}>
              <span className="mono" style={{ fontSize: 11 }}>{relPath(sel, root ?? null)}</span>
              <div style={{ marginTop: 4 }}>No patch text captured — open it in the Files tab.</div>
            </div>
          ) : (
            <div className="wb-empty" style={{ padding: 14 }}>Select a file to view the diff.</div>
          )}
        </>
      )}
    </div>
  )
}

