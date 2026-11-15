/**
 * Drawer project list (UI-1).
 *
 * Projects are real gateway state, not local folders: the rows come from
 * `projects.tree` (lib/workspace) and every mutation goes back through the
 * `projects.*` RPCs. "All projects" is the default bucket — `active_id == null`
 * on the wire, never a made-up id.
 *
 * The long-press sheet (Rename / Set as default / Archive / Delete) and the
 * new/rename/delete dialogs reuse the drawer's dialog language from Sidebar
 * (`makeDialogS`) rather than inventing a second one: same card, same buttons,
 * same scrim, same copy slots. They render in a single RN `Modal` whose
 * full-screen root is `KeyboardAvoidingView` from react-native-keyboard-
 * controller (app/AGENTS.md pattern #2 — RN core's KAV is a literal no-op on
 * Android, and Modals get adjustNothing under edge-to-edge).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
// BUG-133 / app/AGENTS.md pattern #2: inside a Modal the OS never resizes the
// app, and RN core's KAV (`behavior` undefined on Android) is a literal no-op.
// RNKC's KeyboardAvoidingView as the Modal's full-screen root is the repo's
// proven bottom-sheet variant.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr } from '../lib/strings'
import { makeDialogS } from './Sidebar'
import { projectActions, type ProjectRow } from '../lib/workspace'

export interface ProjectListProps {
  projects: ProjectRow[]
  activeProjectId: string | null
  /** Select a project; `null` = the default (Personal) bucket. */
  onSelect: (id: string | null) => void
  /** Fired after a project was created — the shell re-reads sessions. */
  onNewProject?: () => void
  /** Fired when the long-press sheet opens. */
  onProjectMenu?: (p: ProjectRow) => void
  /** False when the drawer is closed: drops any open sheet/dialog. */
  active?: boolean
}

/** Fade/scale the overlay in when it opens (the Modal itself is unmounted on close). */
function usePopIn(visible: boolean, inMs = 140) {
  const anim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!visible) return
    anim.setValue(0)
    const a = Animated.timing(anim, {
      toValue: 1,
      duration: inMs,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    })
    a.start()
    return () => a.stop()
  }, [visible, anim, inMs])
  return anim
}

type ProjectDialog = 'none' | 'new' | 'rename' | 'delete'

