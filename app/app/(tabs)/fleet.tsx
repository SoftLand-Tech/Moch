import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import { useRouter } from 'expo-router'
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
import { tr, isRTL } from '../../src/lib/strings'
import { showAlert } from '../../src/components/AlertDialog'

/** §2.7 starter templates: tappable job seeds — zero typing path. */
const STARTERS: { label: string; job: string }[] = [
  { label: 'Research', job: 'Research assistant: read my saved sources daily and brief me on what changed.' },
  { label: 'Deals', job: 'Deal watcher: track product pages I name and notify me on price drops.' },
  { label: 'Code (PC)', job: 'Code helper bound to my linked PC: work in my repos on request.' },
  { label: 'Private journal', job: 'Private journal/finance watcher over my own local files only — never sends anything anywhere.' },
]

/**
 * Fleet (M9.2): the bots surface. Feature-detected (B12): with no profiles the
 * screen is a friendly entry point; the chat experience never changes. Runtime
 * status (queue/waiting) renders only when the gateway runs the fleet runtime.
 */
export default function Fleet() {
  const s = useStyles(makeS)
  const router = useRouter()
  const online = useStore(isConnected)
  const profiles = useStore(fleetProfiles)
  const status = useStore(fleetStatusAtom)
  const error = useStore(fleetError)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
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
        setCreateErr(tr('fleet.create.err', { why: r.error ?? 'profiles.create refused' }))
        return
      }
      // Bot exists — seeding outcome is best-effort and reported, never fatal.
      if (r.seedError) {
        setCreateErr(tr('fleet.create.err', { why: r.seedError }))
      } else if (r.seed && seedHasSkips(r.seed)) {
        setPartial(true)
      }
      void saveCreateDefaults(checklist)
      setJob('')
      setCreating(false)
    } catch (e) {
      setCreateErr(tr('fleet.create.err', { why: e instanceof Error ? e.message : String(e) }))
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
      showAlert(tr('fleet.freeze.failed', { name: pf.name, why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(null)
    }
  }

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

  return (
    <SafeAreaView style={s.safe} edges={[]}>
      <ScreenShell
        title={tr("fleet.title")}
        showBrand
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr('fleet.refresh')}
            onPress={refresh}
            hitSlop={8}
          >
            <Ionicons name="refresh" size={22} color={C.textDim} />
          </Pressable>
        }
      >
        <Animated.View style={[s.body, kbPad]}>
        {error ? <Text style={s.banner}>{tr("fleet.offline")}: {error}</Text> : null}
        {status ? (
          <View style={s.statusRow}>
            <Text style={s.statusText}>
              {status.fleetEnabled
                ? tr('fleet.runtime.active', { active: status.queue.active, slots: status.queue.slots })
                : tr('fleet.runtime.idle')}
            </Text>
            {waiting.length > 0 ? (
              <Text style={s.statusText}>
                {tr('fleet.waiting', { n: waiting.length, prios: waiting.map((w) => w.priority).join(', ') })}
              </Text>
            ) : null}
          </View>
        ) : null}
        {partial ? <Text style={s.notice}>{tr('fleet.create.partial')}</Text> : null}

        {loading && online ? (
          <ActivityIndicator style={s.spin} />
        ) : (
          <FlatList
            data={profiles}
            keyExtractor={(item) => item.name}
            ListEmptyComponent={
              <View style={s.empty}>
                <Ionicons name="people-outline" size={40} color={C.textDim} />
                <Text style={s.emptyTitle}>{tr("fleet.empty.title")}</Text>
                <Text style={s.emptyBody}>{tr("fleet.empty.body")}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const frozen = frozenSet.has(item.name)
              return (
                <Pressable
                  style={s.card}
                  onPress={() => router.push({ pathname: '/bot', params: { name: item.name } } as never)}
                >
                  <View style={s.cardHead}>
                    <Ionicons
                      name={frozen ? 'snow-outline' : 'person-circle-outline'}
                      size={26}
                      color={frozen ? C.accent : C.textDim}
                    />
                    <View style={s.cardTitles}>
                      <Text style={s.cardName}>{item.name}</Text>
                      {!!item.description && (
                        <Text style={s.cardDesc} numberOfLines={2}>
                          {item.description}
                        </Text>
                      )}
                    </View>
                    <Pressable
                      accessibilityLabel={tr("fleet.chat", { name: item.name })}
                      onPress={() => router.navigate({
                        pathname: '/(tabs)/chat',
                        params: { botProfile: item.name },
                      } as never)}
                      style={s.freezeBtn}
                      hitSlop={6}
                    >
                      <Ionicons name="chatbubble-outline" size={18} color={C.textDim} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={frozen ? tr("fleet.unfreeze", { name: item.name }) : tr("fleet.freeze", { name: item.name })}
                      onPress={() => toggleFreeze(item)}
                      disabled={busy === item.name}
                      style={s.freezeBtn}
                      hitSlop={6}
                    >
                      {busy === item.name ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Ionicons
                          name={frozen ? 'play-outline' : 'pause-outline'}
                          size={20}
                          color={C.textDim}
                        />
                      )}
                    </Pressable>
                  </View>
                </Pressable>
              )
            }}
          />
        )}

        <Animated.View style={[s.createWrap, createPad]}>
          {creating ? (
            <View style={s.createBox}>
              <View style={[s.chips, isRTL() && { flexDirection: 'row-reverse' }]}>
                {STARTERS.map((st) => (
                  <Pressable
                    key={st.label}
                    style={[s.chip, job === st.job && s.chipActive]}
                    onPress={() => setJob(st.job)}
                  >
                    <Text style={s.chipText}>{st.label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={s.input}
                placeholder={tr("fleet.create.job")}
                placeholderTextColor={C.textDim}
                value={job}
                onChangeText={setJob}
                multiline
                autoFocus
              />
              <Text style={s.hint}>{tr("fleet.create.suggested")}: {slugifyName(job) || "…"}</Text>

              {/* BUG-139 checklist: context/skills enter as FILES (USER.md,
                  skills/), never prompt-stuffing — files persist, are
                  visible/editable in bot detail, and ride hermes' memory
                  machinery. Existing files are never overwritten. */}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: checklist.copyUserMemory }}
                style={[s.checkRow, isRTL() && { flexDirection: 'row-reverse' }]}
                onPress={() =>
                  setChecklist((c) => ({ ...c, copyUserMemory: !c.copyUserMemory }))}
              >
                <Ionicons
                  name={checklist.copyUserMemory ? 'checkbox-outline' : 'square-outline'}
                  size={18}
                  color={checklist.copyUserMemory ? C.accent : C.textDim}
                />
                <View style={s.checkText}>
                  <Text style={s.checkLabel}>{tr('fleet.create.ideas')}</Text>
                  <Text style={s.checkHint}>{tr('fleet.create.ideas.hint')}</Text>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: checklist.copyMemory }}
                style={[s.checkRow, isRTL() && { flexDirection: 'row-reverse' }]}
                onPress={() =>
                  setChecklist((c) => ({ ...c, copyMemory: !c.copyMemory }))}
              >
                <Ionicons
                  name={checklist.copyMemory ? 'checkbox-outline' : 'square-outline'}
                  size={18}
                  color={checklist.copyMemory ? C.accent : C.textDim}
                />
                <View style={s.checkText}>
                  <Text style={s.checkLabel}>{tr('fleet.create.memory')}</Text>
                  <Text style={s.checkHint}>{tr('fleet.create.memory.hint')}</Text>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: skillsOpen }}
                style={[s.checkRow, isRTL() && { flexDirection: 'row-reverse' }]}
                onPress={() => setSkillsOpen((v) => !v)}
              >
                <Ionicons
                  name={skillsOpen ? 'chevron-down-outline' : 'chevron-forward-outline'}
                  size={16}
                  color={C.textDim}
                />
                <Text style={s.checkLabel}>{tr('fleet.create.skills')}</Text>
                {checklist.skills.length > 0 ? (
                  <Text style={s.checkCount}>{checklist.skills.length}</Text>
                ) : null}
              </Pressable>
              {skillsOpen ? (
                skillsLoaded && skillsList.length === 0 ? (
                  <Text style={s.checkHint}>{tr('fleet.create.skills.empty')}</Text>
                ) : (
                  <View style={[s.chips, isRTL() && { flexDirection: 'row-reverse' }]}>
                    {skillsList.map((sk) => {
                      const on = checklist.skills.includes(sk.name)
                      return (
                        <Pressable
                          key={sk.path}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: on }}
                          style={[s.chip, on && s.chipActive]}
                          onPress={() =>
                            setChecklist((c) => ({
                              ...c,
                              skills: on
                                ? c.skills.filter((n) => n !== sk.name)
                                : [...c.skills, sk.name],
                            }))}
                        >
                          <Text style={s.chipText} numberOfLines={1}>{sk.name}</Text>
                        </Pressable>
                      )
                    })}
                  </View>
                )
              ) : null}
              {createErr ? <Text style={s.createErr}>{createErr}</Text> : null}
              <View style={s.rowBtns}>
                <Pressable style={s.btnGhost} onPress={() => setCreating(false)}>
                  <Text style={s.btnGhostText}>{tr("fleet.cancel")}</Text>
                </Pressable>
                <Pressable
                  style={[s.btn, !job.trim() && s.btnDisabled]}
                  onPress={create}
                  disabled={!job.trim() || busy === 'create'}
                >
                  {busy === 'create' ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text style={s.btnText}>{tr("fleet.create.cta")}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable accessibilityRole="button" style={s.fab} onPress={() => { setCreateErr(''); setPartial(false); setCreating(true) }} disabled={!online}>
              <Ionicons name="add" size={20} color={C.bg} />
              <Text style={s.fabText}>{tr("fleet.create")}</Text>
            </Pressable>
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
    banner: { color: C.red, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
    statusRow: { paddingHorizontal: 16, paddingBottom: 6 },
    statusText: { color: C.textDim, fontSize: 12 },
    spin: { marginTop: 24 },
    empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 48 },
    emptyTitle: { color: C.text, fontSize: 18, fontWeight: '600', marginTop: 12 },
    emptyBody: { color: C.textDim, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
    card: {
      backgroundColor: C.bgCard,
      borderRadius: 14,
      marginHorizontal: 16,
      marginTop: 10,
      padding: 14,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cardTitles: { flex: 1 },
    cardName: { color: C.text, fontSize: 15, fontWeight: '600' },
    cardDesc: { color: C.textDim, fontSize: 12, marginTop: 2 },
    freezeBtn: { padding: 6 },
    createWrap: { padding: 16 },
    chips: { flexDirection: isRTL() ? 'row-reverse' : 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    chip: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 5 },
    chipActive: { backgroundColor: C.accentSoft, borderColor: C.accent },
    chipText: { color: C.textDim, fontSize: 11 },
    createBox: {
      backgroundColor: C.bgCard,
      borderRadius: 14,
      padding: 12,
    },
    input: {
      color: C.text,
      minHeight: 60,
      fontSize: 14,
      textAlignVertical: 'top',
      padding: 8,
      borderRadius: 8,
      backgroundColor: C.bg,
    },
    hint: { color: C.textDim, fontSize: 11, marginTop: 6 },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10 },
    checkText: { flex: 1 },
    checkLabel: { color: C.text, fontSize: 13, fontWeight: '500' },
    checkHint: { color: C.textFaint, fontSize: 11, marginTop: 2, lineHeight: 15 },
    checkCount: {
      color: C.bg, backgroundColor: C.accent, borderRadius: 8,
      paddingHorizontal: 7, paddingVertical: 1, fontSize: 11, overflow: 'hidden',
    },
    createErr: { color: C.red, fontSize: 11, marginTop: 8 },
    notice: { color: C.accent, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
    rowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
    btn: {
      backgroundColor: C.accent,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: C.bg, fontWeight: '600', fontSize: 13 },
    btnGhost: { paddingHorizontal: 12, paddingVertical: 9 },
    btnGhostText: { color: C.textDim, fontSize: 13 },
    fab: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: C.accent,
      borderRadius: 12,
      paddingVertical: 12,
    },
    fabText: { color: C.bg, fontWeight: '700' },
  })
