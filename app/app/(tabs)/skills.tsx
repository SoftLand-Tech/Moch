import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import { loadCatalog, loadSkillDescriptions, commandCatalog, commandCategories, commandDescriptions, skillCommands, skillDescriptions } from '../../src/lib/slash'
import { isConnected as isConnectedAtom } from '../../src/lib/gateway'

/**
 * Skills + slash commands — the Hermes equivalent of ChatGPT's "Plugins".
 * Everything is fetched from the gateway's own registry (`commands.catalog`),
 * so nothing is hardcoded and new server-side commands appear automatically.
 */
export default function Skills() {
  const s = useStyles(makeS)
  const router = useRouter()
  const online = useStore(isConnectedAtom)
  const skills = useStore(skillCommands)
  const commands = useStore(commandCatalog)
  const categories = useStore(commandCategories)
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

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell title="Skills" showBrand>
        <View style={s.searchWrap}>
          <TextInput
            style={s.search}
            value={query}
            onChangeText={setQuery}
            placeholder={tab === 'commands' ? 'Filter commands…' : 'Filter skills…'}
            placeholderTextColor={C.textFaint}
            autoCorrect={false}
            accessibilityLabel="Filter"
          />
        </View>

        <View style={s.tabs}>
          {(['commands', 'skills'] as const).map((t) => (
            <Pressable
              key={t}
              style={({ pressed }) => [s.tab, tab === t && s.tabOn, pressed && s.tabPressed]}
              onPress={() => setTab(t)}
              accessibilityRole="button"
            >
              <Text style={[s.tabText, tab === t && s.tabTextOn]}>{t === 'commands' ? `Commands (${Object.keys(commands).length})` : `Skills (${Object.keys(skills).length})`}</Text>
            </Pressable>
          ))}
        </View>

        {loading ? <ActivityIndicator color={C.textDim} style={{ marginTop: 28 }} /> : null}

        {!loading && tab === 'commands' ? (
          <FlatList
            data={commandList}
            keyExtractor={(x) => x.name}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32 }}
            ListEmptyComponent={
              <Text style={s.empty}>{online ? (query ? 'No matches' : 'No commands loaded') : 'Offline'}</Text>
            }
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                onPress={() => run(item.name)}
                accessibilityLabel={item.name}
              >
                <Text style={s.rowName}>{item.name}</Text>
                {item.desc ? (
                  <Text style={s.rowDesc} numberOfLines={2}>
                    {item.desc}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        ) : null}

        {!loading && tab === 'skills' ? (
          <FlatList
            data={skillList}
            keyExtractor={(x) => x.name}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32 }}
            ListEmptyComponent={<Text style={s.empty}>{online ? (query ? 'No matches' : 'No skills installed') : 'Offline'}</Text>}
            renderItem={({ item }) => (
              <Pressable style={({ pressed }) => [s.row, pressed && s.rowPressed]} onPress={() => run(item.name)} accessibilityLabel={item.name}>
                <View style={s.skillHead}>
                  <Text style={s.rowName}>{item.name}</Text>
                  <Text style={s.badge}>{item.origin ?? 'local'}</Text>
                </View>
                {item.desc ? (
                  <Text style={s.rowDesc} numberOfLines={2}>{item.desc}</Text>
                ) : item.usage != null ? (
                  <Text style={s.rowDesc}>used {item.usage}×</Text>
                ) : null}
              </Pressable>
            )}
          />
        ) : null}
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  search: { backgroundColor: C.bgCard, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: C.text, fontSize: 15, minHeight: 44 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  tab: { paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: C.accent },
  tabPressed: { opacity: 0.6 },
  tabText: { color: C.textDim, fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: C.onAccent },
  row: { paddingHorizontal: 10, paddingVertical: 11, borderRadius: 10, minHeight: 48, justifyContent: 'center' },
  rowPressed: { backgroundColor: C.bgCard },
  rowName: { color: C.text, fontSize: 15, fontWeight: '600' },
  rowDesc: { color: C.textFaint, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  skillHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase' },
  empty: { color: C.textFaint, textAlign: 'center', marginTop: 48, fontSize: 14 },
})
