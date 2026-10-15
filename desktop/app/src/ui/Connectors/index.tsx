/**
 * Desktop Connectors — the agent's MCP servers as a dense table over the
 * exact engine calls the phone screen makes (app/app/(tabs)/connectors.tsx):
 * mcpState's stores + RPCs. On the desktop there is no phone caveat: the
 * gateway runs on THIS machine, so command/stdio servers run locally.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { C } from '../../../../../app/src/lib/theme'
import { isConnected } from '../../../../../app/src/lib/gateway'
import {
  McpServer,
  McpTestResult,
  addCustomServer,
  catalogLoading,
  cancelMcpOauth,
  installCatalogServer,
  loadMcpCatalog,
  loadMcpServers,
  mcpCatalog,
  mcpListError,
  mcpLoading,
  mcpRuntime,
  mcpServers,
  mcpUnsupported,
  pollMcpOauth,
  refreshMcpRuntime,
  reloadAgentMcp,
  removeMcpServer,
  saveMcpApiKey,
  startMcpOauth,
  testMcpServer,
} from '../../../../../app/src/lib/mcpState'

/** Running-state line for a server row — from cached runtime, never a probe. */
function statusLine(srv: McpServer, rt?: { status?: string; error?: string; tools?: number }): { text: string; danger: boolean; warn: boolean } {
  if (srv.auth === 'oauth' && srv.oauth_tokens_present === false) {
    return { text: 'sign-in needed', danger: false, warn: true }
  }
  if (!srv.enabled) return { text: 'disabled', danger: false, warn: false }
  switch (rt?.status) {
    case 'connected': return { text: `connected${rt.tools ? ` · ${rt.tools} tools` : ''}`, danger: false, warn: false }
    case 'connecting': return { text: 'connecting…', danger: false, warn: false }
    case 'failed': return { text: rt.error ? `failed — ${rt.error}` : 'failed', danger: true, warn: false }
    // Registered but not spawned: the process starts on first use.
    case 'lazy': return { text: `idle · starts on first use${rt.tools ? ` · ${rt.tools} tools` : ''}`, danger: false, warn: false }
    default: return { text: 'not running yet', danger: false, warn: false }
  }
}

/** The catalog RPC carries no brand art (and the app talks only to your
 * machine, never to a favicon service), so each service gets a stable hue
 * from its name: same tile everywhere, every run. */
const TILE_COLORS = ['#E8720C', '#1FA7C4', '#10A37F', '#8B5CF6', '#DB2777', '#D97706', '#3B6FE0', '#0D9488', '#E23838', '#6D5AE0']

function tileColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return TILE_COLORS[h % TILE_COLORS.length]
}

function Tile(props: { name: string; size?: number; installed?: boolean }): React.JSX.Element {
  const size = props.size ?? 36
  const letter = props.name.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?'
  return (
    <span className="moc-tile" style={{ width: size, height: size, borderRadius: size * 0.28, background: tileColor(props.name), fontSize: size * 0.44 }} aria-hidden>
      {letter}
      {props.installed ? <span className="moc-tileCheck">✓</span> : null}
    </span>
  )
}

interface ConfirmState {
  title: string
  body: string
  action: string
  run: () => Promise<void>
}

