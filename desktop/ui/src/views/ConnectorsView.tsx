import { useCallback, useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { CircleAlert, KeyRound, Plus, Plug, RefreshCw, Server, Trash, Unplug, X } from 'lucide-react'
import {
  addMcpServer, disconnectProvider, errMsg, listMcpCatalog, listMcpServers, listProviders,
  mcpDotClass, probeMcpServer, removeMcpServer, saveProviderKey, type McpCatalogEntry, type McpServer,
  type ProviderInfo,
} from '../lib/connectors'
import { isConnected } from '../lib/gateway'
import { locale, tr } from '../lib/strings'

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 650,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  marginBottom: 6,
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6, margin: '6px 0' }}>
      <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {children}
    </div>
  )
}

export default function ConnectorsView() {
  useStore(locale)
  const connected = useStore(isConnected)
  // ── providers ──
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [providersError, setProvidersError] = useState('')
  const [keyModal, setKeyModal] = useState<{ slug: string; name: string } | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [fallbackSlug, setFallbackSlug] = useState('')
  const [fallbackKey, setFallbackKey] = useState('')
  const [fallbackBusy, setFallbackBusy] = useState(false)
  const [fallbackError, setFallbackError] = useState('')
  // ── mcp ──
  const [servers, setServers] = useState<McpServer[]>([])
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpError, setMcpError] = useState('')
  const [probe, setProbe] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [probing, setProbing] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [addModal, setAddModal] = useState<{ name: string; config: string; preset: string | null } | null>(null)
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      setProviders(await listProviders())
      setProvidersError('')
    } catch (e) {
      setProvidersError(errMsg(e))
    } finally {
      setProvidersLoading(false)
    }
  }, [])

  const refreshMcp = useCallback(async () => {
    setMcpLoading(true)
    try {
      setServers(await listMcpServers())
      setMcpError('')
    } catch (e) {
      setMcpError(errMsg(e))
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) {
      void refreshProviders()
      void refreshMcp()
    }
  }, [connected, refreshProviders, refreshMcp])

  // Slow poll (never faster than 30s) keeps connection states honest.
  useEffect(() => {
    const t = setInterval(() => {
      if (connected) {
        void refreshProviders()
        void refreshMcp()
      }
    }, 60_000)
    return () => clearInterval(t)
  }, [connected, refreshProviders, refreshMcp])

  // ── provider actions ──
  const connect = async (slug: string) => {
    setKeyBusy(true)
    setKeyError('')
    try {
      await saveProviderKey(slug, keyValue.trim())
      setKeyModal(null)
      setKeyValue('')
      await refreshProviders()
    } catch (e) {
      setKeyError(errMsg(e))
    } finally {
      setKeyBusy(false)
    }
  }

  const disconnect = async (slug: string) => {
    setKeyBusy(true)
    setKeyError('')
    try {
      await disconnectProvider(slug)
      await refreshProviders()
    } catch (e) {
      setProvidersError(errMsg(e))
    } finally {
      setKeyBusy(false)
    }
  }

  // ── mcp actions ──
  const test = async (name: string) => {
    setProbing(name)
    try {
      const res = await probeMcpServer(name)
      setProbe((prev) => ({ ...prev, [name]: res }))
      void refreshMcp()
    } catch (e) {
      setProbe((prev) => ({ ...prev, [name]: { ok: false, detail: errMsg(e) } }))
    } finally {
      setProbing(null)
    }
  }

  const remove = async (name: string) => {
    try {
      await removeMcpServer(name)
      setConfirmRemove(null)
      await refreshMcp()
    } catch (e) {
      setMcpError(errMsg(e))
    }
  }

  const openAdd = () => {
    setAddError('')
    setAddModal({ name: '', config: '', preset: null })
    if (catalog === null) {
      void listMcpCatalog().then(setCatalog)
    }
  }

  const submitAdd = async () => {
    if (!addModal) return
    const name = addModal.name.trim()
    if (!name) return
    let config: Record<string, unknown> | null = null
    if (addModal.config.trim()) {
      try {
        const parsed: unknown = JSON.parse(addModal.config)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(tr('conn.err.obj'))
        }
        config = parsed as Record<string, unknown>
      } catch (e) {
        setAddError(e instanceof Error ? e.message : String(e))
        return
      }
    } else if (!addModal.preset) {
      setAddError(tr('conn.err.config'))
      return
    }
    setAddBusy(true)
    setAddError('')
    try {
      await addMcpServer(name, config, addModal.preset ?? undefined)
      setAddModal(null)
      await refreshMcp()
      void listMcpCatalog().then(setCatalog)
    } catch (e) {
      setAddError(errMsg(e))
    } finally {
      setAddBusy(false)
    }
  }

  const providersUnusable = !providersLoading && (providers.length === 0 || !!providersError)

  return (
    <main className="focus">
      <div className="focus-head">
        <Plug size={16} color="var(--accent)" />
        <span style={{ fontWeight: 650, fontSize: 15 }}>{tr('nav.connectors')}</span>
        <div style={{ flex: 1 }} />
        <button
          className="btn sm"
          title={tr('conn.rescan')}
          disabled={!connected}
          onClick={() => {
            void refreshProviders()
            void refreshMcp()
          }}
        >
          <RefreshCw size={13} /> {tr('conn.refresh')}
        </button>
      </div>
      <div className="focus-body">
        <div style={{ maxWidth: 780, width: '100%', margin: '0 auto', padding: '18px 24px 48px', display: 'flex', flexDirection: 'column', gap: 30 }}>

          {/* ── (a) Model providers ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <KeyRound size={13} /> {tr('conn.providers')}
            </div>
            {providersError ? <Banner>{providersError}</Banner> : null}
            {providersLoading ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)', padding: '12px 0', fontSize: 'var(--text-sm)' }}>
                <span className="spinner" style={{ width: 12, height: 12 }} /> {tr('conn.providers.loading')}
              </div>
            ) : providersUnusable ? (
              <div style={{ padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>
                  {tr('conn.unavailable')}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" style={{ width: 160 }} placeholder={tr('conn.slug.ph')} value={fallbackSlug} onChange={(e) => setFallbackSlug(e.target.value)} />
                  <input className="input" type="password" style={{ flex: 1 }} placeholder={tr('conn.apikey')} value={fallbackKey} onChange={(e) => setFallbackKey(e.target.value)} />
                  <button
                    className="btn primary"
                    disabled={!fallbackSlug.trim() || !fallbackKey.trim() || fallbackBusy}
                    onClick={() => {
                      setFallbackBusy(true)
                      setFallbackError('')
                      void saveProviderKey(fallbackSlug.trim(), fallbackKey.trim())
                        .then(refreshProviders)
                        .catch((e: unknown) => setFallbackError(errMsg(e)))
                        .finally(() => setFallbackBusy(false))
                    }}
                  >
                    {fallbackBusy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <KeyRound size={13} />} {tr('conn.addkey')}
                  </button>
                </div>
                {fallbackError ? <Banner>{fallbackError}</Banner> : null}
              </div>
            ) : (
              providers.map((p) => (
                <div key={p.slug} className="row" style={{ padding: '10px 6px', borderBottom: '1px solid var(--border-soft)', cursor: 'default' }}>
                  <span
                    className={`status-dot ${p.authenticated === true ? 'ok' : p.authenticated === false ? 'idle' : 'warn'}`}
                    title={p.authenticated === true ? tr('conn.status.connected') : p.authenticated === false ? tr('conn.status.nokey') : tr('conn.status.unknown')}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {p.name}
                      {p.isCurrent ? <span className="chip active" style={{ padding: '1px 8px', fontSize: 10, cursor: 'default' }}>{tr('conn.current')}</span> : null}
                      {p.freeTier ? <span className="chip" style={{ padding: '1px 8px', fontSize: 10, cursor: 'default' }}>{tr('conn.freetier')}</span> : null}
                    </div>
                    <div className="text-faint" style={{ fontSize: 'var(--text-xs)' }}>
                      <span className="mono">{p.slug}</span>
                      {p.models.length ? ` · ${tr('conn.models.n', { n: p.models.length })}` : ''}
                      {p.warning ? ` · ${p.warning}` : ''}
                    </div>
                  </div>
                  {p.authenticated === true ? (
                    <button className="btn sm" disabled={keyBusy} onClick={() => void disconnect(p.slug)}>
                      <Unplug size={13} /> {tr('conn.disconnect')}
                    </button>
                  ) : (
                    <button
                      className="btn sm"
                      disabled={keyBusy}
                      onClick={() => {
                        setKeyError('')
                        setKeyValue('')
                        setKeyModal({ slug: p.slug, name: p.name })
                      }}
                    >
                      <KeyRound size={13} /> {tr('conn.connect')}
                    </button>
                  )}
                </div>
              ))
            )}
          </section>

          {/* ── (b) MCP servers ── */}
          <section>
            <div style={{ ...labelStyle, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Server size={13} /> {tr('conn.mcp')}
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={openAdd} title={tr('conn.mcp.add')}>
                <Plus size={13} /> {tr('conn.mcp.addBtn')}
              </button>
            </div>
            {mcpError ? <Banner>{mcpError}</Banner> : null}
            {mcpLoading ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)', padding: '12px 0', fontSize: 'var(--text-sm)' }}>
                <span className="spinner" style={{ width: 12, height: 12 }} /> {tr('conn.mcp.loading')}
              </div>
            ) : servers.length === 0 ? (
              <div style={{ padding: '12px 0', color: 'var(--text-faint)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                {tr('conn.mcp.none')}
              </div>
            ) : (
              servers.map((s) => {
                const p = probe[s.name]
                return (
                  <div key={s.name} className="row" style={{ padding: '10px 6px', borderBottom: '1px solid var(--border-soft)', cursor: 'default' }}>
                    <span className={`status-dot ${mcpDotClass(s)}`} title={s.status ?? (s.connected === true ? tr('conn.status.connected') : s.connected === false ? tr('conn.mcp.notconnected') : tr('conn.status.unknown'))} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text)' }}>{s.name}</div>
                      <div className="text-faint" style={{ fontSize: 'var(--text-xs)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="mono">{s.transport ?? (s.url ? 'http' : s.command ? 'stdio' : '?')}</span>
                        {s.tools.length ? <span>{tr('conn.mcp.tools.n', { n: s.tools.length })}</span> : null}
                        {s.enabled === false ? <span>{tr('conn.mcp.disabled')}</span> : null}
                        {s.status ? <span>{s.status}</span> : null}
                      </div>
                      {p ? (
                        <div style={{ fontSize: 'var(--text-xs)', color: p.ok ? 'var(--green-soft)' : 'var(--red)', marginTop: 3 }}>
                          {p.ok ? tr('conn.test.ok') : tr('conn.test.failed')} — {p.detail}
                        </div>
                      ) : null}
                    </div>
                    <button className="btn sm" disabled={probing !== null} onClick={() => void test(s.name)}>
                      {probing === s.name ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null} {tr('conn.test')}
                    </button>
                    <button
                      className={`btn sm${confirmRemove === s.name ? ' danger' : ''}`}
                      title={confirmRemove === s.name ? tr('conn.remove.again') : tr('conn.remove')}
                      onClick={() => {
                        if (confirmRemove === s.name) void remove(s.name)
                        else setConfirmRemove(s.name)
                      }}
                    >
                      {confirmRemove === s.name ? tr('conn.confirm') : <Trash size={13} />}
                    </button>
                  </div>
                )
              })
            )}
          </section>
        </div>
      </div>

      {/* connect-key modal */}
      {keyModal ? (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setKeyModal(null)}>
          <div className="modal" style={{ minWidth: 380 }}>
            <div className="modal-head">
              <span>{tr('conn.connect.named', { name: keyModal.name })}</span>
              <button className="btn ghost sm" onClick={() => setKeyModal(null)} aria-label="Close"><X size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={labelStyle}>{tr('conn.apikey')}</div>
              <input
                className="input"
                type="password"
                placeholder="sk-…"
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && keyValue.trim() && void connect(keyModal.slug)}
                autoFocus
              />
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 8 }}>
                {tr('conn.key.stored')}
              </div>
              {keyError ? <div style={{ marginTop: 8 }}><Banner>{keyError}</Banner></div> : null}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setKeyModal(null)}>{tr('conn.cancel')}</button>
              <button className="btn primary" disabled={!keyValue.trim() || keyBusy} onClick={() => void connect(keyModal.slug)}>
                {keyBusy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <KeyRound size={13} />} {tr('conn.key.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* add-server modal */}
      {addModal ? (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setAddModal(null)}>
          <div className="modal">
            <div className="modal-head">
              <span>{tr('conn.mcp.add')}</span>
              <button className="btn ghost sm" onClick={() => setAddModal(null)} aria-label="Close"><X size={14} /></button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={labelStyle}>{tr('conn.name')}</div>
                <input
                  className="input"
                  placeholder={tr('conn.name.ph')}
                  value={addModal.name}
                  onChange={(e) => setAddModal({ ...addModal, name: e.target.value, preset: addModal.preset && !e.target.value.startsWith(addModal.preset) ? null : addModal.preset })}
                  autoFocus
                />
              </div>
              {catalog && catalog.length > 0 ? (
                <div>
                  <div style={labelStyle}>{tr('conn.catalog', { n: catalog.length })}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 108, overflowY: 'auto' }}>
                    {catalog.map((c) => (
                      <button
                        key={c.name}
                        className={`chip${addModal.preset === c.name ? ' active' : ''}`}
                        title={c.description}
                        onClick={() => setAddModal({ name: c.name, config: '', preset: c.name })}
                      >
                        {c.name}{c.installed ? ' ·' : ''}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 5 }}>
                    {tr('conn.catalog.hint')}
                  </div>
                </div>
              ) : null}
              <div>
                <div style={labelStyle}>{tr('conn.config')}</div>
                <textarea
                  className="input mono"
                  rows={6}
                  placeholder={'{\n  "command": "npx",\n  "args": ["-y", "some-mcp-server"]\n}'}
                  value={addModal.config}
                  onChange={(e) => setAddModal({ ...addModal, config: e.target.value })}
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 5 }}>
                  {tr('conn.config.hint')}
                </div>
              </div>
              {addError ? <Banner>{addError}</Banner> : null}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setAddModal(null)}>{tr('conn.cancel')}</button>
              <button className="btn primary" disabled={!addModal.name.trim() || addBusy} onClick={() => void submitAdd()}>
                {addBusy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Plus size={13} />} {tr('conn.addserver')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
