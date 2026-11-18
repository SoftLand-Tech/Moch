import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { View, FlatList, StyleSheet, Pressable, Modal, ScrollView, Linking } from 'react-native'
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { MochiMark } from '../../src/components/MochiMark'
import { showAlert } from '../../src/components/AlertDialog'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { tr, useDir, useT } from '../../src/lib/strings'
import {
  Card,
  Dot,
  Elev,
  Field,
  GhostBtn,
  HeaderButton,
  Pill,
  PrimaryBtn,
  Segmented,
  SheetBackdrop,
  SheetCard,
  SheetGrabber,
  Spinner,
  Txt,
  type DotKind,
} from '../../src/components/ui'
import { connConfig, isConnected as isConnectedAtom } from '../../src/lib/gateway'
import {
  mcpServers, mcpRuntime, mcpCatalog, mcpUnsupported, mcpLoading, catalogLoading, mcpListError,
  loadMcpServers, loadMcpCatalog, refreshMcpRuntime, installCatalogServer, addCustomServer,
  removeMcpServer, testMcpServer, saveMcpApiKey, reloadAgentMcp,
  startMcpOauth, pollMcpOauth, cancelMcpOauth,
  type McpServer, type McpRuntime, type McpTestResult,
} from '../../src/lib/mcpState'

/**
 * Connectors — manage the agent's MCP servers from the phone. The gateway's
 * `mcp.*` RPCs are the same surface as `hermes mcp` on the machine, so
 * everything done here lands in that machine's config.yaml / .env — the app
 * holds no connector state of its own.
 *
 * Redesign pass (mockup screen 11): search + "+ Add" row, a Yours (n) |
 * Browse segmented switch, server cards with an accent letter tile, mono
 * transport badge, amber desktop-only pill and a colored status line;
 * a two-column browse grid with full-width Install buttons; and the server
 * detail / add / API-key bottom sheets rebuilt on the shared sheet kit.
 * Every behavior is unchanged: refresh-on-focus + 5s runtime poll, the
 * deduped refresh, OAuth sign-in/poll/cancel, API-key save, tool tester,
 * remove confirm, custom-server form, desktop-only flags, the offline and
 * unsupported states, and the BUG-133 keyboard-avoidance patterns (kbPad on
 * the lists, RNKC KeyboardAvoidingView as every sheet Modal's full-screen
 * root).
 */

// ── Status line ─────────────────────────────────────────────────────────────

type StatusInfo = { key: string; vars?: Record<string, string | number>; color: string; dot: DotKind }

/**
 * Running-state line under a server name — from cached runtime, never a probe.
 * Returns a translation key (+ vars) so the caller translates at render time.
 */
