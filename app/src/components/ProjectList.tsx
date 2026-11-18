/**
 * Drawer project list (UI-1).
 *
 * Projects are real gateway state, not local folders: the rows come from
 * `projects.tree` (lib/workspace) and every mutation goes back through the
 * `projects.*` RPCs. "All projects" is the default bucket — `active_id == null`
 * on the wire, never a made-up id.
 *
 * Presentation follows the redesign mockup's Projects block
 * (`renderSidebarDrawer`): a colored 8dp dot, a 12/600 name, a mono count, and
 * the active row washed in `accentSoft` with a hairline border; "+ New
 * project" is an accent text link. The section kicker is rendered by the
 * Sidebar (this list is its body), matching the mockup's one-kicker layout.
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
  TextInput,
  View,
} from 'react-native'
// BUG-133 / app/AGENTS.md pattern #2: inside a Modal the OS never resizes the
// app, and RN core's KAV (`behavior` undefined on Android) is a literal no-op.
// RNKC's KeyboardAvoidingView as the Modal's full-screen root is the repo's
// proven bottom-sheet variant.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr, useDir } from '../lib/strings'
import { Txt } from './ui'
import { Icon } from './Icon'
import { makeDialogS, StatusDot, ageLabel, type RecentChat } from './Sidebar'
import { projectActions, type ProjectRow } from '../lib/workspace'

/** Feedback round 2 [12]: at most five recent chats render under a project. */
const MAX_PROJECT_CHATS = 5

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
  /** [12] Per-project recent chats (up to five render inline). */
  projectChats?: Record<string, RecentChat[]>
  /** Open one of the mini-list chats (owner swaps the screen + closes). */
  onOpenProjectChat?: (id: string) => void
  /** [12] "More": owner activates the project and opens the Chats screen. */
  onProjectMore?: (id: string) => void
}

/** Fade/scale the overlay in when it opens (the Modal itself is unmounted on close). */
function usePopIn(visible: boolean, inMs = 140) {
  const anim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!visible) {
      // Park at 0 so the NEXT open starts from a hidden overlay instead of
      // flashing the previous session's end state for one frame.
      anim.setValue(0)
      return
    }
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

/**
 * [12] Lightweight expansion motion for the inline mini-list: fades in and
 * rises a few px on mount. Collapsing unmounts immediately (a closing drawer
 * must never leave rows animating into nothing).
 */
function ExpandIn({ children }: { children: React.ReactNode }) {
  const a = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const t = Animated.timing(a, {
      toValue: 1,
      duration: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    })
    t.start()
    return () => t.stop()
  }, [a])
  return (
    <Animated.View style={{ opacity: a, transform: [{ translateY: Animated.multiply(a, -3) }] }}>
      {children}
    </Animated.View>
  )
}

