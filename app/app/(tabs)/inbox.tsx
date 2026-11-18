import React, { useCallback, useState } from 'react'
import { View, SectionList, StyleSheet, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { router } from 'expo-router'
import { ScreenShell } from '../../src/components/ScreenShell'
import { MochiMark } from '../../src/components/MochiMark'
import { Card, Dot, Kicker, Pill, Txt, type DotKind, type PillKind } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
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
const DOT_KIND: Record<InboxKind, DotKind> = {
  ask: 'amber',
  done: 'green',
  error: 'red',
}

/** Kind → the section-count pill's tone (mockup screen 3). */
const PILL_KIND: Record<InboxKind, PillKind> = {
  ask: 'amber',
  done: 'green',
  error: 'red',
}

const SECTION_KEY: Record<InboxKind, string> = {
  ask: 'inbox.section.ask',
  done: 'inbox.section.done',
  error: 'inbox.section.error',
}

/** The mockup's centered Mochi empty state — the static MochiMark (a full
 *  MochiStage is a WebView, far too heavy for a placeholder). */
const EMPTY_MOCHI_SIZE = 84

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
  // useT subscribes to the locale atom: an open screen re-translates on a
  // language switch, including the SectionList's memoized section headers.
  const t = useT()
  const dir = useDir()
  const items = useStore(inboxItems)
  const [refreshing, setRefreshing] = useState(false)

  // Sections keep the contract's order (Needs you → Finished → Failed) and
  // drop empties, so a quiet day is one short list instead of three headers.
  const groups = groupInbox(items)
  const order: InboxKind[] = ['ask', 'done', 'error']
  const sections = order
    .filter((k) => groups[k].length > 0)
    .map((k) => ({ kind: k, title: t(SECTION_KEY[k]), data: groups[k] }))

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
    <ScreenShell title={t('inbox.title')} showBrand>
      <SectionList
        sections={sections}
        keyExtractor={(item) => `${item.kind}:${item.storedId}`}
        stickySectionHeadersEnabled={false}
        style={s.list}
        contentContainerStyle={[s.content, sections.length === 0 && s.contentEmpty]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.textDim} />
        }
        renderSectionHeader={({ section }) => (
          <View style={[s.sectionHead, { flexDirection: dir.row }]}>
            <Kicker style={s.kicker}>{section.title}</Kicker>
            <Pill
              kind={PILL_KIND[section.kind]}
              style={s.sectionPill}
              textStyle={s.sectionCount}
            >
              {section.data.length}
            </Pill>
          </View>
        )}
        renderItem={({ item }) => {
          const age = inboxAgeLabel(item.at, Date.now(), t)
          const title = item.title || t('inbox.untitled')
          return (
            <Card onPress={() => open(item)} accessibilityLabel={title}>
              <View style={[s.rowInner, { flexDirection: dir.row }]}>
                <Dot kind={DOT_KIND[item.kind]} style={s.dot} />
                <View style={s.rowBody}>
                  <View style={[s.rowHead, { flexDirection: dir.row }]}>
                    <Txt size={13} weight="700" numberOfLines={1} style={s.title}>
                      {title}
                    </Txt>
                    {age ? (
                      <Txt size={10.5} color={C.textFaint} style={s.age}>
                        {age}
                      </Txt>
                    ) : null}
                  </View>
                  {item.detail ? (
                    <Txt size={11.5} color={C.textDim} numberOfLines={1} style={s.detail}>
                      {item.detail}
                    </Txt>
                  ) : null}
                </View>
              </View>
            </Card>
          )
        }}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <MochiMark size={EMPTY_MOCHI_SIZE} />
            <Txt size={16} weight="800" center style={s.emptyTitle}>
              {t('inbox.empty.headline')}
            </Txt>
            <Txt size={12.5} color={C.textDim} center style={s.emptyBody}>
              {t('inbox.empty.caption')}
            </Txt>
          </View>
        }
      />
    </ScreenShell>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  list: { flex: 1 },
  content: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 18 },
  contentEmpty: { flexGrow: 1, justifyContent: 'center' },
  sectionHead: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    marginBottom: 6,
    marginHorizontal: 2,
  },
  // Kicker ships with its own vertical margins; the section row owns them.
  kicker: { margin: 0 },
  sectionPill: { alignSelf: 'center' },
  sectionCount: { fontSize: 10 },
  rowInner: { alignItems: 'flex-start', gap: 9 },
  dot: { marginTop: 5 },
  rowBody: { flex: 1, minWidth: 0 },
  rowHead: { alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  title: { flexShrink: 1 },
  age: { flexShrink: 0 },
  detail: { marginTop: 2 },
  emptyWrap: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 24 },
  emptyTitle: { marginTop: 10 },
  emptyBody: { marginTop: 4, maxWidth: 240 },
})
