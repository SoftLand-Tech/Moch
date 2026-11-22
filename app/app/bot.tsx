import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
// BUG-133: desc + multiline SOUL inputs had zero avoidance (Save row and the
// danger zone sat under the IME), and the missing keyboardShouldPersistTaps
// made the first tap on Save just dismiss the keyboard (RN default ≡ 'never').
// KeyboardAwareScrollView fixes both: viewport above the keys, focused field
// scrolled in, taps delivered while the IME is open.
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Card,
  Field,
  GhostBtn,
  Kicker,
  Pill,
  PrimaryBtn,
  Spinner,
  Txt,
} from '../src/components/ui'
import { Icon } from '../src/components/Icon'
import { showAlert } from '../src/components/AlertDialog'
import { C, useStyles } from '../src/lib/theme'
import { rpc } from '../src/lib/gateway'
import { fleetProfiles, refreshFleet, setActiveBot } from '../src/lib/fleet'
import { openBotChat } from '../src/lib/botChat'
import { taskSessionRows, type TaskSessionRow } from '../src/lib/botRosterMeta'
import { openServerSession } from '../src/lib/chat'
import { useDir, useT } from '../src/lib/strings'
import { useStore } from '@nanostores/react'

/**
 * Bot detail (M9.2): SOUL viewer/editor, description, freeze, chat hand-off,
 * delete wizard (§2.7/§2.1 — tombstone stops schedules by construction;
 * kanban reassignment lands with M9.4 and the wizard says so).
 *
 * Redesign (mockup screen 13 — presented as a root-stack modal): custom header
 * (Back / name + brand / round chat button), optional no-provider amber card,
 * Job + SOUL fields, save row with saved pill, and the 3-tap armed danger
 * zone. The root ScreenShell is intentionally not used here — the mockup's
 * modal header replaces it while keeping the same navigation behavior.
 */
