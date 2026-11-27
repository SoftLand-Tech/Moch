import React, { useMemo } from 'react'
import { View, Pressable, StyleSheet, Modal, ScrollView } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { computed } from 'nanostores'
import { useStore } from '@nanostores/react'
import Constants from 'expo-constants'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { Icon } from '../../src/components/Icon'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import {
  Card,
  Divider,
  GhostBtn,
  HeaderButton,
  Kicker,
  Pill,
  ScreenScroll,
  SheetBackdrop,
  SheetCard,
  SheetGrabber,
  Spinner,
  Toggle,
  Txt,
  Field,
  PrimaryBtn,
} from '../../src/components/ui'
import { C, useStyles, setTheme, THEME_OPTIONS, themeId, type ThemeId } from '../../src/lib/theme'
import { LOCALE_OPTIONS, localeAtom, setLocale, useDir, useT, tr } from '../../src/lib/strings'
import {
  connConfig,
  connectionState,
  gatewayError,
  retryNow,
  redactedUrl,
} from '../../src/lib/gateway'
import { activeSession, messages } from '../../src/lib/chat'
import { diagLog, logText } from '../../src/lib/log'
import {
  notificationsEnabled,
  notificationPermission,
  setNotificationsEnabled,
  ensureNotificationPermission,
} from '../../src/lib/push'
import {
  getEmbeddedGateway,
  mochiRuntimeStatus,
  restartEmbeddedRuntime,
  stopEmbeddedRuntime,
  requestBatteryExemption,
  linuxStatus,
  linuxReset,
  linuxBootstrap,
  type LinuxGuestStatus,
} from '../../src/lib/mochiRuntime'
import {
  thinkerAtom,
  ocOneShotAtom,
  ensureOpencodeInstalled,
  startOpencodeServer,
  setThinker,
  setOpencodeOneShot,
  stopOpencodeServer,
} from '../../src/lib/thinker'
import { parseAbout, readAbout, saveAbout, type AboutFields } from '../../src/lib/aboutMe'
import { checkForMochUpdate, otaSupported, reloadIntoUpdate } from '../../src/lib/updates'

/** Appearance cards: human captions owned by i18n, not by theme.ts. */
const THEME_CAPTION_KEY: Record<ThemeId, string> = {
  mocheme: 'settings.theme.mocheme.caption',
  relay: 'settings.theme.relay.caption',
}

export default function Settings() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <SettingsInner />
    </SafeAreaView>
  )
}

// ── Data hooks (unchanged polling/behaviour, lifted out of JSX sections) ────

/**
 * Linux guest status + the two long fallible operations. Poll cadence stays
 * 60s: linuxStatus() serves a Python-side cache (a real size walk stat()s
 * every rootfs file — seconds of GIL inside the shared app process).
 */
function useLinuxGuest() {
  const [st, setSt] = React.useState<LinuxGuestStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const aliveRef = React.useRef(true)
  const refresh = React.useCallback(async () => {
    try {
      const x = await linuxStatus()
      if (aliveRef.current) setSt(x)
    } catch {}
  }, [])
  React.useEffect(() => {
    aliveRef.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 60_000)
    return () => { aliveRef.current = false; clearInterval(timer) }
  }, [refresh])
  // #112 / BUG-016: bootstrap/reset are long, fallible operations. Await each
  // one, hold the busy state through completion, and surface any failure.
  const runInstall = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await linuxBootstrap('ubuntu-24.04')
      if (!r || r.ok === false) {
        showAlert(
          tr('linux.install.failed', { why: r?.steps || tr('settings.linux.noResult') }),
          undefined,
          [{ text: tr('chrome.alert.ok') }],
        )
        return
      }
    } catch (e) {
      showAlert(
        tr('linux.install.failed', { why: e instanceof Error ? e.message : String(e) }),
        undefined,
        [{ text: tr('chrome.alert.ok') }],
      )
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
        showAlert(
          tr('linux.reset.failed', { why: tr('settings.linux.refused') }),
          undefined,
          [{ text: tr('chrome.alert.ok') }],
        )
        return
      }
    } catch (e) {
      showAlert(
        tr('linux.reset.failed', { why: e instanceof Error ? e.message : String(e) }),
        undefined,
        [{ text: tr('chrome.alert.ok') }],
      )
    } finally {
      setBusy(false)
    }
  }
  return { st, busy, installed: !!st?.bootstrapped, runInstall, runReset, refresh }
}

