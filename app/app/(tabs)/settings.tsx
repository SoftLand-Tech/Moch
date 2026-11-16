import React, { useMemo } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { computed } from 'nanostores'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../../src/components/Icon'
import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { connConfig, connectionState, gatewayError, disconnect, retryNow, redactedUrl } from '../../src/lib/gateway'
import { activeSession, messages } from '../../src/lib/chat'
import { diagLog, logText } from '../../src/lib/log'
import {
  notificationsEnabled, setNotificationsEnabled, ensureNotificationPermission,
} from '../../src/lib/push'
import { getEmbeddedGateway, mochiRuntimeStatus, restartEmbeddedRuntime, stopEmbeddedRuntime, requestBatteryExemption, linuxStatus, linuxReset, linuxBootstrap, type LinuxGuestStatus } from '../../src/lib/mochiRuntime'
import { C, useStyles, setTheme, THEME_OPTIONS, themeId, type ThemeId } from '../../src/lib/theme'
import { ScreenShell } from '../../src/components/ScreenShell'
import { localeAtom, setLocale, tr } from '../../src/lib/strings'
import { showAlert } from '../../src/components/AlertDialog'
import { thinkerAtom, setThinker, stopOpencodeServer, type Thinker } from '../../src/lib/thinker'
import { readAbout, saveAbout } from '../../src/lib/aboutMe'

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
  // #112 / BUG-016 pattern (setup.tsx): the bootstrap/reset are long, fallible
  // operations — the old handlers fired-and-forgot, so a failed install left
  // the row silently unchanged with no retry hint.
  const runInstall = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await linuxBootstrap('ubuntu-24.04')
      if (!r || r.ok === false) {
        showAlert(tr('linux.install.failed', { why: r?.steps || 'no result from the runtime' }))
        return
      }
    } catch (e) {
      showAlert(tr('linux.install.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  const runReset = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await linuxReset()
      if (!r) {
        showAlert(tr('linux.reset.failed', { why: 'the runtime refused or is unavailable' }))
        return
      }
    } catch (e) {
      showAlert(tr('linux.reset.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
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
        onPress={() => { void runInstall() }}
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
              { text: 'Reset', style: 'destructive', onPress: () => { void runReset() } },
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
      mochiRuntimeStatus().then((st) => {
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
        sub={gw?.port ? `Mochi ${gw.hermesVersion ?? '—'} · 127.0.0.1:${gw.port}` : 'Bundled Python + Mochi runtime on this phone'}
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

/** Installed app version (#66 / BUG-119): native first, expo config fallback. */
function appVersion(): string {
  // nativeAppVersion still ships on the native module's constants but is
  // untyped in expo-constants v57's surface — read it through a narrow cast.
  const c = Constants as typeof Constants & { nativeAppVersion?: string | null }
  return c.nativeAppVersion ?? Constants.expoConfig?.version ?? '—'
}

/** Native build/versionCode (Android versionCode, iOS build number). */
function appBuild(): string {
  const c = Constants as typeof Constants & { nativeBuildVersion?: string | null }
  return c.nativeBuildVersion ?? '—'
}

function SettingsInner() {
  const s = useStyles(makeS)
  const cfg = useStore(connConfig)
  // BUG-116: which catalog the fleet screens read (EN/AR).
  const locale = useStore(localeAtom)
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
  const thinker = useStore(thinkerAtom)
  const [aboutBusy, setAboutBusy] = React.useState(false)

  const stateColor = state === 'open' ? C.greenSoft : state === 'connecting' ? C.amber : C.red
  const stateLabel =
    state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting…'
    : state === 'error' ? 'Connection error' : 'Offline'

  const copyDiagnostics = async () => {
    const text = [
      // #66 / BUG-119: the real installed build (was a hardcoded "Moch v1.0").
      `Moch v${appVersion()} (${appBuild()})`,
      `Server: ${cfg ? redactedUrl(cfg) : '—'}`,
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
          <Divider />
          {/* BUG-116: the EN/AR catalog shipped with M9.2 but nothing ever called
              setLocale()/loadLocale(), so the Arabic strings and the RTL flag
              were unreachable dead code. This is the switch. */}
          <Row
            icon="language-outline"
            label="Language"
            sub={locale === 'ar' ? 'العربية — fleet screens are right-to-left' : 'English (fleet screens)'}
            chevron
            onPress={() =>
              showAlert('Language', 'Fleet screens follow this choice. The rest of the app is still English (retrofit is a later pass).', [
                { text: 'English', style: locale === 'en' ? 'cancel' : 'default', onPress: () => { void setLocale('en') } },
                { text: 'العربية', style: locale === 'ar' ? 'cancel' : 'default', onPress: () => { void setLocale('ar') } },
              ])
            }
          />
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

        <Section title="THIS PHONE">
          <Row
            icon="phone-portrait-outline"
            label="Local agent only"
            sub="This build runs the agent on your phone — no remote pairing"
          />
          <Divider />
          <Row
            icon="shield-checkmark-outline"
            label="Agent approvals: off"
            sub="Files and commands run without asking — this is your own phone. 'approvals.deny' rules still apply."
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
        </Section>

        <Section title="THINKER">
          <Row
            icon="sparkles-outline"
            label={thinker === 'moch' ? 'Moch (hermes) — active' : 'OpenCode — active'}
            sub={thinker === 'moch'
              ? 'The full agent on this phone. Everything is available.'
              : 'Free-model brain in the Linux guest. Bots, crew, automations and the agent browser are hidden.'}
          />
          <Divider />
          <Row
            icon="swap-horizontal-outline"
            label="Switch thinker"
            sub="Changes which brain answers new chats"
            chevron
            onPress={() => showAlert('Switch thinker', 'New chats use the other brain. Existing chats keep their own history. OpenCode needs the Linux guest installed and its server running.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'OpenCode',
                onPress: () => { void (async () => {
                  await setThinker('opencode')
                  showAlert('OpenCode selected', 'Open a new chat — Moch will start the OpenCode server in the Linux guest. If it fails, install the guest under RUNTIME.')
                })() },
              },
              {
                text: 'Moch',
                onPress: () => { void (async () => {
                  await stopOpencodeServer()
                  await setThinker('moch')
                })() },
              },
            ])}
          />
          <Divider />
          <Row
            icon="key-outline"
            label="Providers"
            sub="Add or change a provider key"
            chevron
            onPress={() => router.push('/onboarding/providers')}
          />
        </Section>

        <Section title="MEMORY">
          <Row
            icon="person-circle-outline"
            label="About me"
            sub="What Moch remembers about you (USER.md)"
            chevron
            onPress={() => { void (async () => {
              if (aboutBusy) return
              setAboutBusy(true)
              try {
                const entries = await readAbout()
                showAlert('About me', entries.length ? entries.join('\n') : 'Nothing saved yet — finish onboarding or send a message and Moch will remember.', [{ text: 'OK' }])
              } finally {
                setAboutBusy(false)
              }
            })() }}
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
            label={`Moch v${appVersion()} (${appBuild()})`}
            sub="Local agent on this phone — embedded runtime, your data, no pairing."
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
