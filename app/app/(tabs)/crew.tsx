import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, RefreshControl, TextInput } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import { tr, isRTL } from '../../src/lib/strings'
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
  { key: 'ready', label: 'Ready', icon: 'inbox-outline' },
  { key: 'running', label: 'Working', icon: 'cog-outline' },
  { key: 'blocked', label: 'Blocked', icon: 'alert-circle-outline' },
  { key: 'done', label: 'Done', icon: 'checkmark-circle-outline' },
]

const SOURCE_ICON: Record<string, string> = {
  kanban: 'grid-outline',
  cron: 'timer-outline',
  delegate: 'git-branch-outline',
}

/** Retry-safe create over a flaky phone WS (server dedupes on the key). */
function newIdempotencyKey(): string {
  return `moch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function Crew() {
  const s = useStyles(makeS)
  const online = useStore(isConnected)
  const roster = useStore(fleetProfiles)
  const fleetStatus = useStore(fleetStatusAtom)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
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
    if (!online) return
    setErr('')
    try {
      const t = await rpc<{ tasks: Task[] }>('moch.kanban.tasks', { limit: 120 }, 15000)
      setTasks(t.tasks ?? [])
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
  }, [online])

  useEffect(() => { void refresh() }, [refresh])

  const frozenSet = useMemo(
    () => new Set((fleetStatus?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name)),
    [fleetStatus],
  )

  /** Assignee chips: Moch (the launch profile) + every fleet bot. */
  const assignees = useMemo(
    () => [{ name: 'default', label: tr('crew.moch') },
      ...roster.map((p) => ({ name: p.name, label: p.name }))],
    [roster],
  )

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
      setActionErr(tr('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const complete = async (t: Task) => {
    if (busyTask) return
    setBusyTask(t.id)
    setActionErr('')
    try {
      await rpc('moch.kanban.complete', {
        task_id: t.id,
        summary: tr('crew.complete.summary'),
      }, 15000)
      setExpanded(null)
      void refresh()
    } catch (e) {
      setActionErr(tr('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyTask(null)
    }
  }

  const reassign = async (t: Task, to: string) => {
    if (busyTask || to === t.assignee) return
    setBusyTask(t.id)
    setActionErr('')
    try {
      await rpc('moch.kanban.assign', { task_id: t.id, assignee: to }, 15000)
      setExpanded(null)
      void refresh()
    } catch (e) {
      setActionErr(tr('crew.err', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyTask(null)
    }
  }

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {}
    for (const t of tasks) {
      const key = t.status === 'running' ? 'running'
        : t.status === 'blocked' ? 'blocked'
          : t.status === 'done' || t.status === 'complete' ? 'done'
            : 'ready'
      ;(m[key] ??= []).push(t)
    }
    return m
  }, [tasks])

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
      <ScreenShell title="Crew" showBrand>
        <Animated.View style={[s.body, kbPad]}>
        {err ? <Text style={s.err}>{err}</Text> : null}
        {actionErr ? <Text style={s.err}>{actionErr}</Text> : null}
        {loading && online ? (
          <ActivityIndicator style={s.spin} />
        ) : (
          <FlatList
            data={COLUMNS}
            keyExtractor={(c) => c.key}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={C.textDim} />
            }
            ListHeaderComponent={
              <Text style={s.hint}>{tr('crew.hint')}</Text>
            }
            renderItem={({ item: col }) => {
              const list = byStatus[col.key] ?? []
              return (
                <View style={s.column}>
                  <View style={s.colHead}>
                    <Ionicons name={col.icon as never} size={15} color={C.textDim} />
                    <Text style={s.colTitle}>{col.label}</Text>
                    <Text style={s.colCount}>{list.length}</Text>
                  </View>
                  {list.length === 0 ? (
                    <Text style={s.colEmpty}>—</Text>
                  ) : (
                    list.map((t) => {
                      const open = expanded === t.id
                      const done = t.status === 'done' || t.status === 'complete'
                      return (
                        <View key={t.id} style={[s.task, open && s.taskOpen]}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t.title}
                            onPress={() => setExpanded(open ? null : t.id)}
                          >
                            <Text style={s.taskTitle} numberOfLines={open ? 6 : 2}>{t.title}</Text>
                            <View style={s.taskMeta}>
                              <Ionicons name="person-outline" size={11} color={C.textFaint} />
                              <Text style={s.taskMetaText}>
                                {t.assignee === 'default' ? tr('crew.moch') : t.assignee || 'unassigned'}
                              </Text>
                              <Text style={s.taskMetaText}>· {t.id.slice(0, 8)}</Text>
                            </View>
                          </Pressable>
                          {open && !done ? (
                            <View style={s.taskActions}>
                              <Pressable
                                accessibilityRole="button"
                                style={[s.actBtn, s.actPrimary]}
                                onPress={() => complete(t)}
                                disabled={busyTask === t.id}
                              >
                                {busyTask === t.id ? (
                                  <ActivityIndicator size="small" />
                                ) : (
                                  <Text style={s.actPrimaryText}>{tr('crew.complete')}</Text>
                                )}
                              </Pressable>
                            </View>
                          ) : null}
                          {open && !done ? (
                            <View>
                              <Text style={s.reassignLabel}>{tr('crew.assign')}</Text>
                              <View style={[s.chips, isRTL() && { flexDirection: 'row-reverse' }]}>
                                {assignees.map((a) => (
                                  <Pressable
                                    key={a.name}
                                    accessibilityRole="button"
                                    disabled={frozenSet.has(a.name) || a.name === t.assignee}
                                    style={[
                                      s.chip,
                                      a.name === t.assignee && s.chipActive,
                                      frozenSet.has(a.name) && s.chipFrozen,
                                    ]}
                                    onPress={() => reassign(t, a.name)}
                                  >
                                    <Text style={s.chipText} numberOfLines={1}>{a.label}</Text>
                                  </Pressable>
                                ))}
                              </View>
                            </View>
                          ) : null}
                        </View>
                      )
                    })
                  )}
                </View>
              )
            }}
            ListFooterComponent={
              <View style={s.timeline}>
                <Text style={s.tlTitle}>{tr('crew.timeline')}</Text>
                {runs.length === 0 ? (
                  <Text style={s.colEmpty}>{tr('crew.timeline.empty')}</Text>
                ) : (
                  runs.map((r, i) => (
                    <View key={`${r.source}-${r.id}-${i}`} style={s.tlRow}>
                      <Ionicons
                        name={(SOURCE_ICON[r.source] ?? 'ellipse-outline') as never}
                        size={13}
                        color={r.status === 'failed' || r.status === 'blocked'
                          ? C.red : C.textDim}
                      />
                      <Text style={s.tlText} numberOfLines={1}>
                        {r.title || r.id}
                        {r.profile ? ` · @${r.profile}` : ''}
                      </Text>
                      <Text style={s.tlStatus}>{r.status}</Text>
                    </View>
                  ))
                )}
              </View>
            }
          />
        )}

        <Animated.View style={[s.createWrap, createPad]}>
          {creating ? (
            <View style={s.createBox}>
              <TextInput
                style={s.input}
                placeholder={tr('crew.new.title')}
                placeholderTextColor={C.textDim}
                value={title}
                onChangeText={setTitle}
                autoFocus
              />
              <TextInput
                style={s.inputBody}
                placeholder={tr('crew.new.body')}
                placeholderTextColor={C.textDim}
                value={body}
                onChangeText={setBody}
                multiline
              />
              <Text style={s.assignLabel}>{tr('crew.new.assignee')}</Text>
              <View style={[s.chips, isRTL() && { flexDirection: 'row-reverse' }]}>
                {assignees.map((a) => (
                  <Pressable
                    key={a.name}
                    accessibilityRole="button"
                    accessibilityState={{ selected: assignee === a.name }}
                    disabled={frozenSet.has(a.name)}
                    style={[
                      s.chip,
                      assignee === a.name && s.chipActive,
                      frozenSet.has(a.name) && s.chipFrozen,
                    ]}
                    onPress={() => setAssignee(a.name)}
                  >
                    <Text style={s.chipText} numberOfLines={1}>{a.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.rowBtns}>
                <Pressable style={s.btnGhost} onPress={() => setCreating(false)}>
                  <Text style={s.btnGhostText}>{tr('fleet.cancel')}</Text>
                </Pressable>
                <Pressable
                  style={[s.btn, !title.trim() && s.btnDisabled]}
                  onPress={create}
                  disabled={!title.trim() || busy}
                >
                  {busy ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text style={s.btnText}>{tr('crew.new.cta')}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable accessibilityRole="button" style={s.fab} onPress={() => { setActionErr(''); setCreating(true) }} disabled={!online}>
              <Ionicons name="add" size={20} color={C.bg} />
              <Text style={s.fabText}>{tr('crew.new')}</Text>
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
    err: { color: C.red, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
    spin: { marginTop: 24 },
    hint: { color: C.textFaint, fontSize: 11, paddingHorizontal: 16, paddingBottom: 8 },
    column: {
      backgroundColor: C.bgCard,
      borderRadius: 14,
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 12,
    },
    colHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
    colTitle: { color: C.text, fontSize: 13, fontWeight: '600', flex: 1 },
    colCount: { color: C.textFaint, fontSize: 12 },
    colEmpty: { color: C.textFaint, fontSize: 12, paddingLeft: 4 },
    task: { backgroundColor: C.bgElev, borderRadius: 10, padding: 10, marginBottom: 6 },
    taskOpen: { borderWidth: 1, borderColor: C.border },
    taskTitle: { color: C.text, fontSize: 13 },
    taskMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    taskMetaText: { color: C.textFaint, fontSize: 11 },
    taskActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
    actBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
    actPrimary: { backgroundColor: C.accent },
    actPrimaryText: { color: C.bg, fontWeight: '600', fontSize: 12 },
    reassignLabel: { color: C.textFaint, fontSize: 11, marginTop: 8, marginBottom: 4 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 5 },
    chipActive: { backgroundColor: C.accentSoft, borderColor: C.accent },
    chipFrozen: { opacity: 0.4 },
    chipText: { color: C.textDim, fontSize: 11, maxWidth: 120 },
    createWrap: { padding: 16 },
    createBox: { backgroundColor: C.bgCard, borderRadius: 14, padding: 12 },
    input: {
      color: C.text, fontSize: 14, padding: 8, borderRadius: 8,
      backgroundColor: C.bg,
    },
    inputBody: {
      color: C.text, fontSize: 13, minHeight: 44, padding: 8, borderRadius: 8,
      backgroundColor: C.bg, marginTop: 8, textAlignVertical: 'top',
    },
    assignLabel: { color: C.textFaint, fontSize: 11, marginTop: 10, marginBottom: 4 },
    rowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
    btn: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: C.bg, fontWeight: '600', fontSize: 13 },
    btnGhost: { paddingHorizontal: 12, paddingVertical: 9 },
    btnGhostText: { color: C.textDim, fontSize: 13 },
    fab: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12,
    },
    fabText: { color: C.bg, fontWeight: '700' },
    timeline: { paddingHorizontal: 16, paddingBottom: 32 },
    tlTitle: { color: C.text, fontSize: 13, fontWeight: '600', marginBottom: 8 },
    tlRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
    tlText: { color: C.textDim, fontSize: 12, flex: 1 },
    tlStatus: { color: C.textFaint, fontSize: 11 },
  })
