/**
 * MediaBlock — inline rendering of `MEDIA:/abs/path` tokens (the agent's
 * way of delivering files, per the desktop system prompt). Images render
 * inline; audio/video get players; everything else becomes a file card with
 * reveal + copy-path. Bytes come from the shell (read_media_file); the
 * dev-bridge preview reads the same file through its own endpoint.
 */
import { useEffect, useState } from 'react'
import { FileText, FolderOpen, Copy, TriangleAlert } from 'lucide-react'
import { invoke, inTauri } from '../lib/tauri'
import { revealPath } from '../lib/shell-ops'

interface MediaPayload {
  path: string
  mime: string
  size: number
  dataB64?: string
  data_b64?: string
  tooLarge?: boolean
  too_large?: boolean
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function base(name: string): string {
  return name.split('/').pop() ?? name
}

async function loadMedia(path: string): Promise<MediaPayload | null> {
  try {
    if (inTauri) {
      return await invoke<MediaPayload>('read_media_file', { path })
    }
    const res = await fetch(`/dev-bridge/read-file?path=${encodeURIComponent(path)}`)
    if (!res.ok) return null
    return (await res.json()) as MediaPayload
  } catch (err) {
    console.warn('[media-block] load failed', path, err)
    return null
  }
}

export default function MediaBlock({ path }: { path: string }) {
  const [payload, setPayload] = useState<MediaPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadMedia(path).then((p) => {
      if (cancelled) return
      if (p) setPayload(p)
      else setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  const name = base(path)
  const tooLarge = payload?.tooLarge ?? payload?.too_large ?? false
  const b64 = payload?.dataB64 ?? payload?.data_b64 ?? ''
  const mime = payload?.mime ?? ''

  if (failed) {
    return (
      <div className="media-card" style={{ borderColor: 'var(--red)' }}>
        <TriangleAlert size={15} color="var(--red)" />
        <span className="mono" style={{ fontSize: 12 }}>{name}</span>
        <span className="text-faint" style={{ fontSize: 11 }}>could not read</span>
      </div>
    )
  }

  if (!payload) {
    return (
      <div className="media-card">
        <div className="spinner" style={{ width: 12, height: 12 }} />
        <span className="mono" style={{ fontSize: 12 }}>{name}</span>
      </div>
    )
  }

  if (tooLarge) {
    return (
      <div className="media-card">
        <FileText size={15} color="var(--accent)" />
        <span className="mono" style={{ fontSize: 12 }}>{name}</span>
        <span className="text-faint" style={{ fontSize: 11 }}>{fmtSize(payload.size)} — too large to inline</span>
        <button className="msg-action" title="Reveal in file manager" onClick={() => void revealPath(path)}>
          <FolderOpen size={12} /> reveal
        </button>
      </div>
    )
  }

  const src = `data:${mime};base64,${b64}`

  if (mime.startsWith('image/')) {
    return (
      <div className="media-inline">
        <img
          src={src}
          alt={name}
          loading="lazy"
          style={{ maxWidth: '100%', borderRadius: 'var(--radius)', border: '1px solid var(--border-soft)', display: loaded ? 'block' : 'none' }}
          onLoad={() => setLoaded(true)}
        />
        {!loaded ? <div className="spinner" style={{ width: 12, height: 12 }} /> : null}
        <div className="msg-row-meta">
          <span className="mono" style={{ fontSize: 11 }}>{name} · {fmtSize(payload.size)}</span>
        </div>
      </div>
    )
  }

  if (mime.startsWith('audio/')) {
    return (
      <div className="media-inline">
        <audio controls src={src} style={{ width: '100%', height: 36 }} />
        <div className="msg-row-meta"><span className="mono" style={{ fontSize: 11 }}>{name} · {fmtSize(payload.size)}</span></div>
      </div>
    )
  }

  if (mime.startsWith('video/')) {
    return (
      <div className="media-inline">
        <video controls src={src} style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />
        <div className="msg-row-meta"><span className="mono" style={{ fontSize: 11 }}>{name} · {fmtSize(payload.size)}</span></div>
      </div>
    )
  }

  // File card (pdf/txt/anything else)
  return (
    <div className="media-card">
      <FileText size={15} color="var(--accent)" />
      <span className="mono" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span className="text-faint" style={{ fontSize: 11, flexShrink: 0 }}>{fmtSize(payload.size)}</span>
      <button className="msg-action" title="Reveal in file manager" onClick={() => void revealPath(path)}>
        <FolderOpen size={12} /> reveal
      </button>
      <button
        className="msg-action"
        title="Copy the path"
        onClick={() => void navigator.clipboard.writeText(path)}
      >
        <Copy size={12} /> path
      </button>
    </div>
  )
}
