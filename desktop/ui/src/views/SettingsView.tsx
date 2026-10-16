import { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { BotMessageSquare, ChevronDown, ChevronRight, FolderOpen, Info, Languages, Palette, RotateCw, Terminal } from 'lucide-react'
import { gatewayInfo, gatewayLogs, hermesHome, isConnected, restartGateway, rpc, workspaceDir } from '../lib/gateway'
import { locale, setLocale } from '../lib/strings'
import { revealPath } from '../lib/shell-ops'
import type { ViewId } from '../app'

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 650,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  marginBottom: 6,
}

export default function SettingsView({ onOpenView }: { onOpenView?: (v: ViewId) => void }) {
  void onOpenView // reserved for future cross-links; intentionally unused

  const connected = useStore(isConnected)
  const info = useStore(gatewayInfo)
  const home = useStore(hermesHome)
  const ws = useStore(workspaceDir)
  const logs = useStore(gatewayLogs)
  const loc = useStore(locale)

  const [version, setVersion] = useState<string | null>(null)
  const [statusError, setStatusError] = useState('')
  const [restarting, setRestarting] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    rpc<unknown>('moch.desktop.status', {}, 10000)
      .then((res) => {
        if (cancelled) return
        const r = res !== null && typeof res === 'object' && !Array.isArray(res) ? (res as Record<string, unknown>) : {}
        const v = r.hermesVersion ?? r.version ?? r.hermes_version
        setVersion(typeof v === 'string' && v ? v : null)
        setStatusError('')
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatusError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [connected])

  const homePath = info?.home ?? home
  const wsPath = info?.workspace ?? ws
  const tail = logs.slice(-100)

  const doRestart = async () => {
    setRestarting(true)
    try {
      await restartGateway()
    } finally {
      setRestarting(false)
    }
  }

  return (
    <main className="focus">
      <div className="focus-head">
        <span style={{ fontWeight: 650, fontSize: 15 }}>Settings</span>
      </div>
      <div className="focus-body">
        <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '20px 24px 56px', display: 'flex', flexDirection: 'column', gap: 34 }}>

          {/* ── (a) Runtime ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Terminal size={13} /> Runtime
            </div>
            <PathRow label="Hermes home" path={homePath} />
            <PathRow label="Workspace" path={wsPath} />
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>Hermes version</div>
                <div className="mono text-faint" style={{ fontSize: 'var(--text-xs)' }}>
                  {statusError ? <span style={{ color: 'var(--red)' }}>{statusError}</span> : version ?? 'unknown'}
                </div>
              </div>
            </div>
            <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', flex: 1 }}>Gateway runs everything on loopback — restart it if agents act up.</span>
              <button className="btn" disabled={restarting || !connected} onClick={() => void doRestart()}>
                {restarting ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <RotateCw size={13} />} Restart gateway
              </button>
            </div>
            <div style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <button className="btn ghost sm" style={{ marginBottom: 8 }} onClick={() => setLogsOpen((v) => !v)}>
                {logsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Runtime logs · last {Math.min(tail.length, 100)} lines
              </button>
              {logsOpen ? (
                <pre
                  className="mono"
                  style={{
                    margin: '0 0 12px', padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border-soft)',
                    borderRadius: 'var(--radius)', fontSize: 11, lineHeight: 1.55, maxHeight: 280, overflow: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text', color: 'var(--text-dim)',
                  }}
                >
                  {tail.length ? tail.join('\n') : 'No runtime logs yet.'}
                </pre>
              ) : null}
            </div>
          </section>

          {/* ── (b) Appearance ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Palette size={13} /> Appearance
            </div>
            <div style={{ padding: '14px 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.6 }}>
              Mocheme dark — the desktop ships one theme.
            </div>
          </section>

          {/* ── Language ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Languages size={13} /> Language / اللغة
            </div>
            <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', flex: 1 }}>
                English or العربية — the interface switches to right-to-left with Arabic.
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`chip${loc === 'en' ? ' active' : ''}`} onClick={() => setLocale('en')}>EN</button>
                <button className={`chip${loc === 'ar' ? ' active' : ''}`} onClick={() => setLocale('ar')}>العربية</button>
              </div>
            </div>
          </section>

          {/* ── (c) About ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Info size={13} /> About
            </div>
            <div style={{ padding: '16px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span className="avatar" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--accent)', fontSize: 18 }}>
                <BotMessageSquare size={22} color="var(--on-accent)" />
              </span>
              <div>
                <div style={{ fontWeight: 650, fontSize: 'var(--text-lg)' }}>Moch Desktop 0.1.0</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>Fully local — your agents, keys and data stay on this machine.</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" disabled={!wsPath} onClick={() => wsPath && void revealPath(wsPath)}>
                <FolderOpen size={14} /> Open workspace
              </button>
              <button className="btn" disabled={!homePath} onClick={() => homePath && void revealPath(homePath)}>
                <FolderOpen size={14} /> Open hermes home
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

function PathRow({ label, path }: { label: string; path: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{label}</div>
        <div
          className="mono"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={path ?? undefined}
        >
          {path ?? 'unknown'}
        </div>
      </div>
      <button className="btn sm" disabled={!path} onClick={() => path && void revealPath(path)} title="Show in file manager">
        <FolderOpen size={13} /> Reveal
      </button>
    </div>
  )
}
