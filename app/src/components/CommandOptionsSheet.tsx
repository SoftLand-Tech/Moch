/**
 * Subcommand chooser for commands the gateway marks `argument_mode:
 * "options"` or `"mixed"` (same field the desktop composer reads). A bare
 * `/reasoning` or `/fast` opens this instead of the gateway's usage text;
 * tapping a choice runs `/cmd choice` through the normal dispatch path.
 * Mixed commands also take free text (e.g. `/queue add <prompt>`).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, TextInput, ScrollView, StyleSheet } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Icon } from './Icon'
import { SheetGrabber, Txt } from './ui'
import * as Haptics from 'expo-haptics'
import { cachedCommandChoices, rememberCommandChoices } from '../lib/slash'
import { C, useStyles } from '../lib/theme'
import { useDir, useT } from '../lib/strings'

export interface OptionChoice {
  value: string
  meta?: string
}

export function CommandOptionsSheet({
  command,
  description,
  choices,
  allowText,
  loadChoices,
  onRun,
  onClose,
}: {
  command: string
  description: string
  /** Static choices from the catalog's `sub` list, when it has one. */
  choices: OptionChoice[]
  /** Mixed mode: also offer a free-text argument. */
  allowText: boolean
  /**
   * Fallback loader for dynamic choices (the catalog only says "options" for
   * e.g. /personality — the actual names come from `complete.slash`).
   */
  loadChoices?: () => Promise<OptionChoice[]>
  /** Receives the full command line, e.g. "/reasoning high". */
  onRun: (commandLine: string) => void
  onClose: () => void
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  const t = useT()
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  // Repeat opens of the same command render the cached choices instantly —
  // the RPC only pays on the first open (cache is dropped on catalog reload).
  const [dynamic, setDynamic] = useState<OptionChoice[] | null>(() =>
    choices.length ? null : cachedCommandChoices(command),
  )
  const [loadingDyn, setLoadingDyn] = useState(false)
  const loaded = useRef(false)

  const q = query.trim().toLowerCase()
  // `all` is derived inside the memo so the hook deps stay the raw sources.
  const shown = useMemo(() => {
    const all = choices.length ? choices : (dynamic ?? [])
    return q ? all.filter((c) => c.value.toLowerCase().includes(q)) : all
  }, [choices, dynamic, q])

  useEffect(() => {
    if (choices.length || !loadChoices || loaded.current) return
    loaded.current = true
    const cached = cachedCommandChoices(command)
    if (cached) {
      setDynamic(cached)
      return
    }
    setLoadingDyn(true)
    loadChoices()
      .then((items) => {
        rememberCommandChoices(command, items)
        setDynamic(items)
      })
      .catch(() => setDynamic([]))
      .finally(() => setLoadingDyn(false))
  }, [choices.length, loadChoices, command])

  const run = (argText: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onRun(`/${command}${argText ? ` ${argText}` : ''}`)
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* BUG-133: 'height' derives its lift from a measured frame — the exact
          math this repo rejected (chat.tsx MIUI note). With a short options
          list the custom-argument row + Run button sat at the screen bottom
          where any undershoot left them under the IME. 'padding' on the
          Modal's full-screen root is the connectors-proven exact variant. */}
      <KeyboardAvoidingView style={s.flex} behavior="padding">
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={onClose} accessibilityLabel={t('common.close')} />
        <View style={s.sheet}>
          <SheetGrabber />
          <View style={[s.head, { flexDirection: dir.row }]}>
            <Icon name="terminal-outline" size={15} color={C.accent} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt size={13.5} weight="800" color={C.accent} mono ltr>/{command}</Txt>
              {description ? <Text style={s.sub} numberOfLines={2}>{description}</Text> : null}
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

          <View style={[s.searchWrap, { flexDirection: dir.row }]}>
            <Icon name="search" size={14} color={C.textFaint} />
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder={t('chat.options.filterPlaceholder')}
              placeholderTextColor={C.textFaint}
              accessibilityLabel={t('chat.options.filterA11y', { command })}
            />
          </View>

          <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
            {shown.map((c) => (
              <Pressable
                key={c.value}
                style={({ pressed }) => [s.row, { flexDirection: dir.row }, pressed && s.rowPressed]}
                onPress={() => run(c.value)}
                accessibilityRole="button"
                accessibilityLabel={t('chat.options.choiceA11y', { command, value: c.value })}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt size={13} weight="600" numberOfLines={1}>{c.value}</Txt>
                  {c.meta ? <Text style={s.rowMeta} numberOfLines={1}>{c.meta}</Text> : null}
                </View>
                <Icon name={dir.icon.forward} size={13} color={C.textFaint} />
              </Pressable>
            ))}
            {loadingDyn ? (
              <View style={s.dynRow}>
                <Icon name="time-outline" size={14} color={C.accent} />
                <Txt size={11.5} color={C.textFaint}>{t('chat.options.loading')}</Txt>
              </View>
            ) : null}
            {!shown.length && !loadingDyn ? (
              <Pressable
                style={({ pressed }) => [s.row, { flexDirection: dir.row }, pressed && s.rowPressed]}
                onPress={() => run('')}
                accessibilityRole="button"
                accessibilityLabel={t('chat.options.runAnyway', { command })}
              >
                <Txt size={13} weight="600" style={{ flex: 1 }}>{t('chat.options.runAnyway', { command })}</Txt>
                <Icon name={dir.icon.forward} size={13} color={C.textFaint} />
              </Pressable>
            ) : null}

            {allowText ? (
              <View style={[s.customWrap, { flexDirection: dir.row }]}>
                <TextInput
                  style={s.custom}
                  value={custom}
                  onChangeText={setCustom}
                  placeholder={t('chat.options.customPlaceholder')}
                  placeholderTextColor={C.textFaint}
                  onSubmitEditing={() => { if (custom.trim()) run(custom.trim()) }}
                  accessibilityLabel={t('chat.options.customA11y', { command })}
                />
                <Pressable
                  style={({ pressed }) => [s.customSend, !custom.trim() && s.customSendOff, pressed && s.iconPressed]}
                  onPress={() => { if (custom.trim()) run(custom.trim()) }}
                  disabled={!custom.trim()}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.options.runA11y', { command })}
                >
                  <Icon name="arrow-up" size={16} color={custom.trim() ? C.onAccent : C.textFaint} />
                </Pressable>
              </View>
            ) : null}
            <View style={{ height: 12 }} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
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
    maxHeight: '70%',
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 26,
  },
  head: { alignItems: 'center', gap: 8, marginBottom: 8 },
  sub: { color: C.textFaint, fontSize: 11, marginTop: 1 },
  close: { width: 28, height: 28, borderRadius: 9, backgroundColor: C.btnTint, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { opacity: 0.55 },
  searchWrap: {
    alignItems: 'center', gap: 8,
    marginBottom: 6,
    backgroundColor: C.inputBg, borderRadius: 11, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 36,
  },
  search: { flex: 1, color: C.text, fontSize: 13, paddingVertical: 8 },
  list: { paddingHorizontal: 0 },
  row: {
    alignItems: 'center', justifyContent: 'space-between', gap: 8,
    paddingHorizontal: 6, paddingVertical: 9, borderRadius: 9, minHeight: 40,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowMeta: { color: C.textFaint, fontSize: 10.5, marginTop: 2 },
  dynRow: { alignItems: 'center', gap: 8, paddingHorizontal: 6, paddingVertical: 12 },
  customWrap: {
    alignItems: 'center', gap: 8, paddingTop: 8, marginTop: 4,
    borderTopWidth: 1, borderTopColor: C.borderSoft,
  },
  custom: {
    flex: 1, backgroundColor: C.inputBg, borderRadius: 11, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 12, paddingVertical: 9, minHeight: 38, fontSize: 13,
  },
  customSend: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  customSendOff: { backgroundColor: C.bgCard },
})
