/**
 * BrowserView — the full Browser view. The ctx column lists the Chromium's
 * tabs; the focus is the shared BrowserPane (the same surface the Stage
 * docks). This view also owns the Chromium lifecycle UI: status, launch,
 * stop — and the first-run explainer.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { Globe, Plus, Power, Rocket, X } from 'lucide-react'
import BrowserPane from '../components/BrowserPane'
import {
  activeTargetId, browserStatus, browserTabs, cdpConnection, ensureBrowserWatch, getCdp,
  launchBrowser, refreshBrowserStatus, refreshTabs, stopBrowser,
} from '../lib/cdp'

export default function BrowserView() {
  const status = useStore(browserStatus)
  const tabs = useStore(browserTabs)
  const active = useStore(activeTargetId)
  const conn = useStore(cdpConnection)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  useEffect(() => {
    ensureBrowserWatch()
    void refreshBrowserStatus()
  }, [])

  const activate = (id: string) => {
    if (id === activeTargetId.get()) return
    activeTargetId.set(id) // the pane re-attaches its screencast
    const cdp = getCdp()
    if (cdp.isConnected()) void cdp.send('Target.activateTarget', { targetId: id }).catch(() => { /* noop */ })
  }

  const openNewTab = async () => {
    try {
      const tab = await getCdp().newTab('about:blank')
      await refreshTabs()
      activate(tab.id)
    } catch (err) {
      console.warn('[browser] new tab failed', err)
    }
  }

  const closeTab = async (id: string) => {
    try {
      await getCdp().closeTab(id)
    } catch (err) {
      console.warn('[browser] close tab failed', err)
    }
    const remaining = await refreshTabs()
    if (remaining.length === 0) {
      // never leave the browser tabless — restart from a blank page
      try {
        const tab = await getCdp().newTab('about:blank')
        await refreshTabs()
        activate(tab.id)
      } catch { /* browser is going away */ }
    } else if (id === active) {
      activate(remaining[0].id)
    }
  }

  const launch = async () => {
    setLaunching(true)
    setLaunchError(null)
    try {
      await launchBrowser() // applyStatus connects + arms the agent
    } catch (err) {
      setLaunchError(String(err))
    } finally {
      setLaunching(false)
    }
  }

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">Tabs</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title="New tab (about:blank)" disabled={!status.running} onClick={() => void openNewTab()}>
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {tabs.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
              {status.running
                ? conn === 'connected' ? 'No tabs yet — open one below.' : 'Connecting to Chromium…'
                : 'Launch the browser to see its tabs here.'}
            </div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className={`bp-tab${t.id === active ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                title={`${t.title || t.url || 'about:blank'}\n${t.url || 'about:blank'}`}
                onClick={() => activate(t.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') activate(t.id) }}
              >
                <div className="bp-tab-top">
                  <span className="bp-tab-title">{t.title || t.url || 'about:blank'}</span>
                  <button
                    className="bp-close-tab"
                    title="Close tab"
                    aria-label={`Close ${t.title || t.url || 'tab'}`}
                    onClick={(e) => { e.stopPropagation(); void closeTab(t.id) }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <span className="bp-tab-url">{t.url || 'about:blank'}</span>
              </div>
            ))
          )}
          {status.running ? (
            <button className="bp-tab bp-tab-new" onClick={() => void openNewTab()}>
              <div className="bp-tab-top"><Plus size={13} /><span className="bp-tab-title">New tab</span></div>
              <span className="bp-tab-url">about:blank</span>
            </button>
          ) : null}
        </div>
      </aside>

      <main className="focus">
        <div className="focus-head">
          <span className={`status-dot ${status.running ? (conn === 'connected' ? 'ok' : 'warn') : 'idle'}`} />
          <span style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }} title={status.executable ?? undefined}>
            {status.running
              ? status.port != null ? `Chromium · 127.0.0.1:${status.port}` : 'Chromium running'
              : 'Chromium stopped'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
            {status.running && conn !== 'connected'
              ? '· connecting…'
              : status.running && conn === 'connected'
                ? `· ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`
                : ''}
          </span>
          <div style={{ flex: 1 }} />
          {status.running ? (
            <button className="btn sm" title="Stop the managed Chromium" onClick={() => void stopBrowser().catch(() => { /* noop */ })}>
              <Power size={13} /> Stop
            </button>
          ) : (
            <button className="btn primary sm" disabled={launching} onClick={() => void launch()}>
              {launching ? 'Launching…' : 'Launch browser'}
            </button>
          )}
        </div>
        <div className="focus-body">
          {status.running ? (
            <div className="bp-host"><BrowserPane /></div>
          ) : (
            <div className="empty">
              <div className="bp-empty-icon"><Globe size={26} /></div>
              <div className="empty-title">The agent browser</div>
              <div className="empty-sub">
                A real Chromium that lives on this machine. You drive it from here — and so do your agents:
                every page hermes opens appears live in this pane, and the two of you share tabs, cookies and history.
                {launchError ? <div style={{ color: 'var(--red)', marginTop: 8 }}>{launchError}</div> : null}
              </div>
              <button className="btn primary" disabled={launching} onClick={() => void launch()}>
                {launching
                  ? <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />
                  : <Rocket size={14} />}
                {launching ? 'Launching…' : 'Launch browser'}
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
