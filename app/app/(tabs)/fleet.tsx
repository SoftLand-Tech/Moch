import React, { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useStore } from '@nanostores/react'
import { useRouter } from 'expo-router'
import { ScreenShell } from '../../src/components/ScreenShell'
import {
  Card,
  Dot,
  Elev,
  Field,
  GhostBtn,
  HeaderButton,
  Pill,
  PrimaryBtn,
  Spinner,
  Txt,
} from '../../src/components/ui'
import { Icon } from '../../src/components/Icon'
import { MochiMark } from '../../src/components/MochiMark'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import {
  CreateChecklist,
  DEFAULT_CHECKLIST,
  LaunchSkill,
  createProfile,
  fleetError,
  fleetProfiles,
  fleetStatusAtom,
  freezeProfile,
  listLaunchSkills,
  loadCreateDefaults,
  refreshFleet,
  saveCreateDefaults,
  seedHasSkips,
  slugifyName,
  soulDraft,
  FleetProfile,
} from '../../src/lib/fleet'
import { isConnected } from '../../src/lib/gateway'
import { openBotChat } from '../../src/lib/botChat'
import { showAlert } from '../../src/components/AlertDialog'

/** §2.7 starter templates: tappable job seeds — zero typing path. */
const STARTERS: { labelKey: string; jobKey: string }[] = [
  { labelKey: 'fleet.starter.research', jobKey: 'fleet.starter.research.job' },
  { labelKey: 'fleet.starter.deals', jobKey: 'fleet.starter.deals.job' },
  { labelKey: 'fleet.starter.code', jobKey: 'fleet.starter.code.job' },
  { labelKey: 'fleet.starter.journal', jobKey: 'fleet.starter.journal.job' },
]

/**
 * Fleet (M9.2): the bots surface. Feature-detected (B12): with no profiles the
 * screen is a friendly entry point; the chat experience never changes. Runtime
 * status (queue/waiting) renders only when the gateway runs the fleet runtime.
 *
 * Redesign (mockup screen 7): runtime queue strip → bot cards (status dot +
 * name + Active/Frozen pill, description, Chat / Freeze-Unfreeze row) →
 * create-bot card (idea chips, job field, suggested name, BUG-139 checklist,
 * Cancel/Create) or a full-width "+ New Bot" button.
 */
