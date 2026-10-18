import { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { BotMessageSquare, ChevronDown, ChevronRight, FolderOpen, Info, Languages, Palette, RotateCw, Terminal } from 'lucide-react'
import { gatewayInfo, gatewayLogs, hermesHome, isConnected, restartGateway, rpc, workspaceDir } from '../lib/gateway'
import { locale, setLocale, tr } from '../lib/strings'
import { revealPath } from '../lib/shell-ops'
import { browserReadyPref, setBrowserReadyPref } from '../lib/cdp'
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
  const [notifState, setNotifState] = useState<'idle' | 'granted' | 'denied' | 'unavailable'>('idle')
  const [browserReady, setBrowserReady] = useState(() => browserReadyPref())

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
        <span style={{ fontWeight: 650, fontSize: 15 }}>{tr('nav.settings')}</span>
      </div>
      <div className="focus-body">
        <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '20px 24px 56px', display: 'flex', flexDirection: 'column', gap: 34 }}>

          {/* ── (a) Runtime ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Terminal size={13} /> {tr('settings.runtime')}
            </div>
            <PathRow label={tr('settings.runtime.home')} path={homePath} />
            <PathRow label={tr('settings.runtime.workspace')} path={wsPath} />
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{tr('settings.runtime.version')}</div>
                <div className="mono text-faint" style={{ fontSize: 'var(--text-xs)' }}>
                  {statusError ? <span style={{ color: 'var(--red)' }}>{statusError}</span> : version ?? tr('settings.unknown')}
                </div>
              </div>
            </div>
            <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', flex: 1 }}>{tr('settings.runtime.restart.hint')}</span>
              <button className="btn" disabled={restarting || !connected} onClick={() => void doRestart()}>
                {restarting ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <RotateCw size={13} />} {tr('settings.runtime.restart')}
              </button>
            </div>
            <div style={{ borderBottom: '1px solid var(--border-soft)' }}>
              <button className="btn ghost sm" style={{ marginBottom: 8 }} onClick={() => setLogsOpen((v) => !v)}>
                {logsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {tr('settings.runtime.logs', { n: Math.min(tail.length, 100) })}
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
                  {tail.length ? tail.join('\n') : tr('settings.runtime.logs.empty')}
                </pre>
              ) : null}
            </div>
          </section>

          {/* ── (b) Appearance ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Palette size={13} /> {tr('settings.appearance')}
            </div>
            <div style={{ padding: '14px 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.6 }}>
              {tr('settings.appearance.hint')}
            </div>
          </section>

          {/* ── Notifications ── */}
        <section style={{ marginBottom: 26 }}>
          <div style={{ ...labelStyle }}>{tr('settings.notifications')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: 'var(--text-dim)' }}>
              {tr('settings.notifications.hint')}
            </div>
            <button
              className="btn"
              onClick={() => {
                void import('@tauri-apps/plugin-notification').then(async (mod) => {
                  let granted = await mod.isPermissionGranted()
                  if (!granted) granted = (await mod.requestPermission()) === 'granted'
                  setNotifState(granted ? 'granted' : 'denied')
                }).catch(() => setNotifState('unavailable'))
              }}
            >
              {notifState === 'granted' ? tr('settings.notifications.on') : notifState === 'denied' ? tr('settings.notifications.denied') : tr('settings.notifications.enable')}
            </button>
          </div>
        </section>

        {/* ── Agent browser ── */}
        <section style={{ marginBottom: 26 }}>
          <div style={{ ...labelStyle }}>{tr('settings.browser')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: 'var(--text-dim)' }}>
              {tr('settings.browser.hint')}
            </div>
            <button
              className={`chip${browserReady ? ' active' : ''}`}
              onClick={() => {
                setBrowserReady(!browserReady)
                setBrowserReadyPref(!browserReady)
              }}
            >
              {browserReady ? tr('settings.browser.ready') : tr('settings.browser.manual')}
            </button>
          </div>
        </section>

        {/* ── Language ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Languages size={13} /> {tr('settings.language.title')}
            </div>
            <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', flex: 1 }}>
                {tr('settings.language.hint')}
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
              <Info size={13} /> {tr('settings.about')}
            </div>
            <div style={{ padding: '16px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span className="avatar" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--accent)', fontSize: 18 }}>
                <BotMessageSquare size={22} color="var(--on-accent)" />
              </span>
              <div>
                <div style={{ fontWeight: 650, fontSize: 'var(--text-lg)' }}>{tr('settings.about.app')}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>{tr('settings.about.tagline')}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" disabled={!wsPath} onClick={() => wsPath && void revealPath(wsPath)}>
                <FolderOpen size={14} /> {tr('settings.about.workspace')}
              </button>
              <button className="btn" disabled={!homePath} onClick={() => homePath && void revealPath(homePath)}>
                <FolderOpen size={14} /> {tr('settings.about.home')}
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
          {path ?? tr('settings.unknown')}
        </div>
      </div>
      <button className="btn sm" disabled={!path} onClick={() => path && void revealPath(path)} title={tr('settings.reveal.title')}>
        <FolderOpen size={13} /> {tr('settings.reveal')}
      </button>
    </div>
  )
}
