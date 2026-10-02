import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator, Modal, ScrollView } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { C, useStyles } from '../../src/lib/theme'
import { isConnected as isConnectedAtom } from '../../src/lib/gateway'
import {
  mcpServers, mcpRuntime, mcpCatalog, mcpUnsupported, mcpLoading, catalogLoading,
  loadMcpServers, loadMcpCatalog, installCatalogServer, addCustomServer,
  removeMcpServer, testMcpServer, saveMcpApiKey, reloadAgentMcp,
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
    return { text: 'needs sign-in on the computer', color: C.amber }
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

export default function Connectors() {
  const s = useStyles(makeS)
  const online = useStore(isConnectedAtom)
  const unsupported = useStore(mcpUnsupported)
  const servers = useStore(mcpServers)
  const runtime = useStore(mcpRuntime)
  const catalog = useStore(mcpCatalog)
  const loading = useStore(mcpLoading)
  const catLoading = useStore(catalogLoading)
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

  useEffect(() => { refresh() }, [refresh])

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
              The connected hermes doesn't expose connector management yet. Update hermes on that
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

        {tab === 'yours' ? (
          <FlatList
            data={serverList}
            keyExtractor={(x) => x.name}
            keyboardShouldPersistTaps="handled"
            refreshing={loading && online}
            onRefresh={refresh}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32 }}
            ListEmptyComponent={
              <Text style={s.empty}>
                {loading ? '' : online ? (query ? 'No matches' : 'No MCP servers yet — browse the catalog or add one') : 'Offline'}
              </Text>
            }
            renderItem={({ item }) => {
              const st = statusLine(item, runtime[item.name])
              return (
                <Pressable style={({ pressed }) => [s.row, pressed && s.rowPressed]} onPress={() => setOpen(item)} accessibilityLabel={item.name}>
                  <View style={s.rowHead}>
                    <Text style={s.rowName} numberOfLines={1}>{item.name}</Text>
                    <Text style={s.badge}>{item.transport}</Text>
                  </View>
                  <Text style={[s.rowDesc, { color: st.color }]} numberOfLines={2}>{st.text}</Text>
                  {item.url ? <Text style={s.rowSub} numberOfLines={1}>{item.url}</Text> : null}
                  {item.command ? <Text style={s.rowSub} numberOfLines={1}>{[item.command, ...(item.args ?? [])].join(' ')}</Text> : null}
                </Pressable>
              )
            }}
          />
        ) : (
          <FlatList
            data={catalogList}
            keyExtractor={(x) => x.name}
            keyboardShouldPersistTaps="handled"
            refreshing={catLoading && online}
            onRefresh={refresh}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32 }}
            ListEmptyComponent={<Text style={s.empty}>{catLoading ? '' : online ? (query ? 'No matches' : 'Catalog is empty') : 'Offline'}</Text>}
            renderItem={({ item }) => (
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <View style={s.rowHead}>
                    <Text style={s.rowName} numberOfLines={1}>{item.name}</Text>
                    <Text style={s.badge}>{item.transport || 'stdio'}</Text>
                  </View>
                  {item.description ? <Text style={s.rowDesc} numberOfLines={2}>{item.description}</Text> : null}
                  {item.requires.length > 0 ? (
                    <Text style={s.rowSub} numberOfLines={1}>needs key: {item.requires.join(', ')}</Text>
                  ) : null}
                </View>
                <Pressable
                  style={({ pressed }) => [s.installBtn, (item.installed || busy === item.name) && s.installOff, pressed && s.pressed]}
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
  server, runtime, onClose, onChanged, onRemoved, onNeedKey,
}: {
  server: McpServer | null
  runtime?: { status?: string; tools?: number; connected?: boolean; error?: string }
  onClose: () => void
  onChanged: () => void
  onRemoved: (name: string) => void
  onNeedKey: (name: string) => void
}) {
  const s = useStyles(makeS)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => { setResult(null) }, [server?.name])

  if (!server) return null
  const st = statusLine(server, runtime)

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

            {oauthMissing ? (
              <Text style={s.hint}>
                This server uses OAuth. Finish sign-in on the machine: run{' '}
                <Text style={s.code}>hermes mcp login {server.name}</Text>, then test here.
              </Text>
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
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  rowName: { color: C.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  rowDesc: { color: C.textFaint, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  rowSub: { color: C.textFaint, fontSize: 11.5, marginTop: 1, opacity: 0.8 },
  badge: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase' },
  installBtn: { minWidth: 74, height: 34, borderRadius: 17, paddingHorizontal: 12, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  installOff: { backgroundColor: C.bgCard },
  installText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  empty: { color: C.textFaint, textAlign: 'center', marginTop: 48, fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: C.textDim, fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
  pressed: { opacity: 0.55 },

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
