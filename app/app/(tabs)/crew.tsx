import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, ActivityIndicator, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import { tr } from '../../src/lib/strings'
import { rpc } from '../../src/lib/gateway'
import { isConnected } from '../../src/lib/gateway'

/**
 * Crew board (M9.4 read-side): kanban tasks grouped by status + the merged run
 * ledger (moch.runs.timeline: kanban + cron + delegations). Write actions
 * (create/claim via the app) land with the M9.4 write slice — the board renders
 * the truth either way.
 */

interface Task {
  id: string
  title: string
  assignee: string
  status: string
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

export default function Crew() {
  const s = useStyles(makeS)
  const online = useStore(isConnected)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

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

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title="Crew" showBrand>
        {err ? <Text style={s.err}>{err}</Text> : null}
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
              <Text style={s.hint}>{tr('crew.readonly')}</Text>
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
                    list.map((t) => (
                      <View key={t.id} style={s.task}>
                        <Text style={s.taskTitle} numberOfLines={2}>{t.title}</Text>
                        <View style={s.taskMeta}>
                          <Ionicons name="person-outline" size={11} color={C.textFaint} />
                          <Text style={s.taskMetaText}>{t.assignee || 'unassigned'}</Text>
                          <Text style={s.taskMetaText}>· {t.id.slice(0, 8)}</Text>
                        </View>
                      </View>
                    ))
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
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
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
    taskTitle: { color: C.text, fontSize: 13 },
    taskMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    taskMetaText: { color: C.textFaint, fontSize: 11 },
    timeline: { paddingHorizontal: 16, paddingBottom: 32 },
    tlTitle: { color: C.text, fontSize: 13, fontWeight: '600', marginBottom: 8 },
    tlRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
    tlText: { color: C.textDim, fontSize: 12, flex: 1 },
    tlStatus: { color: C.textFaint, fontSize: 11 },
  })
