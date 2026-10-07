import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, RefreshControl } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../../src/components/Icon'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { router } from 'expo-router'
import { rpc, isConnected as isConnectedAtom, retryNow } from '../../src/lib/gateway'
import {
  switchToSession,
  newChat,
  forgetSession,
  activeStoredId,
  busyStoredKey,
  pendingCount,
  sessionsById,
  isSessionNotFound,
  pendingStoredIds,
} from '../../src/lib/chat'
import { forgetChatMarks } from '../../src/lib/chatListState'
import { C, useStyles } from '../../src/lib/theme'
import { attentionById, rowStatus } from '../../src/lib/attention'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { StatusDot } from '../../src/components/Sidebar'
import { loadSessions, sessionRows, sessionListLoading, sessionListError, toMs, type SessionRow } from '../../src/lib/sessionList'

interface Sess {
  id: string
  title?: string
  preview?: string
  started_at?: number
  message_count?: number
  source?: string
}

// Timestamp normalisation lives in the session-list store (shared with the
// drawer) so both agree on the unit.

function fmtWhen(ts?: number): string {
  const ms = toMs(ts)
  if (!ms) return ''
  const d = new Date(ms)
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  try {
    return d.toLocaleDateString()
  } catch {
    return ''
  }
}

export default function Sessions() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <SessionsInner />
    </SafeAreaView>
  )
}

