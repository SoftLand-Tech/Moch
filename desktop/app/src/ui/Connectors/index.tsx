/**
 * Desktop Connectors — the agent's MCP servers as a dense table over the
 * exact engine calls the phone screen makes (app/app/(tabs)/connectors.tsx):
 * mcpState's stores + RPCs. On the desktop there is no phone caveat: the
 * gateway runs on THIS machine, so command/stdio servers run locally.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
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
    <span className="mos-tile" style={{ width: size, height: size, borderRadius: size * 0.28, background: tileColor(props.name), fontSize: size * 0.44 }} aria-hidden>
      {letter}
      {props.installed ? <span className="mos-tileCheck">✓</span> : null}
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
      <div className="mos-root">
        <style>{css}</style>
        <header className="mos-head"><h2>Connectors</h2></header>
        <div className="mos-empty">
          <p className="mos-emptyTitle">Not available on this machine</p>
          <p className="mos-emptyBody">The connected Mochi doesn't expose connector management yet. Update Mochi on that machine, then reconnect.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mos-root">
      <style>{css}</style>
      <header className="mos-head">
        <h2>Connectors</h2>
        <span className="mos-sub">MCP servers on this machine — same surface as `hermes mcp`.</span>
        <input
          className="mos-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'yours' ? 'Filter your servers…' : 'Search the catalog…'}
          aria-label="Filter"
          spellCheck={false}
        />
        <button className="mos-btn" onClick={refresh} disabled={!online} aria-label="Refresh servers">Refresh</button>
        <button className="mos-btn mos-accent" onClick={() => setAdding(true)} disabled={!online}>＋ Add</button>
      </header>

      <div className="mos-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'yours'} className={`mos-tab${tab === 'yours' ? ' mos-tabOn' : ''}`} onClick={() => setTab('yours')}>
          Yours ({servers.length})
        </button>
        <button role="tab" aria-selected={tab === 'browse'} className={`mos-tab${tab === 'browse' ? ' mos-tabOn' : ''}`} onClick={() => setTab('browse')}>
          Browse
        </button>
      </div>

      {note ? <div className="mos-toast" role="status">{note}</div> : null}

      {listError ? (
        <div className="mos-errrow" role="alert">
          <span>Couldn't load servers — {listError}</span>
          <button className="mos-btn" onClick={refresh}>Retry</button>
        </div>
      ) : null}

      {tab === 'yours' ? (
        !online && servers.length === 0 ? (
          <div className="mos-empty" role="status">
            <p className="mos-emptyTitle">Offline</p>
            <p className="mos-emptyBody">Connectors live on your computer. Connect, then refresh.</p>
            <button className="mos-btn" onClick={refresh}>Refresh</button>
          </div>
        ) : loading && servers.length === 0 && !listError ? (
          <div className="mos-spin" aria-label="Loading servers" />
        ) : serverList.length === 0 && !listError ? (
          <div className="mos-empty">
            <p className="mos-emptyTitle">No MCP servers yet</p>
            <p className="mos-emptyBody">Browse the catalog or add one by URL or command.</p>
            <button className="mos-btn mos-accent" onClick={() => setTab('browse')}>Browse catalog</button>
          </div>
        ) : (
          <div className="mos-scroller">
            <table className="mos-table">
              <thead>
                <tr>
                  <th className="mos-th">Name</th>
                  <th className="mos-th">Status</th>
                  <th className="mos-th mos-w-tools">Tools</th>
                  <th className="mos-th mos-w-enabled">Enabled</th>
                  <th className="mos-th mos-w-actions" aria-label="Manage" />
                </tr>
              </thead>
              <tbody>
                {serverList.map((s) => {
                  const st = statusLine(s, runtime[s.name])
                  return (
                    <tr
                      key={s.name}
                      className={`mos-row${selected === s.name ? ' mos-sel' : ''}`}
                      onClick={() => setSelected(s.name)}
                      onDoubleClick={() => setOpenName(s.name)}
                    >
                      <td className="mos-td">
                        <span className="mos-namecell">
                          <Tile name={s.name} size={22} />
                          <span className="mos-name">{s.name}</span>
                          <span className="mos-badge">{s.transport}</span>
                        </span>
                      </td>
                      <td className={`mos-td${st.danger ? ' mos-red' : st.warn ? ' mos-amber' : ''}`}>{st.text}</td>
                      <td className="mos-td mos-w-tools">{runtime[s.name]?.tools ?? '—'}</td>
                      <td className="mos-td mos-w-enabled">{s.enabled === false ? 'no' : 'yes'}</td>
                      <td className="mos-td mos-w-actions">
                        <button className="mos-btn" onClick={(e) => { e.stopPropagation(); setOpenName(s.name) }}>Manage</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : catLoading && catalog.length === 0 && online ? (
        <div className="mos-spin" aria-label="Loading catalog" />
      ) : catalogList.length === 0 ? (
        <div className="mos-empty">
          <p className="mos-emptyTitle">{online ? (query.trim() ? 'No matches' : 'Catalog is empty') : 'Offline'}</p>
        </div>
      ) : (
        <div className="mos-scroller">
          <div className="mos-grid">
            {catalogList.map((item) => (
              <div key={item.name} className="mos-gridCard">
                <div className="mos-gridHead">
                  <Tile name={item.name} size={34} installed={item.installed} />
                  <span className="mos-gridName">{item.name}</span>
                  {item.requires.length > 0 ? <span className="mos-keyChip">API key</span> : null}
                </div>
                <p className="mos-gridDesc">{item.description}</p>
                <button
                  className={`mos-btn${item.installed ? '' : ' mos-accent'}`}
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
        <div className="mos-scrim" onClick={() => setConfirm(null)}>
          <div className="mos-card mos-cardSm" role="dialog" aria-modal aria-label={confirm.title} onClick={(e) => e.stopPropagation()}>
            <strong>{confirm.title}</strong>
            <p className="mos-confirmBody">{confirm.body}</p>
            <div className="mos-dialogBtns">
              <button className="mos-btn" onClick={() => setConfirm(null)}>Not now</button>
              <button className="mos-btn mos-accent" onClick={() => { const c = confirm; setConfirm(null); void c.run() }}>{confirm.action}</button>
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
    <div className="mos-scrim" onClick={close}>
      <div className="mos-card" role="dialog" aria-modal aria-label={`Manage ${server.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="mos-cardHead">
          <Tile name={server.name} size={34} />
          <span className="mos-cardTitle">
            <strong>{server.name}</strong>
            <span className={`mos-sub${st.danger ? ' mos-red' : st.warn ? ' mos-amber' : ''}`}>{st.text}</span>
          </span>
          <span className="mos-badge">{server.transport}</span>
          <button className="mos-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="mos-cfg">
          {server.url ? <p className="mos-cfgLine">{server.url}</p> : null}
          {server.command ? <p className="mos-cfgLine">{[server.command, ...(server.args ?? [])].join(' ')}</p> : null}
          {server.auth === 'oauth' ? <p className="mos-cfgLine">OAuth{server.oauth_tokens_present ? ' · signed in' : ''}</p> : null}
          {server.env && server.env.length > 0 ? <p className="mos-cfgLine">env: {server.env.join(', ')}</p> : null}
        </div>

        {oauthMissing ? (
          oauthFlow ? (
            oauthFlow.phase === 'waiting' ? (
              <div className="mos-oauthRow">
                <span className="mos-spinSm" aria-label="Waiting" />
                <span className="mos-sub">Waiting for browser approval…</span>
                <button className="mos-btn" onClick={cancelSignIn}>Cancel</button>
              </div>
            ) : (
              <div className="mos-oauthRow">
                <span className="mos-sub mos-amber">{oauthFlow.message ?? 'Sign-in failed'}</span>
                <button className="mos-btn" onClick={() => void startSignIn()}>Try again</button>
              </div>
            )
          ) : (
            <div className="mos-oauthRow">
              <span className="mos-sub">This server uses OAuth. Sign in from your browser.</span>
              <button className="mos-btn mos-accent" onClick={() => void startSignIn()}>Sign in</button>
            </div>
          )
        ) : null}

        {testing ? (
          <div className="mos-oauthRow">
            <span className="mos-spinSm" aria-label="Testing" />
            <span className="mos-sub">Testing — can take a minute on a cold start…</span>
          </div>
        ) : null}

        {result ? (
          <div className="mos-testResult">
            {result.ok ? (
              <>
                <p className="mos-cfgLine mos-green">
                  Connected — {result.tools.length} tools{result.prompts ? `, ${result.prompts} prompts` : ''}{result.resources ? `, ${result.resources} resources` : ''}
                </p>
                {result.tools.slice(0, 20).map((t) => (
                  <p key={t.name} className="mos-toolLine">
                    <span className="mos-toolName">{t.name}</span>
                    {t.description ? ` — ${t.description}` : ''}
                  </p>
                ))}
                {result.tools.length > 20 ? <p className="mos-cfgLine">…and {result.tools.length - 20} more</p> : null}
              </>
            ) : (
              <p className="mos-cfgLine mos-red">Failed — {result.error}</p>
            )}
          </div>
        ) : null}

        <div className="mos-dialogBtns">
          <button className="mos-btn" onClick={() => void runTest()} disabled={testing}>{testing ? 'Testing…' : 'Test'}</button>
          <button className="mos-btn" onClick={() => props.onNeedKey(server.name)}>API key</button>
          <button className="mos-btn mos-danger" onClick={() => void runRemove()} disabled={removing}>{removing ? 'Removing…' : 'Remove'}</button>
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
    <div className="mos-scrim" onClick={close}>
      <div className="mos-card" role="dialog" aria-modal aria-label="Add a server" onClick={(e) => e.stopPropagation()}>
        <div className="mos-cardHead">
          <strong>Add a server</strong>
          <button className="mos-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="mos-tabs mos-tabs--flat" role="tablist">
          <button role="tab" aria-selected={kind === 'url'} className={`mos-tab${kind === 'url' ? ' mos-tabOn' : ''}`} onClick={() => setKind('url')}>HTTP URL</button>
          <button role="tab" aria-selected={kind === 'command'} className={`mos-tab${kind === 'command' ? ' mos-tabOn' : ''}`} onClick={() => setKind('command')}>Command</button>
        </div>

        <label className="mos-field">
          <span className="mos-label">Name</span>
          <input className="mos-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. deepwiki" autoFocus spellCheck={false} />
        </label>
        {kind === 'url' ? (
          <label className="mos-field">
            <span className="mos-label">URL</span>
            <input className="mos-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
          </label>
        ) : (
          <label className="mos-field">
            <span className="mos-label">Command</span>
            <input className="mos-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-everything" spellCheck={false} />
          </label>
        )}
        <label className="mos-field">
          <span className="mos-label">Bearer token (optional)</span>
          <input className="mos-input" type="password" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="Authorization: Bearer …" />
        </label>

        {err ? <p className="mos-err" role="alert">{err}</p> : null}

        <div className="mos-dialogBtns">
          <button className="mos-btn" onClick={close} disabled={saving}>Cancel</button>
          <button className="mos-btn mos-accent" onClick={() => void submit()} disabled={saving}>{saving ? 'Adding…' : 'Add server'}</button>
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
    <div className="mos-scrim" onClick={close}>
      <div className="mos-card mos-cardSm" role="dialog" aria-modal aria-label={`API key for ${props.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="mos-cardHead">
          <strong>API key — {props.name}</strong>
          <button className="mos-x" aria-label="Close" onClick={close}>✕</button>
        </div>
        <p className="mos-sub">Stored in this machine's .env — never leaves it except to the server itself.</p>
        <input
          className="mos-input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the key…"
          autoFocus
        />
        {err ? <p className="mos-err" role="alert">{err}</p> : null}
        <div className="mos-dialogBtns">
          <button className="mos-btn" onClick={close} disabled={saving}>Cancel</button>
          <button className="mos-btn mos-accent" onClick={() => void submit()} disabled={saving}>{saving ? 'Saving…' : 'Save key'}</button>
        </div>
      </div>
    </div>
  )
}

const css = `
/* Local to Connectors: the shared table kit (desktop.css) covers the rest. */
.mos-w-tools { width: 64px; }
.mos-w-enabled { width: 72px; }
.mos-tile { display: inline-flex; align-items: center; justify-content: center; color: var(--moch-on-accent, #fff); font-weight: 700; position: relative; flex: none; }
.mos-tileCheck { position: absolute; top: -5px; right: -5px; width: 14px; height: 14px; border-radius: 7px; background: var(--moch-green-soft); color: var(--moch-text); font-size: 9px; line-height: 14px; text-align: center; }
.mos-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; padding: 12px 16px 24px; }
.mos-gridCard { background: var(--moch-bg-card); border: 1px solid var(--moch-border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.mos-gridHead { display: flex; align-items: center; gap: 8px; }
.mos-gridName { font-weight: 500; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mos-keyChip { color: var(--moch-amber); font-size: 10.5px; border: 1px solid var(--moch-border); border-radius: 8px; padding: 0 6px; flex: none; }
.mos-gridDesc { margin: 0; color: var(--moch-text-dim); font-size: 11.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; flex: 1; }
.mos-gridCard .mos-btn { align-self: flex-start; }
.mos-cfg { display: flex; flex-direction: column; gap: 4px; }
.mos-cfgLine { margin: 0; font-family: var(--moch-mono); font-size: 11.5px; color: var(--moch-text-dim); overflow-wrap: anywhere; }
.mos-oauthRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mos-testResult { border-top: 1px solid var(--moch-border-soft); padding-top: 8px; display: flex; flex-direction: column; gap: 3px; }
.mos-toolLine { margin: 0; font-size: 11.5px; color: var(--moch-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mos-toolName { font-family: var(--moch-mono); color: var(--moch-text); }
`