export function ProjectList({
  projects,
  activeProjectId,
  onSelect,
  onNewProject,
  onProjectMenu,
  active = true,
  projectChats,
  onOpenProjectChat,
  onProjectMore,
}: ProjectListProps) {
  const s = useStyles(makeS)
  const d = useStyles(makeDialogS)
  const dir = useDir()
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
  // The mockup puts a count on every row — "All projects" totals the tree's
  // per-project session counts (the Home bucket is included: its node counts
  // the sessions no project owns).
  const allCount = useMemo(
    () => projects.reduce((n, p) => n + (Number.isFinite(p.sessionCount) ? p.sessionCount : 0), 0),
    [projects],
  )
  const allSelected = activeProjectId == null

  // ── [12] expandable project rows ───────────────────────────────────────────
  // Sessions live inside their projects: tapping a project selects it AND
  // expands its inline mini-list; tapping the active project again collapses
  // it (the selection/filter stays — the Chats screen chip clears it).
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEffect(() => {
    // A selection made anywhere (drawer tap, "More", Set as default) expands.
    setExpandedId(activeProjectId)
  }, [activeProjectId])
  const handleProjectPress = (p: ProjectRow) => {
    if (p.id === activeProjectId) {
      setExpandedId((prev) => (prev === p.id ? null : p.id))
      return
    }
    setExpandedId(p.id)
    onSelect(p.id)
  }

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
      <Pressable
        style={({ pressed }) => [
          s.row,
          { flexDirection: dir.row },
          allSelected && s.rowOn,
          pressed && s.rowPressed,
        ]}
        onPress={() => onSelect(null)}
        accessibilityRole="button"
        accessibilityState={{ selected: allSelected }}
        accessibilityLabel={tr('sidebar.allProjects')}
      >
        <View style={[s.rowMain, { flexDirection: dir.row }]}>
          <View style={[s.dot, { backgroundColor: allSelected ? C.accent : C.textFaint }]} />
          <Txt
            size={12}
            weight="600"
            color={allSelected ? C.text : C.textDim}
            numberOfLines={1}
            style={s.name}
          >
            {tr('sidebar.allProjects')}
          </Txt>
        </View>
        <Txt size={10.5} color={C.textFaint} mono numberOfLines={1}>
          {allCount}
        </Txt>
      </Pressable>

      {rows.length ? (
        // Bounded: a machine with many projects must not push the chat list
        // (and search) off the panel. Three rows tall, then it scrolls.
        <ScrollView
          style={s.rowsScroll}
          contentContainerStyle={s.rowsContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {rows.map((p) => {
            const on = p.id === activeProjectId
            const expanded = on && expandedId === p.id
            const mini = expanded ? (projectChats?.[p.id] ?? []).slice(0, MAX_PROJECT_CHATS) : []
            return (
              <View key={p.id}>
                <Pressable
                  style={({ pressed }) => [
                    s.row,
                    { flexDirection: dir.row },
                    on && s.rowOn,
                    pressed && s.rowPressed,
                  ]}
                  onPress={() => handleProjectPress(p)}
                  onLongPress={() => openSheet(p)}
                  delayLongPress={350}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, expanded }}
                  accessibilityLabel={p.name}
                  accessibilityHint={tr(
                    expanded ? 'chrome.drawer.projectCollapse' : 'chrome.drawer.projectExpand',
                    { name: p.name },
                  )}
                >
                  <View style={[s.rowMain, { flexDirection: dir.row }]}>
                    <View style={[s.dot, { backgroundColor: p.color || C.accent }]} />
                    <Txt
                      size={12}
                      weight="600"
                      color={on ? C.text : C.textDim}
                      numberOfLines={1}
                      style={s.name}
                    >
                      {p.name}
                    </Txt>
                  </View>
                  <Txt size={10.5} color={C.textFaint} mono>
                    {p.sessionCount}
                  </Txt>
                  <Animated.View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
                    <MaterialCommunityIcons
                      name="chevron-right"
                      size={13}
                      color={C.textFaint}
                      style={dir.rtl ? s.chevronRtl : undefined}
                    />
                  </Animated.View>
                </Pressable>
                {expanded ? (
                  <ExpandIn>
                    {mini.map((c) => (
                      <Pressable
                        key={c.id}
                        style={({ pressed }) => [
                          s.miniRow,
                          { flexDirection: dir.row },
                          dir.rtl ? { paddingRight: 23 } : { paddingLeft: 23 },
                          c.active && s.miniRowActive,
                          pressed && s.rowPressed,
                        ]}
                        onPress={() => onOpenProjectChat?.(c.id)}
                        accessibilityRole="button"
                        accessibilityLabel={tr('sidebar.openChat', { title: c.title })}
                      >
                        <StatusDot status={c.status} />
                        <Txt
                          size={11.5}
                          weight="600"
                          color={c.active ? C.text : C.textDim}
                          numberOfLines={1}
                          style={s.name}
                        >
                          {c.title}
                        </Txt>
                        {c.ts ? (
                          <Txt size={9.5} color={C.textFaint} numberOfLines={1}>
                            {ageLabel(c.ts)}
                          </Txt>
                        ) : null}
                        <Icon
                          name={dir.icon.forward}
                          size={12}
                          color={c.active ? C.accent : C.textFaint}
                        />
                      </Pressable>
                    ))}
                    <Pressable
                      style={({ pressed }) => [
                        s.moreBtn,
                        { flexDirection: dir.row },
                        dir.rtl ? { paddingRight: 23 } : { paddingLeft: 23 },
                        pressed && s.rowPressed,
                      ]}
                      onPress={() => onProjectMore?.(p.id)}
                      accessibilityRole="button"
                      accessibilityLabel={tr('chrome.drawer.moreChats')}
                    >
                      <Txt size={11} weight="700" color={C.accent}>
                        {tr('chrome.drawer.moreChats')}
                      </Txt>
                    </Pressable>
                  </ExpandIn>
                ) : null}
              </View>
            )
          })}
        </ScrollView>
      ) : null}

      <Pressable
        style={({ pressed }) => [s.newLink, pressed && s.rowPressed]}
        onPress={openNew}
        accessibilityRole="button"
        accessibilityLabel={tr('sidebar.newProject')}
      >
        <Txt size={11.5} weight="600" color={C.accent} numberOfLines={1}>
          {tr('chrome.projects.newLink')}
        </Txt>
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
                <Txt size={10.5} weight="700" color={C.textFaint} style={s.sheetTitle} numberOfLines={1}>
                  {shownSheet.name}
                </Txt>
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
                {error ? <Txt size={12} color={C.red} style={s.sheetError}>{error}</Txt> : null}
              </Animated.View>
            ) : null
          ) : (
            <Animated.View style={[d.dialogCard, { opacity: anim, transform: [{ scale }] }]}>
              <Txt style={d.dialogTitle}>
                {dialog === 'new'
                  ? tr('sidebar.newProject')
                  : dialog === 'rename'
                    ? tr('sidebar.renameProject')
                    : tr('project.delete.title')}
              </Txt>

              {dialog === 'delete' ? (
                <Txt style={d.dialogBody}>
                  {tr('project.delete.body', { name: target?.name ?? '' })}
                </Txt>
              ) : (
                <>
                  <TextInput
                    style={[
                      d.dialogInput,
                      { textAlign: dir.textAlign, writingDirection: dir.writingDirection },
                    ]}
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
                        style={[
                          d.dialogInput,
                          { textAlign: dir.textAlign, writingDirection: dir.writingDirection },
                        ]}
                        value={pathText}
                        onChangeText={setPathText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={tr('project.folder.placeholder')}
                        placeholderTextColor={C.textFaint}
                        accessibilityLabel={tr('project.folder.label')}
                      />
                      <Txt style={d.dialogBody}>{tr('project.folder.hint')}</Txt>
                    </>
                  ) : null}
                </>
              )}

              {error ? <Txt style={d.dialogError}>{error}</Txt> : null}

              <View style={[d.dialogButtons, { flexDirection: dir.row }]}>
                <Pressable
                  style={[d.dialogBtn, busy && d.dialogBtnBusy]}
                  onPress={closeAll}
                  disabled={busy}
                >
                  <Txt style={d.dialogBtnText}>{tr('sidebar.cancel')}</Txt>
                </Pressable>
                {dialog === 'delete' ? (
                  <Pressable
                    style={[d.dialogBtnDanger, busy && d.dialogBtnBusy]}
                    onPress={() => void runDelete()}
                    disabled={busy}
                  >
                    <Txt style={d.dialogBtnDangerText}>{tr('sidebar.delete')}</Txt>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[d.dialogBtnPrimary, (busy || !nameText.trim()) && d.dialogBtnBusy]}
                    onPress={() => void (dialog === 'new' ? runCreate() : runRename())}
                    disabled={busy || !nameText.trim()}
                  >
                    <Txt style={d.dialogBtnPrimaryText}>
                      {dialog === 'new' ? tr('project.create') : tr('sidebar.save')}
                    </Txt>
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
  const dir = useDir()
  return (
    <Pressable
      style={({ pressed }) => [s.sheetRow, { flexDirection: dir.row }, pressed && s.rowPressed]}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Txt size={15} color={danger ? C.red : C.text} style={s.sheetRowLabel} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  root: { marginBottom: 8 },
  row: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: 36,
  },
  rowMain: { flex: 1, minWidth: 0, alignItems: 'center', gap: 7 },
  rowOn: { backgroundColor: C.accentSoft, borderColor: C.border },
  rowPressed: { backgroundColor: C.bgHover },
  rowsScroll: { maxHeight: 3 * 36 },
  rowsContent: { gap: 3 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  name: { flexShrink: 1 },
  // [12] expansion affordance + inline mini-list under a project row. The
  // asymmetric indent is applied inline (useStyles factories don't see the
  // live direction — same pattern as the sessions screen's meta line).
  chevronRtl: { transform: [{ scaleX: -1 }] },
  miniRow: {
    alignItems: 'center',
    gap: 7,
    paddingVertical: 5,
    minHeight: 30,
    borderRadius: 8,
  },
  miniRowActive: { backgroundColor: C.bgHover },
  moreBtn: {
    alignItems: 'center',
    paddingVertical: 4,
    minHeight: 26,
    borderRadius: 8,
  },
  newLink: { paddingVertical: 4, paddingHorizontal: 8, alignSelf: 'flex-start' },
  modalRoot: { flex: 1, justifyContent: 'center' },
  sheet: {
    width: '88%',
    maxWidth: 400,
    alignSelf: 'center',
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 18,
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
    letterSpacing: 0.75,
    textTransform: 'uppercase',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sheetRow: {
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  sheetRowLabel: { flex: 1 },
  sheetError: { paddingHorizontal: 12, paddingVertical: 6 },
})
