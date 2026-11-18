import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import {
  Card,
  Divider,
  Elev,
  Field,
  GhostBtn,
  Kicker,
  Pill,
  PrimaryBtn,
  Spinner,
  Txt,
} from '../../src/components/ui'
import { Icon } from '../../src/components/Icon'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import { rpc } from '../../src/lib/gateway'
import { isConnected } from '../../src/lib/gateway'
import { fleetProfiles, fleetStatusAtom } from '../../src/lib/fleet'

/**
 * Crew board (M9.4 + BUG-138 write slice): kanban tasks grouped by status +
 * the merged run ledger (moch.runs.timeline). The bottom box puts work on
 * the board (moch.kanban.create — assignee required, validated server-side,
 * frozen bots refused); a tapped task expands to Complete / Reassign. The
 * server pokes dispatch after each write and a 60 s heal ticker reclaims
 * stale work, so a created task runs within ~a minute worst case.
 *
 * Redesign (mockup screen 8): four colored column kickers (Ready / Working /
 * Blocked / Done) + mono counts, expandable task cards (accent border when
 * open) with Complete + assignee pills, the run-timeline ledger footer, and a
 * docked new-task card with the real create flow.
 */

interface Task {
  id: string
  title: string
  assignee: string
  status: string
  body?: string
  createdAt?: number
  completedAt?: number
}

interface Run {
  source: string
  id: string
  profile: string
  title: string
  status: string
  ts: number
  error?: string
}

const COLUMNS = [
  { key: 'ready', labelKey: 'crew.col.ready' },
  { key: 'running', labelKey: 'crew.col.working' },
  { key: 'blocked', labelKey: 'crew.col.blocked' },
  { key: 'done', labelKey: 'crew.col.done' },
] as const

/** Column kicker ink (mockup: dim / accent / amber / green). */
function columnColor(key: string): string {
  return key === 'running'
    ? C.accent
    : key === 'blocked'
      ? C.amber
      : key === 'done'
        ? C.greenSoft
        : C.textDim
}

/** Run-ledger source glyph (the ledger rows are the only place the source is
 *  shown; a11y label keeps the raw source name). */
function runGlyph(source: string): string {
  return source === 'cron' ? '⚡' : source === 'kanban' ? '📋' : source === 'delegate' ? '🔀' : '•'
}