export default function Fleet() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const router = useRouter()
  const online = useStore(isConnected)
  const profiles = useStore(fleetProfiles)
  const status = useStore(fleetStatusAtom)
  const error = useStore(fleetError)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // A Chat tap resumes the bot's canonical `Bot Chat` (never a fresh session).
  const [opening, setOpening] = useState<string | null>(null)
  // BUG-139 creation checklist: persisted defaults, launch-skill picker.
  const [checklist, setChecklist] = useState<CreateChecklist>(DEFAULT_CHECKLIST)
  const [skillsList, setSkillsList] = useState<LaunchSkill[]>([])
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [createErr, setCreateErr] = useState('')
  const [partial, setPartial] = useState(false)

  const refresh = useCallback(() => {
    if (!online) return
    void refreshFleet().finally(() => setLoading(false))
  }, [online])

  useEffect(refresh, [refresh])

  // Open the create box → restore the user's last checklist + fetch skills
  // (moch.skills.list; older gateways answer nothing and the picker renders
  // its empty state — the checklist never blocks creation).
  useEffect(() => {
    if (!creating) return
    void loadCreateDefaults().then(setChecklist)
    if (!skillsLoaded) {
      void listLaunchSkills().then((l) => {
        setSkillsList(l)
        setSkillsLoaded(true)
      })
    }
  }, [creating, skillsLoaded])

  const frozenSet = new Set((status?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name))

  const create = async () => {
    if (!job.trim() || busy) return
    setBusy('create')
    setCreateErr('')
    setPartial(false)
    try {
      const name = slugifyName(job)
      const r = await createProfile({
        name,
        description: job.trim(),
        soul: soulDraft(job, name),
        checklist,
      })
      if (!r.ok) {
        setCreateErr(t('fleet.create.err', { why: r.error ?? 'profiles.create refused' }))
        return
      }
      // Bot exists — seeding outcome is best-effort and reported, never fatal.
      if (r.seedError) {
        setCreateErr(t('fleet.create.err', { why: r.seedError }))
      } else if (r.seed && seedHasSkips(r.seed)) {
        setPartial(true)
      }
      void saveCreateDefaults(checklist)
      setJob('')
      setCreating(false)
    } catch (e) {
      setCreateErr(t('fleet.create.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(null)
    }
  }

  const toggleFreeze = async (pf: FleetProfile) => {
    if (busy) return
    setBusy(pf.name)
    try {
      await freezeProfile(pf.name, !frozenSet.has(pf.name))
    } catch (e) {
      // #106: freeze/unfreeze failure used to vanish (no catch) — the row
      // just went back to normal with no hint the state never changed.
      showAlert(t('fleet.freeze.failed', { name: pf.name, why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(null)
    }
  }

  // Open a bot's ONE forever-chat (`Bot Chat`) — the exact same hand-off the
  // bot modal and the drawer roster use. Never mints a fresh session: that
  // made every Fleet "Chat" tap look like a new normal chat with extra prompts.
  const openBotConversation = useCallback((name: string) => {
    if (opening) return
    router.navigate('/(tabs)/chat')
    void openBotChat(name).catch((e) => {
      showAlert(t('bot.chat.failed', { why: e instanceof Error ? e.message : String(e) }))
    })
  }, [opening, router, t])

  const waiting = status?.queue.waiting ?? []

  // BUG-133: edge-to-edge means the OS never resizes this screen for the IME —
  // the create-bot box (input + hint + Cancel/Create) docked at the bottom was
  // fully covered the instant autoFocus opened the keyboard. Port of the chat
  // composer's proven pad: the root gets paddingBottom = keyboard height (0
  // closed → full IME open), and createWrap becomes the SINGLE bottom-inset
  // owner (chat's BUG-037/BUG-133 clamp — resting gap above the nav bar, 0
  // while the keys are up, continuous ramp between).
  const insets = useSafeAreaInsets()
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  const createPad = useAnimatedStyle(() => ({
    paddingBottom: Math.max(Math.max(insets.bottom, 10) + kb.height.value, 0),
  }))

  const toggleCheck = (key: 'copyUserMemory' | 'copyMemory') =>
    setChecklist((c) => ({ ...c, [key]: !c[key] }))

  const checkRow = (
    checked: boolean,
    label: string,
    hint: string,
    onToggle: () => void,
  ) => (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityHint={hint}
      style={[s.checkRow, { flexDirection: dir.row }]}
      onPress={onToggle}
    >
      <Ionicons
        name={checked ? 'checkbox-outline' : 'square-outline'}
        size={16}
        color={checked ? C.accent : C.textFaint}
      />
      <Txt size={11.5} color={C.textDim} style={s.checkLabel}>{label}</Txt>
    </Pressable>
  )

  return (
    <SafeAreaView style={s.safe} edges={[]}>
      <ScreenShell
        title={t('fleet.title')}
        showBrand
        right={
          <HeaderButton onPress={refresh} accessibilityLabel={t('fleet.refresh')} style={s.refreshBtn}>
            <Icon name="refresh" size={16} color={C.textDim} />
          </HeaderButton>
        }
      >
        <Animated.View style={[s.body, kbPad]}>
          {error ? (
            <View style={[s.banner, { flexDirection: dir.row }]}>
              <Icon name="alert-circle" size={14} color={C.red} />
              <Txt size={11.5} color={C.red} numberOfLines={2} style={s.bannerText}>
                {`${t('fleet.offline')}: ${error}`}
              </Txt>
            </View>
          ) : null}

          {loading && online ? (
            <View style={s.spinWrap}>
              <Spinner />
            </View>
          ) : (
            <FlatList
              data={profiles}
              keyExtractor={(item) => item.name}
              contentContainerStyle={s.listContent}
              ListHeaderComponent={
                <>
                  {status ? (
                    <Elev style={[s.strip, { flexDirection: dir.row }]}>
                      <View style={[s.stripLeft, { flexDirection: dir.row }]}>
                        <Dot kind={status.fleetEnabled ? 'green' : 'idle'} />
                        <Txt
                          size={11.5}
                          weight="700"
                          color={status.fleetEnabled ? C.greenSoft : C.textDim}
                          numberOfLines={1}
                          style={s.stripText}
                        >
                          {status.fleetEnabled
                            ? t('fleet.runtime.slots', {
                              active: status.queue.active,
                              slots: status.queue.slots,
                            })
                            : t('fleet.runtime.idle')}
                        </Txt>
                      </View>
                      {waiting.length > 0 ? (
                        <Txt
                          size={11.5}
                          color={C.textFaint}
                          accessibilityLabel={t('fleet.waiting', {
                            n: waiting.length,
                            prios: waiting.map((w) => w.priority).join(', '),
                          })}
                        >
                          {t('fleet.runtime.waiting', { n: waiting.length })}
                        </Txt>
                      ) : null}
                    </Elev>
                  ) : null}
                  {partial ? (
                    <Txt size={11.5} color={C.accent} style={s.partial}>
                      {t('fleet.create.partial')}
                    </Txt>
                  ) : null}
                </>
              }
              ListEmptyComponent={
                <View style={s.empty}>
                  <MochiMark size={56} />
                  <Txt size={15} weight="700" center style={s.emptyTitle}>
                    {t('fleet.empty.title')}
                  </Txt>
                  <Txt size={11.5} color={C.textDim} center style={s.emptyBody}>
                    {t('fleet.empty.body')}
                  </Txt>
                </View>
              }
              renderItem={({ item }) => {
                const frozen = frozenSet.has(item.name)
                return (
                  <Card style={frozen ? s.cardFrozen : null}>
                    <View style={[s.cardHead, { flexDirection: dir.row }]}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={item.title}
                        hitSlop={4}
                        onPress={() => router.push({ pathname: '/bot', params: { name: item.name } } as never)}
                        style={[s.nameHit, { flexDirection: dir.row }]}
                      >
                        <Dot kind={frozen ? 'idle' : 'green'} />
                        <Txt size={13.5} weight="800" numberOfLines={1} style={s.cardName}>
                          {item.title}
                        </Txt>
                      </Pressable>
                      <Pill kind={frozen ? 'amber' : 'green'}>
                        {frozen ? t('fleet.frozen') : t('common.active')}
                      </Pill>
                    </View>
                    {item.description ? (
                      <Txt size={12} color={C.textDim} numberOfLines={2} style={s.cardDesc}>
                        {item.description}
                      </Txt>
                    ) : null}
                    <View style={[s.cardBtns, { flexDirection: dir.row }]}>
                      <PrimaryBtn
                        small
                        label={opening === item.name ? t('common.loading') : t('fleet.chat.cta')}
                        accessibilityLabel={t('fleet.chat', { name: item.name })}
                        disabled={opening !== null}
                        onPress={() => { void openBotConversation(item.name) }}
                        style={s.chatBtn}
                      />
                      {item.isDefault ? null : (
                      <GhostBtn
                        small
                        disabled={busy === item.name}
                        accessibilityLabel={frozen
                          ? t('fleet.unfreeze', { name: item.name })
                          : t('fleet.freeze', { name: item.name })}
                        onPress={() => toggleFreeze(item)}
                        style={s.freezeBtn}
                      >
                        {busy === item.name ? (
                          <Spinner size="small" />
                        ) : (
                          <Txt size={11.5} weight="600" color={C.text}>
                            {frozen ? t('fleet.unfreeze.cta') : t('fleet.freeze.cta')}
                          </Txt>
                        )}
                      </GhostBtn>
                      )}
                    </View>
                  </Card>
                )
              }}
            />
          )}

          <Animated.View style={[s.createWrap, createPad]}>
            {creating ? (
              <Card style={s.createBox}>
                <Txt size={13} weight="800" style={s.createTitle}>{t('fleet.create.title')}</Txt>
                <View style={[s.chips, { flexDirection: dir.row }]}>
                  {STARTERS.map((st) => {
                    const active = job === t(st.jobKey)
                    return (
                      <Pill
                        key={st.labelKey}
                        kind={active ? 'accent' : 'neutral'}
                        onPress={() => setJob(t(st.jobKey))}
                      >
                        {t(st.labelKey)}
                      </Pill>
                    )
                  })}
                </View>
                <Field
                  value={job}
                  onChangeText={setJob}
                  placeholder={t('fleet.create.job')}
                  multiline
                  autoFocus
                  style={s.jobInput}
                  wrapStyle={s.jobInputWrap}
                />
                <Txt size={10.5} color={C.textFaint} style={s.suggested}>
                  {t('fleet.create.suggested')}:{' '}
                  <Txt size={10.5} weight="700" color={C.text}>
                    {`@${slugifyName(job) || '…'}`}
                  </Txt>
                </Txt>

                {/* BUG-139 checklist: context/skills enter as FILES (USER.md,
                    skills/), never prompt-stuffing — files persist, are
                    visible/editable in bot detail, and ride hermes' memory
                    machinery. Existing files are never overwritten. */}
                {checkRow(
                  checklist.copyUserMemory,
                  t('fleet.create.copyUser'),
                  t('fleet.create.ideas.hint'),
                  () => toggleCheck('copyUserMemory'),
                )}
                {checkRow(
                  checklist.copyMemory,
                  t('fleet.create.copyMemory'),
                  t('fleet.create.memory.hint'),
                  () => toggleCheck('copyMemory'),
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: skillsOpen }}
                  style={[s.checkRow, { flexDirection: dir.row }]}
                  onPress={() => setSkillsOpen((v) => !v)}
                >
                  <Ionicons
                    name={skillsOpen ? 'chevron-down-outline' : 'chevron-forward-outline'}
                    size={14}
                    color={C.textFaint}
                  />
                  <Txt size={11.5} color={C.textDim} style={s.checkLabel}>
                    {t('fleet.create.skill')}
                  </Txt>
                  {checklist.skills.length > 0 ? (
                    <Pill kind="accent">{String(checklist.skills.length)}</Pill>
                  ) : null}
                </Pressable>
                {skillsOpen ? (
                  skillsLoaded && skillsList.length === 0 ? (
                    <Txt size={10.5} color={C.textFaint} style={s.skillsHint}>
                      {t('fleet.create.skills.empty')}
                    </Txt>
                  ) : (
                    <View style={[s.chips, { flexDirection: dir.row }]}>
                      {skillsList.map((sk) => {
                        const on = checklist.skills.includes(sk.name)
                        return (
                          <Pill
                            key={sk.path}
                            kind={on ? 'accent' : 'neutral'}
                            onPress={() =>
                              setChecklist((c) => ({
                                ...c,
                                skills: on
                                  ? c.skills.filter((n) => n !== sk.name)
                                  : [...c.skills, sk.name],
                              }))}
                          >
                            {sk.name}
                          </Pill>
                        )
                      })}
                    </View>
                  )
                ) : null}
                {createErr ? (
                  <Txt size={11} color={C.red} style={s.createErr}>{createErr}</Txt>
                ) : null}
                <View style={[s.rowBtns, { flexDirection: dir.row }]}>
                  <GhostBtn
                    label={t('fleet.cancel')}
                    onPress={() => setCreating(false)}
                    style={s.rowBtn}
                  />
                  <PrimaryBtn
                    label={t('fleet.create.submit')}
                    onPress={create}
                    disabled={!job.trim() || busy === 'create'}
                    style={s.rowBtn}
                    children={busy === 'create' ? <Spinner size="small" color={C.onAccent} /> : undefined}
                  />
                </View>
              </Card>
            ) : (
              <PrimaryBtn
                label={t('fleet.create.new')}
                onPress={() => {
                  setCreateErr('')
                  setPartial(false)
                  setCreating(true)
                }}
                disabled={!online}
                style={s.newBtn}
              />
            )}
          </Animated.View>
        </Animated.View>
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    body: { flex: 1 },
    banner: {
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingTop: 8,
    },
    bannerText: { flex: 1 },
    spinWrap: { marginTop: 24, alignItems: 'center' },
    refreshBtn: { width: 28, height: 28 },
    listContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 4 },
    strip: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 10,
    },
    stripLeft: { alignItems: 'center', gap: 6, flexShrink: 1 },
    stripText: { flexShrink: 1 },
    partial: { marginBottom: 8 },
    empty: { alignItems: 'center', paddingHorizontal: 12, paddingTop: 32, paddingBottom: 20 },
    emptyTitle: { marginTop: 12 },
    emptyBody: { marginTop: 6, lineHeight: 17 },
    cardFrozen: { opacity: 0.68 },
    cardHead: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 4,
    },
    nameHit: { alignItems: 'center', gap: 7, flexShrink: 1, flexGrow: 1 },
    cardName: { flexShrink: 1 },
    cardDesc: { marginTop: 4, marginBottom: 10, lineHeight: 17 },
    cardBtns: { gap: 6 },
    // Mockup card buttons are compact (padding 6×10) — the kit's 36dp minimum
    // would make the footer taller than the reference.
    chatBtn: { flex: 1, minHeight: 28 },
    freezeBtn: { minHeight: 28 },
    createWrap: { paddingTop: 8, paddingHorizontal: 14 },
    createBox: { borderColor: C.accent, marginBottom: 0 },
    createTitle: { marginBottom: 6 },
    chips: { flexWrap: 'wrap', gap: 4, marginBottom: 7 },
    jobInput: { fontSize: 12, minHeight: 60 },
    jobInputWrap: { marginBottom: 5 },
    suggested: { marginBottom: 8 },
    checkRow: { alignItems: 'center', gap: 4, paddingVertical: 3 },
    checkLabel: { flexShrink: 1 },
    skillsHint: { marginTop: 2, marginBottom: 6 },
    createErr: { marginTop: 6 },
    rowBtns: { gap: 6, marginTop: 10 },
    rowBtn: { flex: 1 },
    newBtn: { width: '100%' },
  })
