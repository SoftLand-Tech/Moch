import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { View, Text, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator, Modal, ScrollView, Image, Linking } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { MCP_LOGOS } from '../../src/lib/mcpLogos'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { C, useStyles } from '../../src/lib/theme'
import { connConfig, isConnected as isConnectedAtom } from '../../src/lib/gateway'
import {
  mcpServers, mcpRuntime, mcpCatalog, mcpUnsupported, mcpLoading, catalogLoading, mcpListError,
  loadMcpServers, loadMcpCatalog, refreshMcpRuntime, installCatalogServer, addCustomServer,
  removeMcpServer, testMcpServer, saveMcpApiKey, reloadAgentMcp,
  startMcpOauth, pollMcpOauth, cancelMcpOauth,
  type McpServer, type McpTestResult,
} from '../../src/lib/mcpState'

/**
 * Connectors — manage the agent's MCP servers from the phone. The gateway's
 * `mcp.*` RPCs are the same surface as `hermes mcp` on the machine, so
 * everything done here lands in that machine's config.yaml / .env — the app
 * holds no connector state of its own.
 */

/** Running-state line under a server name — from cached runtime, never a probe. */
function statusLine(srv: McpServer, rt?: { status?: string; error?: string; tools?: number }): { text: string; color: string } {
  if (srv.auth === 'oauth' && srv.oauth_tokens_present === false) {
    return { text: 'sign-in needed', color: C.amber }
  }
  if (!srv.enabled) return { text: 'disabled', color: C.textFaint }
  switch (rt?.status) {
    case 'connected': return { text: `connected${rt.tools ? ` · ${rt.tools} tools` : ''}`, color: C.greenSoft }
    case 'connecting': return { text: 'connecting…', color: C.textFaint }
    case 'failed': return { text: rt.error ? `failed — ${rt.error}` : 'failed', color: C.red }
    // Registered but not spawned: the process starts on first use.
    case 'lazy': return { text: `idle · starts on first use${rt.tools ? ` · ${rt.tools} tools` : ''}`, color: C.textDim }
    default: return { text: 'not running yet', color: C.textFaint }
  }
}

/**
 * Command-transport server (npx/uvx/local binary). The embedded gateway
 * can't spawn child processes on Android (same limitation as
 * slash_worker_bridge), so while paired to the loopback host these run on
 * the computer only.
 */
function isCommandServer(srv: McpServer): boolean {
  return srv.transport === 'stdio' || !!srv.command
}

/**
 * App-icon-style letter tile — the catalog RPC carries no brand art (and the
 * app talks only to your machine, never to a favicon service), so each
 * service gets a stable hue from its name: same tile everywhere, every run.
 */
const TILE_COLORS = ['#E8720C', '#1FA7C4', '#10A37F', '#8B5CF6', '#DB2777', '#D97706', '#3B6FE0', '#0D9488', '#E23838', '#6D5AE0']

function tileColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return TILE_COLORS[h % TILE_COLORS.length]
}

function TileAvatar({ name, size = 48, installed }: { name: string; size?: number; installed?: boolean }) {
  const s = useStyles(makeS)
  const logo = MCP_LOGOS[name]
  const letter = name.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?'
  return (
    <View
      style={[s.tile, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: logo ? 'transparent' : tileColor(name) }]}
      accessibilityLabel={name}
    >
      {logo ? (
        // Favicons assume a light background — dark logos (Square, Vercel…)
        // vanish on the app's dark cards, so every logo sits on a white chip.
        <View style={[s.tileLogoChip, { width: size, height: size, borderRadius: size * 0.28 }]}>
          <Image source={logo} style={{ width: size * 0.78, height: size * 0.78 }} resizeMode="contain" />
        </View>
      ) : (
        <Text style={[s.tileText, { fontSize: size * 0.44 }]}>{letter}</Text>
      )}
      {installed ? (
        <View style={[s.tileCheck, { top: -4, right: -4 }]}>
          <Ionicons name="checkmark-circle" size={16} color={C.greenSoft} />
        </View>
      ) : null}
    </View>
  )
}

