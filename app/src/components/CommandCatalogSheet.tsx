/**
 * CommandCatalogSheet — the command browser. Anatomy-copied from
 * ModelPickerSheet (slide Modal, scrim tap-to-close, bgElev sheet, search
 * field, sectioned Pressable rows), now on the redesign sheet language
 * (SheetCard/SheetGrabber + pill tags + mono command names).
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
import { Modal, View, Text, Pressable, TextInput, SectionList, StyleSheet } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Icon } from './Icon'
import { Pill, SheetGrabber, Txt } from './ui'
import * as Haptics from 'expo-haptics'
import { useStore } from '@nanostores/react'
import { loadCatalog, loadSkillDescriptions, commandCategories, commandCatalog, skillCommands, skillDescriptions, catalogWarning, slashLabel } from '../lib/slash'
import { C, useStyles } from '../lib/theme'
import { useDir, useT } from '../lib/strings'

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
  const dir = useDir()
  const t = useT()
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
        skillRows.push({ key, label: slashLabel(key), desc: skillDescs[bare.toLowerCase()] ?? t('chat.catalog.skillOrigin', { origin: skill.origin ?? 'local' }), kind: 'skill' })
      }
    }
    if (skillRows.length) out.push({ name: t('chat.catalog.skills'), data: skillRows })
    return out
    // `matches` closes over q only — recompute on query/registry change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, skills, skillDescs, q, t])

  const registryEmpty = cmdCount === 0 && skillCount === 0
  const countsLabel = [
    cmdCount ? (cmdCount === 1 ? t('chat.cmd.commandOne') : t('chat.cmd.commandMany', { n: cmdCount })) : '',
    skillCount ? (skillCount === 1 ? t('chat.cmd.skillOne') : t('chat.cmd.skillMany', { n: skillCount })) : '',
  ].filter(Boolean).join(' · ')

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
      {/* BUG-133: 'height' derives its lift from a measured frame — the exact
          math this repo rejected (chat.tsx MIUI note) — and could undershoot,
          leaving the bottom rows under the IME. 'padding' on the Modal's
          full-screen root is the connectors-proven exact variant. */}
      <KeyboardAvoidingView style={s.flex} behavior="padding">
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={onClose} accessibilityLabel={t('chat.catalog.closeA11y')} />
        <View style={s.sheet}>
          <SheetGrabber />
          {/* Header */}
          <View style={[s.head, { flexDirection: dir.row }]}>
            <Icon name="terminal-outline" size={15} color={C.accent} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt size={14} weight="800">{t('chat.catalog.title')}</Txt>
              <Txt size={11} color={C.textDim} numberOfLines={1}>
                {loading
                  ? t('chat.catalog.loading')
                  : registryEmpty
                    ? t('chat.catalog.notLoaded')
                    : countsLabel}
              </Txt>
            </View>
            <Pressable
              style={({ pressed }) => [s.close, pressed && s.iconPressed]}
              hitSlop={8}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            >
              <Icon name="close" size={18} color={C.textDim} />
            </Pressable>
          </View>

          {/* Search */}
          <View style={[s.searchWrap, { flexDirection: dir.row }]}>
            <Icon name="search" size={15} color={C.textFaint} />
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder={t('chat.slash.filterPlaceholder')}
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t('chat.slash.filterPlaceholder')}
            />
            {query ? (
              <Pressable
                hitSlop={6}
                style={({ pressed }) => [s.clear, pressed && s.iconPressed]}
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel={t('chat.catalog.clearA11y')}
              >
                <Icon name="close-circle" size={15} color={C.textFaint} />
              </Pressable>
            ) : null}
          </View>

          {warning ? <Text style={s.warning}>{warning}</Text> : null}

          {registryEmpty && loading ? (
            <View style={s.emptyWrap}>
              <Icon name="time-outline" size={16} color={C.accent} />
              <Txt size={11.5} color={C.textFaint} center>{t('chat.catalog.loadingCatalog')}</Txt>
            </View>
          ) : registryEmpty ? (
            <View style={s.emptyWrap}>
              <Txt size={12} color={C.textFaint} center>{t('chat.catalog.empty')}</Txt>
              <Pressable
                onPress={runFallback}
                style={({ pressed }) => [s.fallbackRow, { flexDirection: dir.row }, pressed && s.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel={t('chat.catalog.runFallbackA11y')}
              >
                <Icon name="terminal-outline" size={15} color={C.accent} />
                <Txt size={12.5} weight="700" color={C.accent} style={{ flex: 1 }}>{t('chat.catalog.runFallback')}</Txt>
                <Icon name={dir.icon.forward} size={14} color={C.textFaint} />
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
                  style={({ pressed }) => [s.row, { flexDirection: dir.row }, pressed && s.rowPressed]}
                  onPress={() => pick(row)}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.label}${row.desc ? `, ${row.desc.slice(0, 80)}` : ''}`}
                >
                  <Icon
                    name={row.kind === 'skill' ? 'sparkles-outline' : 'terminal-outline'}
                    size={14}
                    color={row.kind === 'skill' ? C.accent : C.textFaint}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt size={12.5} weight="700" color={C.accent} mono ltr numberOfLines={1}>{row.label}</Txt>
                    {row.desc ? (
                      <Text style={s.rowSub} numberOfLines={2}>{row.desc}</Text>
                    ) : null}
                  </View>
                  <Pill kind="neutral" style={s.kindPill}>
                    {row.kind === 'skill' ? t('chat.catalog.kindSkill') : t('chat.catalog.kindCommand')}
                  </Pill>
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
              ListEmptyComponent={<Text style={s.empty}>{t('chat.catalog.noMatches', { query })}</Text>}
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
  // sheet-card: bgElev, radius 24 top, padding 10 14 26.
  sheet: {
    backgroundColor: C.bgElev,
    borderTopWidth: 1,
    borderColor: C.border,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '82%',
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 26,
  },
  head: { alignItems: 'center', gap: 8, marginBottom: 8 },
  close: { width: 28, height: 28, borderRadius: 9, backgroundColor: C.btnTint, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { opacity: 0.55 },
  searchWrap: {
    alignItems: 'center', gap: 8,
    marginBottom: 6,
    backgroundColor: C.inputBg, borderRadius: 11, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 38,
  },
  search: { flex: 1, color: C.text, fontSize: 13, paddingVertical: 9 },
  clear: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  warning: { color: C.amber, fontSize: 11, lineHeight: 15, paddingBottom: 6 },
  list: { paddingHorizontal: 0 },
  sectionLabel: { color: C.textFaint, fontSize: 10, fontWeight: '800', letterSpacing: 1.2, paddingTop: 12, paddingBottom: 4, textTransform: 'uppercase' },
  row: {
    alignItems: 'center', gap: 8,
    paddingHorizontal: 6, paddingVertical: 8, borderRadius: 9, minHeight: 44,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowSub: { color: C.textFaint, fontSize: 11, marginTop: 2 },
  kindPill: { paddingVertical: 1, paddingHorizontal: 6 },
  emptyWrap: { paddingVertical: 24, paddingHorizontal: 4, gap: 12, alignItems: 'center' },
  empty: { color: C.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 20 },
  fallbackRow: {
    alignItems: 'center', gap: 8,
    backgroundColor: C.bgCard, borderWidth: 1, borderColor: C.border,
    borderRadius: 11, paddingHorizontal: 12, minHeight: 40,
  },
})