function SessionsInner() {
  const s = useStyles(makeS)
  const list = useStore(sessionRows)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const loading = useStore(sessionListLoading)
  const error = useStore(sessionListError)
  const online = useStore(isConnectedAtom)
  const currentStored = useStore(activeStoredId)
  // Flush-stable busy set (string key — see lib/chat summary keys): this list
  // re-renders at turn edges, not per 33ms stream flush.
  const busyKey = useStore(busyStoredKey)
  const busy = useMemo(() => (busyKey ? busyKey.split(',') : []), [busyKey])
  const attention = useStore(attentionById)
  const pending = useStore(pendingCount)
  // BUG-085: unanswered questions keep their row dot even after the chat was
  // opened (opening clears the event-driven mark; the question still blocks).
  const pendingStored = useStore(pendingStoredIds)

  // The store is shared with the drawer, so both show the same list in the
  // same order. `search` is not a valid RPC param (extra="forbid"), so the
  // filter is applied locally on title + preview.
  const load = useCallback(
    async (force = false) => {
      if (!online) return
      await loadSessions({ force })
    },
    [online],
  )

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((s) => `${s.title ?? ''} ${s.preview ?? ''} ${s.source ?? ''}`.toLowerCase().includes(q))
  }, [list, query])

  const openSession = useCallback(
    (s: Sess) => {
      // Navigate first — the content swap is synchronous inside
      // switchToSession (entry reuse or placeholder + cached transcript),
      // with the resume RPC backgrounded. On failure the user is already on
      // the chat tab, where its retry banner surfaces the error.
      router.navigate('/(tabs)/chat')
      void switchToSession(s.id).catch(() => {
        // The chat screen's banner owns the failure.
      })
    },
    [],
  )

  const startNew = useCallback(() => {
    router.navigate('/(tabs)/chat')
    void newChat().catch(() => {
      // Same: the chat screen's retry banner owns the failure.
    })
  }, [])

  const removeSession = useCallback((s: Sess) => {
    showAlert('Delete this conversation?', s.title || s.preview || 'This permanently removes it from Moch.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          // BUG-004: mirror the drawer's flow — the gateway refuses to delete
          // a session that is live in its process ("cannot delete an active
          // session"; live handles persist for hours), so detach first, then
          // close the live handle best-effort. A row id from session.list is
          // a STORED id and forgetSession is live-keyed, so resolve before
          // cleanup; 'not found' (deleted elsewhere) means the goal is
          // already achieved — clean up locally instead of failing.
          try {
            const live = Object.values(sessionsById.get()).find((x) => x.storedId === s.id)?.id
            if (activeStoredId.get() === s.id) await newChat()
            if (live) {
              try {
                await rpc('session.close', { session_id: live })
              } catch {
                /* best effort — a dead handle must not block the delete */
              }
            }
            try {
              await rpc('session.delete', { session_id: s.id })
            } catch (err) {
              if (!isSessionNotFound(err)) throw err
            }
            await forgetSession(live ?? s.id)
            forgetChatMarks(s.id)
            // Drop it from the shared store so the drawer updates too.
            sessionRows.set(sessionRows.get().filter((x) => x.id !== s.id))
          } catch (e) {
            showAlert('Delete failed', e instanceof Error ? e.message : '')
          }
        },
      },
    ])
  }, [])

  return (
    <ScreenShell title="Chats" showBrand onSearch={() => setQuery('')}>
      <View style={s.root}>
        <View style={s.searchRow}>
          <TextInput
            style={s.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations…"
            placeholderTextColor={C.textFaint}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search sessions"
          />
          <Pressable
            style={({ pressed }) => [s.newBtn, pressed && s.btnPressed]}
            onPress={startNew}
            accessibilityLabel="New chat"
          >
            <Icon name="add" size={20} color={C.onAccent} />
          </Pressable>
        </View>

      {pending > 0 ? (
        <Pressable
          style={({ pressed }) => [s.alertRow, pressed && s.btnPressed]}
          onPress={() => {
            // BUG-023: land on the blocking chat itself, not whatever chat
            // happens to be active.
            const first = pendingStored[0]
            router.navigate('/(tabs)/chat')
            if (first) void switchToSession(first).catch(() => {})
          }}
        >
          <Text style={s.alertText}>
            {pending} question{pending > 1 ? 's' : ''} waiting on you — tap to answer
          </Text>
        </Pressable>
      ) : null}

      {error ? (
        <Pressable style={({ pressed }) => [s.errRow, pressed && s.btnPressed]} onPress={() => { void load(true) }}>
          <Text style={s.errText}>{error} — tap to retry</Text>
        </Pressable>
      ) : null}

      {!online && !loading ? (
        <Pressable style={({ pressed }) => [s.errRow, pressed && s.btnPressed]} onPress={() => { void retryNow().catch(() => {}) }}>
          <Text style={s.errText}>Not connected — tap to reconnect</Text>
        </Pressable>
      ) : null}

      <FlatList
        data={shown}
        keyExtractor={(x) => x.id}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.textDim} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false) }} />}
        renderItem={({ item }) => {
          // `session.list` yields stored ids; all our per-session state is
          // keyed by the same stored id, so compare in that space.
          const isCurrent = !!currentStored && currentStored === item.id
          const status = rowStatus(busy.includes(item.id), attention[item.id], pendingStored.includes(item.id))
          const label = item.title || item.preview?.slice(0, 80) || 'Untitled'
          return (
            <Pressable
              style={({ pressed }) => [s.row, pressed && s.rowPressed, isCurrent && s.rowActive]}
              onPress={() => openSession(item)}
              onLongPress={() => void removeSession(item)}
              accessibilityLabel={`Open ${label}`}
            >
              <View style={{ flex: 1 }}>
                <View style={s.titleRow}>
                  <Text style={[s.title, isCurrent && s.titleActive]} numberOfLines={1}>
                    {label}
                  </Text>
                  {isCurrent ? <Text style={s.hereTag}>open</Text> : null}
                  <StatusDot status={status} />
                </View>
                <Text style={s.meta} numberOfLines={1}>
                  {item.source ? `${item.source} · ` : ''}
                  {item.message_count ?? 0} msgs
                  {/* BUG-012: the only server timestamp is CREATION time —
                      label it honestly instead of implying last-used. */}
                  {fmtWhen(item.started_at) ? ` · started ${fmtWhen(item.started_at)}` : ''}
                </Text>
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={
          !loading ? (
            <View style={s.emptyWrap}>
              <Text style={s.empty}>{online ? (query ? 'No matches' : 'No conversations yet') : 'Offline'}</Text>
              {online && !query ? (
                <Pressable style={({ pressed }) => [s.newBtn, pressed && s.btnPressed]} onPress={startNew}>
                  <Text style={s.newText}>Start chatting</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null
        }
        />
      </View>
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },
  searchRow: { paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', gap: 8 },
  search: { flex: 1, backgroundColor: C.bgCard, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 12, color: C.text, fontSize: 15, minHeight: 44 },
  newBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center' },
  btnPressed: { opacity: 0.6 },
  newText: { color: C.onAccent, fontSize: 14, fontWeight: '700' },
  alertRow: { paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#241A08' },
  alertText: { color: C.amber, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  errRow: { padding: 12, alignItems: 'center' },
  errText: { color: C.red, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, minHeight: 58, gap: 8 },
  rowPressed: { backgroundColor: C.bgHover },
  rowActive: { backgroundColor: C.bgCard },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: C.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  titleActive: { color: C.accent },
  hereTag: { color: C.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  meta: { color: C.textFaint, fontSize: 12, marginTop: 3 },
  empty: { color: C.textFaint, textAlign: 'center', marginTop: 60, marginBottom: 16, fontSize: 14 },
  emptyWrap: { alignItems: 'center' },
})
