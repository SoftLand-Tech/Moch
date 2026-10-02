/**
 * CommandCatalogSheet — the command browser. Anatomy-copied from
 * ModelPickerSheet (slide Modal, scrim tap-to-close, bgElev radius-20 sheet,
 * search field, sectioned Pressable rows).
 *
 * Renders the gateway-owned registry atoms — commandCategories for the
 * sectioned commands, skillCommands for the skills — and self-loads them via
 * loadCatalog when opened empty (spinner, then the fallback row only if the
 * fetch failed). The list is a virtualized SectionList: mounting 200+ rows
 * during the Modal slide is what made the sheet feel janky. Tapping a row
 * puts the command in the composer (exactly one leading slash — slashLabel
 * guards both registry key conventions) and closes.
 *
 * `onRunFallback` exists for the degenerate case the intercept can't reach:
 * the sheet open while the registry is still empty after a load attempt
 * (e.g. commands.catalog failed offline). It runs /help through the gateway
 * for the raw dump; it is deliberately not offered as a persistent footer
 * while the registry is loaded, because runSlash would just re-intercept
 * bare /help into this same sheet.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, Pressable, TextInput, SectionList, StyleSheet, Platform, ActivityIndicator } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import * as Haptics from 'expo-haptics'
import { useStore } from '@nanostores/react'
import { loadCatalog, loadSkillDescriptions, commandCategories, commandCatalog, skillCommands, skillDescriptions, catalogWarning, slashLabel } from '../lib/slash'
import { C, pill, useStyles } from '../lib/theme'

interface CatalogSection {
  name: string
  data: Array<{ key: string; label: string; desc: string; kind: 'command' | 'skill' }>
}

export function CommandCatalogSheet({
  open, onClose, onInsert, onRunFallback,
}: {
  open: boolean
  onClose: () => void
  /** Puts the command line in the composer (the chat screen closes nothing). */
  onInsert: (line: string) => void
  /** Runs /help through the gateway for the raw dump (empty-registry path). */
  onRunFallback: () => void
}) {
  const s = useStyles(makeS)
  const categories = useStore(commandCategories)
  const catalog = useStore(commandCatalog)
  const skills = useStore(skillCommands)
  const skillDescs = useStore(skillDescriptions)
  const warning = useStore(catalogWarning)

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (open) setQuery('')
  }, [open])
  // Self-load: the browser is the bare /help entry point, so it must never
  // bounce the user back to the gateway dump just because the registry has
  // not landed yet (loadCatalog also runs on composer focus; force covers
  // retrying a failed first fetch).
  useEffect(() => {
    if (!open) return
    const empty = Object.keys(commandCatalog.get()).length === 0 && Object.keys(skillCommands.get()).length === 0
    if (!empty) return
    let cancelled = false
    setLoading(true)
    void loadCatalog({ force: true })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    void loadSkillDescriptions().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  const cmdCount = Object.keys(catalog).length
  const skillCount = Object.keys(skills).length

  const q = query.trim().toLowerCase().replace(/^\/+/, '')
  const matches = (name: string, desc: string) =>
    !q || name.replace(/^\//, '').toLowerCase().includes(q) || desc.toLowerCase().includes(q)

  const sections = useMemo<CatalogSection[]>(() => {
    const out: CatalogSection[] = []
    const seen = new Set<string>()
    for (const cat of categories) {
      const headMatch = q.length > 0 && cat.name.toLowerCase().includes(q)
      const rows: CatalogSection['data'] = []
      for (const [key, desc] of cat.pairs) {
        seen.add(key.replace(/^\//, '').toLowerCase())
        if (headMatch || matches(key, desc ?? '')) {
          rows.push({ key, label: slashLabel(key), desc: desc ?? '', kind: 'command' })
        }
      }
      if (rows.length) out.push({ name: cat.name, data: rows })
    }
    const skillRows: CatalogSection['data'] = []
    for (const [key, skill] of Object.entries(skills)) {
      if (seen.has(key.replace(/^\//, '').toLowerCase())) continue
      if (skillMatches(q, key, skill.origin)) {
        const bare = key.replace(/^\//, '')
        // Real description once the scrape lands; the origin tag until then.
        skillRows.push({ key, label: slashLabel(key), desc: skillDescs[bare.toLowerCase()] ?? `skill · ${skill.origin ?? 'local'}`, kind: 'skill' })
      }
    }
    if (skillRows.length) out.push({ name: 'Skills', data: skillRows })
    return out
    // `matches` closes over q only — recompute on query/registry change.
  }, [categories, skills, skillDescs, q])

  const registryEmpty = cmdCount === 0 && skillCount === 0

  const pick = (row: CatalogSection['data'][number]) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onInsert(row.label)
    onClose()
  }

  const runFallback = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onRunFallback()
  }

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={onClose} accessibilityLabel="Close command browser" />
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.head}>
            <Icon name="terminal-outline" size={15} color={C.accent} />
            <View style={{ flex: 1 }}>
              <Text style={s.headTitle}>Commands</Text>
              <Text style={s.headSub} numberOfLines={1}>
                {loading
                  ? 'Loading…'
                  : registryEmpty
                    ? 'Registry not loaded'
                    : `${cmdCount ? `${cmdCount} command${cmdCount === 1 ? '' : 's'}` : ''}${cmdCount && skillCount ? ' · ' : ''}${skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'}` : ''}`}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [s.close, pressed && s.iconPressed]}
              hitSlop={8}
              onPress={onClose}
              accessibilityLabel="Close"
            >
              <Icon name="close" size={20} color={C.textDim} />
            </Pressable>
          </View>

          {/* Search */}
          <View style={s.searchWrap}>
            <Icon name="search" size={15} color={C.textFaint} />
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Filter commands…"
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Filter commands"
            />
            {query ? (
              <Pressable
                hitSlop={6}
                style={({ pressed }) => [s.clear, pressed && s.iconPressed]}
                onPress={() => setQuery('')}
                accessibilityLabel="Clear filter"
              >
                <Icon name="close-circle" size={15} color={C.textFaint} />
              </Pressable>
            ) : null}
          </View>

          {warning ? <Text style={s.warning}>{warning}</Text> : null}

          {registryEmpty && loading ? (
            <View style={s.emptyWrap}>
              <ActivityIndicator color={C.accent} />
              <Text style={s.empty}>Loading command catalog…</Text>
            </View>
          ) : registryEmpty ? (
            <View style={s.emptyWrap}>
              <Text style={s.empty}>Command catalog not loaded yet.</Text>
              <Pressable
                onPress={runFallback}
                style={({ pressed }) => [s.fallbackRow, pressed && s.rowPressed]}
                accessibilityLabel="Run /help without the native browser"
              >
                <Icon name="terminal-outline" size={15} color={C.accent} />
                <Text style={s.fallbackText}>Run /help anyway</Text>
                <Icon name="chevron-forward" size={15} color={C.textFaint} />
              </Pressable>
            </View>
          ) : (
            // Virtualized: the registry carries 100+ commands plus skills, and
            // mounting every row during the Modal slide is what made opening
            // feel janky. Only a window of rows mounts now.
            <SectionList
              style={s.list}
              keyboardShouldPersistTaps="handled"
              sections={sections}
              keyExtractor={(row) => row.key}
              renderItem={({ item: row }) => (
                <Pressable
                  style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                  onPress={() => pick(row)}
                  accessibilityLabel={`${row.label}${row.desc ? `, ${row.desc.slice(0, 80)}` : ''}`}
                >
                  <Icon
                    name={row.kind === 'skill' ? 'sparkles-outline' : 'terminal-outline'}
                    size={14}
                    color={row.kind === 'skill' ? C.accent : C.textFaint}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle} numberOfLines={1}>{row.label}</Text>
                    {row.desc ? (
                      <Text style={s.rowSub} numberOfLines={2}>{row.desc}</Text>
                    ) : null}
                  </View>
                  <Text style={s.kindTag}>{row.kind.toUpperCase()}</Text>
                </Pressable>
              )}
              renderSectionHeader={({ section }) => (
                <Text style={s.sectionLabel}>
                  {section.name}
                  {q ? ` · ${section.data.length}` : ''}
                </Text>
              )}
              stickySectionHeadersEnabled={false}
              initialNumToRender={14}
              windowSize={9}
              ListEmptyComponent={<Text style={s.empty}>Nothing matches “{query}”.</Text>}
              ListFooterComponent={<View style={{ height: 24 }} />}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/** Skills have no description field — match the name and the origin tag. */
function skillMatches(q: string, key: string, origin?: string): boolean {
  if (!q) return true
  return key.replace(/^\//, '').toLowerCase().includes(q) || (origin ?? '').toLowerCase().includes(q)
}

const makeS = () => StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '82%',
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8 },
  headTitle: { color: C.text, fontSize: 16.5, fontWeight: '700' },
  headSub: { color: C.textFaint, fontSize: 12, marginTop: 1 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { opacity: 0.55 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 14, marginBottom: 6,
    backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 40,
  },
  search: { flex: 1, color: C.text, fontSize: 14.5, paddingVertical: 9 },
  clear: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  warning: { color: C.amber, fontSize: 11.5, lineHeight: 16, paddingHorizontal: 14, paddingBottom: 6 },
  list: { paddingHorizontal: 6 },
  sectionLabel: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 11, borderRadius: 12, minHeight: 52,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowTitle: { color: C.text, fontSize: 14.5, fontWeight: '600', flexShrink: 1 },
  rowSub: { color: C.textFaint, fontSize: 11.5, marginTop: 2 },
  kindTag: { color: C.textFaint, fontSize: 9.5, fontWeight: '800', letterSpacing: 1 },
  emptyWrap: { padding: 24, gap: 12, alignItems: 'center' },
  empty: { color: C.textFaint, fontSize: 13, textAlign: 'center' },
  fallbackRow: {
    ...pill(44),
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.bgCard, paddingHorizontal: 16,
  },
  fallbackText: { color: C.accent, fontSize: 13.5, fontWeight: '700' },
})
