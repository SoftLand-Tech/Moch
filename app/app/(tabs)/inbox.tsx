import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, SectionList, Pressable, StyleSheet, RefreshControl, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { router } from 'expo-router'
import { ScreenShell } from '../../src/components/ScreenShell'
import { StatusDot } from '../../src/components/Sidebar'
import { C, useStyles } from '../../src/lib/theme'
import { tr, localeAtom } from '../../src/lib/strings'
import { switchToSession } from '../../src/lib/chat'
import { loadSessions } from '../../src/lib/sessionList'
import {
  inboxItems,
  groupInbox,
  inboxAgeLabel,
  type InboxItem,
  type InboxKind,
} from '../../src/lib/inbox'

/**
 * The Inbox: every chat that wants something from the user, in one list —
 * questions blocking a turn (`Needs you`), turns that finished while the app
 * was away (`Finished`), and turns that failed (`Failed`).
 *
 * Read-only over state that already exists (lib/inbox joins the pending map,
 * the attention marks and the session rows). No RPC of its own: a tap is a
 * plain `switchToSession` + navigation, which is exactly what a chat-list row
 * does, and its failure banner (chatBanner) is already owned by the chat
 * screen — so the catch here stays silent on purpose, same as the Chats list.
 */

/** Kind → the shared status dot's vocabulary (amber / green / red). */
const DOT: Record<InboxKind, 'input' | 'done' | 'error'> = {
  ask: 'input',
  done: 'done',
  error: 'error',
}

const SECTION_KEY: Record<InboxKind, string> = {
  ask: 'inbox.section.ask',
  done: 'inbox.section.done',
  error: 'inbox.section.error',
}

/** The static Mochi portrait the empty state shows — a full MochiStage is a
 *  WebView, far too heavy for a placeholder (and it animates forever). */
const MOCHI_AVATAR = require('../../assets/mochi-avatar.png')

export default function Inbox() {
  const s = useStyles(makeS)
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <InboxInner />
    </SafeAreaView>
  )
}

function InboxInner() {
  const s = useStyles(makeS)
  // Re-render on a language switch: tr() reads the atom lazily, so without a
  // subscription the copy would stay in the previous locale.
  const locale = useStore(localeAtom)
  const items = useStore(inboxItems)
  const [refreshing, setRefreshing] = useState(false)

  // Sections keep the contract's order (Needs you → Finished → Failed) and
  // drop empties, so a quiet day is one short list instead of three headers.
  // `locale` is a dependency only so the headers translate with the rest.
  const sections = useMemo(() => {
    const groups = groupInbox(items)
    const order: InboxKind[] = ['ask', 'done', 'error']
    return order
      .filter((k) => groups[k].length > 0)
      .map((k) => ({ kind: k, title: tr(SECTION_KEY[k]), data: groups[k] }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, locale])

  const open = useCallback((item: InboxItem) => {
    // Navigate first: switchToSession swaps the chat content synchronously
    // (entry reuse or placeholder) and backgrounds the resume. On failure the
    // user is already on the chat tab, where chatBanner offers the retry —
    // the same contract the Chats list and the drawer use.
    router.navigate('/(tabs)/chat')
    void switchToSession(item.storedId).catch(() => {
      // The chat screen's retry banner owns the failure.
    })
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await loadSessions({ force: true })
    } finally {
      setRefreshing(false)
    }
  }, [])

  return (
    <ScreenShell title={tr('inbox.title')} showBrand>
      <SectionList
        sections={sections}
        keyExtractor={(item) => `${item.kind}:${item.storedId}`}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.textDim} />
        }
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>{section.title}</Text>
            <Text style={s.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const age = inboxAgeLabel(item.at, Date.now(), tr)
          const title = item.title || tr('inbox.untitled')
          return (
            <Pressable
              style={({ pressed }) => [s.row, pressed && s.rowPressed]}
              onPress={() => open(item)}
              accessibilityLabel={title}
            >
              <View style={s.dotWrap}>
                <StatusDot status={DOT[item.kind]} />
              </View>
              <View style={s.rowBody}>
                <View style={s.rowHead}>
                  <Text style={s.title} numberOfLines={1}>
                    {title}
                  </Text>
                  {age ? <Text style={s.age}>{age}</Text> : null}
                </View>
                {item.detail ? (
                  <Text style={s.detail} numberOfLines={1}>
                    {item.detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <Image source={MOCHI_AVATAR} style={s.emptyMascot} />
            <Text style={s.emptyTitle}>{tr('inbox.empty.title')}</Text>
            <Text style={s.emptyBody}>{tr('inbox.empty.body')}</Text>
          </View>
        }
      />
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  content: { paddingBottom: 28 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: C.textDim,
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionCount: { color: C.textFaint, fontSize: 11.5, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 58,
  },
  rowPressed: { backgroundColor: C.bgHover },
  dotWrap: { paddingTop: 6 },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: C.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  age: { color: C.textFaint, fontSize: 11.5, marginLeft: 'auto' },
  detail: { color: C.textDim, fontSize: 13, marginTop: 3 },
  emptyWrap: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 32 },
  emptyMascot: { width: 96, height: 96, marginBottom: 14 },
  emptyTitle: { color: C.text, fontSize: 17, fontWeight: '700', marginTop: 4 },
  emptyBody: { color: C.textFaint, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 19 },
})