/** Embedded gateway / Mochi runtime status + battery-exemption request. */
function useRuntimeInfo() {
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
  const requestExemption = () => {
    void requestBatteryExemption().then((r) => { if (r) setBattery(r) }).catch(() => {})
  }
  return { gw, battery, requestExemption }
}

// ── Small building blocks in the mockup's row-card language ─────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Kicker>{title}</Kicker>
      {children}
    </View>
  )
}

/** m-card as a settings group: zero padding, 1px soft separators between rows. */
function Group({ children }: { children: React.ReactNode }) {
  const s = useStyles(makeS)
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <Card style={s.group}>
      {items.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Divider /> : null}
          {child}
        </React.Fragment>
      ))}
    </Card>
  )
}

interface RowProps {
  label: string
  sub?: string
  /** Trailing value (mockup: accent links / textFaint muted values). */
  value?: string
  valueColor?: string
  onPress?: () => void
  danger?: boolean
  chevron?: boolean
  right?: React.ReactNode
  disabled?: boolean
  a11y?: string
}

function Row({ label, sub, value, valueColor, onPress, danger, chevron, right, disabled, a11y }: RowProps) {
  const s = useStyles(makeS)
  const dir = useDir()
  const body = (
    <View style={[s.rowInner, { flexDirection: dir.row }]}>
      <View style={s.rowText}>
        <Txt
          size={12.5}
          weight="700"
          color={danger ? C.red : disabled ? C.textDim : C.text}
          numberOfLines={2}
        >
          {label}
        </Txt>
        {sub ? (
          <Txt size={10.5} color={C.textDim} style={s.rowSub}>
            {sub}
          </Txt>
        ) : null}
      </View>
      {right}
      {value ? (
        <Txt size={12.5} weight="600" color={valueColor ?? C.textFaint} numberOfLines={1} style={s.rowValue}>
          {value}
        </Txt>
      ) : null}
      {chevron ? <Icon name={dir.icon.forward} size={14} color={C.textFaint} /> : null}
    </View>
  )
  if (!onPress) {
    return <View style={disabled ? s.rowDisabled : undefined}>{body}</View>
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [pressed && s.pressed, disabled && s.rowDisabled]}
    >
      {body}
    </Pressable>
  )
}

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

// ── Screen ──────────────────────────────────────────────────────────────────