export default function Connectors(): React.JSX.Element {
  const online = useStore(isConnected)
  const unsupported = useStore(mcpUnsupported)
  const servers = useStore(mcpServers)
  const runtime = useStore(mcpRuntime)
  const catalog = useStore(mcpCatalog)
  const loading = useStore(mcpLoading)
  const catLoading = useStore(catalogLoading)
  const listError = useStore(mcpListError)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'yours' | 'browse'>('yours')
  const [selected, setSelected] = useState<string | null>(null)
  const [openName, setOpenName] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Post-install key prompt: the server name awaiting an API key.
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!online) return
    void loadMcpServers()
    void loadMcpCatalog()
  }, [online])

  // Refresh on mount and whenever the gateway (re)connects — `online`
  // flips true on reconnect, so the effect below re-runs `refresh`.
  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  // Live statuses: `mcp.servers.status` is cached-only, so poll it lightly
  // (one RPC) while the surface is MOUNTED — the interval is torn down on
  // unmount, never left firing app-wide.
  useEffect(() => {
    if (!online) return
    void refreshMcpRuntime()
    const id = setInterval(() => { void refreshMcpRuntime() }, 5_000)
    return () => clearInterval(id)
  }, [online])

  const serverList = useMemo(() => {
    const q = query.trim().toLowerCase()
    return servers
      .filter((x) => !q || x.name.toLowerCase().includes(q) || (x.url ?? '').toLowerCase().includes(q) || (x.command ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [servers, query])

  const catalogList = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog
      .filter((x) => !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q))
      .sort((a, b) => Number(a.installed) - Number(b.installed) || a.name.localeCompare(b.name))
  }, [catalog, query])

  /** Config changed — offer the one-tap `/reload-mcp` so the running agent picks it up. */
  const offerReload = useCallback((what: string) => {
    setConfirm({
      title: what,
      body: 'Reload the agent now so the new tools are available? This restarts its MCP connections.',
      action: 'Reload',
      run: async () => {
        try {
          await reloadAgentMcp()
          void loadMcpServers()
        } catch (err) {
          setNote(`Reload failed — ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    })
  }, [])

  const install = async (name: string, requires: string[]) => {
    setBusy(name)
    try {
      await installCatalogServer(name)
      await loadMcpServers()
      void loadMcpCatalog()
      if (requires.length > 0) {
        setNote(`Installed ${name} — it needs an API key (${requires.join(', ')}) before it can connect.`)
        setKeyFor(name)
      } else {
        offerReload(`Installed ${name}`)
      }
    } catch (err) {
      setNote(`Install failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const open = servers.find((s) => s.name === openName) ?? null

  if (unsupported) {
    return (
      <div className="moc-root">
        <style>{css}</style>
        <header className="moc-head"><h2>Connectors</h2></header>
        <div className="moc-empty">
          <p className="moc-emptyTitle">Not available on this machine</p>
          <p className="moc-emptyBody">The connected Mochi doesn't expose connector management yet. Update Mochi on that machine, then reconnect.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="moc-root">
      <style>{css}</style>
      <header className="moc-head">
        <h2>Connectors</h2>
        <span className="moc-sub">MCP servers on this machine — same surface as `hermes mcp`.</span>
        <input
          className="moc-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'yours' ? 'Filter your servers…' : 'Search the catalog…'}
          aria-label="Filter"
          spellCheck={false}
        />
        <button className="moc-btn" onClick={refresh} disabled={!online} aria-label="Refresh servers">Refresh</button>
        <button className="moc-btn moc-accent" onClick={() => setAdding(true)} disabled={!online}>＋ Add</button>
      </header>

      <div className="moc-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'yours'} className={`moc-tab${tab === 'yours' ? ' moc-tabOn' : ''}`} onClick={() => setTab('yours')}>
          Yours ({servers.length})
        </button>
        <button role="tab" aria-selected={tab === 'browse'} className={`moc-tab${tab === 'browse' ? ' moc-tabOn' : ''}`} onClick={() => setTab('browse')}>
          Browse
        </button>
      </div>

      {note ? <div className="moc-toast" role="status">{note}</div> : null}

      {listError ? (
        <div className="moc-errrow" role="alert">
          <span>Couldn't load servers — {listError}</span>
          <button className="moc-btn" onClick={refresh}>Retry</button>
        </div>
      ) : null}

      {tab === 'yours' ? (
        !online && servers.length === 0 ? (
          <div className="moc-empty" role="status">
            <p className="moc-emptyTitle">Offline</p>
            <p className="moc-emptyBody">Connectors live on your computer. Connect, then refresh.</p>
            <button className="moc-btn" onClick={refresh}>Refresh</button>
          </div>
        ) : loading && servers.length === 0 && !listError ? (
          <div className="moc-spin" aria-label="Loading servers" />
        ) : serverList.length === 0 && !listError ? (
          <div className="moc-empty">
            <p className="moc-emptyTitle">No MCP servers yet</p>
            <p className="moc-emptyBody">Browse the catalog or add one by URL or command.</p>
            <button className="moc-btn moc-accent" onClick={() => setTab('browse')}>Browse catalog</button>
          </div>
        ) : (
          <div className="moc-scroller">
            <table className="moc-table">
              <thead>
                <tr>
                  <th className="moc-th">Name</th>
                  <th className="moc-th">Status</th>
                  <th className="moc-th moc-w-tools">Tools</th>
                  <th className="moc-th moc-w-enabled">Enabled</th>
                  <th className="moc-th moc-w-actions" aria-label="Manage" />
                </tr>
              </thead>
              <tbody>
                {serverList.map((s) => {
                  const st = statusLine(s, runtime[s.name])
                  return (
                    <tr
                      key={s.name}
                      className={`moc-row${selected === s.name ? ' moc-sel' : ''}`}
                      onClick={() => setSelected(s.name)}
                      onDoubleClick={() => setOpenName(s.name)}
                    >
                      <td className="moc-td">
                        <span className="moc-nameCell">
                          <Tile name={s.name} size={22} />
                          <span className="moc-name">{s.name}</span>
                          <span className="moc-badge">{s.transport}</span>
                        </span>
                      </td>
                      <td className={`moc-td${st.danger ? ' moc-red' : st.warn ? ' moc-amber' : ''}`}>{st.text}</td>
                      <td className="moc-td moc-w-tools">{runtime[s.name]?.tools ?? '—'}</td>
                      <td className="moc-td moc-w-enabled">{s.enabled === false ? 'no' : 'yes'}</td>
                      <td className="moc-td moc-w-actions">
                        <button className="moc-btn" onClick={(e) => { e.stopPropagation(); setOpenName(s.name) }}>Manage</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : catLoading && catalog.length === 0 && online ? (
        <div className="moc-spin" aria-label="Loading catalog" />
      ) : catalogList.length === 0 ? (
        <div className="moc-empty">
          <p className="moc-emptyTitle">{online ? (query.trim() ? 'No matches' : 'Catalog is empty') : 'Offline'}</p>
        </div>
      ) : (
        <div className="moc-scroller">
          <div className="moc-grid">
            {catalogList.map((item) => (
              <div key={item.name} className="moc-gridCard">
                <div className="moc-gridHead">
                  <Tile name={item.name} size={34} installed={item.installed} />
                  <span className="moc-gridName">{item.name}</span>
                  {item.requires.length > 0 ? <span className="moc-keyChip">API key</span> : null}
                </div>
                <p className="moc-gridDesc">{item.description}</p>
                <button
                  className={`moc-btn${item.installed ? '' : ' moc-accent'}`}
                  disabled={item.installed || busy === item.name || !online}
                  onClick={() => void install(item.name, item.requires)}
                  aria-label={item.installed ? `${item.name} installed` : `Install ${item.name}`}
                >
                  {busy === item.name ? 'Installing…' : item.installed ? 'Installed' : 'Install'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {open ? (
        <ServerSheet
          server={open}
          runtime={runtime[open.name]}
          onClose={() => setOpenName(null)}
          onChanged={() => { void loadMcpServers(); void loadMcpCatalog() }}
          onRemoved={(name) => { setOpenName(null); offerReload(`Removed ${name}`) }}
          onNeedKey={(name) => setKeyFor(name)}
          onNote={setNote}
        />
      ) : null}

      {adding ? (
        <AddSheet
          onClose={() => setAdding(false)}
          onAdded={async (name) => {
            setAdding(false)
            await loadMcpServers()
            void loadMcpCatalog()
            offerReload(`Added ${name}`)
          }}
        />
      ) : null}

      {keyFor ? (
        <KeySheet
          name={keyFor}
          onClose={() => setKeyFor(null)}
          onSaved={async (name) => {
            setKeyFor(null)
            await loadMcpServers()
            offerReload(`${name} key saved`)
          }}
        />
      ) : null}

      {confirm ? (
        <div className="moc-scrim" onClick={() => setConfirm(null)}>
          <div className="moc-card moc-cardSm" role="dialog" aria-modal aria-label={confirm.title} onClick={(e) => e.stopPropagation()}>
            <strong>{confirm.title}</strong>
            <p className="moc-confirmBody">{confirm.body}</p>
            <div className="moc-dialogBtns">
              <button className="moc-btn" onClick={() => setConfirm(null)}>Not now</button>
              <button className="moc-btn moc-accent" onClick={() => { const c = confirm; setConfirm(null); void c.run() }}>{confirm.action}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ServerSheet(props: {
  server: McpServer
  runtime?: { status?: string; tools?: number; connected?: boolean; error?: string }
  onClose: () => void
  onChanged: () => void
  onRemoved: (name: string) => void
  onNeedKey: (name: string) => void
  onNote: (msg: string) => void
}): React.JSX.Element {
  const server = props.server
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [removing, setRemoving] = useState(false)
  // In-app OAuth sign-in: waiting on the browser, failed, or timed out.
  const [oauthFlow, setOauthFlow] = useState<{ phase: 'waiting' | 'error' | 'timeout'; message?: string } | null>(null)
  const pollTimer = useRef<number | null>(null)
  const activeSession = useRef<string | null>(null)
  // The server the active session belongs to, ref'd alongside it: when the
  // sheet CLOSES, `server` is already stale, so cleanup reads the ref.
  const activeName = useRef<string | null>(null)

  const stopOauthPolling = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    activeSession.current = null
    activeName.current = null
  }, [])

  // Leaving the sheet stops the poller and cancels the gateway-side flow so
  // its callback worker isn't left hanging. Uses the ref'd name — `server`
  // is gone by the time an unmount lands here.
  useEffect(() => {
    const session = activeSession.current
    const name = activeName.current
    if (session && name) void cancelMcpOauth(name, session).catch(() => {})
    stopOauthPolling()
    setOauthFlow(null)
    setResult(null)
    return undefined
  }, [server.name, stopOauthPolling])

  const startSignIn = async () => {
    stopOauthPolling()
    setOauthFlow({ phase: 'waiting' })
    let session: string
    let authUrl: string
    try {
      const started = await startMcpOauth(server.name)
      session = started.session_id
      authUrl = started.auth_url
    } catch (err) {
      setOauthFlow({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }
    activeSession.current = session
    activeName.current = server.name
    // The gateway's loopback callback is on THIS machine — the desktop
    // browser reaches it directly.
    window.open(authUrl, '_blank', 'noopener')
    const startedAt = Date.now()
    pollTimer.current = setInterval(() => {
      if (activeSession.current !== session) { stopOauthPolling(); return }
      if (Date.now() - startedAt > 5 * 60_000) {
        const name = server.name
        stopOauthPolling()
        void cancelMcpOauth(name, session).catch(() => {})
        setOauthFlow({ phase: 'timeout', message: 'Sign-in timed out after 5 minutes — try again.' })
        return
      }
      void pollMcpOauth(server.name, session)
        .then((status) => {
          if (activeSession.current !== session) return
          if (status.status === 'approved') {
            stopOauthPolling()
            setOauthFlow(null)
            void loadMcpServers()
            props.onChanged()
          } else if (status.status === 'error') {
            stopOauthPolling()
            setOauthFlow({ phase: 'error', message: status.error ?? 'Sign-in failed' })
          }
        })
        .catch(() => { /* transient RPC hiccup — keep polling */ })
    }, 1_500)
  }

  const cancelSignIn = () => {
    const session = activeSession.current
    const name = server.name
    stopOauthPolling()
    if (session) void cancelMcpOauth(name, session).catch(() => {})
    setOauthFlow(null)
  }

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await testMcpServer(server.name))
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err), tools: [] })
    } finally {
      setTesting(false)
    }
  }

  const runRemove = async () => {
    setRemoving(true)
    try {
      await removeMcpServer(server.name)
      props.onChanged()
      props.onRemoved(server.name)
    } catch (err) {
      props.onNote(`Remove failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRemoving(false)
    }
  }

  const st = statusLine(server, props.runtime)
  const oauthMissing = server.auth === 'oauth' && server.oauth_tokens_present === false
  const close = () => { if (!testing && !removing) props.onClose() }

  return (
    <div className="moc-scrim" onClick={close}>
      <div className="moc-card" role="dialog" aria-modal aria-label={`Manage ${server.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="moc-cardHead">
          <Tile name={server.name} size={34} />
          <span className="moc-cardTitle">
            <strong>{server.name}</strong>
            <span className={`moc-sub${st.danger ? ' moc-red' : st.warn ? ' moc-amber' : ''}`}>{st.text}</span>
          </span>
          <span className="moc-badge">{server.transport}</span>
          <button className="moc-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="moc-cfg">
          {server.url ? <p className="moc-cfgLine">{server.url}</p> : null}
          {server.command ? <p className="moc-cfgLine">{[server.command, ...(server.args ?? [])].join(' ')}</p> : null}
          {server.auth === 'oauth' ? <p className="moc-cfgLine">OAuth{server.oauth_tokens_present ? ' · signed in' : ''}</p> : null}
          {server.env && server.env.length > 0 ? <p className="moc-cfgLine">env: {server.env.join(', ')}</p> : null}
        </div>

        {oauthMissing ? (
          oauthFlow ? (
            oauthFlow.phase === 'waiting' ? (
              <div className="moc-oauthRow">
                <span className="moc-spinSm" aria-label="Waiting" />
                <span className="moc-sub">Waiting for browser approval…</span>
                <button className="moc-btn" onClick={cancelSignIn}>Cancel</button>
              </div>
            ) : (
              <div className="moc-oauthRow">
                <span className="moc-sub moc-amber">{oauthFlow.message ?? 'Sign-in failed'}</span>
                <button className="moc-btn" onClick={() => void startSignIn()}>Try again</button>
              </div>
            )
          ) : (
            <div className="moc-oauthRow">
              <span className="moc-sub">This server uses OAuth. Sign in from your browser.</span>
              <button className="moc-btn moc-accent" onClick={() => void startSignIn()}>Sign in</button>
            </div>
          )
        ) : null}

        {testing ? (
          <div className="moc-oauthRow">
            <span className="moc-spinSm" aria-label="Testing" />
            <span className="moc-sub">Testing — can take a minute on a cold start…</span>
          </div>
        ) : null}

        {result ? (
          <div className="moc-testResult">
            {result.ok ? (
              <>
                <p className="moc-cfgLine moc-green">
                  Connected — {result.tools.length} tools{result.prompts ? `, ${result.prompts} prompts` : ''}{result.resources ? `, ${result.resources} resources` : ''}
                </p>
                {result.tools.slice(0, 20).map((t) => (
                  <p key={t.name} className="moc-toolLine">
                    <span className="moc-toolName">{t.name}</span>
                    {t.description ? ` — ${t.description}` : ''}
                  </p>
                ))}
                {result.tools.length > 20 ? <p className="moc-cfgLine">…and {result.tools.length - 20} more</p> : null}
              </>
            ) : (
              <p className="moc-cfgLine moc-red">Failed — {result.error}</p>
            )}
          </div>
        ) : null}

        <div className="moc-dialogBtns">
          <button className="moc-btn" onClick={() => void runTest()} disabled={testing}>{testing ? 'Testing…' : 'Test'}</button>
          <button className="moc-btn" onClick={() => props.onNeedKey(server.name)}>API key</button>
          <button className="moc-btn moc-danger" onClick={() => void runRemove()} disabled={removing}>{removing ? 'Removing…' : 'Remove'}</button>
        </div>
      </div>
    </div>
  )
}

function AddSheet(props: { onClose: () => void; onAdded: (name: string) => void | Promise<void> }): React.JSX.Element {
  const [kind, setKind] = useState<'url' | 'command'>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [bearer, setBearer] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(trimmed)) {
      setErr('Name: letters, digits, dashes (e.g. my-search).')
      return
    }
    if (kind === 'url' && !/^https?:\/\//i.test(url.trim())) {
      setErr('Enter the server URL (https://…).')
      return
    }
    if (kind === 'command' && !command.trim()) {
      setErr('Enter the command that starts the server (e.g. npx -y …).')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // The first token is the executable; the rest become its args.
      const parts = command.trim().split(/\s+/).filter(Boolean)
      await addCustomServer({
        name: trimmed,
        url: kind === 'url' ? url.trim() : undefined,
        command: kind === 'command' ? parts[0] : undefined,
        args: kind === 'command' && parts.length > 1 ? parts.slice(1) : undefined,
        bearerToken: bearer.trim() || undefined,
      })
      setName(''); setUrl(''); setCommand(''); setBearer('')
      await props.onAdded(trimmed)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const close = () => { if (!saving) props.onClose() }

  return (
    <div className="moc-scrim" onClick={close}>
      <div className="moc-card" role="dialog" aria-modal aria-label="Add a server" onClick={(e) => e.stopPropagation()}>
        <div className="moc-cardHead">
          <strong>Add a server</strong>
          <button className="moc-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="moc-tabs moc-tabsFlat" role="tablist">
          <button role="tab" aria-selected={kind === 'url'} className={`moc-tab${kind === 'url' ? ' moc-tabOn' : ''}`} onClick={() => setKind('url')}>HTTP URL</button>
          <button role="tab" aria-selected={kind === 'command'} className={`moc-tab${kind === 'command' ? ' moc-tabOn' : ''}`} onClick={() => setKind('command')}>Command</button>
        </div>

        <label className="moc-field">
          <span className="moc-label">Name</span>
          <input className="moc-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. deepwiki" autoFocus spellCheck={false} />
        </label>
        {kind === 'url' ? (
          <label className="moc-field">
            <span className="moc-label">URL</span>
            <input className="moc-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
          </label>
        ) : (
          <label className="moc-field">
            <span className="moc-label">Command</span>
            <input className="moc-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-everything" spellCheck={false} />
          </label>
        )}
        <label className="moc-field">
          <span className="moc-label">Bearer token (optional)</span>
          <input className="moc-input" type="password" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="Authorization: Bearer …" />
        </label>

        {err ? <p className="moc-err" role="alert">{err}</p> : null}

        <div className="moc-dialogBtns">
          <button className="moc-btn" onClick={close} disabled={saving}>Cancel</button>
          <button className="moc-btn moc-accent" onClick={() => void submit()} disabled={saving}>{saving ? 'Adding…' : 'Add server'}</button>
        </div>
      </div>
    </div>
  )
}

function KeySheet(props: { name: string; onClose: () => void; onSaved: (name: string) => void | Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!value.trim()) {
      setErr('Enter the key value.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // Written into the machine's .env and wired into the config reference.
      await saveMcpApiKey(props.name, value.trim())
      setValue('')
      await props.onSaved(props.name)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const close = () => { if (!saving) props.onClose() }

  return (
    <div className="moc-scrim" onClick={close}>
      <div className="moc-card moc-cardSm" role="dialog" aria-modal aria-label={`API key for ${props.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="moc-cardHead">
          <strong>API key — {props.name}</strong>
          <button className="moc-x" aria-label="Close" onClick={close}>✕</button>
        </div>
        <p className="moc-sub">Stored in this machine's .env — never leaves it except to the server itself.</p>
        <input
          className="moc-input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the key…"
          autoFocus
        />
        {err ? <p className="moc-err" role="alert">{err}</p> : null}
        <div className="moc-dialogBtns">
          <button className="moc-btn" onClick={close} disabled={saving}>Cancel</button>
          <button className="moc-btn moc-accent" onClick={() => void submit()} disabled={saving}>{saving ? 'Saving…' : 'Save key'}</button>
        </div>
      </div>
    </div>
  )
}

const css = `
.moc-root { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--moch-text); font-family: var(--moch-font); }
.moc-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--moch-border); }
.moc-head h2 { margin: 0; font-size: 15px; }
.moc-sub { color: var(--moch-text-dim); font-size: 12px; }
.moc-search { margin-left: auto; background: var(--moch-bg); color: var(--moch-text); border: 1px solid var(--moch-border); border-radius: 6px; padding: 4px 9px; font-size: 12.5px; font-family: inherit; width: 200px; }
.moc-tabs { display: flex; gap: 2px; padding: 6px 16px 0; border-bottom: 1px solid var(--moch-border); }
.moc-tabsFlat { padding: 0; border-bottom: none; }
.moc-tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--moch-text-dim); font-size: 12.5px; padding: 5px 10px; cursor: pointer; font-family: inherit; }
.moc-tab:hover { color: var(--moch-text); }
.moc-tab.moc-tabOn { color: var(--moch-text); border-bottom-color: var(--moch-accent); }
.moc-scroller { flex: 1; overflow: auto; min-height: 0; }
.moc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.moc-th { position: sticky; top: 0; z-index: 1; background: var(--moch-bg-card); color: var(--moch-text-faint); text-align: left; font-weight: 500; padding: 0 10px; height: 30px; border-bottom: 1px solid var(--moch-border); white-space: nowrap; }
.moc-row { height: var(--moch-row-h, 32px); cursor: default; }
.moc-row:hover { background: var(--moch-bg-hover); }
.moc-row.moc-sel { background: var(--moch-accent-soft); }
.moc-td { padding: 0 10px; border-bottom: 1px solid var(--moch-border-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.moc-nameCell { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.moc-name { font-weight: 500; }
.moc-badge { color: var(--moch-text-faint); font-size: 10.5px; border: 1px solid var(--moch-border); border-radius: 8px; padding: 0 6px; }
.moc-w-tools { width: 64px; }
.moc-w-enabled { width: 72px; }
.moc-w-actions { width: 1%; white-space: nowrap; }
.moc-red { color: var(--moch-red); }
.moc-green { color: var(--moch-green-soft); }
.moc-amber { color: var(--moch-amber, ${C.amber}); }
.moc-tile { display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; position: relative; flex: none; }
.moc-tileCheck { position: absolute; top: -5px; right: -5px; width: 14px; height: 14px; border-radius: 7px; background: var(--moch-green-soft); color: var(--moch-text); font-size: 9px; line-height: 14px; text-align: center; }
.moc-btn { background: transparent; color: var(--moch-text-dim); border: 1px solid var(--moch-border); border-radius: 5px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
.moc-btn:hover:not(:disabled) { color: var(--moch-text); border-color: var(--moch-text-faint); }
.moc-btn:disabled { opacity: 0.5; cursor: default; }
.moc-btn.moc-accent { background: var(--moch-accent); color: var(--moch-bg); border-color: transparent; }
.moc-btn.moc-danger { color: var(--moch-red); }
.moc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; padding: 12px 16px 24px; }
.moc-gridCard { background: var(--moch-bg-card); border: 1px solid var(--moch-border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.moc-gridHead { display: flex; align-items: center; gap: 8px; }
.moc-gridName { font-weight: 500; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moc-keyChip { color: var(--moch-amber, ${C.amber}); font-size: 10.5px; border: 1px solid var(--moch-border); border-radius: 8px; padding: 0 6px; flex: none; }
.moc-gridDesc { margin: 0; color: var(--moch-text-dim); font-size: 11.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; flex: 1; }
.moc-gridCard .moc-btn { align-self: flex-start; }
.moc-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; color: var(--moch-text-dim); }
.moc-emptyTitle { margin: 0; color: var(--moch-text); font-size: 16px; font-weight: 600; }
.moc-emptyBody { margin: 0 0 8px; font-size: 12.5px; text-align: center; max-width: 420px; }
.moc-errrow { display: flex; align-items: center; gap: 12px; padding: 8px 16px; color: var(--moch-red); font-size: 12.5px; border-bottom: 1px solid var(--moch-border-soft); }
.moc-errrow span { flex: 1; }
.moc-err { margin: 0; color: var(--moch-red); font-size: 12.5px; }
.moc-spin { width: 22px; height: 22px; margin: 48px auto; border: 2px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: moc-rot 800ms linear infinite; }
.moc-spinSm { display: inline-block; width: 13px; height: 13px; border: 1.5px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: moc-rot 800ms linear infinite; }
@keyframes moc-rot { to { transform: rotate(360deg); } }
.moc-toast { position: fixed; left: 16px; bottom: 16px; z-index: 40; background: var(--moch-bg-elev); border: 1px solid var(--moch-border); color: var(--moch-text); font-size: 12.5px; padding: 7px 12px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
.moc-scrim { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.45); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px; }
.moc-card { background: var(--moch-bg-card); border: 1px solid var(--moch-border); border-radius: 10px; width: 480px; max-width: 100%; max-height: 84vh; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); }
.moc-cardSm { width: 360px; }
.moc-cardHead { display: flex; align-items: center; gap: 10px; }
.moc-cardTitle { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.moc-cardTitle strong { font-size: 14px; }
.moc-x { background: none; border: none; color: var(--moch-text-faint); cursor: pointer; font-size: 12px; padding: 2px 6px; }
.moc-cfg { display: flex; flex-direction: column; gap: 4px; }
.moc-cfgLine { margin: 0; font-family: var(--moch-mono); font-size: 11.5px; color: var(--moch-text-dim); overflow-wrap: anywhere; }
.moc-oauthRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.moc-testResult { border-top: 1px solid var(--moch-border-soft); padding-top: 8px; display: flex; flex-direction: column; gap: 3px; }
.moc-toolLine { margin: 0; font-size: 11.5px; color: var(--moch-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.moc-toolName { font-family: var(--moch-mono); color: var(--moch-text); }
.moc-field { display: flex; flex-direction: column; gap: 4px; }
.moc-label { color: var(--moch-text-faint); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.moc-input { background: var(--moch-bg); color: var(--moch-text); border: 1px solid var(--moch-border); border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit; }
.moc-dialogBtns { display: flex; justify-content: flex-end; gap: 8px; }
.moc-confirmBody { margin: 0; color: var(--moch-text-dim); font-size: 13px; }
.moc-root :focus-visible { outline: 2px solid var(--moch-accent); outline-offset: 1px; }
`