/** Retry-safe create over a flaky phone WS (server dedupes on the key). */
function newIdempotencyKey(): string {
  return `moch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function Crew() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const online = useStore(isConnected)
  const roster = useStore(fleetProfiles)
  const fleetStatus = useStore(fleetStatusAtom)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  // #115: dedicated pull-to-refresh flag (was `loading`, so every RPC retry
  // spun the RefreshControl and a real pull-to-refresh fought the loader).
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')
  const [actionErr, setActionErr] = useState('')
  // create box
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('default')
  const [busy, setBusy] = useState(false)
  // expanded task actions
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyTask, setBusyTask] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!online) {
      // #115: a from-mount offline start must land here with the spinner
      // cleared, or the banner never renders and the screen spins forever.
      setLoading(false)
      setRefreshing(false)
      return
    }
    setErr('')
    try {
      const tasksRes = await rpc<{ tasks: Task[] }>('moch.kanban.tasks', { limit: 120 }, 15000)
      setTasks(tasksRes.tasks ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    try {
      const r = await rpc<{ runs: Run[] }>('moch.runs.timeline', { limit: 40 }, 15000)
      setRuns(r.runs ?? [])
    } catch {
      // timeline needs the fleet runtime armed — board alone is still useful
    }
    setLoading(false)
    setRefreshing(false)
  }, [online])

  useEffect(() => { void refresh() }, [refresh])

  const frozenSet = useMemo(
    () => new Set((fleetStatus?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name)),
    [fleetStatus],
  )

  /** Assignee chips: Moch (the launch profile) + every fleet bot. */
  const assignees = useMemo(
    () => [{ name: 'default', label: t('crew.moch') },
      ...roster.map((p) => ({ name: p.name, label: p.name }))],
    [roster, t],
  )

  const assigneeLabel = (name: string) => (name === 'default' ? t('crew.moch') : name)
  const chipText = (name: string, label: string) =>
    `@${name === 'default' ? label : name}`

  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setActionErr('')
    try {
      const res = await rpc<{ task: string }>('moch.kanban.create', {
        title: title.trim(),
        body: body.trim(),
        assignee,
        idempotency_key: newIdempotencyKey(),
      }, 20000)
      setTitle('')
      setBody('')
      setCreating(false)
      void refresh()
      return res
    } catch (e) {
      setActionErr(t('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const complete = async (task: Task) => {
    if (busyTask) return
    setBusyTask(task.id)
    setActionErr('')
    try {
      await rpc('moch.kanban.complete', {
        task_id: task.id,
        summary: t('crew.complete.summary'),
      }, 15000)
      setExpanded(null)
      void refresh()
    } catch (e) {
      setActionErr(t('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyTask(null)
    }
  }

  const reassign = async (task: Task, to: string) => {
    if (busyTask || to === task.assignee) return
    setBusyTask(task.id)
    setActionErr('')
    try {
      await rpc('moch.kanban.assign', { task_id: task.id, assignee: to }, 15000)
      setExpanded(null)
      void refresh()
    } catch (e) {
      setActionErr(t('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyTask(null)
    }
  }

  /** Real number of completed tasks on the board (drives the Done empty line). */
  const doneTotal = useMemo(
    () => tasks.filter((task) => task.status === 'done' || task.status === 'complete').length,
    [tasks],
  )

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {}
    for (const task of tasks) {
      const key = task.status === 'running' ? 'running'
        : task.status === 'blocked' ? 'blocked'
          : task.status === 'done' || task.status === 'complete' ? 'done'
            : 'ready'
      ;(m[key] ??= []).push(task)
    }
    return m
  }, [tasks])

  const runStatusLabel = (status: string) => {
    switch (status) {
      case 'done':
      case 'complete':
        return t('crew.run.done')
      case 'running':
        return t('crew.run.running')
      case 'failed':
        return t('crew.run.failed')
      case 'blocked':
        return t('crew.run.blocked')
      default:
        return status
    }
  }

  const runStatusColor = (status: string) =>
    status === 'failed' || status === 'blocked'
      ? C.red
      : status === 'running'
        ? C.amber
        : status === 'done' || status === 'complete'
          ? C.greenSoft
          : C.textFaint

  // BUG-133: the create box is a bottom-docked input surface — port of the
  // fleet chat-pad pattern (kbPad lifts the list; createPad is the SINGLE
  // bottom-inset owner). No SafeAreaView bottom edge on top of it.
  const insets = useSafeAreaInsets()
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  const createPad = useAnimatedStyle(() => ({
    paddingBottom: Math.max(Math.max(insets.bottom, 10) + kb.height.value, 0),
  }))

  return (
    <SafeAreaView style={s.safe} edges={[]}>
      <ScreenShell title={t('crew.title')} showBrand>
        <Animated.View style={[s.body, kbPad]}>
          {!online ? (
            <Txt size={12} color={C.amber} style={s.banner}>{t('crew.offline')}</Txt>
          ) : null}
          {err ? (
            <Txt size={12} color={C.red} style={s.banner}>
              {t('crew.loadFailed', { why: err })}
            </Txt>
          ) : null}
          {actionErr ? (
            <Txt size={12} color={C.red} style={s.banner}>{actionErr}</Txt>
          ) : null}
          {loading && online ? (
            <View style={s.spinWrap}>
              <Spinner />
            </View>
          ) : (
            <FlatList
              data={COLUMNS}
              keyExtractor={(c) => c.key}
              contentContainerStyle={s.listContent}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => { setRefreshing(true); void refresh() }}
                  tintColor={C.textDim}
                />
              }
              ListHeaderComponent={
                <Txt size={10.5} color={C.textFaint} style={s.hint}>{t('crew.hint')}</Txt>
              }
              renderItem={({ item: col }) => {
                const list = byStatus[col.key] ?? []
                const color = columnColor(col.key)
                return (
                  <View style={s.column}>
                    <View style={[s.colHead, { flexDirection: dir.row }]}>
                      <Txt
                        size={11}
                        weight="800"
                        color={color}
                        style={[s.colTitle, !dir.rtl && s.colTitleUpper]}
                      >
                        {t(col.labelKey)}
                      </Txt>
                      <Txt size={11} color={C.textFaint} mono>{String(list.length)}</Txt>
                    </View>
                    {list.length === 0 ? (
                      <Elev style={s.colEmpty}>
                        <Txt size={11.5} color={C.textFaint} center>
                          {col.key === 'done'
                            ? t('crew.col.done.empty', { n: doneTotal })
                            : t('crew.col.empty')}
                        </Txt>
                      </Elev>
                    ) : (
                      list.map((task) => {
                        const open = expanded === task.id
                        const done = task.status === 'done' || task.status === 'complete'
                        return (
                          <Card key={task.id} style={[s.taskCard, open && s.taskCardOpen]}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={task.title}
                              accessibilityState={{ expanded: open }}
                              onPress={() => setExpanded(open ? null : task.id)}
                            >
                              <View style={[s.taskTop, { flexDirection: dir.row }]}>
                                <Txt
                                  size={12.5}
                                  weight="700"
                                  numberOfLines={open ? 6 : 2}
                                  style={[s.taskTitle, done && s.taskTitleDone]}
                                >
                                  {task.title}
                                </Txt>
                                <Txt size={10.5} color={C.accent} mono numberOfLines={1} style={s.taskAssignee}>
                                  {chipText(task.assignee, assigneeLabel(task.assignee))}
                                </Txt>
                              </View>
                            </Pressable>
                            {open ? (
                              <View style={s.taskOpen}>
                                <Divider style={s.taskDivider} />
                                <View style={[s.taskActions, { flexDirection: dir.row }]}>
                                  <PrimaryBtn
                                    small
                                    label={done ? t('crew.completed') : t('crew.complete')}
                                    onPress={() => complete(task)}
                                    disabled={done || busyTask === task.id}
                                    style={s.completeBtn}
                                  >
                                    {busyTask === task.id ? (
                                      <Spinner size="small" color={C.onAccent} />
                                    ) : (
                                      <Txt size={11} weight="700" color={C.onAccent}>
                                        {done ? t('crew.completed') : t('crew.complete')}
                                      </Txt>
                                    )}
                                  </PrimaryBtn>
                                  <View style={[s.assigneePills, { flexDirection: dir.row }]}>
                                    {done ? (
                                      <Pill kind="accent" textStyle={s.taskPillText}>
                                        {chipText(task.assignee, assigneeLabel(task.assignee))}
                                      </Pill>
                                    ) : (
                                      assignees.map((a) => {
                                        const frozen = frozenSet.has(a.name)
                                        const current = a.name === task.assignee
                                        const label = chipText(a.name, a.label)
                                        return (
                                          <Pill
                                            key={a.name}
                                            kind={current ? 'accent' : 'neutral'}
                                            onPress={frozen || current ? undefined : () => reassign(task, a.name)}
                                            accessibilityLabel={`${t('crew.assign')}: ${label}`}
                                            textStyle={s.taskPillText}
                                            style={frozen ? s.pillFrozen : undefined}
                                          >
                                            {frozen ? t('crew.chip.frozen', { name: label }) : label}
                                          </Pill>
                                        )
                                      })
                                    )}
                                  </View>
                                </View>
                                <Txt size={10} color={C.textFaint} mono ltr style={s.taskId}>
                                  {`#${task.id.slice(0, 8)}`}
                                </Txt>
                              </View>
                            ) : null}
                          </Card>
                        )
                      })
                    )}
                  </View>
                )
              }}
              ListFooterComponent={
                <View style={s.timeline}>
                  <Kicker>{t('crew.runTimeline')}</Kicker>
                  {runs.length === 0 ? (
                    <Elev>
                      <Txt size={11.5} color={C.textFaint} center>{t('crew.timeline.empty')}</Txt>
                    </Elev>
                  ) : (
                    <Elev style={s.ledger}>
                      {runs.map((run, i) => (
                        <View
                          key={`${run.source}-${run.id}-${i}`}
                          style={[s.tlRow, { flexDirection: dir.row }]}
                        >
                          <Txt size={12} color={C.text}>
                            {runGlyph(run.source)}
                          </Txt>
                          <Txt size={11.5} color={C.text} numberOfLines={1} style={s.tlText}>
                            {run.title || run.id}
                            {run.profile ? (
                              <Txt size={11.5} weight="700" color={C.accent}>
                                {` · @${run.profile}`}
                              </Txt>
                            ) : null}
                          </Txt>
                          <Txt size={11.5} color={runStatusColor(run.status)}>
                            {runStatusLabel(run.status)}
                          </Txt>
                        </View>
                      ))}
                    </Elev>
                  )}
                </View>
              }
            />
          )}

          <Animated.View style={[s.createWrap, createPad]}>
            {creating ? (
              <Card style={s.createBox}>
                <View style={[s.createHead, { flexDirection: dir.row }]}>
                  <Txt size={13} weight="800" style={s.createTitle}>{t('crew.create.title')}</Txt>
                  <GhostBtn small label={t('common.cancel')} onPress={() => setCreating(false)} />
                </View>
                <Field
                  value={title}
                  onChangeText={setTitle}
                  placeholder={t('crew.create.titlePlaceholder')}
                  autoFocus
                  wrapStyle={s.fieldGap}
                />
                <Field
                  value={body}
                  onChangeText={setBody}
                  placeholder={t('crew.create.bodyPlaceholder')}
                  multiline
                  wrapStyle={s.fieldGap}
                  style={s.bodyInput}
                />
                <View style={[s.chips, { flexDirection: dir.row }]}>
                  {assignees.map((a) => {
                    const frozen = frozenSet.has(a.name)
                    const label = chipText(a.name, a.label)
                    return (
                      <Pill
                        key={a.name}
                        kind={assignee === a.name ? 'accent' : 'neutral'}
                        onPress={frozen ? undefined : () => setAssignee(a.name)}
                        accessibilityLabel={`${t('crew.new.assignee')}: ${label}`}
                        textStyle={s.chipText}
                        style={frozen ? s.pillFrozen : undefined}
                      >
                        {frozen ? t('crew.chip.frozen', { name: label }) : label}
                      </Pill>
                    )
                  })}
                </View>
                <PrimaryBtn
                  label={t('crew.create.cta')}
                  onPress={create}
                  disabled={!title.trim() || busy}
                  style={s.createBtn}
                >
                  {busy ? (
                    <Spinner size="small" color={C.onAccent} />
                  ) : (
                    <Txt size={13} weight="700" color={C.onAccent}>{t('crew.create.cta')}</Txt>
                  )}
                </PrimaryBtn>
              </Card>
            ) : (
              <PrimaryBtn
                onPress={() => { setActionErr(''); setCreating(true) }}
                disabled={!online}
                style={[s.newBtn, { flexDirection: dir.row }]}
              >
                <Icon name="add" size={18} color={C.onAccent} />
                <Txt size={13} weight="700" color={C.onAccent}>{t('crew.new')}</Txt>
              </PrimaryBtn>
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
    banner: { paddingHorizontal: 14, paddingTop: 8 },
    spinWrap: { marginTop: 24, alignItems: 'center' },
    listContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 18 },
    hint: { lineHeight: 15, marginBottom: 8 },
    column: { marginBottom: 10 },
    colHead: {
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 4,
      marginHorizontal: 2,
      marginBottom: 5,
    },
    colTitle: { flexShrink: 1 },
    // Mockup uses uppercase + 0.06em tracking, but letterSpacing breaks Arabic
    // letter joining — apply both only when the layout is LTR.
    colTitleUpper: { textTransform: 'uppercase', letterSpacing: 0.66 },
    colEmpty: { marginBottom: 6 },
    taskCard: { marginBottom: 6 },
    taskCardOpen: { borderColor: C.accent },
    taskTop: { alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    taskTitle: { flex: 1, lineHeight: 17 },
    taskTitleDone: { textDecorationLine: 'line-through' },
    taskAssignee: { flexShrink: 0 },
    taskOpen: {},
    taskDivider: { marginTop: 8 },
    taskActions: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      flexWrap: 'wrap',
      marginTop: 8,
    },
    assigneePills: { alignItems: 'center', flexWrap: 'wrap', gap: 4 },
    pillFrozen: { opacity: 0.45 },
    completeBtn: { paddingVertical: 4, paddingHorizontal: 10, minHeight: 26 },
    taskPillText: { fontSize: 10, maxWidth: 140 },
    taskId: { marginTop: 6 },
    timeline: { paddingBottom: 32 },
    ledger: { gap: 6 },
    tlRow: { alignItems: 'center', gap: 6 },
    tlText: { flex: 1 },
    createWrap: { paddingHorizontal: 14, paddingTop: 8 },
    createBox: { borderColor: C.accent, marginBottom: 0 },
    createHead: {
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      marginBottom: 6,
    },
    createTitle: { flexShrink: 1 },
    fieldGap: { marginBottom: 6 },
    bodyInput: { fontSize: 12, minHeight: 40 },
    chips: { flexWrap: 'wrap', gap: 5, marginTop: 2, marginBottom: 8 },
    chipText: { maxWidth: 140 },
    createBtn: { width: '100%' },
    newBtn: { width: '100%' },
  })
