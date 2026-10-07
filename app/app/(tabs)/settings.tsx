import React, { useMemo } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { computed } from 'nanostores'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../../src/components/Icon'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { connConfig, connectionState, gatewayError, disconnect, retryNow, redactedUrl,
  servers as serversStore, activeServerId, switchToServer, removeServer, forgetActiveServer,
  mostRecentServer, type SavedServer } from '../../src/lib/gateway'
import { activeSession, messages } from '../../src/lib/chat'
import { diagLog, logText } from '../../src/lib/log'
import {
  notificationsEnabled, setNotificationsEnabled, ensureNotificationPermission,
} from '../../src/lib/push'
import { getEmbeddedGateway, hermesRuntimeStatus, restartEmbeddedRuntime, stopEmbeddedRuntime, requestBatteryExemption, linuxStatus, linuxReset, linuxBootstrap, type LinuxGuestStatus } from '../../src/lib/hermesRuntime'
import { C, useStyles, setTheme, THEME_OPTIONS, themeId, type ThemeId } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'

export default function Settings() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <SettingsInner />
    </SafeAreaView>
  )
}

// ── Small building blocks ───────────────────────────────────────────────────

function LinuxSectionRows() {
  const [st, setSt] = React.useState<LinuxGuestStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    const tick = () => { linuxStatus().then((x) => { if (alive) setSt(x) }).catch(() => {}) }
    tick()
    // linuxStatus() serves a Python-side cache (a real size walk stat()s every
    // rootfs file — seconds of GIL inside the shared app process, which used
    // to fire here every 5s and starve sessions). 60s is plenty: install and
    // reset both refresh the cache when they change the tree.
    const t = setInterval(tick, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const installed = !!st?.bootstrapped
  return (
    <>
      <Row
        icon="logo-tux"
        label={installed ? `Linux ready — ${st?.distro ?? 'guest'}` : st?.sizeMb ? 'Linux — setting up…' : 'No Linux environment'}
        sub={installed ? `${st?.sizeMb ?? 0} MB on disk · agent shell runs inside it` : st?.sizeMb ? `${st?.sizeMb} MB so far…` : 'Ubuntu/Debian userspace for the agent (apt, any language, browser)'}
      />
      <Row
        icon="download-outline"
        label={installed ? 'Update / reinstall environment' : 'Install Linux environment'}
        sub="Downloads the base system (needs network, few minutes)"
        onPress={() => {
          if (busy) return
          setBusy(true)
          void linuxBootstrap('ubuntu-24.04').finally(() => setBusy(false))
        }}
      />
      {installed ? (
        <Row
          icon="trash-outline"
          label="Reset Linux environment"
          sub="Deletes the guest and everything installed inside it"
          danger
          onPress={() => {
            showAlert('Reset Linux environment?', 'Deletes the guest rootfs and all packages inside it.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive', onPress: () => { void linuxReset() } },
            ])
          }}
        />
      ) : null}
    </>
  )
}

