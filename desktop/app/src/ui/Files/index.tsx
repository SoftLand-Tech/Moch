/**
 * Desktop Files — a browser over the gateway machine's filesystem via the
 * dashboard REST (desktop/app/src/core/fs.ts). Folder navigation with
 * breadcrumbs, the shared mos-* table kit for entries, and a text preview
 * pane for the selected file. Binary and image files are listed but not
 * previewed (the read endpoint returns a data: URL, and rendering those
 * is out of scope for this surface).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { desktopShell } from '../../core/boot'
import {
  dataUrlText,
  isTextFile,
  listDir,
  readFile,
  removeFile,
  type FsEntry,
  type FsListing,
} from '../../core/fs'
import { IconMoch, IconRefresh } from '../shell/icons'
import './files.css'

/** Whole-file wire cap: the read endpoint has no range form. */
const PREVIEW_MAX_BYTES = 1_000_000
/** DOM cap: past this we truncate the rendered tail. */
const PREVIEW_CHARS = 200_000

type Preview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string }

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

function fmtDate(sec: number | null): string {
  if (sec == null) return '—'
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function Files(): React.JSX.Element {
  const shell = useStore(desktopShell)

  const [cwd, setCwd] = useState<string>('/')
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' })
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const listSeq = useRef(0)
  const previewSeq = useRef(0)
  const navigated = useRef(false)

  // The shell's handshake carries the gateway workspace root; adopt it as
  // the start folder once, unless the user already navigated somewhere.
  useEffect(() => {
    const home = shell?.home
    if (!navigated.current && cwd === '/' && home && home !== '/') setCwd(home)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.home])

  const go = useCallback((dir: string) => {
    navigated.current = true
    setCwd(dir)
  }, [])

  const load = useCallback(async (dir: string) => {
    const id = ++listSeq.current
    setLoading(true)
    setError(null)
    try {
      const l = await listDir(dir)
      if (listSeq.current !== id) return
      setListing(l)
      setSelected(null)
      setConfirmPath(null)
    } catch (e) {
      if (listSeq.current !== id) return
      setError(errText(e))
    } finally {
      if (listSeq.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(cwd)
  }, [cwd, load])

  const open = useCallback((entry: FsEntry) => {
    if (entry.isDirectory) {
      go(entry.path)
      return
    }
    setSelected(entry)
    setConfirmPath(null)
    if (!isTextFile(entry, PREVIEW_MAX_BYTES)) {
      setPreview({
        kind: 'blocked',
        reason:
          entry.size != null && entry.size > PREVIEW_MAX_BYTES
            ? `Too large to preview (limit ${humanSize(PREVIEW_MAX_BYTES)}).`
            : 'No text preview for this file type.',
      })
      return
    }
    const id = ++previewSeq.current
    setPreview({ kind: 'loading' })
    void readFile(entry.path)
      .then((f) => {
        if (previewSeq.current !== id) return
        const text = dataUrlText(f.dataUrl)
        const truncated = text.length > PREVIEW_CHARS
        setPreview({ kind: 'text', text: truncated ? text.slice(0, PREVIEW_CHARS) : text, truncated })
      })
      .catch((e: unknown) => {
        if (previewSeq.current !== id) return
        setPreview({ kind: 'error', message: errText(e) })
      })
  }, [go])

  const doDelete = useCallback(
    async (entry: FsEntry) => {
      setDeleting(true)
      setError(null)
      try {
        await removeFile(entry.path)
        setConfirmPath(null)
        if (selected?.path === entry.path) {
          setSelected(null)
          setPreview({ kind: 'idle' })
        }
        void load(cwd)
      } catch (e) {
        setError(errText(e))
      } finally {
        setDeleting(false)
      }
    },
    [cwd, load, selected],
  )

  const entries = useMemo(() => {
    if (!listing) return []
    return [...listing.entries].sort((a, b) =>
      a.isDirectory !== b.isDirectory
        ? a.isDirectory
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [listing])

  const crumbs = useMemo(() => {
    const root = { name: '/', path: '/' }
    if (cwd === '/') return [root]
    const parts = cwd.split('/').filter(Boolean)
    return [
      root,
      ...parts.map((p, i) => ({ name: p, path: `/${parts.slice(0, i + 1).join('/')}` })),
    ]
  }, [cwd])

  const reload = useCallback(() => void load(cwd), [cwd, load])

  const metaLine = selected
    ? [
        selected.isDirectory ? 'Folder' : selected.mime ?? 'File',
        selected.size != null ? humanSize(selected.size) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Nothing selected'

  return (
    <div className="mos-root">
      <div className="mos-head">
        <h2>Files</h2>
        <span className="mos-sub" title={cwd}>
          {cwd}
          {loading ? ' · loading…' : ''}
        </span>
        {error ? <span className="files-error">{error}</span> : null}
        <span className="mos-spring" />
        <button className="btn" onClick={reload}>
          <span className="files-btn-glyph">
            <IconRefresh size={13} />
          </span>
          Reload
        </button>
      </div>

      <nav className="files-crumbs" aria-label="Path">
        {listing?.parent != null ? (
          <button className="files-up" onClick={() => go(listing.parent as string)} aria-label="Parent folder">
            ↑
          </button>
        ) : null}
        {crumbs.map((c, i) => (
          <React.Fragment key={c.path}>
            {i > 0 ? <span className="files-sep">/</span> : null}
            <button
              className={i === crumbs.length - 1 ? 'files-crumb files-crumbOn' : 'files-crumb'}
              onClick={() => go(c.path)}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </nav>

      <div className="files-body">
        <div className="files-table-pane">
          {error && !listing ? (
            <div className="files-empty">
              <IconMoch size={44} />
              <div className="files-empty-title">Couldn’t list this folder</div>
              <div className="files-note">{error}</div>
              <button className="btn" onClick={reload}>
                Retry
              </button>
            </div>
          ) : !error && !loading && entries.length === 0 ? (
            <div className="files-empty">
              <IconMoch size={44} />
              <div className="files-empty-title">This folder is empty</div>
              <button className="btn" onClick={reload}>
                Reload
              </button>
            </div>
          ) : (
            <div className="mos-scroller">
              <table className="mos-table">
                <thead>
                  <tr>
                    <th className="mos-th">Name</th>
                    <th className="mos-th">Type</th>
                    <th className="mos-th">Size</th>
                    <th className="mos-th">Modified</th>
                    <th className="mos-th mos-w-actions" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr
                      key={e.path}
                      className={selected?.path === e.path ? 'mos-row mos-sel' : 'mos-row'}
                      onClick={() => open(e)}
                    >
                      <td className="mos-td">
                        <span className="mos-namecell">
                          <span className="mos-name">{e.name}</span>
                        </span>
                      </td>
                      <td className="mos-td">
                        <span className="mos-badge">
                          {e.isDirectory ? 'Folder' : e.mime ?? 'File'}
                        </span>
                      </td>
                      <td className="mos-td mos-mono">{e.isDirectory ? '—' : e.size != null ? humanSize(e.size) : '—'}</td>
                      <td className="mos-td">{fmtDate(e.mtimeSec)}</td>
                      <td className="mos-td mos-w-actions">
                        {!e.isDirectory ? (
                          <button
                            className={confirmPath === e.path ? 'btn primary files-del' : 'btn files-del'}
                            disabled={deleting}
                            aria-label={confirmPath === e.path ? `Confirm delete ${e.name}` : `Delete ${e.name}`}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              if (confirmPath === e.path) void doDelete(e)
                              else setConfirmPath(e.path)
                            }}
                            onBlur={() => setConfirmPath((p) => (p === e.path ? null : p))}
                          >
                            {confirmPath === e.path ? 'Sure?' : 'Delete'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="files-preview" aria-label="Preview">
          <div className="files-preview-head">
            <div className="mos-name">{selected ? selected.name : 'Preview'}</div>
            <div className="files-note">{metaLine}</div>
          </div>
          <div className="files-preview-body">
            {preview.kind === 'idle' ? <div className="files-note">Select a file to preview.</div> : null}
            {preview.kind === 'loading' ? <div className="files-note">Loading…</div> : null}
            {preview.kind === 'blocked' ? <div className="files-note">{preview.reason}</div> : null}
            {preview.kind === 'error' ? (
              <div className="files-preview-error">
                <div className="files-note">{preview.message}</div>
                <button className="btn" onClick={() => selected && open(selected)}>
                  Retry
                </button>
              </div>
            ) : null}
            {preview.kind === 'text' ? (
              <>
                <pre className="files-pre">{preview.text}</pre>
                {preview.truncated ? (
                  <div className="files-note">Truncated at {humanSize(PREVIEW_CHARS)} of text.</div>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}
