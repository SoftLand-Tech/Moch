/** Browser — the agent's Chromium, live on THIS screen.
 *
 *  runtime.py spawns a Moch-owned Chromium with --remote-debugging-port
 *  before the gateway boots and publishes BROWSER_CDP_URL, so the agent's
 *  browser_* tools (browser_navigate/click/type/tab_list/…) drive a real
 *  browser on this PC — no relay, no WebView hack like the phone needed.
 *  This tab surfaces it: the CDP target list via the shell's /cdp/json
 *  proxy (the UI can't fetch the CDP port cross-origin). The browser
 *  window itself is on your desktop — this is the control panel.
 */
import { useEffect, useRef, useState } from 'react'

type CdpTarget = {
  id?: string
  type?: string
  title?: string
  url?: string
  description?: string
}

/** GET /cdp/json → CDP target list, with a graceful error envelope. */
async function fetchTargets(): Promise<CdpTarget[] | { error: string }> {
  try {
    const r = await fetch('/cdp/json')
    const body = await r.json().catch(() => null)
    if (!r.ok) {
      const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${r.status}`
      return { error: msg }
    }
    return Array.isArray(body) ? (body as CdpTarget[]) : []
  } catch (e) {
    return { error: String(e) }
  }
}

export default function BrowserTab() {
  const [targets, setTargets] = useState<CdpTarget[] | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      const res = await fetchTargets()
      if (dead) return
      if (Array.isArray(res)) {
        setTargets(res)
        setErr('')
      } else {
        setTargets(null)
        setErr(res.error)
      }
    }
    void tick()
    timer.current = window.setInterval(tick, 3000)
    return () => {
      dead = true
      if (timer.current !== undefined) window.clearInterval(timer.current)
    }
  }, [])

  const pages = (targets ?? []).filter((t) => (t.type ?? 'page') === 'page')

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      window.setTimeout(() => setCopied(''), 1500)
    } catch { /* clipboard unavailable — selection still works */ }
  }

  return (
    <div className="page">
      <div className="pagehead">
        <h2>Agent browser</h2>
        <span className={err ? 'pill warn' : 'pill ok'}>
          {err ? 'offline' : `live · ${pages.length} tab${pages.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="card">
        {err ? (
          <>
            <p className="dim">
              The agent browser isn't reachable{err.includes('not running') ? ' (not started this boot)' : ''}. Start Moch
              with it enabled (default) or set <code>MOCH_BROWSER=1</code>; the agent's
              browser_* tools wait for this same endpoint.
            </p>
            <p className="dim small">{err}</p>
          </>
        ) : (
          <p className="dim">
            A real Chromium runs on this desktop under Moch's control — the agent
            drives it with its browser tools (navigate, click, type, snapshot, tabs).
            The window is on your screen; this is the control panel.
          </p>
        )}
      </div>

      {pages.length > 0 && (
        <div className="card">
          <div className="sec">Open tabs</div>
          <div className="tools-scroll">
            {pages.map((t, i) => (
              <div key={t.id ?? i} className="mini-tool-item" style={{ display: 'block' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mini-tool-name">{t.title || 'Untitled'}</span>
                  <button
                    className="ghost"
                    style={{ marginLeft: 'auto', fontSize: 11 }}
                    onClick={() => void copy(t.url ?? '')}
                  >
                    {copied && copied === t.url ? 'copied ✓' : 'copy URL'}
                  </button>
                </div>
                {t.url && (
                  <span className="mini-tool-desc" style={{ wordBreak: 'break-all' }}>{t.url}</span>
                )}
              </div>
            ))}
          </div>
          <p className="dim small mt8">
            Tell the agent things like “open github.com in the browser and check the
            latest release” — it navigates this window itself. Tab create/close/switch
            are agent-side tools; this list refreshes every 3s.
          </p>
        </div>
      )}
    </div>
  )
}
