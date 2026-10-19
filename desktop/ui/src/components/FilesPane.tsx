/**
 * FilesPane — the context panel's Files tab: the bot's workspace as a
 * directory tree walker, plus the Changes sub-mode that re-homes the Diff
 * surface the old WorkbenchPanel carried (same changedFiles store, still
 * strictly read-only). Text previews open in-place through filesClient;
 * rows that aren't text say so instead of silently doing nothing.
 *
 * While the tab is visible the listing refreshes every few seconds
 * (the Rakazo computer rule); the poll pauses when the tab is hidden or a
 * preview is open.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { FileText, FolderOpen, GitCompare, RefreshCw, X } from 'lucide-react'
import { changedFiles, changedOrder } from '../lib/chat'
import { locale, tr } from '../lib/strings'
import { listDir, previewKind, readTextFile, PREVIEW_TEXT_LIMIT, type FsEntry, type FilePreview } from '../lib/filesClient'

type Mode = 'tree' | 'changes'

const REFRESH_MS = 4000

interface PreviewState {
  path: string
  name: string
  status: 'loading' | 'text' | 'unsupported' | 'tooLarge' | 'error'
  preview?: FilePreview
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function relPath(p: string, root: string | null): string {
  if (root && p.startsWith(root)) return p.slice(root.length).replace(/^\//, '')
  return p
}

export default function FilesPane({ root, active }: { root: string | null; active: boolean }) {
  useStore(locale)
  const [mode, setMode] = useState<Mode>('tree')

  return (
    <div className="rk-files">
      <div className="rk-fseg" role="tablist" aria-label={tr('ctx.files.view.aria')}>
        <button
          role="tab"
          aria-selected={mode === 'tree'}
          className={`rk-fseg-btn${mode === 'tree' ? ' on' : ''}`}
          onClick={() => setMode('tree')}
        >
          {tr('ctx.files.workspace')}
        </button>
        <ChangesTabButton on={mode === 'changes'} onSelect={() => setMode('changes')} />
      </div>
      {mode === 'tree' ? <TreeMode root={root} active={active} /> : <ChangesMode root={root} />}
    </div>
  )
}

function ChangesTabButton({ on, onSelect }: { on: boolean; onSelect: () => void }) {
  const order = useStore(changedOrder)
  return (
    <button
      role="tab"
      aria-selected={on}
      className={`rk-fseg-btn${on ? ' on' : ''}`}
      onClick={onSelect}
    >
      {tr('ctx.files.changes')}
      {order.length > 0 ? <span className="rk-fseg-count" dir="ltr">{order.length}</span> : null}
    </button>
  )
}

/* ── workspace tree ─────────────────────────────────────────────────── */

function TreeMode({ root, active }: { root: string | null; active: boolean }) {
  useStore(locale)
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [nonce, setNonce] = useState(0)
  const dir: string | undefined = cwd ?? root ?? undefined

  useEffect(() => {
    if (!dir) return
    let cancelled = false
    listDir(dir)
      .then((list) => { if (!cancelled) { setEntries(list); setErr('') } })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [dir, nonce])

  // Refresh while the tab is actually visible; a hidden tab keeps its last
  // listing instead of polling in the dark.
  useEffect(() => {
    if (!active || preview) return
    const t = setInterval(() => setNonce((n) => n + 1), REFRESH_MS)
    return () => clearInterval(t)
  }, [active, preview])

  useEffect(() => { setPreview(null); setCwd(undefined) }, [root])

  if (!root) return <div className="rk-empty">{tr('files.waiting')}</div>

  const openPreview = (e: FsEntry) => {
    if (previewKind(e.name) !== 'text') {
      setPreview({ path: e.path, name: e.name, status: 'unsupported' })
      return
    }
    setPreview({ path: e.path, name: e.name, status: 'loading' })
    readTextFile(e.path)
      .then((p) => setPreview((cur) => (cur && cur.path === e.path ? { ...cur, status: p.tooLarge ? 'tooLarge' : 'text', preview: p } : cur)))
      .catch(() => setPreview((cur) => (cur && cur.path === e.path ? { ...cur, status: 'error' } : cur)))
  }

  if (preview) return <PreviewView preview={preview} onClose={() => setPreview(null)} />

  return (
    <>
      <div className="rk-crumb" title={dir}>
        <FolderOpen size={13} />
        <span className="mono">{dir}</span>
        <button
          className="msg-action"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => { setCwd(undefined); setNonce((n) => n + 1) }}
          title={cwd ? tr('ctx.files.root') : tr('ctx.files.refresh')}
          aria-label={cwd ? tr('ctx.files.root') : tr('ctx.files.refresh')}
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
            onClick={() => (e.dir ? setCwd(e.path) : openPreview(e))}
            title={e.dir ? e.name : `${e.name} — ${fmtSize(e.size)}`}
          >
            {e.dir ? <FolderOpen size={13} color="var(--acc2)" /> : <FileText size={13} color="var(--text-faint)" />}
            <span className="fname">{e.name}</span>
            {!e.dir ? <span className="fsize">{fmtSize(e.size)}</span> : null}
          </button>
        ))}
        {entries.length === 0 && !err ? <div className="rk-empty">{tr('files.empty')}</div> : null}
      </div>
    </>
  )
}