export default function BotDetail() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const router = useRouter()
  const { name } = useLocalSearchParams<{ name?: string }>()
  const bot = name ?? ''
  const profiles = useStore(fleetProfiles)
  // Native Bot Mode identity: the marker title is what the roster calls this
  // bot; the folder id stays the RPC handle (profiles.* take `name`).
  const botTitle = profiles.find((p) => p.name === bot)?.title || bot
  const [soul, setSoul] = useState<string>('')
  const [desc, setDesc] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [noProvider, setNoProvider] = useState(false)
  const [mirroring, setMirroring] = useState(false)
  const [opening, setOpening] = useState(false)
  const [tasks, setTasks] = useState<TaskSessionRow[]>([]) 
  const [tasksLoading, setTasksLoading] = useState(false)

  const load = useCallback(async () => {
    if (!bot) return
    try {
      // BUG-108: the `profiles.*` family resolves `params["name"]`
      // (`tui_gateway/methods_profiles.py::_resolve_profile` — 4063 "name
      // required" otherwise); only the `moch.*` family takes `profile`. This
      // screen sent `profile`, so describe failed silently (the editor opened
      // blank for a bot that has a description and a SOUL) and configure was a
      // silent no-op on Save. `profiles.create` in fleet.ts has always used
      // `name` — this is the same contract.
      const res = await rpc<{ result?: { soul?: string; description?: string } }>(
        'profiles.describe', { name: bot }, 15000)
      const r = (res as { result?: { soul?: string; description?: string } }).result ?? res
      setSoul((r as { soul?: string }).soul ?? '')
      setDesc((r as { description?: string }).description ?? '')
      setNoProvider(!((r as { model?: { provider?: string } }).model?.provider))
    } catch {
      // profile listing stays authoritative; editor starts blank on failure
    } finally {
      setLoading(false)
    }
    // Hermes-side task sessions: separate from the canonical Bot Chat. Shown
    // read-only so legacy/side conversations stay reachable (they are not
    // chats in the drawer anymore) and so a task session is visibly NOT the
    // bot's permanent home. Best-effort.
    setTasksLoading(true)
    try {
      const res = await rpc<{ sessions?: unknown[] }>('session.list', { profile: bot, limit: 50 }, 15000)
      setTasks(taskSessionRows(res?.sessions))
    } catch {
      setTasks([])
    } finally {
      setTasksLoading(false)
    }
  }, [bot])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await rpc('profiles.configure', { name: bot, soul, description: desc }, 20000)
      setSavedAt(Date.now())
      void refreshFleet()
    } catch (e) {
      // #107: try/finally with no catch let the rejection escape as an
      // unhandled promise (silent on some surfaces) while the stale
      // "saved" indicator stayed up from an earlier success.
      setSavedAt(null)
      showAlert(t('bot.save.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }

  const connectProvider = async () => {
    if (mirroring) return
    setMirroring(true)
    try {
      const res = await rpc<{ mirrored?: string[] }>(
        'moch.profiles.mirror_model_key', { profile: bot }, 15000)
      const keys = res.mirrored ?? []
      showAlert(
        keys.length ? t('bot.provider.connected.title') : t('bot.provider.nothing.title'),
        keys.length
          ? t('bot.provider.connected.body', { keys: keys.join(', ') })
          : t('bot.provider.nothing.body'),
      )
      setNoProvider(false)
    } catch (e) {
      showAlert(t('bot.provider.failed.title'), e instanceof Error ? e.message : String(e))
    } finally {
      setMirroring(false)
    }
  }

  // BUG-110 (second cause): the guard used to read `confirmDelete < 2`, but the
  // second tap calls doDelete() from the render where confirmDelete is still 1 —
  // React state updates are async, so the guard returned immediately and the
  // delete never fired (the button then sat on "deleting…" until the screen was
  // remounted). Verified on device: two taps left the bot in /api/profiles while
  // the same RPC called directly returned {"deleted": "…"}. Only `deleting`
  // guards now; the armed tap is the confirmation.
  const doDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      await rpc('moch.profiles.delete', { profile: bot, confirm: true }, 20000)
      await setActiveBot(null)
      void refreshFleet()
      router.back()
    } catch (e) {
      // #107: surface the failure instead of swallowing it, and re-arm the
      // wizard — otherwise the button sat on "Tap again to confirm deletion"
      // with nothing to tap into.
      setConfirmDelete(0)
      showAlert(t('bot.delete.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setDeleting(false)
    }
  }

  // Canonical Bot Chat hand-off (UI-1): a bot's row opens its ONE forever-chat
  // (`Bot Chat`), never a fresh per-visit session. openBotChat resolves the
  // exact-title chat, mints it only when the profile truly has none, and
  // single-flights per profile — so a double-tap cannot mint two.
  const openChat = async () => {
    if (!bot || opening) return
    setOpening(true)
    try {
      await openBotChat(bot)
      router.navigate('/(tabs)/chat')
    } catch (e) {
      showAlert(t('bot.chat.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setOpening(false)
    }
  }

  // Task sessions belong to the bot profile but are NOT the Bot Chat: they open
  // as ordinary chats (launch identity, bot pill cleared) with a banner naming
  // the bot, and never replace/reset the canonical conversation.
  const openTask = async (id: string) => {
    if (!id) return
    try {
      await openServerSession(id, {
        profile: bot,
        banner: t('bot.tasks.banner', { name: botTitle || bot }),
      })
      router.navigate('/(tabs)/chat')
    } catch (e) {
      showAlert(t('bot.tasks.failed', { why: e instanceof Error ? e.message : String(e) }))
    }
  }

  const armed = confirmDelete > 0 || deleting
  const deleteLabel = deleting
    ? t('bot.delete.actionDoing')
    : confirmDelete === 0
      ? t('bot.delete.action')
      : t('bot.delete.actionConfirm')

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={[s.header, { flexDirection: dir.row }]}>
        <GhostBtn
          small
          onPress={() => router.back()}
          accessibilityLabel={t('common.back')}
          style={[s.backBtn, { flexDirection: dir.row }]}
        >
          <Icon name={dir.icon.back} size={14} color={C.text} />
          <Txt size={12} weight="600" color={C.text}>{t('common.back')}</Txt>
        </GhostBtn>
        <View style={s.titleBlock}>
          <Txt size={14.5} weight="800" center numberOfLines={1} style={s.titleName}>
            {botTitle || t('bot.fallbackName')}
          </Txt>
          <Txt size={9.5} weight="700" center color={C.textFaint} style={s.brand}>
            {t('bot.brand')}
          </Txt>
        </View>
        <PrimaryBtn
          onPress={openChat}
          disabled={opening}
          accessibilityLabel={t('bot.chat', { name: botTitle || bot })}
          style={s.chatBtn}
        >
          {opening ? (
            <Spinner size="small" color={C.onAccent} />
          ) : (
            <Icon name="chatbubble-outline" size={16} color={C.onAccent} />
          )}
        </PrimaryBtn>
      </View>

      {loading ? (
        <View style={s.spinWrap}>
          <Spinner />
        </View>
      ) : (
        <KeyboardAwareScrollView
          style={s.scroll}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
        >
          {noProvider ? (
            <Card style={s.warnCard}>
              <Txt size={12.5} weight="700" color={C.amber} style={s.warnTitle}>
                {t('bot.noprov.title')}
              </Txt>
              <Txt size={11.5} color={C.textDim} style={s.warnBody}>
                {t('bot.noprov.body')}
              </Txt>
              <PrimaryBtn
                small
                label={t('bot.noprov.cta')}
                onPress={connectProvider}
                disabled={mirroring}
                style={s.warnBtn}
                children={mirroring ? <Spinner size="small" color={C.onAccent} /> : undefined}
              />
            </Card>
          ) : null}

          <Kicker style={s.firstKicker}>{t('bot.jobKicker')}</Kicker>
          <Field
            value={desc}
            onChangeText={setDesc}
            placeholder={t('bot.jobPlaceholder')}
          />

          <Kicker>{t('bot.soulKicker')}</Kicker>
          <Field
            value={soul}
            onChangeText={setSoul}
            multiline
            textAlignVertical="top"
            style={s.soulInput}
          />

          <View style={[s.saveRow, { flexDirection: dir.row }]}>
            <PrimaryBtn
              label={t('bot.save.cta')}
              onPress={save}
              disabled={saving}
              children={saving ? <Spinner size="small" color={C.onAccent} /> : undefined}
            />
            {savedAt ? (
              <Pill kind="green">{t('bot.savedBadge')}</Pill>
            ) : (
              <Txt size={11} color={C.textFaint}>{t('bot.synced')}</Txt>
            )}
          </View>

          <Kicker style={s.tasksKicker}>{t('bot.tasks.kicker')}</Kicker>
          <Card>
            <Txt size={11} color={C.textFaint} style={s.tasksHint}>
              {t('bot.tasks.hint')}
            </Txt>
            {tasksLoading ? (
              <View style={s.tasksSpin}>
                <Spinner size="small" />
              </View>
            ) : tasks.length === 0 ? (
              <Txt size={11.5} color={C.textDim}>{t('bot.tasks.empty')}</Txt>
            ) : (
              tasks.map((task) => (
                <Pressable
                  key={task.id}
                  accessibilityRole="button"
                  accessibilityLabel={task.title || t('bot.tasks.untitled')}
                  onPress={() => { void openTask(task.id) }}
                  style={({ pressed }) => [s.taskRow, { flexDirection: dir.row }, pressed && s.taskRowPressed]}
                >
                  <Icon name="git-branch-outline" size={13} color={C.textDim} />
                  <View style={s.taskText}>
                    <Txt size={12} weight="600" numberOfLines={1} style={s.taskTitle}>
                      {task.title || t('bot.tasks.untitled')}
                    </Txt>
                    {task.preview ? (
                      <Txt size={11} color={C.textDim} numberOfLines={1}>{task.preview}</Txt>
                    ) : null}
                  </View>
                  <Icon name={dir.icon.forward} size={12} color={C.textFaint} />
                </Pressable>
              ))
            )}
          </Card>

          <Kicker style={s.dangerKicker}>{t('bot.delete.title')}</Kicker>
          <Card style={s.dangerCard}>
            <Txt size={11.5} color={C.textDim} style={s.dangerBody}>
              {t('bot.delete.desc', { name: bot })}
            </Txt>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={deleteLabel}
              accessibilityState={{ disabled: deleting }}
              disabled={deleting}
              onPress={() => {
                if (confirmDelete === 0) { setConfirmDelete(1); return }
                if (confirmDelete === 1) { setConfirmDelete(2); void doDelete() }
              }}
              style={[s.deleteBtn, { flexDirection: dir.row }, armed && s.deleteArmed]}
            >
              <Txt size={12} weight="700" center color={armed ? '#FFFFFF' : C.red}>
                {deleteLabel}
              </Txt>
            </Pressable>
          </Card>
        </KeyboardAwareScrollView>
      )}
    </SafeAreaView>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    header: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      minHeight: 44,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderBottomWidth: 1,
      borderBottomColor: C.border,
    },
    backBtn: { paddingVertical: 5, paddingHorizontal: 10, minHeight: 30 },
    titleBlock: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
    titleName: { maxWidth: '100%' },
    brand: { letterSpacing: 0.76, textTransform: 'uppercase', marginTop: 1 },
    chatBtn: {
      width: 32,
      height: 32,
      minHeight: 32,
      borderRadius: 16,
      paddingVertical: 0,
      paddingHorizontal: 0,
    },
    scroll: { flex: 1 },
    spinWrap: { marginTop: 24, alignItems: 'center' },
    body: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 24 },
    warnCard: {
      backgroundColor: C.amberSoft,
      borderColor: 'rgba(245,165,36,0.35)',
    },
    warnTitle: { marginBottom: 4 },
    warnBody: { marginBottom: 8, lineHeight: 17 },
    warnBtn: { alignSelf: 'flex-start', minHeight: 28, paddingHorizontal: 12 },
    firstKicker: { marginTop: 2 },
    soulInput: { minHeight: 112, lineHeight: 19 },
    saveRow: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginTop: 10,
    },
    tasksKicker: { marginTop: 22 },
    tasksHint: { lineHeight: 16, marginBottom: 8 },
    tasksSpin: { paddingVertical: 8 },
    taskRow: { alignItems: 'center', gap: 8, paddingVertical: 7 },
    taskRowPressed: { opacity: 0.6 },
    taskText: { flex: 1, minWidth: 0 },
    taskTitle: { marginBottom: 1 },
    dangerKicker: { color: C.red, marginTop: 22 },
    dangerCard: {
      backgroundColor: C.redSoft,
      borderColor: 'rgba(255,90,90,0.3)',
    },
    dangerBody: { lineHeight: 17, marginBottom: 8 },
    deleteBtn: {
      width: '100%',
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.red,
      alignItems: 'center',
      justifyContent: 'center',
    },
    deleteArmed: { backgroundColor: C.red },
  })
