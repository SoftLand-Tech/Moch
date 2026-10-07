import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Icon } from '../src/components/Icon'
import { C, useStyles } from '../src/lib/theme'
import {
  linuxBootstrap,
  linuxStatus,
  linuxStatusLive,
  requestBatteryExemption,
  type LinuxGuestStatus,
} from '../src/lib/hermesRuntime'
import { ensureNotificationPermission } from '../src/lib/push'
import { fetchModelOptions, saveProviderKey, modelOptions, rankProviders, type ProviderOption } from '../src/lib/modelState'
import { connConfig, rpc } from '../src/lib/gateway'
import { getEmbeddedGateway } from '../src/lib/hermesRuntime'
import { useStore } from '@nanostores/react'
import { ProviderKeyForm } from '../src/components/ProviderKeyForm'

/**
 * First-run setup wizard for the embedded ("This phone") mode:
 * environment → provider → basics → install progress.
 * BUG-057: the comment used to claim a Settings → "Run setup" entry that
 * doesn't exist — the real route is the pair screen's embedded-mode card
 * (src/components/PairForm.tsx pushes /setup).
 */
export default function Setup() {
  const s = useStyles(makeS)
  const [stepIdx, setStepIdx] = useState(0)
  // "Continue without Linux": the guest never lands, so the Install step must
  // not wait on status.bootstrapped (which stays false after a skip).
  const [skippedLinux, setSkippedLinux] = useState(false)
  // The Import step only makes sense when the phone is paired to a remote
  // computer — on the embedded gateway the data already lives here.
  const remotePaired = useRemotePaired()
  const steps: Array<{ title: string; render: () => React.ReactNode }> = [
    { title: 'Choose an environment', render: () => <EnvStep onNext={(skipped) => { setSkippedLinux(skipped); setStepIdx(1) }} /> },
    { title: 'Connect a model', render: () => <ProviderStep onNext={() => setStepIdx(2)} /> },
    ...(remotePaired ? [{
      title: 'Import from your computer',
      render: () => <ImportStep onNext={() => setStepIdx(3)} />,
    }] : []),
    { title: 'Basics', render: () => <BasicsStep onNext={() => setStepIdx(steps.length - 1)} /> },
    { title: 'Installing', render: () => <InstallStep skipped={skippedLinux} /> },
  ]
  const step = steps[Math.min(stepIdx, steps.length - 1)]
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.kicker}>FIRST-RUN SETUP</Text>
        <Text style={s.title}>{step.title}</Text>
        <View style={s.stepsRow}>
          {steps.map((_, i) => (
            <View key={i} style={[s.stepDot, i <= stepIdx && s.stepDotOn]} />
          ))}
        </View>
        {step.render()}
      </ScrollView>
    </SafeAreaView>
  )
}

/**
 * True when the phone is paired to a remote computer rather than the embedded
 * on-phone gateway (same test chat.ts uses to pick the embedded session cwd:
 * embedded + loopback host ⇒ this phone).
 */
function useRemotePaired(): boolean {
  const [remote, setRemote] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        const gw = await getEmbeddedGateway()
        const host = connConfig.get()?.host ?? ''
        setRemote(!!host && !(gw?.running && host.startsWith('127.0.0.1')))
      } catch {
        setRemote(false)
      }
    })()
  }, [])
  return remote
}

