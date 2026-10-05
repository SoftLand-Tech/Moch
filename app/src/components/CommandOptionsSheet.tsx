/**
 * Subcommand chooser for commands the gateway marks `argument_mode:
 * "options"` or `"mixed"` (same field the desktop composer reads). A bare
 * `/reasoning` or `/fast` opens this instead of the gateway's usage text;
 * tapping a choice runs `/cmd choice` through the normal dispatch path.
 * Mixed commands also take free text (e.g. `/queue add <prompt>`).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, TextInput, ScrollView, StyleSheet, Platform, ActivityIndicator } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import * as Haptics from 'expo-haptics'
import { cachedCommandChoices, rememberCommandChoices } from '../lib/slash'
import { C, useStyles } from '../lib/theme'

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
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  // Repeat opens of the same command render the cached choices instantly —
  // the RPC only pays on the first open (cache is dropped on catalog reload).
  const [dynamic, setDynamic] = useState<OptionChoice[] | null>(() =>
    choices.length ? null : cachedCommandChoices(command),
  )
  const [loadingDyn, setLoadingDyn] = useState(false)
  const loaded = useRef(false)

  const all = choices.length ? choices : (dynamic ?? [])
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (q ? all.filter((c) => c.value.toLowerCase().includes(q)) : all),
    [all, q],
  )

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
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={onClose} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.head}>
            <Icon name="terminal-outline" size={15} color={C.accent} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>/{command}</Text>
              {description ? <Text style={s.sub} numberOfLines={2}>{description}</Text> : null}
            </View>
            <Pressable
              style={({ pressed }) => [s.close, pressed && s.iconPressed]}
              hitSlop={8}
              onPress={onClose}
              accessibilityLabel="Close"
            >
              <Icon name="close" size={18} color={C.textDim} />
            </Pressable>
          </View>

          <View style={s.searchWrap}>
            <Icon name="search" size={14} color={C.textFaint} />
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Filter options…"
              placeholderTextColor={C.textFaint}
              accessibilityLabel={`Filter ${command} options`}
            />
          </View>

          <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
            {shown.map((c) => (
              <Pressable
                key={c.value}
                style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                onPress={() => run(c.value)}
                accessibilityLabel={`${command} ${c.value}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowText} numberOfLines={1}>{c.value}</Text>
                  {c.meta ? <Text style={s.rowMeta} numberOfLines={1}>{c.meta}</Text> : null}
                </View>
                <Icon name="arrow-forward" size={13} color={C.textFaint} />
              </Pressable>
            ))}
            {loadingDyn ? (
              <View style={s.dynRow}>
                <ActivityIndicator size="small" color={C.accent} />
                <Text style={s.empty}>Loading options…</Text>
              </View>
            ) : null}
            {!shown.length && !loadingDyn ? (
              <Pressable style={({ pressed }) => [s.row, pressed && s.rowPressed]} onPress={() => run('')}>
                <Text style={s.rowText}>Run /{command} anyway</Text>
                <Icon name="arrow-forward" size={13} color={C.textFaint} />
              </Pressable>
            ) : null}

            {allowText ? (
              <View style={s.customWrap}>
                <TextInput
                  style={s.custom}
                  value={custom}
                  onChangeText={setCustom}
                  placeholder="Or type an argument…"
                  placeholderTextColor={C.textFaint}
                  onSubmitEditing={() => { if (custom.trim()) run(custom.trim()) }}
                  accessibilityLabel={`Custom argument for ${command}`}
                />
                <Pressable
                  style={({ pressed }) => [s.customSend, !custom.trim() && s.customSendOff, pressed && s.iconPressed]}
                  onPress={() => { if (custom.trim()) run(custom.trim()) }}
                  disabled={!custom.trim()}
                  accessibilityLabel={`Run ${command}`}
                >
                  <Icon name="arrow-up" size={16} color={C.onAccent} />
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
  scrim: { backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6 },
  title: { color: C.text, fontSize: 15.5, fontWeight: '700' },
  sub: { color: C.textFaint, fontSize: 11.5, marginTop: 1 },
  close: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { opacity: 0.55 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 14, marginBottom: 6,
    backgroundColor: C.bgCard, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, minHeight: 38,
  },
  search: { flex: 1, color: C.text, fontSize: 14, paddingVertical: 8 },
  list: { paddingHorizontal: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingHorizontal: 10, paddingVertical: 11, borderRadius: 12, minHeight: 44,
  },
  rowPressed: { backgroundColor: C.bgHover },
  rowText: { color: C.text, fontSize: 14.5, fontWeight: '500', flex: 1 },
  rowMeta: { color: C.textFaint, fontSize: 11, marginTop: 2 },
  dynRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 12 },
  empty: { color: C.textFaint, fontSize: 13, textAlign: 'center', padding: 20 },
  customWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 6, paddingTop: 6,
  },
  custom: {
    flex: 1, backgroundColor: C.bgCard, borderRadius: 20, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 13, paddingVertical: 10, minHeight: 42, fontSize: 14,
  },
  customSend: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  customSendOff: { backgroundColor: C.bgCard },
})