function SettingsInner() {
  const s = useStyles(makeS)
  // useT/useDir subscribe: the whole screen re-renders and mirrors on a
  // language switch, with no restart (never I18nManager.forceRTL).
  const t = useT()
  const dir = useDir()
  const cfg = useStore(connConfig)
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
  const ocOneShot = useStore(ocOneShotAtom)
  const activeTheme = useStore(themeId)
  const [aboutBusy, setAboutBusy] = React.useState(false)
  const [langOpen, setLangOpen] = React.useState(false)
  const [thinkerOpen, setThinkerOpen] = React.useState(false)
  const [thinkerBusy, setThinkerBusy] = React.useState(false)
  const [thinkerStageMsg, setThinkerStageMsg] = React.useState<string | null>(null)
  const [thinkerErr, setThinkerErr] = React.useState<string | null>(null)
  const [thinkerOneShotOffer, setThinkerOneShotOffer] = React.useState(false)
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const [aboutForm, setAboutForm] = React.useState<AboutFields>({ name: '', work: '', extra: '' })
  const [aboutError, setAboutError] = React.useState<string | null>(null)
  // OTA (expo-updates): manual check from the About section. The native side
  // already checks on every launch (CHECK_ON_LAUNCH=ALWAYS) and applies on
  // the next cold start; this row is the immediate/visible path.
  const [updateState, setUpdateState] = React.useState<'idle' | 'checking' | 'ready' | 'uptodate'>('idle')
  const notifPerm = useStore(notificationPermission)
  const linux = useLinuxGuest()
  const runtime = useRuntimeInfo()

  // ── Connection hero ──────────────────────────────────────────────────────
  const connected = state === 'open'
  const connecting = state === 'connecting'
  const stateLabel =
    connected ? t('settings.conn.connected')
    : connecting ? t('settings.conn.connecting')
    : state === 'error' ? t('settings.conn.error')
    : t('settings.conn.offline')
  const pillKind = connected ? 'green' as const : connecting ? 'amber' as const : 'red' as const
  const heroTone = connected ? s.heroConnected : connecting ? s.heroConnecting : s.heroDown
  const heroSub = cfg
    ? cfg.tls ? t('settings.conn.secure') : t('settings.conn.plain')
    : t('settings.conn.noneSub')

  // ── Runtime / Linux rows ────────────────────────────────────────────────
  const runtimeValue = runtime.gw?.ready
    ? t('settings.runtime.running')
    : runtime.gw ? t('settings.runtime.starting') : t('settings.runtime.unavailable')
  const runtimeColor = runtime.gw?.ready ? C.greenSoft : runtime.gw ? C.amber : C.textFaint
  const embeddedSub = runtime.gw?.port
    ? `Mochi ${runtime.gw.hermesVersion ?? '—'} · 127.0.0.1:${runtime.gw.port}`
    : t('settings.runtime.embedded.sub')
  const linuxValue = linux.installed
    ? `${linux.st?.distro ?? 'guest'} · ${linux.st?.sizeMb ?? 0} MB`
    : linux.st?.sizeMb ? t('settings.linux.settingUp') : t('settings.linux.notInstalled')
  const linuxColor = linux.installed ? C.greenSoft : C.textFaint
  const linuxSub = linux.installed ? t('settings.linux.subInstalled') : t('settings.linux.subNone')

  // ── Thinker rows ────────────────────────────────────────────────────────
  const thinkerValue =
    thinker === 'moch' ? t('settings.thinker.moch')
    : ocOneShot ? t('settings.thinker.oneshot')
    : t('settings.thinker.server')
  const thinkerSub =
    thinker === 'moch' ? t('settings.thinker.moch.sub')
    : ocOneShot ? t('settings.thinker.oneshot.sub')
    : t('settings.thinker.server.sub')

  // ── Language picker ─────────────────────────────────────────────────────
  const currentNative = LOCALE_OPTIONS.find((l) => l.id === locale)?.native ?? locale

  // ── Actions (all pre-existing behaviour, copy localized) ────────────────
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
    showAlert(t('settings.about.copied.title'), t('settings.about.diagnosticsCopied'), [
      { text: t('chrome.alert.ok') },
    ])
  }

  const exportTranscript = async () => {
    const text = messages.get().map((m) => `[${new Date(m.ts).toLocaleString(locale)}] ${m.role}: ${m.text}`).join('\n\n')
    if (!text) {
      showAlert(t('settings.about.empty.title'), t('settings.about.noMessages'), [
        { text: t('chrome.alert.ok') },
      ])
      return
    }
    // BUG-077: say so when the clipboard cap clips the export.
    const clipped = text.length > 50000
    await Clipboard.setStringAsync(text.slice(0, 50000))
    showAlert(
      t('settings.about.copied.title'),
      clipped ? t('settings.about.transcriptClipped') : t('settings.about.transcriptCopied'),
      [{ text: t('chrome.alert.ok') }],
    )
  }

  const reconnect = () => {
    void retryNow().catch((e) => showAlert(t('settings.phone.retryFailed'), String(e), [{ text: t('chrome.alert.ok') }]))
  }

  const confirmLinuxReset = () => {
    showAlert(t('settings.linux.reset.title'), t('settings.linux.reset.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.linux.reset.confirm'), style: 'destructive', onPress: () => { void linux.runReset() } },
    ])
  }

  const confirmLinuxReinstall = () => {
    showAlert(t('settings.linux.reinstall.title'), t('settings.linux.reinstall.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.linux.reinstall.confirm'), onPress: () => { void linux.runInstall() } },
    ])
  }

  const openThinkerSheet = () => {
    if (!thinkerBusy) {
      setThinkerErr(null)
      setThinkerStageMsg(null)
      setThinkerOneShotOffer(false)
    }
    setThinkerOpen(true)
  }

  const closeThinkerSheet = () => {
    if (!thinkerBusy) setThinkerOpen(false)
  }

  const retryServerMode = () => {
    if (thinkerBusy) return
    setThinkerBusy(true)
    void (async () => {
      try {
        const inst = await ensureOpencodeInstalled({ autoInstallGuest: true })
        void linux.refresh()
        if (!inst.ok) {
          showAlert(
            t('settings.thinker.retryServer'),
            inst.stderr || t('settings.thinker.installFailed'),
            [{ text: t('chrome.alert.ok') }],
          )
          return
        }
        await setOpencodeOneShot(false)
        showAlert(t('settings.thinker.serverMode.title'), t('settings.thinker.serverMode.body'), [
          { text: t('chrome.alert.ok') },
        ])
      } catch (e) {
        showAlert(
          t('settings.thinker.retryServer'),
          e instanceof Error ? e.message : String(e),
          [{ text: t('chrome.alert.ok') }],
        )
      } finally {
        setThinkerBusy(false)
      }
    })()
  }

  /**
   * Thinker switch: picker sheet instead of the old two-button alert. Picking
   * OpenCode ensures the Linux guest and OpenCode binary are installed and
   * starts the server before switching, offering one-shot fallback if the
   * server fails on-device.
   */
  const chooseThinker = (id: 'moch' | 'opencode') => {
    if (id === thinker || thinkerBusy) return
    if (id === 'opencode') {
      setThinkerBusy(true)
      setThinkerErr(null)
      setThinkerOneShotOffer(false)
      setThinkerStageMsg(t('settings.thinker.checking'))
      void (async () => {
        try {
          const inst = await ensureOpencodeInstalled({
            autoInstallGuest: true,
            onStage: (stage, pct) => {
              if (stage === 'guest') {
                setThinkerStageMsg(t('settings.thinker.installingGuest'))
              } else if (stage === 'downloading') {
                setThinkerStageMsg(
                  pct !== undefined
                    ? t('settings.thinker.downloadingPct', { pct })
                    : t('settings.thinker.downloading'),
                )
              }
            },
          })
          void linux.refresh()
          if (!inst.ok) {
            setThinkerErr(inst.stderr || t('settings.thinker.installFailed'))
            return
          }
          setThinkerStageMsg(t('settings.thinker.starting'))
          const up = await startOpencodeServer()
          if (!up.ok) {
            setThinkerErr(t('settings.thinker.serverFailed'))
            setThinkerOneShotOffer(true)
            return
          }
          await setOpencodeOneShot(false)
          await setThinker('opencode')
          setThinkerOpen(false)
          showAlert(t('settings.thinker.selected.title'), t('settings.thinker.selected.body'), [
            { text: t('chrome.alert.ok') },
          ])
        } catch (e) {
          setThinkerErr(e instanceof Error ? e.message : String(e))
        } finally {
          setThinkerBusy(false)
          setThinkerStageMsg(null)
        }
      })()
      return
    }
    setThinkerBusy(true)
    void (async () => {
      try {
        await stopOpencodeServer()
        await setOpencodeOneShot(false)
        await setThinker('moch')
        setThinkerOpen(false)
      } finally {
        setThinkerBusy(false)
      }
    })()
  }

  const continueThinkerOneShot = async () => {
    if (thinkerBusy) return
    setThinkerBusy(true)
    try {
      await setOpencodeOneShot(true)
      await setThinker('opencode')
      setThinkerOneShotOffer(false)
      setThinkerErr(null)
      setThinkerOpen(false)
    } finally {
      setThinkerBusy(false)
    }
  }

  /** Open the editable About-me sheet, prefilled from the stored profile. */
  const openAbout = () => {
    void (async () => {
      if (aboutBusy) return
      setAboutBusy(true)
      setAboutError(null)
      try {
        const entries = await readAbout()
        setAboutForm(parseAbout(entries))
        setAboutOpen(true)
      } finally {
        setAboutBusy(false)
      }
    })()
  }

  const saveAboutSheet = () => {
    void (async () => {
      if (aboutBusy) return
      setAboutBusy(true)
      setAboutError(null)
      try {
        const r = await saveAbout(aboutForm)
        if (!r.ok) {
          setAboutError(r.error ?? t('settings.about.saveFailedWhy', { why: 'RPC' }))
          return
        }
        setAboutOpen(false)
      } catch (e) {
        setAboutError(e instanceof Error ? e.message : String(e))
      } finally {
        setAboutBusy(false)
      }
    })()
  }

  // Manual OTA check: honest three-way result, restart offer when ready.
  const runUpdateCheck = () => {
    if (updateState === 'checking') return
    setUpdateState('checking')
    void (async () => {
      const r = await checkForMochUpdate()
      if (r.error) {
        showAlert(
          t('settings.updates.check'),
          t('settings.updates.failed', { why: r.error }),
          [{ text: t('chrome.alert.ok') }],
        )
        setUpdateState('idle')
      } else if (r.available) {
        setUpdateState('ready')
        showAlert(t('settings.updates.ready.title'), t('settings.updates.ready.body'), [
          { text: t('common.close'), style: 'cancel' },
          {
            text: t('settings.updates.restart'),
            onPress: () => { void reloadIntoUpdate() },
          },
        ])
      } else {
        setUpdateState('uptodate')
        setTimeout(() => setUpdateState('idle'), 4000)
      }
    })()
  }

  const pickLocale = (id: (typeof LOCALE_OPTIONS)[number]['id']) => {
    void Haptics.selectionAsync()
    void setLocale(id)
    setLangOpen(false)
  }

  return (
    <ScreenShell title={t('settings.title')} showBrand>
      <ScreenScroll contentContainerStyle={s.content}>
        {/* Connection hero (mockup screen 12): tinted Card, mono host:port,
            real gateway state/error, no fake "secure" while disconnected. */}
        <Card style={[s.hero, heroTone]}>
          <View style={[s.heroTop, { flexDirection: dir.row }]}>
            <Txt size={13} weight="700" mono ltr numberOfLines={1} style={s.heroHost}>
              {cfg ? cfg.host : t('settings.conn.none')}
            </Txt>
            <Pill kind={pillKind}>{stateLabel}</Pill>
          </View>
          <Txt size={11.5} color={C.textDim} style={s.heroSub} numberOfLines={2}>
            {heroSub}
          </Txt>
          {err ? (
            <Txt size={10.5} color={C.red} numberOfLines={2} style={s.heroErr}>
              {err}
            </Txt>
          ) : null}
        </Card>

        {/* Appearance — live theme switcher (Mocheme / Relay). */}
        <Section title={t('settings.section.appearance')}>
          <View style={[s.themeRow, { flexDirection: dir.row }]}>
            {THEME_OPTIONS.map((opt) => {
              const active = activeTheme === opt.id
              return (
                <Card
                  key={opt.id}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                    void setTheme(opt.id)
                  }}
                  accessibilityLabel={t(
                    active ? 'settings.theme.cardActiveA11y' : 'settings.theme.cardA11y',
                    { name: opt.name },
                  )}
                  style={[s.themeCard, active && s.themeCardOn]}
                >
                  <View style={[s.themeHead, { flexDirection: dir.row }]}>
                    <View style={[s.themeSwatch, { backgroundColor: opt.swatches[1] }]} />
                    <Txt size={12.5} weight="700">
                      {opt.name}
                    </Txt>
                  </View>
                  <Txt size={10.5} color={C.textDim} numberOfLines={2} style={s.themeCaption}>
                    {t(THEME_CAPTION_KEY[opt.id])}
                  </Txt>
                </Card>
              )
            })}
          </View>
        </Section>

        {/* Language — four locales, applied instantly via setLocale(). */}
        <Section title={t('settings.section.language')}>
          <Group>
            <Row
              label={t('settings.language.label')}
              value={currentNative}
              chevron
              onPress={() => setLangOpen(true)}
              a11y={t('settings.language.rowA11y', { name: currentNative })}
            />
          </Group>
        </Section>

        {/* Runtime & agent — embedded runtime, Linux guest, maintenance, links. */}
        <Section title={t('settings.section.runtime')}>
          <Group>
            <Row
              label={t('settings.runtime.embedded')}
              sub={embeddedSub}
              value={runtimeValue}
              valueColor={runtimeColor}
            />
            <Row
              label={t('settings.linux.title')}
              sub={linuxSub}
              value={linuxValue}
              valueColor={linuxColor}
            />
            <Row
              label={linux.installed ? t('settings.linux.reinstall') : t('settings.linux.install')}
              onPress={() => {
                if (linux.installed) confirmLinuxReinstall()
                else void linux.runInstall()
              }}
              disabled={linux.busy}
              right={linux.busy ? <Spinner size="small" color={C.accent} /> : undefined}
            />
            {linux.installed ? (
              <Row
                label={t('settings.linux.reset')}
                danger
                onPress={confirmLinuxReset}
              />
            ) : null}
            <Row
              label={t('settings.runtime.restart')}
              onPress={() => { void restartEmbeddedRuntime().catch(() => {}) }}
            />
            <Row
              label={t('settings.runtime.battery')}
              value={runtime.battery === 'already' ? t('settings.runtime.battery.exempted') : undefined}
              valueColor={C.greenSoft}
              disabled={runtime.battery === 'already'}
              onPress={runtime.requestExemption}
            />
            <Row
              label={t('settings.runtime.stop')}
              danger
              onPress={() => { void stopEmbeddedRuntime().then(() => { /* process exits shortly */ }).catch(() => {}) }}
            />
            <Row
              label={t('settings.agent.skills')}
              chevron
              onPress={() => router.push('/(tabs)/skills')}
            />
            <Row
              label={t('settings.agent.models')}
              chevron
              onPress={() => router.push('/(tabs)/agent')}
            />
          </Group>
        </Section>

        {/* Thinker & memory — active brain, switch, providers, about me. */}
        <Section title={t('settings.section.thinker')}>
          <Group>
            <Row
              label={t('settings.thinker.active')}
              sub={thinkerSub}
              value={thinkerValue}
              valueColor={C.accent}
            />
            {thinker === 'opencode' && ocOneShot ? (
              <Row
                label={t('settings.thinker.retryServer')}
                sub={t('settings.thinker.retryServer.sub')}
                chevron
                onPress={retryServerMode}
              />
            ) : null}
            <Row
              label={t('settings.thinker.switch')}
              chevron
              onPress={openThinkerSheet}
            />
            <Row
              label={t('settings.thinker.providers')}
              chevron
              onPress={() => router.push('/onboarding/providers')}
            />
            <Row
              label={t('settings.memory.about')}
              value={t('common.edit')}
              chevron
              onPress={openAbout}
            />
          </Group>
        </Section>

        {/* Notifications — background toggle + permission request. */}
        <Section title={t('settings.section.notifications')}>
          <Group>
            <Row
              label={t('settings.notifications.title')}
              right={
                <Toggle
                  value={notifOn}
                  onChange={(v) => { void setNotificationsEnabled(v) }}
                  accessibilityLabel={t('settings.notifications.toggleA11y')}
                />
              }
            />
            {/* #7: once permission is granted the row disappears — the atom
                updates right after ensureNotificationPermission() resolves. */}
            {notifPerm !== 'granted' ? (
              <Row
                label={t('settings.notifications.enable')}
                onPress={() => { void ensureNotificationPermission().catch(() => {}) }}
              />
            ) : null}
          </Group>
        </Section>

        {/* This phone — local-only facts + reconnect action (local-only build
            has no pairing screen, so Disconnect is intentionally omitted). */}
        <Section title={t('settings.section.phone')}>
          <Group>
            <Row label={t('settings.phone.local')} />
            <Row label={t('settings.phone.approvals')} />
          </Group>
          <View style={[s.btnPair, { flexDirection: dir.row }]}>
            <GhostBtn label={t('settings.phone.reconnect')} onPress={reconnect} style={s.btnPairItem} />
          </View>
        </Section>

        {/* About — build info, diagnostics/transcript export, counts. */}
        <Section title={t('settings.section.about')}>
          <Group>
            <Row
              label={`Moch v${appVersion()} (${appBuild()})`}
              disabled
            />
            {otaSupported() ? (
              <Row
                label={
                  updateState === 'checking'
                    ? t('settings.updates.checking')
                    : updateState === 'uptodate'
                      ? t('settings.updates.uptodate')
                      : updateState === 'ready'
                        ? t('settings.updates.ready.row')
                        : t('settings.updates.check')
                }
                chevron={updateState === 'idle'}
                right={updateState === 'checking' ? <Spinner size="small" color={C.accent} /> : undefined}
                onPress={updateState === 'idle' ? runUpdateCheck : undefined}
                disabled={updateState !== 'idle'}
                a11y={t('settings.updates.a11y')}
              />
            ) : null}
          </Group>
          <View style={[s.btnPair, { flexDirection: dir.row }]}>
            <GhostBtn
              label={t('settings.about.copyDiagnostics')}
              onPress={() => { void copyDiagnostics() }}
              style={s.btnPairItem}
            />
            <GhostBtn
              label={t('settings.about.export')}
              onPress={() => { void exportTranscript() }}
              style={s.btnPairItem}
            />
          </View>
          <Txt size={10.5} color={C.textFaint} style={s.aboutCounts}>
            {t('settings.about.counts', { logs: logs.length, msgs: msgCount })}
          </Txt>
        </Section>
      </ScreenScroll>

      {/* Language sheet — native names + check, current highlighted. */}
      <Modal
        visible={langOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setLangOpen(false)}
      >
        <View style={s.sheetRoot}>
          <SheetBackdrop onPress={() => setLangOpen(false)} />
          <SheetCard style={s.sheetCard}>
            <SheetGrabber />
            <View style={[s.sheetHead, { flexDirection: dir.row }]}>
              <Txt size={13.5} weight="800">
                {t('settings.section.language')}
              </Txt>
              <HeaderButton
                onPress={() => setLangOpen(false)}
                accessibilityLabel={t('common.close')}
              >
                <Icon name="close" size={14} color={C.textDim} />
              </HeaderButton>
            </View>
            <Txt size={10.5} color={C.textDim} style={s.sheetHint}>
              {t('settings.language.sheetHint')}
            </Txt>
            {LOCALE_OPTIONS.map((opt) => {
              const active = opt.id === locale
              return (
                <Pressable
                  key={opt.id}
                  onPress={() => pickLocale(opt.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={opt.native}
                  style={({ pressed }) => [
                    s.langRow,
                    { flexDirection: dir.row },
                    active && s.langRowOn,
                    pressed && s.pressed,
                  ]}
                >
                  <Txt size={13.5} weight={active ? '700' : '500'} color={active ? C.accent : C.text}>
                    {opt.native}
                  </Txt>
                  {active ? <Icon name="checkmark" size={16} color={C.accent} /> : null}
                </Pressable>
              )
            })}
          </SheetCard>
        </View>
      </Modal>

      {/* Thinker picker sheet — current thinker selected & locked, the other
          one installs/starts OpenCode or switches back to Moch. */}
      <Modal
        visible={thinkerOpen}
        transparent
        animationType="slide"
        onRequestClose={closeThinkerSheet}
      >
        <View style={s.sheetRoot}>
          <SheetBackdrop onPress={closeThinkerSheet} />
          <SheetCard style={s.sheetCard}>
            <SheetGrabber />
            <View style={[s.sheetHead, { flexDirection: dir.row }]}>
              <Txt size={13.5} weight="800">
                {t('settings.thinker.switch.title')}
              </Txt>
              <HeaderButton
                onPress={closeThinkerSheet}
                disabled={thinkerBusy}
                accessibilityLabel={t('common.close')}
              >
                <Icon name="close" size={14} color={C.textDim} />
              </HeaderButton>
            </View>
            {(
              [
                { id: 'moch' as const, label: t('settings.thinker.moch') },
                { id: 'opencode' as const, label: t('settings.thinker.opencode') },
              ]
            ).map((opt) => {
              const active = opt.id === thinker
              const rowDisabled = active || thinkerBusy
              return (
                <Pressable
                  key={opt.id}
                  onPress={rowDisabled ? undefined : () => chooseThinker(opt.id)}
                  disabled={rowDisabled}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled: rowDisabled }}
                  accessibilityLabel={opt.label}
                  style={({ pressed }) => [
                    s.langRow,
                    { flexDirection: dir.row },
                    active && s.langRowOn,
                    active && s.thinkerRowOn,
                    !active && thinkerBusy && s.rowDisabled,
                    pressed && s.pressed,
                  ]}
                >
                  <Txt
                    size={13.5}
                    weight={active ? '700' : '500'}
                    color={active ? C.accent : C.text}
                  >
                    {opt.label}
                  </Txt>
                  {active ? <Icon name="checkmark" size={16} color={C.accent} /> : null}
                </Pressable>
              )
            })}
            {thinkerBusy ? (
              <View style={[s.thinkerStatusRow, { flexDirection: dir.row }]}>
                <Spinner size="small" color={C.accent} />
                <Txt size={12.5} color={C.textDim} style={s.thinkerStatusText}>
                  {thinkerStageMsg ?? t('settings.thinker.checking')}
                </Txt>
              </View>
            ) : null}
            {thinkerErr ? (
              <Txt size={12} color={C.red} style={s.thinkerError}>
                {thinkerErr}
              </Txt>
            ) : null}
            {thinkerOneShotOffer && !thinkerBusy ? (
              <PrimaryBtn
                onPress={() => void continueThinkerOneShot()}
                accessibilityLabel={t('settings.thinker.oneshot.a11y')}
                label={t('settings.thinker.oneshot.cta')}
                style={s.thinkerOneShotBtn}
              />
            ) : null}
          </SheetCard>
        </View>
      </Modal>

      {/* About-me editor — AGENTS.md pattern #2: RNKC KeyboardAvoidingView as
          the Modal's full-screen root; fields scroll above the IME. */}
      <Modal
        visible={aboutOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAboutOpen(false)}
      >
        <KeyboardAvoidingView style={s.sheetRoot} behavior="padding">
          <SheetBackdrop onPress={() => { if (!aboutBusy) setAboutOpen(false) }} />
          <SheetCard style={s.sheetCard}>
            <SheetGrabber />
            <View style={[s.sheetHead, { flexDirection: dir.row }]}>
              <Txt size={13.5} weight="800">
                {t('settings.memory.about.title')}
              </Txt>
              <HeaderButton
                onPress={() => { if (!aboutBusy) setAboutOpen(false) }}
                accessibilityLabel={t('common.close')}
              >
                <Icon name="close" size={14} color={C.textDim} />
              </HeaderButton>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={s.aboutForm}>
              <Txt size={10.5} color={C.textDim} style={s.aboutLabel}>
                {t('settings.about.field.name')}
              </Txt>
              <Field
                value={aboutForm.name}
                onChangeText={(v) => setAboutForm((f) => ({ ...f, name: v }))}
                placeholder={t('settings.about.field.name')}
                returnKeyType="next"
                accessibilityLabel={t('settings.about.field.name')}
              />
              <Txt size={10.5} color={C.textDim} style={s.aboutLabel}>
                {t('settings.about.field.work')}
              </Txt>
              <Field
                value={aboutForm.work}
                onChangeText={(v) => setAboutForm((f) => ({ ...f, work: v }))}
                placeholder={t('settings.about.field.work')}
                returnKeyType="next"
                accessibilityLabel={t('settings.about.field.work')}
              />
              <Txt size={10.5} color={C.textDim} style={s.aboutLabel}>
                {t('settings.about.field.extra')}
              </Txt>
              <Field
                multiline
                value={aboutForm.extra}
                onChangeText={(v) => setAboutForm((f) => ({ ...f, extra: v }))}
                placeholder={t('settings.about.field.extra')}
                accessibilityLabel={t('settings.about.field.extra')}
              />
              {aboutError ? (
                <Txt size={10.5} color={C.red} style={s.aboutError}>
                  {t('settings.about.saveFailedWhy', { why: aboutError })}
                </Txt>
              ) : null}
              <PrimaryBtn
                label={aboutBusy ? t('settings.about.saving') : t('settings.about.save')}
                onPress={saveAboutSheet}
                disabled={aboutBusy}
                style={s.aboutSave}
              />
            </ScrollView>
          </SheetCard>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  content: { paddingBottom: 44 },
  pressed: { opacity: 0.7 },
  // Connection hero
  hero: { padding: 12 },
  heroConnected: { backgroundColor: C.greenTint, borderColor: 'rgba(74,222,128,0.3)' },
  heroConnecting: { backgroundColor: C.amberSoft, borderColor: 'rgba(245,165,36,0.35)' },
  heroDown: { backgroundColor: C.redSoft, borderColor: 'rgba(255,90,90,0.35)' },
  heroTop: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  heroHost: { flexShrink: 1 },
  heroSub: { lineHeight: 16 },
  heroErr: { marginTop: 4, lineHeight: 14 },
  // Appearance cards
  themeRow: { gap: 8 },
  themeCard: { flex: 1, marginBottom: 0, padding: 10 },
  themeCardOn: { borderColor: C.accent },
  themeHead: { alignItems: 'center', gap: 6, marginBottom: 4 },
  themeSwatch: { width: 12, height: 12, borderRadius: 6 },
  themeCaption: { lineHeight: 14 },
  // Row groups
  group: { padding: 0, overflow: 'hidden', marginBottom: 10 },
  rowInner: { alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  rowSub: { lineHeight: 14 },
  rowValue: { flexShrink: 1, maxWidth: '45%' },
  rowDisabled: { opacity: 0.6 },
  // Button pairs
  btnPair: { gap: 6, marginBottom: 2 },
  btnPairItem: { flex: 1 },
  aboutCounts: { marginTop: 6, marginHorizontal: 2 },
  // Language sheet
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetCard: { paddingBottom: 26 },
  sheetHead: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  sheetHint: { lineHeight: 14, marginBottom: 8 },
  langRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 4,
  },
  langRowOn: { backgroundColor: C.accentSoft },
  thinkerRowOn: { borderColor: C.accent, borderWidth: 1 },
  thinkerStatusRow: { alignItems: 'center', gap: 8, marginTop: 12 },
  thinkerStatusText: { flex: 1, lineHeight: 16 },
  thinkerError: { marginTop: 10, lineHeight: 16 },
  thinkerOneShotBtn: { marginTop: 12 },
  // About-me sheet
  aboutForm: { marginTop: 4 },
  aboutLabel: { marginTop: 10, marginBottom: 4 },
  aboutError: { marginTop: 8, lineHeight: 14 },
  aboutSave: { marginTop: 14 },
})
