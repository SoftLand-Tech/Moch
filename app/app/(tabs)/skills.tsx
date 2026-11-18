import React, { useEffect, useMemo, useState } from 'react'
import { View, FlatList, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { Icon } from '../../src/components/Icon'
import { Card, Field, Segmented, Spinner, Txt, Pill } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { useDir, useT } from '../../src/lib/strings'
import { loadCatalog, loadSkillDescriptions, commandCatalog, commandDescriptions, skillCommands, skillDescriptions } from '../../src/lib/slash'
import { isConnected as isConnectedAtom } from '../../src/lib/gateway'

/**
 * Skills + slash commands — the Hermes equivalent of ChatGPT's "Plugins".
 * Everything is fetched from the gateway's own registry (`commands.catalog`),
 * so nothing is hardcoded and new server-side commands appear automatically.
 *
 * Mockup screen 10: filter + Commands/Skills segmented switch + catalog cards.
 * Tapping a row still just drops the command/skill into the chat composer.
 */

/** Known gateway origin tokens → localized labels; anything else reads raw. */
const ORIGIN_KEYS: Record<string, string> = {
  bundled: 'skills.origin.bundled',
  user: 'skills.origin.user',
  local: 'skills.origin.local',
}

export default function Skills() {
  const s = useStyles(makeS)
  // BUG-133: chat-pad pattern on the LIST only — the filter field stays
  // top-anchored while the results viewport ends at the keyboard's top edge.
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  // Locale subscription: the open screen re-translates on a language switch.
  const t = useT()
  const dir = useDir()
  const router = useRouter()
  const online = useStore(isConnectedAtom)
  const skills = useStore(skillCommands)
  const commands = useStore(commandCatalog)
  const cmdDescs = useStore(commandDescriptions)
  const skillDescs = useStore(skillDescriptions)
  const [query, setQuery] = useState('')
  // Spinner only until the FIRST catalog lands — when the chat path already
  // loaded the registry the lists render on the very first paint.
  const [loading, setLoading] = useState(() => Object.keys(commandCatalog.get()).length === 0)
  const [tab, setTab] = useState<'commands' | 'skills'>('commands')

  useEffect(() => {
    if (!online) {
      setLoading(false)
      return
    }
    // Serve the in-memory catalog instantly; only hit the wire when empty
    // (loadCatalog({}) is a no-op once loaded — same lifetime the chat path
    // and ScreenShell already assume).
    const cached = Object.keys(commandCatalog.get()).length > 0
    loadCatalog(cached ? {} : { force: true })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [online])

  // Skill descriptions arrive via one complete.slash query per skill (the
  // catalog carries none) — progressive: rows render immediately and the
  // descriptions fill in as batches land.
  useEffect(() => {
    if (tab === 'skills' && online) void loadSkillDescriptions().catch(() => {})
  }, [tab, online])

  const skillList = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\//, '')
    return Object.entries(skills)
      .map(([name, meta]) => ({ name, desc: skillDescs[name.replace(/^\//, '').toLowerCase()], ...meta }))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.desc?.toLowerCase().includes(q))
      .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))
  }, [skills, skillDescs, query])

  const commandList = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.entries(commands)
      .map(([name, def]) => ({ name, desc: cmdDescs[name.replace(/^\//, '').toLowerCase()] ?? def.description }))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.desc?.toLowerCase().includes(q))
  }, [commands, cmdDescs, query])

  const run = (name: string) => {
    // Skill keys already carry a leading slash — normalise so the composer
    // never ends up with "//airtable".
    const bare = name.replace(/^\/+/, '')
    // navigate (not push): reuse the mounted tabs group instead of stacking
    // a fresh copy of every tab screen on each run.
    router.navigate({ pathname: '/(tabs)/chat', params: { draft: `/${bare} ` } } as never)
  }

  /** Origin token as the mockup's accent pill ("bundled" / "user" / …). */
  const originLabel = (raw?: string): string => {
    const token = (raw ?? 'local').trim().toLowerCase()
    const key = ORIGIN_KEYS[token]
    return key ? t(key) : token
  }

  // Command/skill ids are mono LTR data even in Arabic — writingDirection
  // stays ltr, but the text itself must sit on the row's start edge (right
  // when the UI is mirrored), so the alignment follows the UI direction.
  const idAlign = { textAlign: dir.textAlign } as const

  const emptyText = !online
    ? t('common.offline')
    : query.trim()
      ? t('skills.empty.matches')
      : tab === 'commands'
        ? t('skills.empty.commands')
        : t('skills.empty.skills')

  const tabOptions = [
    { key: 'commands' as const, label: t('skills.tab.commands', { n: Object.keys(commands).length }) },
    { key: 'skills' as const, label: t('skills.tab.skills', { n: Object.keys(skills).length }) },
  ]

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title={t('skills.title')} showBrand>
        {/* app-scroll's padded top block: filter + Commands/Skills switch.
            Kept OUTSIDE the keyboard-padded list wraps so the field stays put
            (BUG-133) while results rise above the keys. */}
        <View style={s.top}>
          <Field
            value={query}
            onChangeText={setQuery}
            placeholder={t('skills.filter.placeholder')}
            autoCorrect={false}
            accessibilityLabel={t('skills.filter.a11y')}
            wrapStyle={s.filter}
          />
          <Segmented options={tabOptions} value={tab} onChange={setTab} style={s.segment} />
        </View>

        {loading ? (
          <View style={s.loadWrap}>
            <Spinner />
          </View>
        ) : null}

        {!loading && tab === 'commands' ? (
          <Animated.View style={[s.kbListWrap, kbPad]}>
            <FlatList
              data={commandList}
              keyExtractor={(x) => x.name}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={s.listContent}
              ListEmptyComponent={<Txt size={14} color={C.textFaint} center style={s.empty}>{emptyText}</Txt>}
              renderItem={({ item }) => (
                <Card
                  onPress={() => run(item.name)}
                  accessibilityLabel={t('skills.a11y.command', { name: item.name })}
                >
                  <View style={[s.rowInner, { flexDirection: dir.row }]}>
                    <View style={s.rowBody}>
                      <Txt
                        size={13}
                        weight="700"
                        color={C.accent}
                        mono
                        ltr
                        numberOfLines={1}
                        style={idAlign}
                      >
                        {item.name}
                      </Txt>
                      {item.desc ? (
                        <Txt size={11.5} color={C.textDim} numberOfLines={2} style={s.rowDesc}>
                          {item.desc}
                        </Txt>
                      ) : null}
                    </View>
                    <Icon name={dir.icon.forward} size={16} color={C.textFaint} />
                  </View>
                </Card>
              )}
            />
          </Animated.View>
        ) : null}

        {!loading && tab === 'skills' ? (
          <Animated.View style={[s.kbListWrap, kbPad]}>
            <FlatList
              data={skillList}
              keyExtractor={(x) => x.name}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={s.listContent}
              ListEmptyComponent={<Txt size={14} color={C.textFaint} center style={s.empty}>{emptyText}</Txt>}
              renderItem={({ item }) => (
                <Card
                  onPress={() => run(item.name)}
                  accessibilityLabel={t('skills.a11y.skill', { name: item.name })}
                >
                  <View style={[s.skillHead, { flexDirection: dir.row }]}>
                    <View style={[s.skillId, { flexDirection: dir.row }]}>
                      <Txt
                        size={13}
                        weight="700"
                        mono
                        ltr
                        numberOfLines={1}
                        style={[s.skillName, idAlign]}
                      >
                        {item.name}
                      </Txt>
                      <Pill kind="accent" style={s.originPill} textStyle={s.originPillText}>
                        {originLabel(item.origin)}
                      </Pill>
                    </View>
                    {item.usage != null ? (
                      <Txt size={10.5} color={C.textFaint} mono style={s.used}>
                        {t('skills.used', { n: item.usage })}
                      </Txt>
                    ) : null}
                  </View>
                  {item.desc ? (
                    <Txt size={11.5} color={C.textDim} numberOfLines={2} style={s.rowDesc}>
                      {item.desc}
                    </Txt>
                  ) : null}
                </Card>
              )}
            />
          </Animated.View>
        ) : null}
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  kbListWrap: { flex: 1 },
  top: { paddingHorizontal: 14, paddingTop: 10 },
  filter: { marginBottom: 8 },
  segment: { marginBottom: 10 },
  loadWrap: { marginTop: 28, alignItems: 'center' },
  // app-scroll padding: 10 top / 14 horizontal / 18 bottom (mockup screen 10).
  listContent: { paddingHorizontal: 14, paddingBottom: 18 },
  rowInner: { alignItems: 'center', gap: 8 },
  rowBody: { flex: 1, minWidth: 0 },
  rowDesc: { marginTop: 2, lineHeight: 17 },
  skillHead: { alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  skillId: { alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },
  skillName: { flexShrink: 1 },
  originPill: { alignSelf: 'center' },
  originPillText: { fontSize: 9.5 },
  used: { flexShrink: 0 },
  empty: { marginTop: 48 },
})