function PreviewView({ preview, onClose }: { preview: PreviewState; onClose: () => void }) {
  useStore(locale)
  return (
    <>
      <div className="rk-crumb" title={preview.path}>
        <FileText size={13} />
        <span className="mono">{preview.name}</span>
        <button
          className="msg-action"
          style={{ marginInlineStart: 'auto' }}
          onClick={onClose}
          title={tr('ctx.files.preview.close')}
          aria-label={tr('ctx.files.preview.close')}
        >
          <X size={12} />
        </button>
      </div>
      {preview.status === 'loading' ? (
        <div className="rk-empty"><div className="spinner" /> {tr('ctx.files.preview.loading')}</div>
      ) : preview.status === 'unsupported' ? (
        <div className="rk-empty">{tr('ctx.files.preview.unsupported')}</div>
      ) : preview.status === 'tooLarge' ? (
        <div className="rk-empty">{tr('ctx.files.preview.tooLarge')}</div>
      ) : preview.status === 'error' ? (
        <div className="rk-empty" style={{ color: 'var(--red)' }}>{tr('ctx.files.preview.readError')}</div>
      ) : (
        <div className="rk-preview mono">
          {preview.preview?.truncated ? (
            <div className="rk-preview-note">{tr('ctx.files.preview.truncated', { n: Math.round(PREVIEW_TEXT_LIMIT / 1024) })}</div>
          ) : null}
          <pre>{preview.preview?.text}</pre>
        </div>
      )}
    </>
  )
}

/* ── changes (the Diff re-home) ─────────────────────────────────────── */

function ChangesMode({ root }: { root: string | null }) {
  useStore(locale)
  const files = useStore(changedFiles)
  const order = useStore(changedOrder)
  const [sel, setSel] = useState<string | null>(null)

  const totalAdd = useMemo(() => order.reduce((n, p) => n + (files.get(p)?.add ?? 0), 0), [files, order])
  const totalDel = useMemo(() => order.reduce((n, p) => n + (files.get(p)?.del ?? 0), 0), [files, order])
  const selected = sel ? files.get(sel) : null

  if (order.length === 0) {
    return (
      <div className="rk-empty">
        <GitCompare size={22} color="var(--text-faint)" />
        <div>{tr('ctx.diff.empty')}</div>
        <div>{tr('ctx.diff.hint')}</div>
      </div>
    )
  }

  return (
    <div className="rk-changes">
      <div className="rk-changes-head">
        <span>{tr('ctx.diff.changed')}</span>
        <span className="num" dir="ltr"><span className="add">+{totalAdd}</span> <span className="del">−{totalDel}</span></span>
      </div>
      <div className="rk-filelist">
        {order.map((p) => {
          const f = files.get(p)
          if (!f) return null
          return (
            <button key={p} className={`rk-frow${sel === p ? ' on' : ''}`} onClick={() => setSel(p)} title={p}>
              <FileText size={13} color="var(--text-faint)" />
              <span className="fname">{relPath(p, root)}</span>
              <span className="num" dir="ltr"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
            </button>
          )
        })}
      </div>
      {selected?.patch ? (
        <div className="rk-diffview mono" dir="ltr">
          {selected.patch.split('\n').map((line, i) => (
            <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx'}>{line}</span>
          ))}
        </div>
      ) : sel ? (
        <div className="rk-empty" style={{ padding: 14 }}>
          <span className="mono" style={{ fontSize: 11, direction: 'ltr' }}>{relPath(sel, root)}</span>
          <div style={{ marginTop: 4 }}>{tr('ctx.diff.nopatch')}</div>
        </div>
      ) : (
        <div className="rk-empty" style={{ padding: 14 }}>{tr('ctx.diff.hint')}</div>
      )}
    </div>
  )
}