function statusOf(
  srv: McpServer,
  rt?: { status?: string; error?: string; tools?: number },
): StatusInfo {
  if (srv.auth === 'oauth' && srv.oauth_tokens_present === false) {
    return { key: 'connectors.status.oauthNeeded', color: C.amber, dot: 'amber' }
  }
  if (!srv.enabled) return { key: 'connectors.status.disabled', color: C.textFaint, dot: 'idle' }
  switch (rt?.status) {
    case 'connected':
      return rt.tools
        ? { key: 'connectors.status.connectedTools', vars: { n: rt.tools }, color: C.greenSoft, dot: 'green' }
        : { key: 'connectors.status.connected', color: C.greenSoft, dot: 'green' }
    case 'connecting':
      return { key: 'connectors.status.connecting', color: C.textFaint, dot: 'idle' }
    case 'failed':
      return rt.error
        ? { key: 'connectors.status.failedWhy', vars: { why: rt.error }, color: C.red, dot: 'red' }
        : { key: 'connectors.status.failed', color: C.red, dot: 'red' }
    // Registered but not spawned: the process starts on first use.
    case 'lazy':
      return rt.tools
        ? { key: 'connectors.status.lazyTools', vars: { n: rt.tools }, color: C.textDim, dot: 'idle' }
        : { key: 'connectors.status.lazy', color: C.textDim, dot: 'idle' }
    default:
      return { key: 'connectors.status.notRunning', color: C.textFaint, dot: 'idle' }
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

// ── Brand-less letter tile (mockup: accentSoft square, accent ink) ──────────

function LetterTile({ name, size }: { name: string; size: number }) {
  const s = useStyles(makeS)
  const letter = name.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?'
  return (
    <View
      style={[s.tile, { width: size, height: size, borderRadius: size >= 36 ? 10 : 8 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Txt size={size * 0.42} weight="800" color={C.accent}>
        {letter}
      </Txt>
    </View>
  )
}

// ── Form error (validation key, or a raw RPC message) ──────────────────────

type FormError = { key: string } | { text: string }

function errText(err: FormError, t: (key: string) => string): string {
  return 'key' in err ? t(err.key) : err.text
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function Connectors() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  // BUG-133: chat-pad pattern on the LISTS only — the filter field stays
  // top-anchored while the results viewport ends at the keyboard's top edge.
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
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

  // BUG-118: mcpState has no fetch dedup, so collapse concurrent refresh()
  // callers (mount effect, focus effect, pull-to-refresh, error Retry) into
  // one in-flight pass instead of stacking duplicate catalog/server fetches.
  const refreshingRef = useRef(false)
  const refresh = useCallback(() => {
    if (!online || refreshingRef.current) return
    refreshingRef.current = true
    void (async () => {
      try {
        await Promise.all([loadMcpServers(), loadMcpCatalog()])
      } finally {
        refreshingRef.current = false
      }
    })()
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
      // BUG-118: tabs stay mounted (BUG-055), so the mount effect above never
      // re-runs after the first visit — refetch catalog + servers on every
      // focus too, or the screen shows stale state on return. The in-flight
      // guard in `refresh` collapses the double call on the first focus.
      refresh()
      void refreshMcpRuntime()
      const id = setInterval(() => { void refreshMcpRuntime() }, 5_000)
      return () => clearInterval(id)
    }, [online, refresh]),
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
    const reloadLabel = tr('connectors.alert.reload.reload')
    const btn = await showAlert(what, tr('connectors.alert.reload.body'), [
      { text: tr('connectors.alert.reload.notNow'), style: 'cancel' },
      { text: reloadLabel, style: 'default' },
    ])
    if (btn.text !== reloadLabel) return
    try {
      await reloadAgentMcp()
      void loadMcpServers()
    } catch (err) {
      void showAlert(tr('connectors.alert.reloadFailed'), err instanceof Error ? err.message : String(err))
    }
  }, [])

  const install = useCallback(async (name: string, requires: string[]) => {
    setBusy(name)
    try {
      await installCatalogServer(name)
      await loadMcpServers()
      void loadMcpCatalog()
      if (requires.length > 0) {
        void showAlert(
          tr('connectors.alert.installed', { name }),
          tr('connectors.alert.installedNeedsKey', { keys: requires.join(', ') }),
        )
        setKeyFor(name)
      } else {
        void offerReload(tr('connectors.alert.installed', { name }))
      }
    } catch (err) {
      void showAlert(tr('connectors.alert.installFailed'), err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [offerReload])

  const onRemoved = useCallback((name: string) => {
    setOpen(null)
    void offerReload(tr('connectors.alert.removed', { name }))
  }, [offerReload])

  if (unsupported) {
    return (
      <SafeAreaView style={s.safe} edges={['bottom']}>
        <ScreenShell title={t('connectors.title')} showBrand>
          <View style={s.unsupported}>
            <MochiMark size={64} mood="sleepy" />
            <Txt size={16} weight="700" center style={s.unsupportedTitle}>
              {t('connectors.unsupported.title')}
            </Txt>
            <Txt size={13.5} color={C.textDim} center style={s.unsupportedBody}>
              {t('connectors.unsupported.body')}
            </Txt>
          </View>
        </ScreenShell>
      </SafeAreaView>
    )
  }

  const emptyYours = loading || listError
    ? null
    : online
      ? query
        ? <Txt size={13} color={C.textFaint} center style={s.emptyText}>{t('connectors.empty.noMatches')}</Txt>
        : (
          <View style={s.emptyState}>
            <MochiMark size={56} />
            <Txt size={13} color={C.textFaint} center>{t('connectors.empty.noServers')}</Txt>
          </View>
        )
      : <Txt size={13} color={C.textFaint} center style={s.emptyText}>{t('common.offline')}</Txt>

  const emptyBrowse = catLoading
    ? null
    : online
      ? query
        ? <Txt size={13} color={C.textFaint} center style={s.emptyText}>{t('connectors.empty.noMatches')}</Txt>
        : <Txt size={13} color={C.textFaint} center style={s.emptyText}>{t('connectors.empty.browse')}</Txt>
      : <Txt size={13} color={C.textFaint} center style={s.emptyText}>{t('common.offline')}</Txt>

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title={t('connectors.title')} showBrand>
        {/* Search + Add (mockup: 14px gutter, 6px gap, compact primary) */}
        <View style={[s.searchRow, { flexDirection: dir.row }]}>
          <Field
            value={query}
            onChangeText={setQuery}
            placeholder={t('connectors.searchPlaceholder')}
            autoCorrect={false}
            accessibilityLabel={t('common.filter')}
            wrapStyle={s.searchWrap}
          />
          <PrimaryBtn
            onPress={() => setAdding(true)}
            accessibilityLabel={t('connectors.addA11y')}
            style={s.addBtn}
          >
            <Txt size={13} weight="700" color={C.onAccent}>{`+ ${t('common.add')}`}</Txt>
          </PrimaryBtn>
        </View>

        {/* Yours (n) | Browse */}
        <Segmented
          options={[
            { key: 'yours', label: t('connectors.tab.yours', { n: servers.length }) },
            { key: 'browse', label: t('connectors.tab.browse') },
          ]}
          value={tab}
          onChange={setTab}
          style={s.segmented}
        />

        {listError ? (
          <Elev style={[s.errBanner, { flexDirection: dir.row }]}>
            <Icon name="alert-circle" size={14} color={C.amber} />
            <Txt size={12.5} color={C.textDim} numberOfLines={2} style={s.errBannerText}>
              {t('connectors.error.load', { why: listError })}
            </Txt>
            <Pressable
              onPress={refresh}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('connectors.error.retryA11y')}
            >
              <Txt size={13} weight="800" color={C.accent}>{t('common.retry')}</Txt>
            </Pressable>
          </Elev>
        ) : null}

        {tab === 'yours' ? (
          // Distinct keys: without them React reconciles the two lists into
          // one instance across the tab switch, and numColumns can't change
          // on the fly (RN throws).
          <Animated.View style={[s.kbListWrap, kbPad]}>
            <FlatList
              key="yours"
              data={serverList}
              keyExtractor={(x) => x.name}
              keyboardShouldPersistTaps="handled"
              refreshing={loading && online}
              onRefresh={refresh}
              contentContainerStyle={s.listContent}
              ListEmptyComponent={emptyYours}
              renderItem={({ item }) => {
                const st = statusOf(item, runtime[item.name])
                const desktopOnly = loopbackHost && isCommandServer(item)
                return (
                  <Card
                    style={s.serverCard}
                    onPress={() => setOpen(item)}
                    accessibilityLabel={item.name}
                  >
                    <View style={[s.serverRow, { flexDirection: dir.row }]}>
                      <LetterTile name={item.name} size={36} />
                      <View style={s.serverBody}>
                        <View style={[s.serverHead, { flexDirection: dir.row }]}>
                          <Txt size={13} weight="700" numberOfLines={1} style={s.serverName}>
                            {item.name}
                          </Txt>
                          <View style={s.transportBadge}>
                            <Txt size={9.5} mono color={C.textDim}>
                              {item.transport.toUpperCase()}
                            </Txt>
                          </View>
                          {desktopOnly ? (
                            <Pill kind="amber" style={s.desktopPill} textStyle={s.desktopPillText}>
                              {t('connectors.desktopOnly')}
                            </Pill>
                          ) : null}
                        </View>
                        <Txt size={11} weight="600" color={st.color} numberOfLines={2} style={s.serverStatus}>
                          {t(st.key, st.vars)}
                        </Txt>
                        {item.url ? (
                          <Txt size={10} mono ltr color={C.textFaint} numberOfLines={1}>
                            {item.url}
                          </Txt>
                        ) : null}
                        {item.command ? (
                          <Txt size={10} mono ltr color={C.textFaint} numberOfLines={1}>
                            {[item.command, ...(item.args ?? [])].join(' ')}
                          </Txt>
                        ) : null}
                      </View>
                    </View>
                  </Card>
                )
              }}
            />
          </Animated.View>
        ) : (
          <Animated.View style={[s.kbListWrap, kbPad]}>
            <FlatList
              key="browse"
              data={catalogList}
              keyExtractor={(x) => x.name}
              numColumns={2}
              columnWrapperStyle={s.gridRow}
              contentContainerStyle={s.gridContent}
              keyboardShouldPersistTaps="handled"
              refreshing={catLoading && online}
              onRefresh={refresh}
              ListEmptyComponent={emptyBrowse}
              renderItem={({ item }) => (
                <Card style={s.gridCard}>
                  <View style={[s.gridTop, { flexDirection: dir.row }]}>
                    <LetterTile name={item.name} size={30} />
                    {item.requires.length > 0 ? (
                      <Txt size={9.5} mono color={C.textFaint} numberOfLines={1}>
                        {t('connectors.apiKeyTag')}
                      </Txt>
                    ) : null}
                  </View>
                  <Txt size={13} weight="700" numberOfLines={2}>{item.name}</Txt>
                  {item.installed ? (
                    <GhostBtn
                      label={t('connectors.browse.installed')}
                      disabled
                      style={[s.installBtn, s.installedBtn]}
                      textStyle={s.installBtnText}
                      accessibilityLabel={t('connectors.browse.installed')}
                    />
                  ) : (
                    <PrimaryBtn
                      onPress={() => void install(item.name, item.requires)}
                      disabled={busy === item.name}
                      style={s.installBtn}
                      accessibilityLabel={t('connectors.browse.installA11y', { name: item.name })}
                    >
                      {busy === item.name ? (
                        <Spinner size="small" color={C.onAccent} />
                      ) : (
                        <Txt size={11} weight="700" color={C.onAccent}>{t('common.install')}</Txt>
                      )}
                    </PrimaryBtn>
                  )}
                </Card>
              )}
            />
          </Animated.View>
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
          void offerReload(tr('connectors.alert.added', { name }))
        }}
      />

      <KeySheet
        name={keyFor}
        onClose={() => setKeyFor(null)}
        onSaved={async (name) => {
          setKeyFor(null)
          await loadMcpServers()
          void offerReload(tr('connectors.alert.keySaved', { name }))
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
  runtime?: McpRuntime
  /** Loopback pairing + command transport — can't run on the phone. */
  desktopOnly?: boolean
  onClose: () => void
  onChanged: () => void
  onRemoved: (name: string) => void
  onNeedKey: (name: string) => void
}) {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
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
  const st = statusOf(server, runtime)
  // Mockup detail status: "● Connected · N tools exposed".
  const statusText =
    (st.key === 'connectors.status.connected' || st.key === 'connectors.status.connectedTools') && (runtime?.tools ?? 0) > 0
      ? t('connectors.status.exposed', { n: runtime?.tools ?? 0 })
      : t(st.key, st.vars)

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
        setOauthFlow({ phase: 'timeout' })
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
            setOauthFlow({ phase: 'error', message: status.error })
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
    const removeLabel = tr('common.remove')
    const btn = await showAlert(
      tr('connectors.remove.title', { name: server.name }),
      tr('connectors.remove.body'),
      [
        { text: tr('common.cancel'), style: 'cancel' },
        { text: removeLabel, style: 'destructive' },
      ],
    )
    if (btn.text !== removeLabel) return
    setRemoving(true)
    try {
      await removeMcpServer(server.name)
      onChanged()
      onRemoved(server.name)
    } catch (err) {
      void showAlert(tr('connectors.alert.removeFailed'), err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  const oauthMissing = server.auth === 'oauth' && server.oauth_tokens_present === false
  let testLine = ''
  if (result?.ok) {
    testLine = t('connectors.detail.testOk', { n: result.tools.length })
    if (result.prompts) testLine += t('connectors.detail.testPrompts', { n: result.prompts })
    if (result.resources) testLine += t('connectors.detail.testResources', { n: result.resources })
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetRoot} behavior="padding">
        <SheetBackdrop onPress={onClose} />
        <SheetCard style={s.sheetCard}>
          <SheetGrabber />
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <LetterTile name={server.name} size={36} />
            <View style={s.sheetHeadBody}>
              <View style={[s.sheetTitleRow, { flexDirection: dir.row }]}>
                <Txt size={13.5} weight="800" numberOfLines={1} style={s.sheetTitleText}>{server.name}</Txt>
                <View style={s.transportBadge}>
                  <Txt size={9} mono color={C.textDim}>{server.transport.toUpperCase()}</Txt>
                </View>
              </View>
              <View style={[s.detailStatusRow, { flexDirection: dir.row }]}>
                <Dot kind={st.dot} size={7} />
                <Txt size={11.5} weight="600" color={st.color} numberOfLines={1} style={s.detailStatusText}>
                  {statusText}
                </Txt>
              </View>
            </View>
            <HeaderButton style={s.sheetClose} onPress={onClose} accessibilityLabel={t('common.close')}>
              <Icon name="close" size={13} color={C.textDim} />
            </HeaderButton>
          </View>

          <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetScrollBody} keyboardShouldPersistTaps="handled">
            {server.url ? (
              <Txt size={12.5} mono ltr color={C.textDim} numberOfLines={2}>{server.url}</Txt>
            ) : null}
            {server.command ? (
              <Txt size={12.5} mono ltr color={C.textDim} numberOfLines={3}>
                {[server.command, ...(server.args ?? [])].join(' ')}
              </Txt>
            ) : null}
            {server.auth === 'oauth' ? (
              <Txt size={12.5} color={C.textDim}>
                {server.oauth_tokens_present ? t('connectors.oauth.labelSignedIn') : t('connectors.oauth.label')}
              </Txt>
            ) : null}
            {server.env && server.env.length > 0 ? (
              <Txt size={12.5} color={C.textDim} numberOfLines={2}>
                {t('connectors.detail.env', { keys: server.env.join(', ') })}
              </Txt>
            ) : null}

            {desktopOnly ? (
              <Txt size={12.5} color={C.textFaint}>{t('connectors.detail.desktopHint')}</Txt>
            ) : null}

            {oauthMissing ? (
              oauthFlow ? (
                oauthFlow.phase === 'waiting' ? (
                  <View style={[s.oauthRow, { flexDirection: dir.row }]}>
                    <Spinner size="small" color={C.textDim} />
                    <Txt size={12.5} color={C.textDim} style={s.oauthMsg}>{t('connectors.oauth.waiting')}</Txt>
                    <Pressable
                      onPress={cancelSignIn}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('connectors.oauth.cancelA11y')}
                    >
                      <Txt size={12.5} weight="700" color={C.accent}>{t('common.cancel')}</Txt>
                    </Pressable>
                  </View>
                ) : (
                  <View style={[s.oauthRow, { flexDirection: dir.row }]}>
                    <Icon name={oauthFlow.phase === 'timeout' ? 'time-outline' : 'alert-circle'} size={14} color={C.amber} />
                    <Txt size={12.5} color={C.amber} numberOfLines={3} style={s.oauthMsg}>
                      {oauthFlow.message
                        ? oauthFlow.message
                        : oauthFlow.phase === 'timeout'
                          ? t('connectors.oauth.timeout')
                          : t('connectors.oauth.failed')}
                    </Txt>
                    <Pressable
                      onPress={() => void startSignIn()}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('connectors.oauth.tryAgain')}
                    >
                      <Txt size={12.5} weight="700" color={C.accent}>{t('connectors.oauth.tryAgain')}</Txt>
                    </Pressable>
                  </View>
                )
              ) : (
                <View style={[s.oauthRow, { flexDirection: dir.row }]}>
                  <Txt size={12.5} color={C.textFaint} style={s.oauthMsg}>{t('connectors.oauth.hint')}</Txt>
                  <PrimaryBtn
                    onPress={() => void startSignIn()}
                    small
                    accessibilityLabel={t('connectors.oauth.signIn')}
                    textStyle={s.sheetBtnText}
                  >
                    <Txt size={11.5} weight="700" color={C.onAccent}>{t('connectors.oauth.signIn')}</Txt>
                  </PrimaryBtn>
                </View>
              )
            ) : null}

            {testing ? (
              <View style={[s.oauthRow, { flexDirection: dir.row }]}>
                <Spinner size="small" color={C.textDim} />
                <Txt size={12.5} color={C.textDim} style={s.oauthMsg}>{t('connectors.detail.testProgress')}</Txt>
              </View>
            ) : null}

            {result ? (
              <View style={s.testResult}>
                {result.ok ? (
                  <>
                    <Txt size={12.5} color={C.greenSoft}>{testLine}</Txt>
                    {result.tools.slice(0, 20).map((tool) => (
                      <Txt key={tool.name} size={12} color={C.textFaint} numberOfLines={1}>
                        <Txt size={12} weight="600" color={C.textDim}>{tool.name}</Txt>
                        {tool.description ? ` — ${tool.description}` : ''}
                      </Txt>
                    ))}
                    {result.tools.length > 20 ? (
                      <Txt size={11.5} color={C.textFaint}>
                        {t('connectors.detail.moreTools', { n: result.tools.length - 20 })}
                      </Txt>
                    ) : null}
                  </>
                ) : (
                  <Txt size={12.5} color={C.red}>
                    {t('connectors.detail.testFailed', { why: result.error ?? '' })}
                  </Txt>
                )}
              </View>
            ) : null}
          </ScrollView>

          <View style={[s.sheetActions, { flexDirection: dir.row }]}>
            <PrimaryBtn
              onPress={() => void runTest()}
              disabled={testing}
              style={s.actionPrimary}
              accessibilityLabel={t('connectors.detail.testA11y')}
            >
              <Txt size={11.5} weight="700" color={C.onAccent} numberOfLines={1}>
                {testing ? t('connectors.detail.testing') : t('connectors.detail.test')}
              </Txt>
            </PrimaryBtn>
            <GhostBtn
              onPress={() => onNeedKey(server.name)}
              small
              style={s.actionGhost}
              accessibilityLabel={t('connectors.detail.apiKeyA11y')}
            >
              <Txt size={11.5} weight="600" color={C.text} numberOfLines={1}>{t('connectors.apiKeyTag')}</Txt>
            </GhostBtn>
            <GhostBtn
              onPress={() => void runRemove()}
              disabled={removing}
              small
              style={s.actionGhost}
              accessibilityLabel={t('connectors.detail.removeA11y')}
            >
              <Txt size={11.5} weight="600" color={C.red} numberOfLines={1}>
                {removing ? t('connectors.detail.removing') : t('common.remove')}
              </Txt>
            </GhostBtn>
          </View>
        </SheetCard>
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
  const t = useT()
  const dir = useDir()
  const [kind, setKind] = useState<'url' | 'command'>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [bearer, setBearer] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<FormError | null>(null)

  useEffect(() => {
    if (open) setErr(null)
  }, [open])

  const submit = async () => {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(trimmed)) {
      setErr({ key: 'connectors.add.errName' })
      return
    }
    if (kind === 'url' && !/^https?:\/\//i.test(url.trim())) {
      setErr({ key: 'connectors.add.errUrl' })
      return
    }
    if (kind === 'command' && !command.trim()) {
      setErr({ key: 'connectors.add.errCommand' })
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
      setErr({ text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetRoot} behavior="padding">
        <SheetBackdrop onPress={onClose} />
        <SheetCard style={s.sheetCard}>
          <SheetGrabber />
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <Txt size={13.5} weight="800" style={s.sheetTitleFlex}>{t('connectors.add.title')}</Txt>
            <HeaderButton style={s.sheetClose} onPress={onClose} accessibilityLabel={t('common.close')}>
              <Icon name="close" size={13} color={C.textDim} />
            </HeaderButton>
          </View>

          <Segmented
            options={[
              { key: 'url', label: t('connectors.add.kindUrl') },
              { key: 'command', label: t('connectors.add.kindCommand') },
            ]}
            value={kind}
            onChange={setKind}
          />

          <ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled">
            <Field
              value={name}
              onChangeText={setName}
              placeholder={t('connectors.add.namePlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t('connectors.field.nameA11y')}
            />
            {kind === 'url' ? (
              <Field
                value={url}
                onChangeText={setUrl}
                placeholder={t('connectors.add.urlPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel={t('connectors.field.urlA11y')}
              />
            ) : (
              <Field
                value={command}
                onChangeText={setCommand}
                placeholder={t('connectors.add.commandPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('connectors.field.commandA11y')}
              />
            )}
            <Field
              value={bearer}
              onChangeText={setBearer}
              placeholder={t('connectors.add.bearerPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel={t('connectors.field.bearerA11y')}
            />
            {kind === 'command' ? (
              <Txt size={12.5} color={C.textFaint} style={s.hint}>{t('connectors.add.commandHint')}</Txt>
            ) : null}
            {err ? <Txt size={13} color={C.red} style={s.hint}>{errText(err, t)}</Txt> : null}
          </ScrollView>

          <View style={[s.sheetActions, { flexDirection: dir.row }]}>
            <GhostBtn
              label={t('common.cancel')}
              onPress={onClose}
              disabled={saving}
              style={s.formBtn}
            />
            <PrimaryBtn
              onPress={() => void submit()}
              disabled={saving}
              style={s.formBtn}
              accessibilityLabel={t('connectors.addA11y')}
            >
              <Txt size={13} weight="700" color={C.onAccent}>
                {saving ? t('connectors.add.adding') : t('common.add')}
              </Txt>
            </PrimaryBtn>
          </View>
        </SheetCard>
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
  const t = useT()
  const dir = useDir()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<FormError | null>(null)

  useEffect(() => { if (name) { setValue(''); setErr(null) } }, [name])

  if (!name) return null

  // `${MCP_<NAME>_API_KEY}` — the .env KEY reference, not a secret value.
  const envRef = `\${MCP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY}`

  const submit = async () => {
    if (!value.trim()) {
      setErr({ key: 'connectors.key.errEmpty' })
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await saveMcpApiKey(name, value.trim())
      await onSaved(name)
    } catch (e) {
      setErr({ text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.sheetRoot} behavior="padding">
        <SheetBackdrop onPress={onClose} />
        <SheetCard style={s.sheetCard}>
          <SheetGrabber />
          <View style={[s.sheetHead, { flexDirection: dir.row }]}>
            <Txt size={13.5} weight="800" numberOfLines={1} style={s.sheetTitleFlex}>
              {t('connectors.key.title', { name })}
            </Txt>
            <HeaderButton style={s.sheetClose} onPress={onClose} accessibilityLabel={t('common.close')}>
              <Icon name="close" size={13} color={C.textDim} />
            </HeaderButton>
          </View>
          <Txt size={12.5} color={C.textFaint} style={s.hint}>
            {t('connectors.key.hintPre')}
            <Txt size={12.5} mono ltr color={C.textFaint}>{envRef}</Txt>
            {t('connectors.key.hintPost')}
          </Txt>
          <Field
            value={value}
            onChangeText={setValue}
            placeholder={t('connectors.key.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel={t('connectors.key.fieldA11y')}
          />
          {err ? <Txt size={13} color={C.red} style={s.hint}>{errText(err, t)}</Txt> : null}
          <View style={[s.sheetActions, { flexDirection: dir.row }]}>
            <GhostBtn
              label={t('common.cancel')}
              onPress={onClose}
              disabled={saving}
              style={s.formBtn}
            />
            <PrimaryBtn
              onPress={() => void submit()}
              disabled={saving}
              style={s.formBtn}
              accessibilityLabel={t('common.save')}
            >
              <Txt size={13} weight="700" color={C.onAccent}>
                {saving ? t('connectors.key.saving') : t('common.save')}
              </Txt>
            </PrimaryBtn>
          </View>
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  )
}

// ── Styles ──────────────────────────────────────────────────────────────────

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  kbListWrap: { flex: 1 },

  // Search + "+ Add" (mockup: flex row, gap 6, margin-bottom 8)
  searchRow: { alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingTop: 10, marginBottom: 8 },
  searchWrap: { flex: 1 },
  addBtn: { paddingHorizontal: 12, paddingVertical: 0, height: 36, flexShrink: 0 },

  // Yours (n) | Browse segmented
  segmented: { marginHorizontal: 14, marginBottom: 10 },

  // Lists
  listContent: { paddingHorizontal: 14, paddingBottom: 18 },
  gridContent: { paddingHorizontal: 14, paddingBottom: 18, gap: 8 },
  gridRow: { gap: 8 },

  // Server cards (mockup: m-card row, 36px tile, gap 10)
  serverCard: { padding: 12 },
  serverRow: { alignItems: 'center', gap: 10 },
  serverBody: { flex: 1, minWidth: 0 },
  serverHead: { alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  serverName: { flexShrink: 1 },
  serverStatus: { marginTop: 2 },
  transportBadge: {
    paddingVertical: 1,
    paddingHorizontal: 5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgElev,
  },
  desktopPill: { paddingVertical: 1, paddingHorizontal: 5 },
  desktopPillText: { fontSize: 9 },

  // Browse grid cards (mockup: m-card column, gap 8, full-width CTA)
  gridCard: { flex: 1, marginBottom: 0, gap: 8, justifyContent: 'space-between' },
  gridTop: { alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  installBtn: { width: '100%', minHeight: 30, paddingVertical: 5, paddingHorizontal: 5 },
  installedBtn: { opacity: 0.8 },
  installBtnText: { fontSize: 11 },

  // Letter tile (accentSoft square, accent ink — the mockup's brand-less tile)
  tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft, flexShrink: 0 },

  // Empty / centered states
  emptyText: { marginTop: 48 },
  emptyState: { alignItems: 'center', marginTop: 40, gap: 10, paddingHorizontal: 24 },
  unsupported: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  unsupportedTitle: { marginTop: 8 },
  unsupportedBody: { marginTop: 2 },

  // Error banner
  errBanner: { alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 8, padding: 10 },
  errBannerText: { flex: 1 },

  pressed: { opacity: 0.55 },

  // Sheets
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetCard: { gap: 10 },
  sheetHead: { alignItems: 'center', gap: 10 },
  sheetHeadBody: { flex: 1, minWidth: 0 },
  sheetTitleRow: { alignItems: 'center', gap: 5 },
  sheetTitleText: { flexShrink: 1 },
  sheetTitleFlex: { flex: 1 },
  sheetClose: { width: 26, height: 26, borderRadius: 8, flexShrink: 0 },
  detailStatusRow: { alignItems: 'center', gap: 4, marginTop: 2 },
  detailStatusText: { flexShrink: 1 },
  sheetScroll: { maxHeight: 320, flexGrow: 0 },
  sheetScrollBody: { gap: 6 },
  hint: { lineHeight: 17 },
  oauthRow: { alignItems: 'center', gap: 8 },
  oauthMsg: { flex: 1 },
  testResult: { gap: 4, paddingTop: 4 },
  sheetActions: { gap: 8, marginTop: 6 },
  actionPrimary: { flex: 1, minHeight: 36, paddingVertical: 6, paddingHorizontal: 10 },
  actionGhost: { minHeight: 36, paddingVertical: 6, paddingHorizontal: 10, flexShrink: 0 },
  sheetBtnText: { fontSize: 11.5 },
  formBody: { gap: 8 },
  formBtn: { flex: 1, minHeight: 40 },
})