function EnvStep({ onNext }: { onNext: (skipped: boolean) => void }) {
  const s = useStyles(makeS)
  const [distro, setDistro] = useState('ubuntu-24.04')
  const [existing, setExisting] = useState<LinuxGuestStatus | null>(null)
  // BUG-016: the bootstrap is a minutes-long download that can fail — the
  // old button swallowed every error and advanced regardless, stranding the
  // Install step on an infinite spinner with no retry and no busy state.
  const [booting, setBooting] = useState(false)
  const [bootErr, setBootErr] = useState<string | null>(null)
  useEffect(() => { void linuxStatus().then(setExisting).catch(() => {}) }, [])
  const runBootstrap = async () => {
    if (booting) return
    setBootErr(null)
    setBooting(true)
    try {
      const r = await linuxBootstrap(distro === "none" ? "skip" : distro)
      if (!r || r.ok === false) {
        setBootErr("The install didn't finish — check the connection and try again.")
        return
      }
      // Skip path: the runtime answers ok with no guest installed — the next
      // step must not spin on status.bootstrapped.
      onNext(distro === 'none' || (r as { skipped?: boolean }).skipped === true)
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : "The install failed — check the connection and try again.")
    } finally {
      setBooting(false)
    }
  }
  return (
    <>
      <Text style={s.sub}>
        Give the agent a real Linux userspace (apt, any language, servers).
        Downloaded on demand, lives entirely inside Moch's storage.
      </Text>
      {[
        { id: 'ubuntu-24.04', name: 'Ubuntu 24.04 LTS', desc: '~31 MB download · newest packages' },
        { id: 'debian-12', name: 'Debian 12', desc: 'smaller base, rock solid' },
        { id: 'none', name: 'None for now', desc: 'Android-only tools; can install later in Settings' },
      ].map((o) => (
        <Pressable key={o.id} style={[s.card, distro === o.id && s.cardOn]} onPress={() => setDistro(o.id)}>
          <View style={s.cardHead}>
            <Icon name={o.id === 'none' ? 'phone-portrait-outline' : 'logo-tux'} size={20} color={C.accent} />
            <Text style={s.cardTitle}>{o.name}</Text>
            {distro === o.id ? <Icon name="checkmark-circle" size={20} color={C.accent} /> : null}
          </View>
          <Text style={s.cardDesc}>{o.desc}</Text>
        </Pressable>
      ))}
      {existing?.bootstrapped ? (
        <Text style={s.note}>Already installed: {existing.distro || 'Linux'} · {existing.sizeMb} MB</Text>
      ) : null}
      {bootErr ? <Text style={s.err}>{bootErr}</Text> : null}
      <Pressable style={[s.btn, s.btnBlock, booting && s.btnBusy]} disabled={booting} onPress={() => { void runBootstrap() }}>
        <Text style={s.btnText}>{booting ? "Installing…" : distro === "none" ? "Continue without Linux" : "Install environment"}</Text>
      </Pressable>
      <Pressable style={s.ghost} onPress={() => router.replace('/(tabs)/chat')}>
        <Text style={s.ghostText}>Skip setup</Text>
      </Pressable>
    </>
  )
}

function ProviderStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const opts = useStore(modelOptions)
  // Full inventory, ranked (current → configured → rest): configured providers
  // used to be filtered out and the list capped at 8, hiding most of the
  // gateway registry. The container scrolls — no cap needed.
  const providers = rankProviders(opts?.providers ?? [])
  // Force a fresh fetch: a cached atom from a previous run of the sheet
  // renders stale authentication flags.
  useEffect(() => { void fetchModelOptions(undefined, { force: true }).catch(() => {}) }, [])
  return (
    <>
      {/* BUG-052: the wire truth is server-side (model.save_key RPC) — the
          old "on this phone" copy contradicted the Models tab and reality. */}
      <Text style={s.sub}>Pick the model provider the agent should use. Keys are stored on your computer (the agent's server).</Text>
      {providers.map((p) => (
        <Pressable key={p.slug} style={[s.card, picked === p.slug && s.cardOn]} onPress={() => setPicked(p.slug)}>
          <View style={s.cardHead}>
            <Icon name="flash-outline" size={18} color={C.accent} />
            <Text style={s.cardTitle}>{p.name}</Text>
            {p.authenticated ? <Text style={s.okTag}>ready</Text> : null}
          </View>
        </Pressable>
      ))}
      {providers.length === 0 ? <Text style={s.note}>Provider list loading… you can also set this later in Settings.</Text> : null}
      {picked ? (
        <ProviderKeyForm
          provider={providers.find((p) => p.slug === picked)!}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={async (key) => {
            setBusy(true)
            try {
              await saveProviderKey(picked, key)
              return null
            } catch (e) {
              return e instanceof Error ? e.message : 'save failed'
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}
      <Pressable style={[s.btn, s.btnBlock]} onPress={onNext}>
        <Text style={s.btnText}>{picked ? 'Continue' : 'Skip for now'}</Text>
      </Pressable>
    </>
  )
}

function BasicsStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  const [battery, setBattery] = useState(false)
  const [notif, setNotif] = useState(false)
  useEffect(() => {
    void ensureNotificationPermission().then((ok) => setNotif(ok)).catch(() => {})
  }, [])
  return (
    <>
      <Text style={s.sub}>Two permissions that keep the agent reliable in the background.</Text>
      {/* BUG-057: the tap actually (re-)requests the permission — it used to
          run `setNotif(notif || true)`, i.e. always flip to "allowed" without
          asking anything, so a user who denied could fake the card green. */}
      <Pressable
        style={s.card}
        onPress={() => { void ensureNotificationPermission().then((ok) => setNotif(ok)).catch(() => {}) }}
        accessibilityRole="button"
        accessibilityLabel="Allow notifications"
      >
        <View style={s.cardHead}>
          <Icon name={notif ? 'notifications' : 'notifications-outline'} size={20} color={C.accent} />
          <Text style={s.cardTitle}>{notif ? 'Notifications allowed' : 'Notifications — asking…'}</Text>
        </View>
        <Text style={s.cardDesc}>Automation knocks and reply alerts</Text>
      </Pressable>
      <Pressable style={[s.card, battery && s.cardOn]} onPress={async () => { const r = await requestBatteryExemption().catch(() => null); setBattery(!!r) }}>
        <View style={s.cardHead}>
          <Icon name="battery-charging-outline" size={20} color={C.accent} />
          <Text style={s.cardTitle}>{battery ? 'Battery exemption requested' : 'Exempt from battery optimization'}</Text>
        </View>
        <Text style={s.cardDesc}>Recommended on MIUI and other aggressive ROMs</Text>
      </Pressable>
      <Pressable style={[s.btn, s.btnBlock]} onPress={onNext}>
        <Text style={s.btnText}>Finish setup</Text>
      </Pressable>
    </>
  )
}

function InstallStep({ skipped }: { skipped: boolean }) {
  const s = useStyles(makeS)
  const [status, setStatus] = useState<LinuxGuestStatus | null>(null)
  useEffect(() => {
    if (skipped) return
    const t = setInterval(() => { void linuxStatusLive().then(setStatus).catch(() => {}) }, 2000)
    return () => clearInterval(t)
  }, [skipped])
  const done = skipped || status?.bootstrapped
  return (
    <>
      <Text style={s.sub}>
        {skipped
          ? 'No Linux guest installed — the agent runs with Android-only tools. You can install Linux later in Settings.'
          : done
          ? `Linux is ready: ${status?.distro ?? 'guest'} · ${status?.sizeMb ?? 0} MB. The agent's terminal now runs inside it.`
          : 'Setting up. This can take a few minutes on first install — you can leave this screen.'}
      </Text>
      {!done ? <ActivityIndicator color={C.accent} style={{ marginVertical: 18 }} /> : (
        <Icon name="checkmark-circle" size={56} color={C.accent} style={{ alignSelf: 'center', marginVertical: 18 }} />
      )}
      {status && !done ? <Text style={s.note}>on disk so far: {status.sizeMb} MB</Text> : null}
      <Pressable style={[s.btn, s.btnBlock]} onPress={() => router.replace('/(tabs)/chat')}>
        <Text style={s.btnText}>Enter Moch</Text>
      </Pressable>
    </>
  )
}

// ── Import from your computer ──────────────────────────────────────────────

/**
 * Mirrors the paired computer's setup onto the phone over the EXISTING
 * gateway RPCs — no new endpoints. Secrets never leave the desktop (the list
 * RPCs carry key *names* only), so provider keys are re-entered once and MCP
 * API keys are flagged "key needed". Categories degrade independently: a
 * failed list RPC renders "unavailable" without blocking the others.
 */

/** One configured MCP server — `mcp.servers.list`'s summary (no secret values). */
interface ImportMcpServer {
  name: string
  url?: string | null
  command?: string | null
  args?: string[]
  /** Env KEY NAMES only — values live in the desktop's .env. */
  env?: string[]
  auth?: string | null
}

const COMING_SOON = [
  { id: 'sessions', name: 'Chat sessions', note: 'No gateway RPC yet — restore from a backup zip in a follow-up.' },
  { id: 'memories', name: 'Memories', note: 'No gateway RPC yet — restore from a backup zip in a follow-up.' },
]

function ImportStep({ onNext }: { onNext: () => void }) {
  const s = useStyles(makeS)
  // null = still loading, 'unavailable' = the list RPC failed for this category.
  const [providers, setProviders] = useState<ProviderOption[] | 'unavailable' | null>(null)
  const [servers, setServers] = useState<ImportMcpServer[] | 'unavailable' | null>(null)
  const [skills, setSkills] = useState<string[] | 'unavailable' | null>(null)
  const [picked, setPicked] = useState<ProviderOption | null>(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, 'ok' | 'failed'>>({})
  const [saveErr, setSaveErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      // Providers: desktop inventory with the authenticated flags included.
      try {
        const res = await rpc<{ providers?: ProviderOption[] }>('model.options', { include_unconfigured: true })
        setProviders(rankProviders((res?.providers ?? []).filter((p) => p.authenticated)))
      } catch { setProviders('unavailable') }
      // MCP servers: config summary; key values are vault-sealed desktop-side.
      try {
        const res = await rpc<{ servers?: ImportMcpServer[] }>('mcp.servers.list', {})
        setServers(Array.isArray(res?.servers) ? res.servers : [])
      } catch { setServers('unavailable') }
      // Skills: `list` returns category → names.
      try {
        const res = await rpc<{ skills?: Record<string, string[]> | null }>('skills.manage', { action: 'list' })
        const names = Object.values(res?.skills ?? {}).flat()
        setSkills(names)
      } catch { setSkills('unavailable') }
    })()
  }, [])

  const mark = (id: string, r: 'ok' | 'failed') => setResults((prev) => ({ ...prev, [id]: r }))

  const importSelected = async () => {
    if (busy) return
    setBusy(true)
    setSaveErr(null)
    try {
      const ids = Object.keys(sel).filter((k) => sel[k] && results[k] !== 'ok')
      for (const id of ids) {
        try {
          if (id.startsWith('mcp:')) {
            const srv = Array.isArray(servers) ? servers.find((x) => `mcp:${x.name}` === id) : null
            if (!srv) throw new Error('server vanished')
            // Same shape the Connectors screen sends via addCustomServer.
            const config: Record<string, unknown> = {}
            if (srv.url) config.url = srv.url
            if (srv.command) {
              config.command = srv.command
              if (srv.args?.length) config.args = srv.args
            }
            await rpc('mcp.servers.add', { name: srv.name, config })
          } else if (id.startsWith('skill:')) {
            await rpc('skills.manage', { action: 'install', query: id.slice('skill:'.length) })
          }
          mark(id, 'ok')
        } catch {
          mark(id, 'failed')
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const Row = ({ id, title, note, tag }: { id: string; title: string; note?: string; tag?: string }) => {
    const checked = !!sel[id]
    const result = results[id]
    return (
      <Pressable
        style={[s.card, checked && s.cardOn]}
        onPress={() => setSel((p) => ({ ...p, [id]: !p[id] }))}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <View style={s.cardHead}>
          <Icon name={result === 'ok' ? 'checkmark-circle' : checked ? 'checkbox' : 'square-outline'} size={20} color={C.accent} />
          <Text style={s.cardTitle}>{title}</Text>
          {result === 'failed' ? <Text style={s.errTag}>failed</Text> : null}
          {result === 'ok' ? <Text style={s.okTag}>imported</Text> : null}
          {!result && tag ? <Text style={s.warnTag}>{tag}</Text> : null}
        </View>
        {note ? <Text style={s.cardDesc}>{note}</Text> : null}
      </Pressable>
    )
  }

  return (
    <>
      <Text style={s.sub}>
        Copy your computer's provider, server, and skill setup onto this phone.
        API keys can't be read off the computer — you'll re-enter each provider key once.
      </Text>

      <Text style={s.sectionTitle}>Model providers (re-enter key)</Text>
      {providers === null ? <Text style={s.note}>Loading…</Text> : null}
      {providers === 'unavailable' ? <Text style={s.note}>Providers unavailable right now.</Text> : null}
      {Array.isArray(providers) && providers.length === 0 ? <Text style={s.note}>No authenticated providers on the computer yet.</Text> : null}
      {Array.isArray(providers) ? providers.map((p) => {
        const id = `provider:${p.slug}`
        const result = results[id]
        return (
          <Pressable key={p.slug} style={s.card} onPress={() => { setSaveErr(null); setPicked(p) }} accessibilityRole="button">
            <View style={s.cardHead}>
              <Icon name={result === 'ok' ? 'checkmark-circle' : 'key-outline'} size={20} color={C.accent} />
              <Text style={s.cardTitle}>{p.name}</Text>
              {result === 'failed' ? <Text style={s.errTag}>failed</Text> : null}
              {result === 'ok' ? <Text style={s.okTag}>imported</Text> : null}
            </View>
            <Text style={s.cardDesc}>{result === 'ok' ? 'Key saved' : 'Tap, then paste the API key'}</Text>
          </Pressable>
        )
      }) : null}

      <Text style={s.sectionTitle}>MCP servers</Text>
      {servers === null ? <Text style={s.note}>Loading…</Text> : null}
      {servers === 'unavailable' ? <Text style={s.note}>MCP servers unavailable right now.</Text> : null}
      {Array.isArray(servers) && servers.length === 0 ? <Text style={s.note}>No MCP servers configured on the computer.</Text> : null}
      {Array.isArray(servers) ? servers.map((srv) => (
        <Row
          key={srv.name}
          id={`mcp:${srv.name}`}
          title={srv.name}
          note={srv.env?.length ? `Key needed: ${srv.env.join(', ')}` : srv.url ?? srv.command ?? undefined}
          tag={srv.env?.length || srv.auth === 'header' ? 'key needed' : undefined}
        />
      )) : null}

      <Text style={s.sectionTitle}>Skills</Text>
      {skills === null ? <Text style={s.note}>Loading…</Text> : null}
      {skills === 'unavailable' ? <Text style={s.note}>Skills unavailable right now.</Text> : null}
      {Array.isArray(skills) && skills.length === 0 ? <Text style={s.note}>No skills installed on the computer.</Text> : null}
      {Array.isArray(skills) ? skills.slice(0, 50).map((name) => (
        <Row key={name} id={`skill:${name}`} title={name} />
      )) : null}

      <Text style={s.sectionTitle}>Coming soon</Text>
      {COMING_SOON.map((c) => (
        <View key={c.id} style={s.card}>
          <View style={s.cardHead}>
            <Icon name="time-outline" size={20} color={C.textFaint} />
            <Text style={s.cardTitle}>{c.name}</Text>
            <Text style={s.warnTag}>coming soon</Text>
          </View>
          <Text style={s.cardDesc}>{c.note}</Text>
        </View>
      ))}

      {picked ? (
        <ProviderKeyForm
          provider={picked}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={async (key) => {
            try {
              await saveProviderKey(picked.slug, key)
              mark(`provider:${picked.slug}`, 'ok')
              setPicked(null)
              return null
            } catch (e) {
              return e instanceof Error ? e.message : 'save failed'
            }
          }}
        />
      ) : null}
      {saveErr ? <Text style={s.err}>{saveErr}</Text> : null}

      <Pressable
        style={[s.btn, s.btnBlock, busy && s.btnBusy]}
        disabled={busy || !Object.values(sel).some(Boolean)}
        onPress={() => { void importSelected() }}
      >
        <Text style={s.btnText}>{busy ? 'Importing…' : 'Import selected'}</Text>
      </Pressable>
      <Pressable style={[s.btn, s.btnBlock, s.btnGhost]} onPress={onNext}>
        <Text style={s.btnTextDark}>Continue</Text>
      </Pressable>
    </>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingBottom: 48 },
  kicker: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 6 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 10 },
  stepsRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  stepDot: { width: 34, height: 4, borderRadius: 2, backgroundColor: C.bgCard },
  stepDotOn: { backgroundColor: C.accent },
  sub: { color: C.textDim, fontSize: 15, lineHeight: 21, marginBottom: 18 },
  card: { backgroundColor: C.bgCard, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  cardOn: { borderColor: C.accent },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '700', flex: 1 },
  cardDesc: { color: C.textFaint, fontSize: 13, marginTop: 6, lineHeight: 18 },
  okTag: { color: C.accent, fontSize: 12, fontWeight: '700' },
  note: { color: C.textFaint, fontSize: 12.5, marginVertical: 10 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  btnBusy: { opacity: 0.6 },
  err: { color: C.red, fontSize: 13, lineHeight: 18, marginTop: 10, textAlign: 'center' },
  btnBlock: { marginTop: 16 },
  btnText: { color: C.onAccent, fontSize: 16, fontWeight: '800' },
  ghost: { alignItems: 'center', paddingVertical: 14 },
  ghostText: { color: C.textFaint, fontSize: 14, fontWeight: '600' },
  sectionTitle: { color: C.text, fontSize: 14, fontWeight: '800', marginTop: 14, marginBottom: 6 },
  errTag: { color: C.red, fontSize: 12, fontWeight: '700' },
  warnTag: { color: C.textFaint, fontSize: 12, fontWeight: '700' },
  btnGhost: { backgroundColor: C.bgCard },
  btnTextDark: { color: C.text, fontSize: 16, fontWeight: '800' },
})