function RuntimeSectionRows() {
  const [gw, setGw] = React.useState<{ ready: boolean; port: number | null; hermesVersion?: string | null } | null>(null)
  const [battery, setBattery] = React.useState<'idle' | 'already' | 'requested'>('idle')

  React.useEffect(() => {
    let alive = true
    const tick = () => {
      getEmbeddedGateway().then((g) => { if (alive) setGw(g) }).catch(() => {})
      hermesRuntimeStatus().then((st) => {
        if (alive) setGw((prev) => prev ? { ...prev, hermesVersion: st.hermesVersion } : { ready: false, port: null, hermesVersion: st.hermesVersion })
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const running = !!gw?.ready
  return (
    <>
      <Row
        icon="hardware-chip-outline"
        label={running ? 'Embedded agent — running' : gw ? 'Embedded agent — starting…' : 'Embedded agent — unavailable'}
        sub={gw?.port ? `hermes ${gw.hermesVersion ?? '—'} · 127.0.0.1:${gw.port}` : 'Bundled Python + hermes runtime on this phone'}
      />
      <Row
        icon="refresh-outline"
        label="Restart runtime"
        sub="Fresh Python process (relaunches the app)"
        onPress={() => { void restartEmbeddedRuntime().catch(() => {}) }}
      />
      <Row
        icon="battery-charging-outline"
        label={battery === 'already' ? 'Battery optimization — exempted' : 'Battery optimization — exempt this app'}
        sub="Helps the runtime survive aggressive ROMs (MIUI etc.)"
        disabled={battery === 'already'}
        onPress={() => {
          void requestBatteryExemption().then((r) => { if (r) setBattery(r) }).catch(() => {})
        }}
      />
      <Row
        icon="stop-circle-outline"
        label="Stop runtime"
        sub="Ends the background service and exits the app"
        danger
        onPress={() => { void stopEmbeddedRuntime().then(() => { /* process exits shortly */ }).catch(() => {}) }}
      />
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const s = useStyles(makeS)
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  )
}

function Row({
  icon, label, sub, right, onPress, danger, disabled, chevron,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  sub?: string
  right?: React.ReactNode
  onPress?: () => void
  danger?: boolean
  disabled?: boolean
  chevron?: boolean
}) {
  const s = useStyles(makeS)
  const body = (
    <View style={[s.rowInner, !onPress && { minHeight: 52 }]}>
      <View style={[s.rowIcon, danger && s.rowIconDanger]}>
        <Icon name={icon} size={16} color={danger ? C.red : C.accent} />
      </View>
      <View style={s.rowText}>
        <Text style={[s.rowLabel, disabled && s.rowLabelDisabled, danger && { color: C.red }]} numberOfLines={1}>
          {label}
        </Text>
        {sub ? <Text style={s.rowSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right}
      {chevron && !right ? <Icon name="chevron-forward" size={15} color={C.textFaint} /> : null}
    </View>
  )
  if (!onPress) return <View style={{ opacity: disabled ? 0.5 : 1 }}>{body}</View>
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.rowPressed, disabled && s.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
    >
      {body}
    </Pressable>
  )
}

function Divider() {
  const s = useStyles(makeS)
  return <View style={s.divider} />
}


// ── Appearance: theme option card (Mocheme / Relay) ─────────────────────────

function ThemeCard({ id, name, desc, swatches, onPick }: {
  id: ThemeId
  name: string
  desc: string
  swatches: string[]
  onPick: (id: ThemeId) => void
}) {
  const s = useStyles(makeS)
  const active = useStore(themeId) === id
  return (
    <Pressable
      style={({ pressed }) => [s.themeCard, active && s.themeCardOn, pressed && s.rowPressed]}
      onPress={() => onPick(id)}
      accessibilityRole="button"
      accessibilityLabel={`${name} theme${active ? ', active' : ''}`}
    >
      {active ? (
        <View style={s.themeCheck}>
          <Icon name="checkmark" size={13} color={C.onAccent} />
        </View>
      ) : null}
      <Text style={s.themeName}>{name}</Text>
      <Text style={s.themeDesc} numberOfLines={2}>{desc}</Text>
      <View style={s.themeSwatches}>
        {swatches.map((c, i) => (
          <View key={i} style={[s.themeSw, { backgroundColor: c }]} />
        ))}
      </View>
    </Pressable>
  )
}

// ── Screen ──────────────────────────────────────────────────────────────────

function SettingsInner() {
  const s = useStyles(makeS)
  const cfg = useStore(connConfig)
  const state = useStore(connectionState)
  const err = useStore(gatewayError)
  const logs = useStore(diagLog)
  const sid = useStore(activeSession)
  // Primitive count only — the messages array gets a fresh identity on every
  // stream flush (33ms cadence), which would re-render this whole tree; a
  // length computed re-renders only when a message is added or removed. The
  // two clipboard exports read the live array imperatively at press time.
  const msgCount = useStore(useMemo(() => computed(messages, (m) => m.length), []))
  const notifOn = useStore(notificationsEnabled)
  const savedServers = useStore(serversStore)
  const activeId = useStore(activeServerId)

  const stateColor = state === 'open' ? C.greenSoft : state === 'connecting' ? C.amber : C.red
  const stateLabel =
    state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting…'
    : state === 'error' ? 'Connection error' : 'Offline'

  const forgetServer = async (sv: SavedServer) => {
    const remaining = await removeServer(sv.id)
    if (activeId === sv.id || !connConfig.get()) {
      const next = mostRecentServer(remaining)
      if (next) {
        try { await switchToServer(next.id); return } catch {}
      }
      router.replace('/')
    }
  }

  const copyDiagnostics = async () => {
    const text = [
      `Moch v1.0`,
      `Server: ${cfg ? redactedUrl(cfg) : '—'}`,
      `Computers saved: ${savedServers.length}`,
      `State: ${state}${err ? ` (${err.slice(0, 200)})` : ''}`,
      `Session: ${sid ?? '—'} · messages: ${msgCount}`,
      ``,
      `--- log ---`,
      logText().slice(-4000),
    ].join('\n')
    await Clipboard.setStringAsync(text)
    showAlert('Copied', 'Diagnostics copied to clipboard.')
  }

  const exportTranscript = async () => {
    const text = messages.get().map((m) => `[${new Date(m.ts).toLocaleString()}] ${m.role}: ${m.text}`).join('\n\n')
    if (!text) { showAlert('Empty', 'No messages to export.'); return }
    // BUG-077: say so when the clipboard cap clips the export.
    const clipped = text.length > 50000
    await Clipboard.setStringAsync(text.slice(0, 50000))
    showAlert('Copied', clipped ? 'Copied — long transcripts are capped at 50,000 characters.' : 'Transcript copied to clipboard.')
  }

  const forgetCurrent = () => {
    showAlert('Forget this computer?', 'Removes the current computer from this device. Others stay saved.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: async () => {
        // BUG-034: tear the socket down BEFORE forgetting — the old flow
        // left a live 'open' connection to the machine it just revoked
        // (green "Connected" hero, its events still streaming in).
        disconnect()
        const remaining = await forgetActiveServer()
        const next = mostRecentServer(remaining)
        if (next) {
          try { await switchToServer(next.id); return } catch {}
        }
        router.replace('/')
      } },
    ])
  }

  return (
    <ScreenShell title="Settings" showBrand>
      <ScrollView style={s.root} contentContainerStyle={{ padding: 16, gap: 18, paddingBottom: 44 }}>
        {/* Connection status hero */}
        <View style={s.hero}>
          <View style={[s.heroDot, { backgroundColor: stateColor }]} />
          <View style={{ flex: 1 }}>
            <Text style={s.heroTitle} numberOfLines={1}>{cfg?.host ?? 'No computer'}</Text>
            <Text style={[s.heroState, { color: stateColor }]} numberOfLines={1}>
              {stateLabel}{cfg ? ` · ${cfg.tls ? 'secure (wss)' : 'plain (ws)'}` : ''}
            </Text>
            {err ? <Text style={s.heroErr} numberOfLines={2}>{err}</Text> : null}
          </View>
        </View>

        <Section title="RUNTIME">
          <RuntimeSectionRows />
          <Divider />
          <LinuxSectionRows />
        </Section>
        <Section title="APPEARANCE">
          <View style={s.themeRow}>
            {THEME_OPTIONS.map((t) => (
              <ThemeCard key={t.id} id={t.id} name={t.name} desc={t.desc} swatches={t.swatches} onPick={(id) => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); void setTheme(id) }} />
            ))}
          </View>
        </Section>

        <Section title="AGENT">
          <Row
            icon="sparkles-outline"
            label="Skills"
            sub="Browse and manage the agent's skills"
            chevron
            onPress={() => router.push('/(tabs)/skills')}
          />
          <Divider />
          <Row
            icon="cube-outline"
            label="Models"
            sub="Provider, model and reasoning effort"
            chevron
            onPress={() => router.push('/(tabs)/agent')}
          />
        </Section>

        <Section title="COMPUTERS">
          {savedServers.length === 0 ? (
            <Row icon="laptop-outline" label={cfg?.host ?? '—'} sub="Current session — pair to remember it" chevron />
          ) : (
            savedServers.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt).map((sv, i) => {
              const active = sv.id === activeId
              return (
                <React.Fragment key={sv.id}>
                  {i > 0 ? <Divider /> : null}
                  <View style={s.serverRow}>
                    <Pressable
                      style={({ pressed }) => [s.serverMain, pressed && s.rowPressed]}
                      disabled={active}
                      onPress={() => { void switchToServer(sv.id).catch((e) => showAlert('Switch failed', e instanceof Error ? e.message : String(e))) }}
                      accessibilityLabel={active ? `Connected to ${sv.name}` : `Switch to ${sv.name}`}
                    >
                      <View style={s.serverLine}>
                        <View style={[s.miniDot, active && { backgroundColor: C.greenSoft }]} />
                        <Text style={s.rowLabel} numberOfLines={1}>{sv.name}</Text>
                        {active ? <Text style={s.activeTag}>connected</Text> : null}
                      </View>
                      <Text style={s.rowSub} numberOfLines={1}>{sv.tls ? 'WSS' : 'WS'} · {sv.host}</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [s.serverForget, pressed && s.rowPressed]}
                      hitSlop={8}
                      onPress={() => showAlert('Forget this computer?', `Removes ${sv.name} from this device.`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Forget', style: 'destructive', onPress: () => { void forgetServer(sv) } },
                      ])}
                      accessibilityLabel={`Forget ${sv.name}`}
                    >
                      <Icon name="trash-outline" size={16} color={C.red} />
                    </Pressable>
                  </View>
                </React.Fragment>
              )
            })
          )}
          <Divider />
          <Row
            icon="add-circle-outline"
            label="Add computer"
            sub="Pair with a computer — scan its pairing QR code"
            chevron
            onPress={() => router.push('/add-computer')}
          />
          <Divider />
          <Row
            icon="refresh"
            label="Reconnect now"
            chevron
            onPress={() => { void retryNow().catch((e) => showAlert('Retry failed', String(e))) }}
          />
          <Row
            icon="close-circle-outline"
            label="Disconnect"
            danger
            onPress={() => { disconnect() }}
          />
          <Row
            icon="trash-outline"
            label="Forget this computer"
            sub="Others stay saved"
            danger
            onPress={forgetCurrent}
          />
        </Section>

        <Section title="NOTIFICATIONS">
          <View style={s.toggleRow}>
            <View style={[s.rowIcon]}>
              <Icon name="notifications-outline" size={16} color={C.accent} />
            </View>
            <View style={s.rowText}>
              <Text style={s.rowLabel}>Notifications</Text>
              <Text style={s.rowSub}>Buzz for approvals, questions & replies</Text>
            </View>
            <Switch
              value={notifOn}
              onValueChange={(v) => { void setNotificationsEnabled(v) }}
              trackColor={{ true: C.accent, false: C.border }}
              accessibilityLabel="Toggle notifications"
            />
          </View>
          <Divider />
          <Row
            icon="checkmark-circle-outline"
            label="Enable notifications"
            onPress={() => { void ensureNotificationPermission().catch(() => {}) }}
          />
        </Section>

        <Section title="ABOUT">
          <Row
            icon="copy-outline"
            label="Copy diagnostics"
            sub={`${logs.length} log lines`}
            onPress={copyDiagnostics}
          />
          <Divider />
          <Row
            icon="share-outline"
            label="Export transcript"
            sub={msgCount ? `${msgCount} messages — copies to clipboard` : 'No messages yet'}
            onPress={exportTranscript}
          />
          <Divider />
          <Row
            icon="information-circle-outline"
            label="Moch v1.0"
            sub="Mobile client for your self-hosted Hermes agent. Pair from the Add computer screen or your PC's pairing tool."
            disabled
          />
        </Section>
      </ScrollView>
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.bgCard,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  heroDot: { width: 10, height: 10, borderRadius: 5 },
  heroTitle: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  heroState: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  heroErr: { color: C.red, fontSize: 11.5, marginTop: 4, lineHeight: 15 },
  section: { gap: 8 },
  sectionLabel: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, marginLeft: 4 },
  themeRow: { flexDirection: 'row', gap: 10, padding: 10 },
  themeCard: {
    flex: 1,
    backgroundColor: C.bgElev,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 20,
    padding: 12,
  },
  themeCardOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  themeCheck: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeName: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  themeDesc: { color: C.textFaint, fontSize: 11, lineHeight: 15, marginBottom: 10, minHeight: 30 },
  themeSwatches: { flexDirection: 'row', gap: 5 },
  themeSw: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  card: { backgroundColor: C.bgCard, borderRadius: 16, borderWidth: 1, borderColor: C.borderSoft, overflow: 'hidden' },
  row: { minHeight: 56 },
  rowPressed: { backgroundColor: C.bgHover },
  rowDisabled: { opacity: 0.5 },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  rowIcon: {
    width: 30, height: 30, borderRadius: 9,
    // BUG-017: theme token, not a hard-coded Mocheme literal (the literal
    // kept the chips orange under the Relay theme).
    backgroundColor: C.accentSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  rowIconDanger: { backgroundColor: C.redSoft },
  rowText: { flex: 1, gap: 1 },
  rowLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  rowLabelDisabled: { color: C.textDim },
  rowSub: { color: C.textFaint, fontSize: 12, lineHeight: 16 },
  divider: { height: 1, backgroundColor: C.borderSoft, marginLeft: 56 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56 },
  serverRow: { flexDirection: 'row', alignItems: 'center' },
  serverMain: { flex: 1, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56, justifyContent: 'center' },
  serverLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.textFaint },
  activeTag: { color: C.greenSoft, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  serverForget: { paddingHorizontal: 14, paddingVertical: 14, minHeight: 56, justifyContent: 'center' },
})