export default function Connectors() {
  const s = useStyles(makeS)
  const online = useStore(isConnectedAtom)
  const unsupported = useStore(mcpUnsupported)
  const servers = useStore(mcpServers)
  const runtime = useStore(mcpRuntime)
  const catalog = useStore(mcpCatalog)
  const loading = useStore(mcpLoading)
  const catLoading = useStore(catalogLoading)
  const listError = useStore(mcpListError)
  const connCfg = useStore(connConfig)
  /** Loopback pairing → the embedded gateway runs on this phone's machine. */
  const loopbackHost = !!connCfg?.host && connCfg.host.startsWith('127.0.0.1')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'yours' | 'browse'>('yours')
  const [open, setOpen] = useState<McpServer | null>(null)
  const [adding, setAdding] = useState(false)
  /** Post-install key prompt: the server name awaiting an API key. */
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // installing catalog entry name

  const refresh = useCallback(() => {
    if (!online) return
    void loadMcpServers()
    void loadMcpCatalog()
  }, [online])

  // Refresh on mount and whenever the gateway (re)connects — `online`
  // flips true on reconnect, so the effect below re-runs `refresh`.
  useEffect(() => { refresh() }, [refresh])

  // Live statuses: `mcp.servers.status` is cached-only, so poll it lightly
  // (one RPC) while the tab is VISIBLE — useFocusEffect, not useEffect:
  // expo-router tabs stay mounted after first visit (the BUG-055 premise),
  // so a mount-scoped interval would keep firing app-wide for the whole
  // session. Focus-scoped: starts on focus, torn down on blur/unmount.
  useFocusEffect(
    useCallback(() => {
      if (!online) return
      void refreshMcpRuntime()
      const id = setInterval(() => { void refreshMcpRuntime() }, 5_000)
      return () => clearInterval(id)
    }, [online]),
  )

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
  const offerReload = useCallback(async (what: string) => {
    const btn = await showAlert(what, 'Reload the agent now so the new tools are available? This restarts its MCP connections.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Reload', style: 'default' },
    ])
    if (btn.text !== 'Reload') return
    try {
      await reloadAgentMcp()
      void loadMcpServers()
    } catch (err) {
      void showAlert('Reload failed', err instanceof Error ? err.message : String(err))
    }
  }, [])

  const install = useCallback(async (name: string, requires: string[]) => {
    setBusy(name)
    try {
      await installCatalogServer(name)
      await loadMcpServers()
      void loadMcpCatalog()
      if (requires.length > 0) {
        void showAlert(`Installed ${name}`, `It needs an API key (${requires.join(', ')}) before it can connect.`)
        setKeyFor(name)
      } else {
        void offerReload(`Installed ${name}`)
      }
    } catch (err) {
      void showAlert('Install failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [offerReload])

  const onRemoved = useCallback((name: string) => {
    setOpen(null)
    void offerReload(`Removed ${name}`)
  }, [offerReload])

  if (unsupported) {
    return (
      <SafeAreaView style={s.safe} edges={['bottom']}>
        <ScreenShell title="Connectors" showBrand>
          <View style={s.center}>
            <Text style={s.emptyTitle}>Not available on this machine</Text>
            <Text style={s.emptyBody}>
              The connected Mochi doesn't expose connector management yet. Update Mochi on that
              machine, then reconnect.
            </Text>
          </View>
        </ScreenShell>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title="Connectors" showBrand>
        <View style={s.headRow}>
          <View style={s.searchWrap}>
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder={tab === 'yours' ? 'Filter your servers…' : 'Search the catalog…'}
              placeholderTextColor={C.textFaint}
              autoCorrect={false}
              accessibilityLabel="Filter"
            />
          </View>
          <Pressable style={({ pressed }) => [s.addBtn, pressed && s.pressed]} onPress={() => setAdding(true)} accessibilityLabel="Add server">
            <Text style={s.addBtnText}>＋ Add</Text>
          </Pressable>
        </View>

        <View style={s.tabs}>
          {(['yours', 'browse'] as const).map((t) => (
            <Pressable
              key={t}
              style={({ pressed }) => [s.tab, tab === t && s.tabOn, pressed && s.tabPressed]}
              onPress={() => setTab(t)}
              accessibilityRole="button"
            >
              <Text style={[s.tabText, tab === t && s.tabTextOn]}>
                {t === 'yours' ? `Yours (${servers.length})` : 'Browse'}
              </Text>
            </Pressable>
          ))}
        </View>

        {listError ? (
          <View style={s.errBanner}>
            <Ionicons name="alert-circle" size={16} color={C.amber} />
            <Text style={s.errBannerText} numberOfLines={2}>Couldn't load servers — {listError}</Text>
            <Pressable style={({ pressed }) => [pressed && s.pressed]} onPress={refresh} accessibilityLabel="Retry loading servers">
              <Text style={s.errRetry}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {tab === 'yours' ? (
          // Distinct keys: without them React reconciles the two lists into
          // one instance across the tab switch, and numColumns can't change
          // on the fly (RN throws).
          <FlatList
            key="yours"
            data={serverList}
            keyExtractor={(x) => x.name}
            keyboardShouldPersistTaps="handled"
            refreshing={loading && online}
            onRefresh={refresh}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32 }}
            ListEmptyComponent={
              <Text style={s.empty}>
                {loading || listError ? '' : online ? (query ? 'No matches' : 'No MCP servers yet — browse the catalog or add one') : 'Offline'}
              </Text>
            }
            renderItem={({ item }) => {
              const st = statusLine(item, runtime[item.name])
              const desktopOnly = loopbackHost && isCommandServer(item)
              return (
                <Pressable style={({ pressed }) => [s.row, pressed && s.rowPressed]} onPress={() => setOpen(item)} accessibilityLabel={item.name}>
                  <TileAvatar name={item.name} size={42} />
                  <View style={{ flex: 1 }}>
                    <View style={s.rowHead}>
                      <Text style={s.rowName} numberOfLines={1}>{item.name}</Text>
                      {desktopOnly ? (
                        <View style={s.amberBadge}><Text style={s.amberBadgeText}>Desktop only</Text></View>
                      ) : null}
                      <Text style={s.badge}>{item.transport}</Text>
                    </View>
                    <Text style={[s.rowDesc, { color: st.color }]} numberOfLines={2}>{st.text}</Text>
                    {item.url ? <Text style={s.rowSub} numberOfLines={1}>{item.url}</Text> : null}
                    {item.command ? <Text style={s.rowSub} numberOfLines={1}>{[item.command, ...(item.args ?? [])].join(' ')}</Text> : null}
                  </View>
                </Pressable>
              )
            }}
          />
        ) : (
          <FlatList
            key="browse"
            data={catalogList}
            keyExtractor={(x) => x.name}
            numColumns={2}
            columnWrapperStyle={{ gap: 10, paddingHorizontal: 8 }}
            contentContainerStyle={{ gap: 10, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
            refreshing={catLoading && online}
            onRefresh={refresh}
            ListEmptyComponent={<Text style={s.empty}>{catLoading ? '' : online ? (query ? 'No matches' : 'Catalog is empty') : 'Offline'}</Text>}
            renderItem={({ item }) => (
              <View style={s.gridCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <TileAvatar name={item.name} size={44} installed={item.installed} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName} numberOfLines={2}>{item.name}</Text>
                    {item.requires.length > 0 ? (
                      <Text style={s.keyChip} numberOfLines={1}>API key</Text>
                    ) : null}
                  </View>
                </View>
                <Pressable
                  style={({ pressed }) => [s.installBtn, item.installed && s.installOff, pressed && s.pressed]}
                  disabled={item.installed || busy === item.name}
                  onPress={() => void install(item.name, item.requires)}
                  accessibilityLabel={item.installed ? 'Installed' : `Install ${item.name}`}
                >
                  {busy === item.name ? (
                    <ActivityIndicator size="small" color={C.textDim} />
                  ) : (
                    <Text style={[s.installText, item.installed && { color: C.textFaint }]}>
                      {item.installed ? 'Installed' : 'Install'}
                    </Text>
                  )}
                </Pressable>
              </View>
            )}
          />
        )}
      </ScreenShell>

      <ServerSheet
        server={open}
        runtime={open ? runtime[open.name] : undefined}
        desktopOnly={loopbackHost && !!open && isCommandServer(open)}
        onClose={() => setOpen(null)}
        onChanged={() => { void loadMcpServers(); void loadMcpCatalog() }}
        onRemoved={onRemoved}
        onNeedKey={(name) => setKeyFor(name)}
      />

      <AddSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={async (name) => {
          setAdding(false)
          await loadMcpServers()
          void loadMcpCatalog()
          void offerReload(`Added ${name}`)
        }}
      />

      <KeySheet
        name={keyFor}
        onClose={() => setKeyFor(null)}
        onSaved={async (name) => {
          setKeyFor(null)
          await loadMcpServers()
          void offerReload(`${name} key saved`)
        }}
      />
    </SafeAreaView>
  )
}

// ── Server detail sheet ─────────────────────────────────────────────────────

function ServerSheet({
  server, runtime, desktopOnly, onClose, onChanged, onRemoved, onNeedKey,
}: {
  server: McpServer | null
  runtime?: { status?: string; tools?: number; connected?: boolean; error?: string }
  /** Loopback pairing + command transport — can't run on the phone. */
  desktopOnly?: boolean
  onClose: () => void
  onChanged: () => void
  onRemoved: (name: string) => void
  onNeedKey: (name: string) => void
}) {
  const s = useStyles(makeS)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [removing, setRemoving] = useState(false)
  /** In-app OAuth sign-in: waiting on the browser, failed, or timed out. */
  const [oauthFlow, setOauthFlow] = useState<{ phase: 'waiting' | 'error' | 'timeout'; message?: string } | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeSession = useRef<string | null>(null)
  /**
   * The server the active session belongs to, ref'd alongside it: when the
   * sheet CLOSES, `server` is already null, so reading `server?.name` in the
   * cleanup effect skipped the gateway-side cancel — the flow (and its
   * callback worker) hung until the server's own timeout. The ref still
   * knows the name.
   */
  const activeName = useRef<string | null>(null)

  const stopOauthPolling = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    activeSession.current = null
    activeName.current = null
  }, [])

  // Leaving the sheet (closing it OR switching servers) stops the poller and
  // cancels the gateway-side flow so its callback worker isn't left hanging.
  // Uses the ref'd name — `server` is null by the time a close lands here.
  useEffect(() => {
    const session = activeSession.current
    const name = activeName.current
    if (session && name) void cancelMcpOauth(name, session).catch(() => {})
    stopOauthPolling()
    setOauthFlow(null)
    setResult(null)
    return undefined
  }, [server?.name, stopOauthPolling])

  useEffect(
    () => () => {
      const session = activeSession.current
      const name = activeName.current
      if (session && name) void cancelMcpOauth(name, session).catch(() => {})
      stopOauthPolling()
    },
    [stopOauthPolling],
  )

  if (!server) return null
  const st = statusLine(server, runtime)

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
    // The embedded gateway's loopback callback is on the paired machine —
    // reachable from the phone's own browser, so open the URL there.
    void Linking.openURL(authUrl).catch(() => {})
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
            onChanged()
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
    const btn = await showAlert(`Remove ${server.name}?`, 'The machine forgets this server and its config entry. Secrets in .env are kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive' },
    ])
    if (btn.text !== 'Remove') return
    setRemoving(true)
    try {
      await removeMcpServer(server.name)
      onChanged()
      onRemoved(server.name)
    } catch (err) {
      void showAlert('Remove failed', err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  const oauthMissing = server.auth === 'oauth' && server.oauth_tokens_present === false

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetScrim} behavior="padding">
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        <View style={s.sheetCard}>
          <View style={s.sheetHead}>
            <TileAvatar name={server.name} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={s.sheetTitle} numberOfLines={1}>{server.name}</Text>
              <Text style={[s.rowDesc, { color: st.color }]}>{st.text}</Text>
            </View>
            <Text style={s.badge}>{server.transport}</Text>
          </View>

          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
            {server.url ? <Text style={s.cfgLine} numberOfLines={2}>{server.url}</Text> : null}
            {server.command ? (
              <Text style={s.cfgLine} numberOfLines={3}>{[server.command, ...(server.args ?? [])].join(' ')}</Text>
            ) : null}
            {server.auth === 'oauth' ? (
              <Text style={s.cfgLine}>OAuth{server.oauth_tokens_present ? ' · signed in' : ''}</Text>
            ) : null}
            {server.env && server.env.length > 0 ? (
              <Text style={s.cfgLine} numberOfLines={2}>env: {server.env.join(', ')}</Text>
            ) : null}

            {desktopOnly ? (
              <Text style={s.hint}>Command-based servers run on your computer, not on the phone.</Text>
            ) : null}

            {oauthMissing ? (
              oauthFlow ? (
                oauthFlow.phase === 'waiting' ? (
                  <View style={s.oauthRow}>
                    <ActivityIndicator size="small" color={C.textDim} />
                    <Text style={s.rowDesc}>Waiting for browser approval…</Text>
                    <Pressable style={({ pressed }) => [s.oauthCancel, pressed && s.pressed]} onPress={cancelSignIn} accessibilityLabel="Cancel sign-in">
                      <Text style={s.oauthCancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={s.oauthRow}>
                    <Ionicons name={oauthFlow.phase === 'timeout' ? 'time-outline' : 'alert-circle'} size={16} color={C.amber} />
                    <Text style={[s.rowDesc, { color: C.amber, flex: 1 }]} numberOfLines={3}>
                      {oauthFlow.message ?? 'Sign-in failed'}
                    </Text>
                    <Pressable style={({ pressed }) => [s.oauthCancel, pressed && s.pressed]} onPress={() => void startSignIn()} accessibilityLabel="Try again">
                      <Text style={s.oauthCancelText}>Try again</Text>
                    </Pressable>
                  </View>
                )
              ) : (
                <View style={s.oauthRow}>
                  <Text style={[s.hint, { flex: 1 }]}>This server uses OAuth. Sign in from your phone's browser.</Text>
                  <Pressable style={({ pressed }) => [s.signInBtn, pressed && s.pressed]} onPress={() => void startSignIn()} accessibilityLabel="Sign in">
                    <Text style={s.signInText}>Sign in</Text>
                  </Pressable>
                </View>
              )
            ) : null}

            {testing ? (
              <View style={s.testingRow}>
                <ActivityIndicator size="small" color={C.textDim} />
                <Text style={s.rowDesc}>Testing — can take a minute on a cold start…</Text>
              </View>
            ) : null}

            {result ? (
              <View style={s.testResult}>
                {result.ok ? (
                  <>
                    <Text style={[s.rowDesc, { color: C.greenSoft }]}>
                      Connected — {result.tools.length} tools{result.prompts ? `, ${result.prompts} prompts` : ''}{result.resources ? `, ${result.resources} resources` : ''}
                    </Text>
                    {result.tools.slice(0, 20).map((t) => (
                      <Text key={t.name} style={s.toolLine} numberOfLines={1}>
                        <Text style={s.toolName}>{t.name}</Text>
                        {t.description ? ` — ${t.description}` : ''}
                      </Text>
                    ))}
                    {result.tools.length > 20 ? (
                      <Text style={s.rowSub}>…and {result.tools.length - 20} more</Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={[s.rowDesc, { color: C.red }]}>Failed — {result.error}</Text>
                )}
              </View>
            ) : null}
          </ScrollView>

          <View style={s.sheetActions}>
            <Pressable style={({ pressed }) => [s.actBtn, pressed && s.pressed]} onPress={() => void runTest()} disabled={testing} accessibilityLabel="Test connection">
              <Text style={s.actText}>{testing ? 'Testing…' : 'Test'}</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [s.actBtn, pressed && s.pressed]} onPress={() => onNeedKey(server.name)} accessibilityLabel="Set API key">
              <Text style={s.actText}>API key</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [s.actBtn, s.actDanger, pressed && s.pressed]} onPress={() => void runRemove()} disabled={removing} accessibilityLabel="Remove server">
              <Text style={[s.actText, { color: C.red }]}>{removing ? 'Removing…' : 'Remove'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

// ── Add-custom sheet ────────────────────────────────────────────────────────

function AddSheet({
  open, onClose, onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: (name: string) => void | Promise<void>
}) {
  const s = useStyles(makeS)
  const [kind, setKind] = useState<'url' | 'command'>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [bearer, setBearer] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) setErr(null)
  }, [open])

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
      await onAdded(trimmed)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetScrim} behavior="padding">
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        <View style={s.sheetCard}>
          <Text style={s.sheetTitle}>Add a server</Text>

          <View style={s.tabs}>
            {(['url', 'command'] as const).map((k) => (
              <Pressable
                key={k}
                style={({ pressed }) => [s.tab, kind === k && s.tabOn, pressed && s.tabPressed]}
                onPress={() => setKind(k)}
                accessibilityRole="button"
              >
                <Text style={[s.tabText, kind === k && s.tabTextOn]}>{k === 'url' ? 'HTTP URL' : 'Command'}</Text>
              </Pressable>
            ))}
          </View>

          <ScrollView contentContainerStyle={{ gap: 8 }}>
            <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Name (e.g. deepwiki)" placeholderTextColor={C.textFaint} autoCapitalize="none" autoCorrect={false} />
            {kind === 'url' ? (
              <TextInput
                style={s.input} value={url} onChangeText={setUrl}
                placeholder="https://mcp.example.com/mcp" placeholderTextColor={C.textFaint}
                autoCapitalize="none" autoCorrect={false} keyboardType="url"
              />
            ) : (
              <TextInput
                style={s.input} value={command} onChangeText={setCommand}
                placeholder="npx -y @example/mcp-server" placeholderTextColor={C.textFaint}
                autoCapitalize="none" autoCorrect={false}
                multiline={false}
              />
            )}
            <TextInput
              style={s.input} value={bearer} onChangeText={setBearer}
              placeholder="Bearer token (optional)" placeholderTextColor={C.textFaint}
              autoCapitalize="none" autoCorrect={false} secureTextEntry
            />
            {kind === 'command' ? (
              <Text style={s.hint}>The machine must have the command available (node/npm for npx…).</Text>
            ) : null}
            {err ? <Text style={s.errText}>{err}</Text> : null}
          </ScrollView>

          <View style={s.sheetActions}>
            <Pressable style={({ pressed }) => [s.actBtn, pressed && s.pressed]} onPress={onClose} disabled={saving}>
              <Text style={[s.actText, { color: C.textDim }]}>Cancel</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [s.actBtn, s.actPrimary, pressed && s.pressed]} onPress={() => void submit()} disabled={saving} accessibilityLabel="Add server">
              <Text style={[s.actText, { color: C.onAccent }]}>{saving ? 'Adding…' : 'Add'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

// ── API-key sheet ───────────────────────────────────────────────────────────

function KeySheet({
  name, onClose, onSaved,
}: {
  name: string | null
  onClose: () => void
  onSaved: (name: string) => void | Promise<void>
}) {
  const s = useStyles(makeS)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (name) { setValue(''); setErr(null) } }, [name])

  if (!name) return null

  const submit = async () => {
    if (!value.trim()) {
      setErr('Paste the key first.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await saveMcpApiKey(name, value.trim())
      await onSaved(name)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetScrim} behavior="padding">
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        <View style={s.sheetCard}>
          <Text style={s.sheetTitle} numberOfLines={1}>API key — {name}</Text>
          <Text style={s.hint}>
            Saved to the machine's .env as a {'${'}MCP_{name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY{'}'} reference — it never leaves that machine.
          </Text>
          <TextInput
            style={s.input} value={value} onChangeText={setValue}
            placeholder="Paste the API key" placeholderTextColor={C.textFaint}
            autoCapitalize="none" autoCorrect={false} secureTextEntry
          />
          {err ? <Text style={s.errText}>{err}</Text> : null}
          <View style={s.sheetActions}>
            <Pressable style={({ pressed }) => [s.actBtn, pressed && s.pressed]} onPress={onClose} disabled={saving}>
              <Text style={[s.actText, { color: C.textDim }]}>Cancel</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [s.actBtn, s.actPrimary, pressed && s.pressed]} onPress={() => void submit()} disabled={saving} accessibilityLabel="Save key">
              <Text style={[s.actText, { color: C.onAccent }]}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  headRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  searchWrap: { flex: 1 },
  search: { backgroundColor: C.bgCard, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: C.text, fontSize: 15, minHeight: 44 },
  addBtn: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 14, height: 44, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: C.accent, fontSize: 14, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  tab: { paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: C.accent },
  tabPressed: { opacity: 0.6 },
  tabText: { color: C.textDim, fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: C.onAccent },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 11, borderRadius: 10, minHeight: 48 },
  rowPressed: { backgroundColor: C.bgCard },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { color: C.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  rowDesc: { color: C.textFaint, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  rowSub: { color: C.textFaint, fontSize: 11.5, marginTop: 1, opacity: 0.8 },
  badge: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase' },
  gridCard: {
    flex: 1, backgroundColor: C.bgCard, borderRadius: 16, borderWidth: 1, borderColor: C.borderSoft,
    padding: 12, gap: 10,
  },
  keyChip: { color: C.amber, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', marginTop: 2 },
  tile: { alignItems: 'center', justifyContent: 'center' },
  tileLogoChip: { backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  tileText: { color: '#FFFFFF', fontWeight: '800' },
  tileCheck: { position: 'absolute' },
  installBtn: { minHeight: 34, borderRadius: 17, paddingHorizontal: 12, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  installOff: { backgroundColor: C.bgCard },
  installText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  empty: { color: C.textFaint, textAlign: 'center', marginTop: 48, fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: C.textDim, fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
  pressed: { opacity: 0.55 },
  errBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, padding: 10,
    backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.borderSoft,
  },
  errBannerText: { color: C.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 },
  errRetry: { color: C.accent, fontSize: 13, fontWeight: '800' },
  amberBadge: {
    backgroundColor: C.amberSoft, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  amberBadgeText: { color: C.amber, fontSize: 10.5, fontWeight: '800', textTransform: 'uppercase' },
  oauthRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  signInBtn: {
    backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16,
    minHeight: 40, alignItems: 'center', justifyContent: 'center',
  },
  signInText: { color: C.onAccent, fontSize: 14, fontWeight: '800' },
  oauthCancel: { paddingHorizontal: 10, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  oauthCancelText: { color: C.accent, fontSize: 13, fontWeight: '700' },

  // sheets
  sheetScrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: C.scrim },
  sheetCard: {
    backgroundColor: C.bgElev, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderWidth: 1, borderColor: C.borderSoft, padding: 18, gap: 10, paddingBottom: 26,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sheetTitle: { color: C.text, fontSize: 17, fontWeight: '800' },
  cfgLine: { color: C.textDim, fontSize: 12.5, lineHeight: 17, fontFamily: undefined },
  hint: { color: C.textFaint, fontSize: 12.5, lineHeight: 17 },
  code: { color: C.accent, fontWeight: '600' },
  testingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  testResult: { gap: 4, paddingTop: 4 },
  toolLine: { color: C.textFaint, fontSize: 12, lineHeight: 16 },
  toolName: { color: C.textDim, fontWeight: '600' },
  sheetActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actBtn: {
    flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: C.bgCard,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.borderSoft,
  },
  actPrimary: { backgroundColor: C.accent, borderColor: 'transparent' },
  actDanger: { backgroundColor: C.redSoft },
  actText: { color: C.accent, fontSize: 14.5, fontWeight: '800' },
  input: {
    backgroundColor: C.bgCard, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    color: C.text, fontSize: 15, minHeight: 46, borderWidth: 1, borderColor: C.borderSoft,
  },
  errText: { color: C.red, fontSize: 13, lineHeight: 18 },
})
