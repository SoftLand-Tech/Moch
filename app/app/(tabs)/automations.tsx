import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, StyleSheet, Pressable, RefreshControl } from 'react-native'
import {
  KeyboardAwareScrollView,
  type KeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import * as Clipboard from 'expo-clipboard'
import { Icon } from '../../src/components/Icon'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { MochiMark } from '../../src/components/MochiMark'
import { Card, Field, GhostBtn, Kicker, Pill, PrimaryBtn, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { rpc, isConnected as isConnectedAtom, retryNow } from '../../src/lib/gateway'
import { ensureSession } from '../../src/lib/chat'
import { runningAutomationCount, countRunningJobs } from '../../src/lib/automationsState'
import { localeAtom, tr, useDir, useT } from '../../src/lib/strings'

interface Job {
  job_id: string
  name?: string
  schedule?: string
  prompt_preview?: string
  repeat?: string | null
  deliver?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  last_fire_error?: string | null
  last_delivery_error?: string | null
  enabled?: boolean
  state?: string | null
  paused_reason?: string | null
}

type TFn = (key: string, vars?: Record<string, string | number>) => string

/** Shell-quote a value for /cron edit flags — schedules contain spaces ("every 30m"). */
function shq(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Localized "next run" pill label. Same buckets as the pre-redesign helper, but
 * the copy now comes from the automations catalog so zh/fr/ar read naturally.
 */
function nextLabel(iso: string | null | undefined, t: TFn): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = at - Date.now()
  if (diff < 0) return t('automations.next.due')
  if (diff < 3_600_000) return t('automations.next.minutes', { n: Math.round(diff / 60_000) })
  if (diff < 86_400_000) return t('automations.next.hours', { n: Math.round(diff / 3_600_000) })
  return t('automations.next.days', { n: Math.round(diff / 86_400_000) })
}

/** Absolute timestamp for the expanded detail block, localized (SPEC §3). */
function fmtFull(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  try {
    return new Date(at).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * Scheduled automations — the Hermes equivalent of ChatGPT's "Scheduled".
 * Backed by the real surface: `cron.manage` (list/add/get/remove/pause/resume)
 * and `slash.exec /cron` for run-now and edit (edit flags are shell-quoted).
 *
 * Redesign (mockup screen 9): the new/edit form is an accent-bordered Card at
 * the top of the app-scroll (it used to be a full-screen Modal), the whole
 * scroll is a KeyboardAwareScrollView so the multiline prompt clears the IME
 * (BUG-133 form pattern), and every visible string is localized in four
 * locales.
 */
export default function Automations() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <AutomationsInner />
    </SafeAreaView>
  )
}

function AutomationsInner() {
  const s = useStyles(makeS)
  // useT subscribes: an open screen re-translates on a language switch.
  const t = useT()
  const dir = useDir()
  const locale = useStore(localeAtom)
  const online = useStore(isConnectedAtom)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Which job id was just copied — drives the mockup's "Copied ✓" chip state.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null)
  // Add/edit form. jobId === null → add mode; set → edit mode.
  // loadedPrompt: the prompt exactly as loaded from the gateway (full text
  // after the 'get' fetch) — the save dirty-check compares against it so a
  // schedule-only edit never re-sends --prompt. promptDegraded: the full
  // fetch failed and the field holds the 100-char preview.
  const [form, setForm] = useState<{ jobId: string | null; name: string; schedule: string; prompt: string; loadedPrompt: string | null; promptDegraded: boolean; saving: boolean } | null>(null)

  const load = useCallback(async () => {
    if (!online) {
      setLoading(false)
      return
    }
    setError(null)
    try {
      // include_disabled: without it paused jobs are omitted — a toggle UI
      // would lose the job it just paused (and could never resume it).
      const res = await rpc<{ jobs?: Job[] }>('cron.manage', { action: 'list', include_disabled: true })
      setJobs(res?.jobs ?? [])
      // The sidebar's mini-Mochi row mirrors every load here, so pause /
      // resume / remove / add update it instantly.
      runningAutomationCount.set(countRunningJobs(res?.jobs ?? []))
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('automations.error.load'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [online])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  // Transient status line ("Saved", "Queued to run") fades after a few seconds.
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 4000)
    return () => clearTimeout(timer)
  }, [status])

  // "Copied ✓" chip label returns to "Tap to copy" after a moment.
  useEffect(() => {
    if (!copiedId) return
    const timer = setTimeout(() => setCopiedId(null), 2000)
    return () => clearTimeout(timer)
  }, [copiedId])

  /** Run a /cron subcommand through slash.exec; it needs a live session id. */
  const cronSlash = useCallback(async (command: string): Promise<string> => {
    const sid = await ensureSession()
    const r = await rpc<{ output?: string }>('slash.exec', { session_id: sid, command })
    return (r?.output ?? '').trim()
  }, [])

  const withBusy = async (jobId: string, fn: () => Promise<void>) => {
    setBusyJob(jobId)
    try {
      await fn()
    } catch (e) {
      showAlert(tr('automations.alert.actionFailed'), e instanceof Error ? e.message : String(e))
    } finally {
      setBusyJob(null)
    }
  }

  const toggle = (j: Job) =>
    withBusy(j.job_id, async () => {
      const action = j.enabled === false ? 'resume' : 'pause'
      await rpc('cron.manage', { action, name: j.job_id })
      setStatus(
        tr(action === 'pause' ? 'automations.status.paused' : 'automations.status.resumed', {
          name: j.name ?? j.job_id,
        }),
      )
      await load()
    })

  const runNow = (j: Job) =>
    withBusy(j.job_id, async () => {
      const out = await cronSlash(`/cron run ${j.job_id}`)
      setStatus(out.split('\n')[0] || tr('automations.status.queued', { name: j.name ?? j.job_id }))
    })

  const remove = (j: Job) =>
    showAlert(tr('automations.alert.deleteTitle'), j.name ?? j.job_id, [
      { text: tr('common.cancel'), style: 'cancel' },
      {
        text: tr('common.delete'),
        style: 'destructive',
        onPress: () =>
          withBusy(j.job_id, async () => {
            await rpc('cron.manage', { action: 'remove', name: j.job_id })
            setStatus(tr('automations.status.deleted', { name: j.name ?? j.job_id }))
            await load()
          }),
      },
    ])

  const saveForm = async () => {
    if (!form) return
    const schedule = form.schedule.trim()
    const prompt = form.prompt.trim()
    const name = form.name.trim()
    // #108: an unmodified prompt is omitted from the edit command — the
    // backend's /cron edit overwrites the stored prompt whenever --prompt is
    // present, so a schedule-only edit must never re-send it (least of all
    // the truncated preview).
    const promptUnchanged = !!form.jobId && form.loadedPrompt !== null && prompt === form.loadedPrompt.trim()
    if (!schedule || (!prompt && !promptUnchanged) || (!form.jobId && !name)) {
      showAlert(tr('automations.alert.missing.title'), tr('automations.alert.missing.body'), [
        { text: tr('chrome.alert.ok') },
      ])
      return
    }
    setForm({ ...form, saving: true })
    try {
      if (form.jobId) {
        // /cron edit has no --name; schedule + prompt are the editable levers.
        const promptFlag = promptUnchanged ? '' : ` --prompt ${shq(prompt)}`
        const out = await cronSlash(`/cron edit ${form.jobId} --schedule ${shq(schedule)}${promptFlag}`)
        setStatus(out.split('\n')[0] || tr('automations.status.updated'))
      } else {
        await rpc('cron.manage', { action: 'add', name, schedule, prompt })
        setStatus(tr('automations.status.created', { name }))
      }
      setForm(null)
      await load()
    } catch (e) {
      showAlert(
        form.jobId ? tr('automations.alert.editFailed') : tr('automations.alert.createFailed'),
        e instanceof Error ? e.message : String(e),
        [{ text: tr('chrome.alert.ok') }],
      )
      setForm({ ...form, saving: false })
    }
  }

  /** Form sits at the top of the scroll — make sure it is on screen. */
  const revealForm = () => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }))
  }

  const openAdd = () => {
    if (form?.saving) return
    setForm({ jobId: null, name: '', schedule: '', prompt: '', loadedPrompt: null, promptDegraded: false, saving: false })
    revealForm()
  }

  /**
   * #108: prompt_preview is truncated at 100 chars — opening the editor from
   * it and saving would silently rewrite the stored prompt to the truncated
   * text. Fetch the full prompt via cron.manage 'get'; the preview is only a
   * fallback (with a banner saying so, and the save dirty-check keeps it from
   * being written back).
   */
  const openEdit = async (j: Job) => {
    setForm({ jobId: j.job_id, name: j.name ?? '', schedule: j.schedule ?? '', prompt: j.prompt_preview ?? '', loadedPrompt: null, promptDegraded: false, saving: false })
    revealForm()
    try {
      const r = await rpc<{ job?: { prompt?: string } }>('cron.manage', { action: 'get', name: j.job_id })
      const full = r?.job?.prompt
      if (typeof full !== 'string') throw new Error('cron.manage get: no job in response')
      setForm((f) => (f && f.jobId === j.job_id ? { ...f, prompt: full, loadedPrompt: full } : f))
    } catch {
      // Older gateway (no 'get' action) or the RPC failed: keep the preview,
      // mark the form degraded so the user knows it is truncated.
      setForm((f) => (f && f.jobId === j.job_id ? { ...f, loadedPrompt: j.prompt_preview ?? '', promptDegraded: true } : f))
    }
  }

  const copyId = async (j: Job) => {
    await Clipboard.setStringAsync(j.job_id)
    setCopiedId(j.job_id)
  }

  // Only claim "nothing scheduled" when the gateway could actually answer —
  // offline keeps the offline notice as the single explanation.
  const showEmpty = online && !loading && jobs.length === 0 && !error && !form

  return (
    <ScreenShell
      title={t('automations.title')}
      showBrand
      right={
        <Pressable
          onPress={openAdd}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('automations.newA11y')}
          style={({ pressed }) => [s.fab, pressed && s.pressed]}
        >
          <Icon name="add" size={18} color={C.onAccent} />
        </Pressable>
      }
    >
      {/* BUG-133: scrollable forms use KeyboardAwareScrollView with
          keyboardShouldPersistTaps="handled" so the cron/prompt fields clear
          the IME (the repo's proven form pattern, mockup §7). */}
      <KeyboardAwareScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={C.textDim}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
            }}
          />
        }
      >
        <Txt size={11.5} color={C.textDim} style={s.intro}>
          {t('automations.intro')}
        </Txt>

        {status ? (
          <View style={[s.statusRow, { flexDirection: dir.row }]}>
            <Icon name="checkmark-circle" size={13} color={C.greenSoft} />
            <Txt size={12} weight="600" color={C.greenSoft} style={s.statusText}>
              {status}
            </Txt>
          </View>
        ) : null}

        {error ? (
          <Pressable
            style={({ pressed }) => [s.notice, s.noticeError, pressed && s.pressed]}
            onPress={() => {
              setLoading(true)
              void load()
            }}
            accessibilityRole="button"
          >
            <Txt size={12} weight="700" color={C.red} center>
              {t('automations.error.retry', { error })}
            </Txt>
          </Pressable>
        ) : null}

        {!online ? (
          <Pressable
            style={({ pressed }) => [s.notice, s.noticeOffline, pressed && s.pressed]}
            onPress={() => {
              void retryNow().catch(() => {})
            }}
            accessibilityRole="button"
          >
            <Txt size={12} weight="700" color={C.amber} center>
              {t('automations.offline')}
            </Txt>
          </Pressable>
        ) : null}

        {loading ? (
          <View style={s.loadWrap}>
            <Spinner color={C.accent} />
          </View>
        ) : null}

        {/* New / edit automation — accent-bordered Card at the top of the
            scroll (mockup screen 9 `stateKey === 'modal'`). */}
        {form ? (
          <Card style={s.formCard}>
            <Txt size={13.5} weight="800" style={s.formTitle}>
              {form.jobId ? t('automations.form.editTitle') : t('automations.form.newTitle')}
            </Txt>

            <Kicker style={s.formKicker}>{t('automations.form.name')}</Kicker>
            {form.jobId ? (
              <Txt size={13} color={C.textDim} numberOfLines={1} style={s.formLocked}>
                {form.name || form.jobId}
              </Txt>
            ) : (
              <Field
                value={form.name}
                onChangeText={(v) => setForm((f) => (f ? { ...f, name: v } : f))}
                placeholder={t('automations.form.name.placeholder')}
                autoCapitalize="none"
                accessibilityLabel={t('automations.form.nameA11y')}
              />
            )}

            <Kicker style={s.formKicker}>{t('automations.form.schedule')}</Kicker>
            <Field
              value={form.schedule}
              onChangeText={(v) => setForm((f) => (f ? { ...f, schedule: v } : f))}
              placeholder={t('automations.form.schedule.placeholder')}
              mono
              ltr
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t('automations.form.scheduleA11y')}
            />
            <Txt size={10.5} color={C.textFaint} style={s.formHint}>
              {t('automations.form.schedule.hint')}
            </Txt>

            <Kicker style={s.formKicker}>{t('automations.form.prompt')}</Kicker>
            {form.promptDegraded ? (
              <Txt size={10.5} color={C.amber} style={s.formWarn}>
                {tr('automations.promptLoadFailed')}
              </Txt>
            ) : null}
            <Field
              value={form.prompt}
              onChangeText={(v) => setForm((f) => (f ? { ...f, prompt: v } : f))}
              placeholder={t('automations.form.prompt.placeholder')}
              multiline
              accessibilityLabel={t('automations.form.promptA11y')}
            />
            <Txt size={10.5} color={C.textFaint} style={s.formHint}>
              {t('automations.form.prompt.hint')}
            </Txt>

            <View style={[s.formActions, { flexDirection: dir.row }]}>
              <GhostBtn
                label={t('common.cancel')}
                onPress={() => {
                  if (!form.saving) setForm(null)
                }}
                disabled={form.saving}
                style={s.formBtn}
              />
              <PrimaryBtn
                onPress={() => {
                  void saveForm()
                }}
                disabled={form.saving}
                style={s.formBtn}
              >
                {form.saving ? (
                  <Spinner size="small" color={C.onAccent} />
                ) : (
                  <Txt size={13} weight="700" color={C.onAccent}>
                    {form.jobId ? t('common.save') : t('automations.form.create')}
                  </Txt>
                )}
              </PrimaryBtn>
            </View>
          </Card>
        ) : null}

        {jobs.map((j) => {
          const paused = j.enabled === false || j.state === 'paused'
          const open = expanded === j.job_id
          const busy = busyJob === j.job_id
          const lastError = j.last_fire_error || j.last_delivery_error || j.last_error
          const next = paused ? '' : nextLabel(j.next_run_at, t)
          const details: { key: string; value: string; danger?: boolean }[] = []
          if (j.next_run_at) details.push({ key: 'automations.detail.next', value: fmtFull(j.next_run_at, locale) })
          if (j.last_run_at) details.push({ key: 'automations.detail.last', value: fmtFull(j.last_run_at, locale) })
          if (j.repeat) details.push({ key: 'automations.detail.repeat', value: j.repeat })
          if (j.paused_reason) details.push({ key: 'automations.detail.pausedBecause', value: j.paused_reason })
          if (lastError) details.push({ key: 'automations.detail.lastError', value: String(lastError).slice(0, 300), danger: true })
          return (
            <Card key={j.job_id} style={[s.jobCard, paused && s.jobPaused]}>
              {/* Tap-to-expand summary. Kept as its own Pressable (not the Card
                  itself) so the copy chip and action buttons inside the
                  expanded section are not nested in a pressable parent. */}
              <Pressable
                onPress={() => setExpanded(open ? null : j.job_id)}
                accessibilityRole="button"
                accessibilityLabel={t(
                  open ? 'automations.card.collapseA11y' : 'automations.card.expandA11y',
                  { name: j.name ?? j.job_id },
                )}
                style={({ pressed }) => [pressed && s.pressed]}
              >
                <View style={[s.jobHead, { flexDirection: dir.row }]}>
                  <Txt size={13.5} weight="800" numberOfLines={1} style={s.jobName}>
                    {j.name ?? j.job_id}
                  </Txt>
                  {paused ? (
                    <Pill kind="amber">{t('automations.card.paused')}</Pill>
                  ) : next ? (
                    <Pill kind="accent">{next}</Pill>
                  ) : null}
                </View>

                {j.prompt_preview ? (
                  <Txt size={12} color={C.textDim} numberOfLines={open ? undefined : 2} style={s.jobPrompt}>
                    {j.prompt_preview}
                  </Txt>
                ) : null}

                {j.schedule || j.last_status ? (
                  <View style={[s.metaRow, { flexDirection: dir.row }]}>
                    {j.schedule ? (
                      <Txt size={10.5} mono ltr color={C.textFaint}>
                        {j.schedule}
                      </Txt>
                    ) : null}
                    {j.schedule && j.last_status ? (
                      <Txt size={10.5} color={C.textFaint}>
                        ·
                      </Txt>
                    ) : null}
                    {j.last_status ? (
                      <Txt size={10.5} color={C.textFaint} numberOfLines={1} style={s.metaLast}>
                        {t('automations.card.last', { status: j.last_status })}
                      </Txt>
                    ) : null}
                  </View>
                ) : null}
              </Pressable>

              {open ? (
                <View style={s.detailWrap}>
                  <View style={[s.detailTop, { flexDirection: dir.row }]}>
                    <Pressable
                      onPress={() => {
                        void copyId(j)
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={t('automations.card.copyA11y', { id: j.job_id })}
                      style={({ pressed }) => [s.idChip, pressed && s.pressed]}
                    >
                      {/* Mixed bidi: the id is a mono LTR run, the localized
                          label/hint sit in their own non-mono runs so Arabic
                          keeps natural reading order. */}
                      <View style={[s.idChipInner, { flexDirection: dir.row }]}>
                        <Txt size={10.5} color={C.textDim}>
                          {t('automations.card.idLabel')}
                        </Txt>
                        <Txt size={10.5} mono ltr color={C.textDim} numberOfLines={1} style={s.idChipId}>
                          {j.job_id}
                        </Txt>
                        <Txt
                          size={10.5}
                          color={copiedId === j.job_id ? C.greenSoft : C.textFaint}
                          numberOfLines={1}
                          style={s.idChipHint}
                        >
                          {t(copiedId === j.job_id ? 'automations.card.copied' : 'automations.card.tapToCopy')}
                        </Txt>
                      </View>
                    </Pressable>
                    <Txt size={10.5} color={C.greenSoft} numberOfLines={1} style={s.deliver}>
                      {t('automations.card.deliver', { target: j.deliver ?? '—' })}
                    </Txt>
                  </View>

                  {details.length > 0 ? (
                    <View style={s.detailRows}>
                      {details.map((d) => (
                        <View key={d.key} style={[s.detailRow, { flexDirection: dir.row }]}>
                          <Txt size={10.5} color={C.textFaint} style={s.detailLabel}>
                            {t(d.key)}
                          </Txt>
                          <Txt
                            size={10.5}
                            color={d.danger ? C.red : C.textDim}
                            numberOfLines={2}
                            style={s.detailValue}
                          >
                            {d.value}
                          </Txt>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  <View style={[s.actions, { flexDirection: dir.row }]}>
                    {busy ? (
                      <View style={s.busyWrap}>
                        <Spinner size="small" color={C.accent} />
                      </View>
                    ) : (
                      <>
                        <PrimaryBtn
                          small
                          label={t('automations.action.run')}
                          onPress={() => {
                            void runNow(j)
                          }}
                          style={s.actionGrow}
                        />
                        <GhostBtn
                          small
                          label={t(paused ? 'automations.action.resume' : 'automations.action.pause')}
                          onPress={() => {
                            void toggle(j)
                          }}
                          style={s.actionGrow}
                        />
                        <GhostBtn
                          small
                          label={t('automations.action.edit')}
                          onPress={() => {
                            void openEdit(j)
                          }}
                          style={s.actionEdit}
                        />
                        <GhostBtn
                          small
                          label={t('automations.action.delete')}
                          onPress={() => remove(j)}
                          textStyle={s.actionDelete}
                          style={s.actionEdit}
                        />
                      </>
                    )}
                  </View>
                </View>
              ) : null}
            </Card>
          )
        })}

        {showEmpty ? (
          <View style={s.empty}>
            <MochiMark size={72} />
            <Txt size={16} weight="800" center style={s.emptyTitle}>
              {t('automations.empty.title')}
            </Txt>
            <Txt size={12.5} color={C.textDim} center style={s.emptyBody}>
              {t('automations.empty.body')}
            </Txt>
            <PrimaryBtn
              label={t('automations.empty.cta')}
              onPress={openAdd}
              style={s.emptyBtn}
            />
          </View>
        ) : null}
      </KeyboardAwareScrollView>
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  content: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 28 },
  intro: { marginHorizontal: 2, marginBottom: 10 },
  pressed: { opacity: 0.72 },
  fab: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: {
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.greenTint,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
  },
  statusText: { flexShrink: 1 },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeError: { backgroundColor: C.redSoft },
  noticeOffline: { backgroundColor: C.amberSoft },
  loadWrap: { paddingVertical: 28, alignItems: 'center' },
  // New / edit form
  formCard: { borderColor: C.accent, marginBottom: 10 },
  formTitle: { marginBottom: 2 },
  formKicker: { marginTop: 10, marginBottom: 5, marginHorizontal: 0 },
  formLocked: { paddingVertical: 4 },
  formHint: { marginTop: 5, lineHeight: 15 },
  formWarn: { marginBottom: 5, lineHeight: 15 },
  formActions: { gap: 6, marginTop: 12 },
  formBtn: { flex: 1 },
  // Job cards
  jobCard: { marginBottom: 10 },
  jobPaused: { opacity: 0.72 },
  jobHead: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  jobName: { flexShrink: 1 },
  jobPrompt: { lineHeight: 17, marginBottom: 6 },
  metaRow: { alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  metaLast: { flexShrink: 1 },
  detailWrap: {
    marginTop: 9,
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: C.borderSoft,
  },
  detailTop: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  idChip: {
    flexShrink: 1,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  idChipInner: { alignItems: 'center', gap: 4 },
  idChipId: { flexShrink: 1 },
  idChipHint: { flexShrink: 1 },
  deliver: { flexShrink: 1, maxWidth: '45%' },
  detailRows: { gap: 4, marginBottom: 9 },
  detailRow: { alignItems: 'flex-start', gap: 8 },
  detailLabel: { width: 96, flexShrink: 0 },
  detailValue: { flex: 1, lineHeight: 15 },
  actions: { gap: 5 },
  actionGrow: { flex: 1 },
  actionEdit: { paddingHorizontal: 9 },
  actionDelete: { color: C.red },
  busyWrap: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  empty: { alignItems: 'center', paddingTop: 32, paddingHorizontal: 20 },
  emptyTitle: { marginTop: 10 },
  emptyBody: { marginTop: 4, lineHeight: 18, maxWidth: 280 },
  emptyBtn: { marginTop: 14 },
})
