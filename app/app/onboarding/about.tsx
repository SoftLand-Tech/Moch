import React, { useEffect, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { router } from 'expo-router'
import { Card, Field, Kicker, Pill, PrimaryBtn, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import { readAbout, saveAbout, setOnboarded } from '../../src/lib/aboutMe'
import { ensureNotificationPermission, hasNotificationPermission } from '../../src/lib/push'
import { requestBatteryExemption } from '../../src/lib/mochiRuntime'
import { thinkerAtom } from '../../src/lib/thinker'

/**
 * Onboarding step 4 — about you, then the two permissions that keep the runtime
 * alive (mockup 19). The answers go into the launch profile's USER.md through
 * MemoryStore, so the agent has them from its first turn.
 */
export default function About() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const [name, setName] = useState('')
  const [work, setWork] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notif, setNotif] = useState(false)
  const [battery, setBattery] = useState(false)
  const thinker = thinkerAtom.get()

  // Prefill from the real on-phone profile (USER.md via moch.profile.about):
  // re-entering onboarding must not make the user retype what Moch knows.
  // Entries are the exact lines saveAbout() writes; anything else is "extra".
  useEffect(() => {
    let alive = true
    void hasNotificationPermission()
      .then((ok) => { if (alive && ok) setNotif(true) })
      .catch(() => {})
    void readAbout()
      .then((entries) => {
        if (!alive) return
        let nameVal = ''
        let workVal = ''
        const rest: string[] = []
        for (const raw of entries) {
          const entry = raw.trim()
          if (!entry) continue
          const nameMatch = /^The user's name is (.+?)\.?$/i.exec(entry)
          if (nameMatch && !nameVal) { nameVal = nameMatch[1]; continue }
          const workMatch = /^What they do: (.+?)\.?$/i.exec(entry)
          if (workMatch && !workVal) { workVal = workMatch[1]; continue }
          rest.push(entry)
        }
        if (nameVal) setName((cur) => cur || nameVal)
        if (workVal) setWork((cur) => cur || workVal)
        if (rest.length) setExtra((cur) => cur || rest.join('\n'))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const finish = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    const r = await saveAbout({ name, work, extra })
    if (!r.ok) {
      // Memory is a nice-to-have: report, but never trap the user in setup.
      setErr(r.error ?? t('setup.about.saveErr'))
    }
    await setOnboarded(true)
    setBusy(false)
    // Pop the pushed onboarding steps so Android Back from Chat exits instead
    // of stepping back into onboarding/providers.
    if (router.canDismiss()) router.dismissAll()
    router.replace('/(tabs)/chat')
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <Txt
          size={10.5}
          weight="800"
          color={C.accent}
          style={[s.kicker, { letterSpacing: dir.rtl ? 0 : 0.84 }]}
        >
          {t('setup.about.kicker')}
        </Txt>
        <Txt size={19} weight="800">{t('setup.about.title')}</Txt>
        <Txt size={11.5} color={C.textDim} style={s.sub}>{t('setup.about.sub')}</Txt>
      </View>

      <KeyboardAwareScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Kicker style={s.kickerFirst}>{t('setup.about.name.label')}</Kicker>
        <Field
          value={name}
          onChangeText={setName}
          placeholder={t('setup.about.name.placeholder')}
          accessibilityLabel={t('setup.about.name.a11y')}
          autoCapitalize="words"
          wrapStyle={s.fieldGap}
        />

        <Kicker>{t('setup.about.work.label')}</Kicker>
        <Field
          value={work}
          onChangeText={setWork}
          placeholder={t('setup.about.work.placeholder')}
          accessibilityLabel={t('setup.about.work.a11y')}
          wrapStyle={s.fieldGap}
        />

        <Kicker>{t('setup.about.extra.label')}</Kicker>
        <Field
          value={extra}
          onChangeText={setExtra}
          placeholder={t('setup.about.extra.placeholder')}
          accessibilityLabel={t('setup.about.extra.a11y')}
          multiline
          wrapStyle={s.fieldGapLast}
        />

        <Card
          onPress={() => { void ensureNotificationPermission().then(setNotif).catch(() => {}) }}
          style={s.permCard}
          accessibilityLabel={t('setup.about.perm.notifications')}
        >
          <View style={[s.permRow, { flexDirection: dir.row }]}>
            <Txt size={12} weight="700" style={s.flex}>{t('setup.about.perm.notifications')}</Txt>
            <Pill kind={notif ? 'green' : 'accent'}>
              {notif ? t('setup.about.perm.notifications.on') : t('setup.about.perm.notifications.off')}
            </Pill>
          </View>
        </Card>
        <Card
          onPress={() => { void requestBatteryExemption().then((r) => setBattery(!!r)).catch(() => {}) }}
          style={s.permCard}
          accessibilityLabel={t('setup.about.perm.battery')}
        >
          <View style={[s.permRow, { flexDirection: dir.row }]}>
            <Txt size={12} weight="700" style={s.flex}>{t('setup.about.perm.battery')}</Txt>
            <Pill kind={battery ? 'green' : 'accent'}>
              {battery ? t('setup.about.perm.battery.done') : t('setup.about.perm.battery.recommended')}
            </Pill>
          </View>
        </Card>

        {thinker === 'opencode' ? (
          <Card style={s.noteCard}>
            <Txt size={11.5} color={C.amber} style={s.noteText}>
              {t('setup.about.opencodeNote')}
            </Txt>
          </Card>
        ) : null}

        {err ? <Txt size={12.5} color={C.red} style={s.error}>{err}</Txt> : null}

        <PrimaryBtn
          onPress={() => void finish()}
          disabled={busy}
          style={s.startBtn}
          accessibilityLabel={t('setup.about.start')}
        >
          {busy ? (
            <Spinner size="small" color={C.onAccent} />
          ) : (
            <Txt size={13.5} weight="700" color={C.onAccent}>{t('setup.about.start')}</Txt>
          )}
        </PrimaryBtn>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 },
  kicker: { textTransform: 'uppercase' },
  sub: { marginTop: 2 },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 32 },
  kickerFirst: { marginTop: 2 },
  flex: { flex: 1 },
  fieldGap: { marginBottom: 6 },
  fieldGapLast: { marginBottom: 8 },
  permCard: { paddingVertical: 9, paddingHorizontal: 11, marginBottom: 10 },
  permRow: { alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  noteCard: {
    backgroundColor: C.amberSoft,
    borderColor: 'rgba(245,165,36,0.3)',
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  noteText: { lineHeight: 17 },
  error: { lineHeight: 18, marginTop: 4, marginBottom: 8 },
  startBtn: { width: '100%', paddingVertical: 11, marginTop: 4 },
})
