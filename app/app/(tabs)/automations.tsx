import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl, ActivityIndicator, Modal, TextInput, Platform } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../../src/components/Icon'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import * as Clipboard from 'expo-clipboard'
import { rpc, isConnected as isConnectedAtom } from '../../src/lib/gateway'
import { ensureSession } from '../../src/lib/chat'
import { runningAutomationCount, countRunningJobs } from '../../src/lib/automationsState'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { C, useStyles } from '../../src/lib/theme'

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

/** Shell-quote a value for /cron edit flags — schedules contain spaces ("every 30m"). */
function shq(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  if (diff < 0) return 'due'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`
  return `in ${Math.round(diff / 86_400_000)}d`
}

function fmtFull(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  try {
    return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

/**
 * Scheduled automations — the Hermes equivalent of ChatGPT's "Scheduled".
 * Backed by the real surface: `cron.manage` (list/add/remove/pause/resume)
 * and `slash.exec /cron` for run-now and edit (edit flags are shell-quoted).
 */
export default function Automations() {
  const s = useStyles(makeS)
  const online = useStore(isConnectedAtom)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Add/edit form. editing === null → closed; job_id set → edit mode.
  const [form, setForm] = useState<{ jobId: string | null; name: string; schedule: string; prompt: string; saving: boolean } | null>(null)

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
      setError(e instanceof Error ? e.message : 'Could not load automations')
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
    const t = setTimeout(() => setStatus(null), 4000)
    return () => clearTimeout(t)
  }, [status])

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
      showAlert('Action failed', e instanceof Error ? e.message : String(e))
    } finally {
      setBusyJob(null)
    }
  }

  const toggle = (j: Job) =>
    withBusy(j.job_id, async () => {
      const action = j.enabled === false ? 'resume' : 'pause'
      await rpc('cron.manage', { action, name: j.job_id })
      setStatus(action === 'pause' ? `Paused “${j.name ?? j.job_id}”` : `Resumed “${j.name ?? j.job_id}”`)
      await load()
    })

  const runNow = (j: Job) =>
    withBusy(j.job_id, async () => {
      const out = await cronSlash(`/cron run ${j.job_id}`)
      setStatus(out.split('\n')[0] || `Queued “${j.name ?? j.job_id}” to run`)
    })

  const remove = (j: Job) =>
    showAlert('Delete this automation?', j.name ?? j.job_id, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          withBusy(j.job_id, async () => {
            await rpc('cron.manage', { action: 'remove', name: j.job_id })
            setStatus(`Deleted “${j.name ?? j.job_id}”`)
            await load()
          }),
      },
    ])

  const saveForm = async () => {
    if (!form) return
    const schedule = form.schedule.trim()
    const prompt = form.prompt.trim()
    const name = form.name.trim()
    if (!schedule || !prompt || (!form.jobId && !name)) {
      showAlert('Missing fields', 'Name, schedule and prompt are all needed.')
      return
    }
    setForm({ ...form, saving: true })
    try {
      if (form.jobId) {
        // /cron edit has no --name; schedule + prompt are the editable levers.
        const out = await cronSlash(`/cron edit ${form.jobId} --schedule ${shq(schedule)} --prompt ${shq(prompt)}`)
        setStatus(out.split('\n')[0] || 'Updated')
      } else {
        await rpc('cron.manage', { action: 'add', name, schedule, prompt })
        setStatus(`Created “${name}”`)
      }
      setForm(null)
      await load()
    } catch (e) {
      showAlert(form.jobId ? 'Edit failed' : 'Create failed', e instanceof Error ? e.message : String(e))
      setForm({ ...form, saving: false })
    }
  }

  const openAdd = () => setForm({ jobId: null, name: '', schedule: '', prompt: '', saving: false })
  const openEdit = (j: Job) =>
    setForm({ jobId: j.job_id, name: j.name ?? '', schedule: j.schedule ?? '', prompt: j.prompt_preview ?? '', saving: false })

  const copyId = async (j: Job) => {
    await Clipboard.setStringAsync(j.job_id)
    setStatus('Job ID copied')
  }

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell
        title="Automations"
        showBrand
        right={
          <Pressable
            style={({ pressed }) => [s.addBtn, pressed && s.btnPressed]}
            onPress={openAdd}
            hitSlop={8}
            accessibilityLabel="New automation"
          >
            <Icon name="add" size={20} color={C.onAccent} />
          </Pressable>
        }
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.textDim} onRefresh={async () => { setRefreshing(true); await load() }} />}
        >
          <Text style={s.intro}>Scheduled jobs run on your gateway, so they work even when this app is closed.</Text>

          {status ? (
            <View style={s.statusRow}>
              <Icon name="checkmark-circle" size={13} color={C.greenSoft} />
              <Text style={s.statusText}>{status}</Text>
            </View>
          ) : null}

          {error ? (
            <Pressable style={({ pressed }) => [s.retryRow, pressed && s.btnPressed]} onPress={() => { setLoading(true); void load() }}>
              <Text style={s.error}>{error} — tap to retry</Text>
            </Pressable>
          ) : null}

          {loading ? <ActivityIndicator color={C.textDim} style={{ marginTop: 24 }} /> : null}

          {!loading && jobs.length === 0 && !error ? (
            <View style={s.empty}>
              <Icon name="timer-outline" size={28} color={C.textFaint} />
              <Text style={s.emptyTitle}>No automations yet</Text>
              <Text style={s.emptyBody}>Tap + to schedule your first job,{'\n'}or create one from chat with /cron add</Text>
              <Pressable style={({ pressed }) => [s.emptyBtn, pressed && s.btnPressed]} onPress={openAdd} accessibilityLabel="New automation">
                <Icon name="add" size={16} color={C.onAccent} />
                <Text style={s.emptyBtnText}>New automation</Text>
              </Pressable>
            </View>
          ) : null}

          {jobs.map((j) => {
            const paused = j.enabled === false || j.state === 'paused'
            const open = expanded === j.job_id
            const busy = busyJob === j.job_id
            const lastError = j.last_fire_error || j.last_delivery_error || j.last_error
            return (
              <View key={j.job_id} style={[s.card, paused && s.cardPaused]}>
                <Pressable
                  style={({ pressed }) => [s.cardHead, pressed && s.btnPressed]}
                  onPress={() => setExpanded(open ? null : j.job_id)}
                  accessibilityLabel={open ? `Collapse ${j.name ?? j.job_id}` : `Expand ${j.name ?? j.job_id}`}
                >
                  <Icon name={paused ? 'pause-circle-outline' : 'timer-outline'} size={17} color={paused ? C.textFaint : C.accent} />
                  <Text style={[s.name, paused && { color: C.textDim }]} numberOfLines={1}>
                    {j.name ?? j.job_id}
                  </Text>
                  {j.next_run_at && !paused ? (
                    <Text style={s.nextChip}>{when(j.next_run_at)}</Text>
                  ) : paused ? (
                    <Text style={s.pausedChip}>paused</Text>
                  ) : null}
                  <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.textFaint} />
                </Pressable>

                {j.prompt_preview ? (
                  <Text style={s.prompt} numberOfLines={open ? undefined : 2}>{j.prompt_preview}</Text>
                ) : null}

                <View style={s.metaRow}>
                  {j.schedule ? <Text style={s.meta}>{j.schedule}</Text> : null}
                  {j.last_status ? <Text style={s.meta}>last: {j.last_status}</Text> : null}
                </View>

                {open ? (
                  <View style={s.detail}>
                    <Detail label="Job ID" value={j.job_id} onCopy={() => { void copyId(j) }} />
                    <Detail label="Next run" value={j.next_run_at ? fmtFull(j.next_run_at) : '—'} />
                    <Detail label="Last run" value={j.last_run_at ? fmtFull(j.last_run_at) : '—'} />
                    <Detail label="Repeat" value={j.repeat ?? '—'} />
                    <Detail label="Deliver" value={j.deliver ?? '—'} />
                    {j.paused_reason ? <Detail label="Paused because" value={j.paused_reason} /> : null}
                    {lastError ? <Detail label="Last error" value={String(lastError).slice(0, 300)} danger /> : null}
                  </View>
                ) : null}

                <View style={s.actions}>
                  {busy ? (
                    <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 'auto' }} />
                  ) : (
                    <>
                      <Action icon="play-outline" label="Run now" onPress={() => { void runNow(j) }} />
                      <Action
                        icon={paused ? 'play-skip-forward-outline' : 'pause-outline'}
                        label={paused ? 'Resume' : 'Pause'}
                        onPress={() => { void toggle(j) }}
                      />
                      <Action icon="create-outline" label="Edit" onPress={() => openEdit(j)} />
                      <Action icon="trash-outline" label="Delete" danger onPress={() => remove(j)} />
                    </>
                  )}
                </View>
              </View>
            )
          })}
        </ScrollView>
      </ScreenShell>

      {/* Add / edit sheet */}
      <Modal visible={!!form} animationType="slide" onRequestClose={() => { if (!form?.saving) setForm(null) }}>
        <SafeAreaView style={s.modalSafe}>
          <KeyboardAvoidingView style={s.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={s.modalHead}>
              <Pressable
                style={({ pressed }) => [s.modalTextBtn, pressed && s.btnPressed]}
                onPress={() => { if (!form?.saving) setForm(null) }}
                disabled={form?.saving}
                accessibilityLabel="Cancel"
              >
                <Text style={s.modalCancel}>Cancel</Text>
              </Pressable>
              <Text style={s.modalTitle}>{form?.jobId ? 'Edit automation' : 'New automation'}</Text>
              <Pressable
                style={({ pressed }) => [s.modalTextBtn, pressed && s.btnPressed]}
                onPress={() => { void saveForm() }}
                disabled={form?.saving}
                accessibilityLabel="Save automation"
              >
                {form?.saving ? (
                  <ActivityIndicator size="small" color={C.accent} />
                ) : (
                  <Text style={s.modalSave}>{form?.jobId ? 'Save' : 'Create'}</Text>
                )}
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
              {form?.jobId ? (
                <View>
                  <Text style={s.fieldLabel}>NAME</Text>
                  <Text style={s.fieldLocked}>{form.name || form.jobId}</Text>
                </View>
              ) : (
                <View>
                  <Text style={s.fieldLabel}>NAME</Text>
                  <TextInput
                    style={s.field}
                    value={form?.name ?? ''}
                    onChangeText={(t) => setForm((f) => (f ? { ...f, name: t } : f))}
                    placeholder="daily-standup"
                    placeholderTextColor={C.textFaint}
                    autoCapitalize="none"
                    accessibilityLabel="Automation name"
                  />
                </View>
              )}

              <View>
                <Text style={s.fieldLabel}>SCHEDULE</Text>
                <TextInput
                  style={s.field}
                  value={form?.schedule ?? ''}
                  onChangeText={(t) => setForm((f) => (f ? { ...f, schedule: t } : f))}
                  placeholder="every 30m"
                  placeholderTextColor={C.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Schedule"
                />
                <Text style={s.fieldHint}>Intervals: every 30m · every 2h — one-shot: in 45m — weekly: every monday 9:00</Text>
              </View>

              <View>
                <Text style={s.fieldLabel}>PROMPT</Text>
                <TextInput
                  style={[s.field, s.fieldMulti]}
                  value={form?.prompt ?? ''}
                  onChangeText={(t) => setForm((f) => (f ? { ...f, prompt: t } : f))}
                  placeholder="Check my inbox and summarize what needs a reply today."
                  placeholderTextColor={C.textFaint}
                  multiline
                  accessibilityLabel="Prompt"
                />
                <Text style={s.fieldHint}>Jobs run in a fresh session with no chat context — write self-contained prompts.</Text>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

function Detail({ label, value, onCopy, danger }: { label: string; value: string; onCopy?: () => void; danger?: boolean }) {
  const s = useStyles(makeS)
  return (
    <View style={s.detailRow}>
      <Text style={s.detailLabel}>{label}</Text>
      <Pressable disabled={!onCopy} onPress={onCopy} style={{ flex: 1 }} accessibilityLabel={onCopy ? `${label}, tap to copy` : label}>
        <Text style={[s.detailValue, danger && { color: C.red }]} selectable={!!onCopy}>
          {value}
          {onCopy ? ' ⧉' : ''}
        </Text>
      </Pressable>
    </View>
  )
}

function Action({ icon, label, onPress, danger }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; danger?: boolean }) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.actionBtn, pressed && s.actionPressed]}
      onPress={onPress}
      hitSlop={4}
      accessibilityLabel={label}
    >
      <Icon name={icon} size={14} color={danger ? C.red : C.textDim} />
      <Text style={[s.actionLabel, danger && { color: C.red }]}>{label}</Text>
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  intro: { color: C.textDim, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(74,222,128,0.08)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  statusText: { color: C.greenSoft, fontSize: 12.5, fontWeight: '600' },
  error: { color: C.red, fontSize: 13, paddingVertical: 8 },
  retryRow: { alignItems: 'center' },
  empty: { alignItems: 'center', marginTop: 48, gap: 8 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  emptyBody: { color: C.textFaint, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, borderRadius: 20, paddingHorizontal: 16, height: 40, marginTop: 10 },
  emptyBtnText: { color: C.onAccent, fontSize: 14, fontWeight: '700' },
  addBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  btnPressed: { opacity: 0.6 },
  card: { backgroundColor: C.bgCard, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.borderSoft },
  cardPaused: { opacity: 0.75 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, color: C.text, fontSize: 15, fontWeight: '600' },
  nextChip: { color: C.accent, fontSize: 11, fontWeight: '700' },
  pausedChip: { color: C.textFaint, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  prompt: { color: C.textDim, fontSize: 13, lineHeight: 18, marginTop: 6 },
  metaRow: { flexDirection: 'row', gap: 12, marginTop: 8, flexWrap: 'wrap' },
  meta: { color: C.textFaint, fontSize: 11.5 },
  detail: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.borderSoft, gap: 6 },
  detailRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  detailLabel: { color: C.textFaint, fontSize: 11, fontWeight: '700', width: 88, paddingTop: 1 },
  detailValue: { color: C.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.borderSoft },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 32, borderRadius: 16, backgroundColor: C.bgHover },
  actionPressed: { opacity: 0.6 },
  actionLabel: { color: C.textDim, fontSize: 12, fontWeight: '600' },
  modalSafe: { flex: 1, backgroundColor: C.bg },
  modalRoot: { flex: 1 },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  modalTitle: { color: C.text, fontSize: 15.5, fontWeight: '700' },
  modalTextBtn: { justifyContent: 'center' },
  modalCancel: { color: C.textDim, fontSize: 14.5, fontWeight: '600', paddingTop: 12, minHeight: 44 },
  modalSave: { color: C.accent, fontSize: 14.5, fontWeight: '800', paddingTop: 12, minHeight: 44 },
  fieldLabel: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
  field: { backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.borderSoft, paddingHorizontal: 14, paddingVertical: 12, color: C.text, fontSize: 15, minHeight: 48 },
  fieldMulti: { minHeight: 120, textAlignVertical: 'top' },
  fieldLocked: { color: C.textDim, fontSize: 15 },
  fieldHint: { color: C.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
})