export function ProjectList({
  projects,
  activeProjectId,
  onSelect,
  onNewProject,
  onProjectMenu,
  active = true,
}: ProjectListProps) {
  const s = useStyles(makeS)
  const d = useStyles(makeDialogS)
  // Locale switches must re-render the list's copy.
  useStore(localeAtom)

  const [sheetFor, setSheetFor] = useState<ProjectRow | null>(null)
  const [dialog, setDialog] = useState<ProjectDialog>('none')
  const [target, setTarget] = useState<ProjectRow | null>(null)
  const [nameText, setNameText] = useState('')
  const [pathText, setPathText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closeAll = () => {
    setSheetFor(null)
    setDialog('none')
    setTarget(null)
    setError(null)
    setBusy(false)
  }

  // Drawer closed underneath us: nothing should survive into the next open.
  // `closeAll` is a set of plain setters, stable by construction.
  useEffect(() => {
    if (!active) closeAll()
  }, [active])

  const openNew = () => {
    setSheetFor(null)
    setTarget(null)
    setNameText('')
    setPathText('')
    setError(null)
    setDialog('new')
  }

  const openSheet = (p: ProjectRow) => {
    onProjectMenu?.(p)
    setSheetFor(p)
  }

  const openRename = (p: ProjectRow) => {
    setSheetFor(null)
    setTarget(p)
    setNameText(p.name)
    setError(null)
    setDialog('rename')
  }

  const openDelete = (p: ProjectRow) => {
    setSheetFor(null)
    setTarget(p)
    setError(null)
    setDialog('delete')
  }

  const runCreate = async () => {
    if (busy) return
    const name = nameText.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    const err = await projectActions.create(name, pathText.trim() || undefined)
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    closeAll()
    onNewProject?.()
  }

  const runRename = async () => {
    if (busy || !target) return
    const name = nameText.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    const err = await projectActions.rename(target.id, name)
    setBusy(false)
    if (err) setError(err)
    else closeAll()
  }

  const runArchive = async (p: ProjectRow) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const err = await projectActions.archive(p.id)
    setBusy(false)
    if (err) setError(err)
    else closeAll()
  }

  const runDelete = async () => {
    if (busy || !target) return
    setBusy(true)
    setError(null)
    const err = await projectActions.remove(target.id)
    setBusy(false)
    if (err) setError(err)
    else closeAll()
  }

  // The default (Home) bucket is the "All projects" row, never a row of its own.
  const rows = useMemo(() => projects.filter((p) => !p.isNoProject), [projects])
  const allSelected = activeProjectId == null

  // Once closed, the sheet keeps its last project for the exit animation.
  const sheetRef = useRef<ProjectRow | null>(null)
  if (sheetFor) sheetRef.current = sheetFor
  const shownSheet = sheetFor ?? sheetRef.current

  const overlayOpen = sheetFor != null || dialog !== 'none'
  const anim = usePopIn(overlayOpen)
  const scale = useMemo(
    () => anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }),
    [anim],
  )

  return (
    <View style={s.root}>
      <View style={s.headerRow}>
        <Text style={s.header} numberOfLines={1}>{tr('sidebar.projects')}</Text>
        <Pressable
          style={({ pressed }) => [s.headerAdd, pressed && s.pressed]}
          onPress={openNew}
          hitSlop={8}
          accessibilityLabel={tr('sidebar.newProject')}
        >
          <Icon name="add" size={16} color={C.textDim} />
        </Pressable>
      </View>

      <Pressable
        style={({ pressed }) => [s.row, allSelected && s.rowOn, pressed && s.rowPressed]}
        onPress={() => onSelect(null)}
        accessibilityRole="button"
        accessibilityState={{ selected: allSelected }}
        accessibilityLabel={tr('sidebar.allProjects')}
      >
        <View style={[s.dot, { backgroundColor: allSelected ? C.accent : C.textFaint }]} />
        <Text style={[s.name, allSelected && s.nameOn]} numberOfLines={1}>
          {tr('sidebar.allProjects')}
        </Text>
        {allSelected ? (
          <Text style={s.caption} numberOfLines={1}>{tr('sidebar.personal')}</Text>
        ) : null}
      </Pressable>

      {rows.length ? (
        // Bounded: a machine with many projects must not push the chat list
        // (and search) off the panel. Four rows tall, then it scrolls.
        <ScrollView
          style={s.rowsScroll}
          contentContainerStyle={s.rowsContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {rows.map((p) => {
            const on = p.id === activeProjectId
            return (
              <Pressable
                key={p.id}
                style={({ pressed }) => [s.row, on && s.rowOn, pressed && s.rowPressed]}
                onPress={() => onSelect(p.id)}
                onLongPress={() => openSheet(p)}
                delayLongPress={350}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={p.name}
                accessibilityHint={tr('sidebar.projectActionsHint')}
              >
                <View style={[s.dot, { backgroundColor: p.color || C.accent }]} />
                <Text style={[s.name, on && s.nameOn]} numberOfLines={1}>{p.name}</Text>
                {p.sessionCount > 0 ? <Text style={s.count}>{p.sessionCount}</Text> : null}
              </Pressable>
            )
          })}
        </ScrollView>
      ) : null}

      <Pressable
        style={({ pressed }) => [s.row, pressed && s.rowPressed]}
        onPress={openNew}
        accessibilityRole="button"
        accessibilityLabel={tr('sidebar.newProject')}
      >
        <Icon name="add" size={16} color={C.accent} />
        <Text style={s.newLabel} numberOfLines={1}>{tr('sidebar.newProject')}</Text>
      </Pressable>

      {/* ── Sheet + dialogs: one Modal, one scrim, one pop ──────────────── */}
      <Modal
        visible={overlayOpen}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={closeAll}
      >
        <KeyboardAvoidingView style={s.modalRoot} behavior="padding">
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim, opacity: anim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeAll} accessibilityLabel={tr('sidebar.cancel')} />
          </Animated.View>

          {dialog === 'none' ? (
            shownSheet ? (
              <Animated.View
                style={[s.sheet, { opacity: anim, transform: [{ scale }] }]}
              >
                <Text style={s.sheetTitle} numberOfLines={1}>{shownSheet.name}</Text>
                <SheetRow
                  icon="pencil-outline"
                  label={tr('sidebar.renameProject')}
                  onPress={() => openRename(shownSheet)}
                />
                <SheetRow
                  icon="check-circle-outline"
                  label={tr('sidebar.setDefault')}
                  onPress={() => {
                    const p = shownSheet
                    closeAll()
                    onSelect(p.id)
                  }}
                />
                <SheetRow
                  icon="archive-outline"
                  label={tr('sidebar.archive')}
                  onPress={() => void runArchive(shownSheet)}
                />
                <SheetRow
                  icon="trash-can-outline"
                  label={tr('sidebar.delete')}
                  danger
                  onPress={() => openDelete(shownSheet)}
                />
                {error ? <Text style={[d.dialogError, s.sheetError]}>{error}</Text> : null}
              </Animated.View>
            ) : null
          ) : (
            <Animated.View style={[d.dialogCard, { opacity: anim, transform: [{ scale }] }]}>
              <Text style={d.dialogTitle}>
                {dialog === 'new'
                  ? tr('sidebar.newProject')
                  : dialog === 'rename'
                    ? tr('sidebar.renameProject')
                    : tr('project.delete.title')}
              </Text>

              {dialog === 'delete' ? (
                <Text style={d.dialogBody}>
                  {tr('project.delete.body', { name: target?.name ?? '' })}
                </Text>
              ) : (
                <>
                  <TextInput
                    style={d.dialogInput}
                    value={nameText}
                    onChangeText={setNameText}
                    autoFocus
                    selectTextOnFocus
                    maxLength={120}
                    placeholder={tr('project.name.placeholder')}
                    placeholderTextColor={C.textFaint}
                    onSubmitEditing={() => void (dialog === 'new' ? runCreate() : runRename())}
                    accessibilityLabel={tr('project.name.label')}
                  />
                  {dialog === 'new' ? (
                    <>
                      <TextInput
                        style={d.dialogInput}
                        value={pathText}
                        onChangeText={setPathText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={tr('project.folder.placeholder')}
                        placeholderTextColor={C.textFaint}
                        accessibilityLabel={tr('project.folder.label')}
                      />
                      <Text style={d.dialogBody}>{tr('project.folder.hint')}</Text>
                    </>
                  ) : null}
                </>
              )}

              {error ? <Text style={d.dialogError}>{error}</Text> : null}

              <View style={d.dialogButtons}>
                <Pressable
                  style={[d.dialogBtn, busy && d.dialogBtnBusy]}
                  onPress={closeAll}
                  disabled={busy}
                >
                  <Text style={d.dialogBtnText}>{tr('sidebar.cancel')}</Text>
                </Pressable>
                {dialog === 'delete' ? (
                  <Pressable
                    style={[d.dialogBtnDanger, busy && d.dialogBtnBusy]}
                    onPress={() => void runDelete()}
                    disabled={busy}
                  >
                    <Text style={d.dialogBtnDangerText}>{tr('sidebar.delete')}</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[d.dialogBtnPrimary, (busy || !nameText.trim()) && d.dialogBtnBusy]}
                    onPress={() => void (dialog === 'new' ? runCreate() : runRename())}
                    disabled={busy || !nameText.trim()}
                  >
                    <Text style={d.dialogBtnPrimaryText}>
                      {dialog === 'new' ? tr('project.create') : tr('sidebar.save')}
                    </Text>
                  </Pressable>
                )}
              </View>
            </Animated.View>
          )}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

/** One icon row inside the project sheet (same language as Sidebar's MenuRow). */
function SheetRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap
  label: string
  danger?: boolean
  onPress: () => void
}) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Text style={[s.sheetRowLabel, danger && { color: C.red }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  root: { marginBottom: 2 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 10,
    marginTop: 6,
    marginBottom: 2,
  },
  header: {
    flex: 1,
    color: C.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  headerAdd: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  pressed: { opacity: 0.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    marginHorizontal: 6,
    borderRadius: 12,
  },
  rowOn: { backgroundColor: C.accentSoft },
  rowPressed: { backgroundColor: C.bgHover },
  rowsScroll: { maxHeight: 4 * 44 },
  rowsContent: { paddingBottom: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, color: C.textDim, fontSize: 14.5, fontWeight: '500' },
  nameOn: { color: C.text, fontWeight: '700' },
  caption: { color: C.textFaint, fontSize: 11.5, fontWeight: '600' },
  count: { color: C.textFaint, fontSize: 12, fontWeight: '600' },
  newLabel: { flex: 1, color: C.accent, fontSize: 14.5, fontWeight: '600' },
  modalRoot: { flex: 1, justifyContent: 'center' },
  sheet: {
    width: '86%',
    maxWidth: 400,
    alignSelf: 'center',
    backgroundColor: C.bgElev,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingVertical: 8,
    paddingHorizontal: 6,
    gap: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  sheetTitle: {
    color: C.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  sheetRowLabel: { color: C.text, fontSize: 15.5, flex: 1 },
  sheetError: { paddingHorizontal: 12, paddingVertical: 6 },
})
