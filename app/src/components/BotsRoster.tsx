/**
 * Drawer Bots roster (UI-1, slice D).
 *
 * Product model: a bot is ONE profile with ONE persistent conversation titled
 * exactly `Bot Chat` (`lib/botChat.ts`). So this is a roster of BOTS, not a
 * chat list: one row per profile, tapping opens that bot's canonical chat via
 * the shell's `onOpenBot` (slice B's `openBotChat` does the lookup/create).
 * There is deliberately no per-bot chat list here.
 *
 * Rows reuse the drawer's own row language — avatar disc, one-line preview,
 * relative age, `StatusDot` from `./Sidebar` — so Sessions and Bots read as
 * two views of the same list, not two designs. The long-press menu is rendered
 * INSIDE the roster (not an RN Modal): the drawer already owns an animated
 * panel, and a Modal on top of it would fight the close animation, the
 * swipe-to-close pan and the web tab-order rules.
 *
 * `+ New bot` opens the existing Fleet screen (the create flow lives there);
 * creating from the drawer would be a second implementation of that flow.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr } from '../lib/strings'
import { attentionById } from '../lib/attention'
import { busyStoredKey, pendingStoredIds } from '../lib/chat'
import { sessionRows } from '../lib/sessionList'
import {
  activeBotAtom,
  fleetProfiles,
  refreshFleet,
  setActiveBot,
  type FleetProfile,
} from '../lib/fleet'
import { rpc } from '../lib/gateway'
import {
  DEFAULT_PROFILE,
  botInitials,
  botStatusOf,
  botTintIndex,
  relativeAge,
  rosterRows,
  type RosterProfileLike,
  type RosterRow,
} from '../lib/botRosterMeta'
import { StatusDot } from './Sidebar'

export interface BotsRosterProps {
  /** The roster from `profiles.list` (`fleetProfiles`), or raw wire rows. */
  profiles: readonly (FleetProfile | RosterProfileLike)[]
  /**
   * Open a bot's canonical chat. `''` is the default agent (whose tap starts
   * an ordinary chat — it has no `Bot Chat` of its own).
   */
  onOpenBot: (key: string) => void
  /** Open the create flow (the Fleet screen). */
  onNewBot: () => void
  /** False when the drawer is closed: drops any open sheet/dialog. */
  active?: boolean
}

/** Menu sheet state for one row. `armed` is the two-tap delete confirm. */
interface SheetState {
  row: RosterRow
  anchored: boolean
}

export function BotsRoster({ profiles, onOpenBot, onNewBot, active = true }: BotsRosterProps) {
  const s = useStyles(makeS)
  // Locale switches must re-render the roster's own copy.
  useStore(localeAtom)
  const router = useRouter()

  const rows = useMemo(() => rosterRows(profiles), [profiles])

  // Per-bot status: every session id we can attribute to a profile, then the
  // drawer's single dot policy (an ask beats busy beats done/error).
  const busyKey = useStore(busyStoredKey)
  const busy = useMemo(() => new Set(busyKey ? busyKey.split(',') : []), [busyKey])
  const attention = useStore(attentionById)
  const pendingList = useStore(pendingStoredIds)
  const pending = useMemo(() => new Set(pendingList), [pendingList])
  const sessions = useStore(sessionRows)
  const myActiveBot = useStore(activeBotAtom)
  const idsByProfile = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const r of sessions) {
      const p = r.profile || DEFAULT_PROFILE
      const list = map.get(p) ?? []
      list.push(r.id)
      map.set(p, list)
    }
    return map
  }, [sessions])

  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [armed, setArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closeSheet = () => {
    setSheet(null)
    setArmed(false)
    setError(null)
  }

  // Drawer closed underneath us: nothing should survive into the next open.
  useEffect(() => {
    if (!active) {
      setSheet(null)
      setArmed(false)
      setError(null)
    }
  }, [active])

  const openSheet = (row: RosterRow) => {
    setArmed(false)
    setError(null)
    setSheet({ row, anchored: true })
  }

  const openChat = (row: RosterRow) => {
    closeSheet()
    onOpenBot(row.key)
  }

  const editBot = (row: RosterRow) => {
    closeSheet()
    router.push({ pathname: '/bot', params: { name: row.profile } } as never)
  }

  // Deletion contract is bot.tsx's, verbatim: `moch.profiles.delete` with
  // `confirm: true`, then clear the active bot when it was this one and
  // re-read the roster so the row disappears without waiting for a poll.
  const deleteBot = async (row: RosterRow) => {
    if (deleting) return
    if (!armed) {
      setArmed(true)
      return
    }
    setDeleting(true)
    setError(null)
    try {
      await rpc('moch.profiles.delete', { profile: row.profile, confirm: true }, 20000)
      if (activeBotAtom.get() === row.profile) await setActiveBot(null)
      await refreshFleet()
      closeSheet()
    } catch (e) {
      setArmed(false)
      setError(tr('bots.delete.failed', { why: e instanceof Error ? e.message : String(e) }))
    } finally {
      setDeleting(false)
    }
  }

  const named = rows.filter((r) => !r.isDefault)

  return (
    <View style={s.root}>
      <View style={s.headerRow}>
        <Text style={s.header} numberOfLines={1}>{tr('bots.title')}</Text>
        <Pressable
          style={({ pressed }) => [s.headerAdd, pressed && s.pressed]}
          onPress={onNewBot}
          hitSlop={8}
          accessibilityLabel={tr('bots.new')}
        >
          <MaterialCommunityIcons name="plus" size={16} color={C.textDim} />
        </Pressable>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollBody}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {rows.map((row) => {
          const ids = [
            ...(row.canonicalId ? [row.canonicalId] : []),
            ...(row.lastSession ? [row.lastSession.id] : []),
            ...(row.worker ? [row.worker.id] : []),
            ...(idsByProfile.get(row.profile) ?? []),
          ]
          const status = botStatusOf(row, ids, busy, attention, pending)
          const age = relativeAge(row.lastActiveTs)
          const on = row.isDefault ? myActiveBot == null : myActiveBot === row.profile
          const name = row.name
          const subtitle = row.preview
            || row.description
            || (row.isDefault ? tr('bots.agent') : '')
          return (
            <Pressable
              key={row.profile}
              style={({ pressed }) => [s.row, on && s.rowOn, pressed && s.rowPressed]}
              onPress={() => openChat(row)}
              onLongPress={() => openSheet(row)}
              delayLongPress={350}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={name}
              accessibilityHint={tr('bots.menu.hint')}
            >
              <BotDisc row={row} />
              <View style={s.rowText}>
                <Text style={[s.name, on && s.nameOn]} numberOfLines={1}>{name}</Text>
                {subtitle ? (
                  <Text style={s.preview} numberOfLines={1}>{subtitle}</Text>
                ) : null}
              </View>
              {age ? <Text style={s.age}>{age}</Text> : null}
              <StatusDot status={status} />
              <Pressable
                style={s.rowMenu}
                hitSlop={6}
                onPress={() => openSheet(row)}
                accessibilityLabel={tr('bots.actions', { name })}
              >
                <MaterialCommunityIcons name="dots-horizontal" size={15} color={C.textFaint} />
              </Pressable>
            </Pressable>
          )
        })}

        {named.length === 0 ? (
          <Text style={s.empty}>{tr('bots.empty')}</Text>
        ) : null}

        <Pressable
          style={({ pressed }) => [s.row, pressed && s.rowPressed]}
          onPress={onNewBot}
          accessibilityRole="button"
          accessibilityLabel={tr('bots.new')}
        >
          <View style={s.newDisc}>
            <MaterialCommunityIcons name="plus" size={16} color={C.accent} />
          </View>
          <Text style={s.newLabel} numberOfLines={1}>{tr('bots.new')}</Text>
        </Pressable>
      </ScrollView>

      {/* ── Long-press sheet: same card/rows as the project sheet ─────────── */}
      {sheet ? (
        <View style={s.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeSheet}
            accessibilityLabel={tr('sidebar.cancel')}
          />
          <View style={s.sheet}>
            <Text style={s.sheetTitle} numberOfLines={1}>{sheet.row.name}</Text>
            <SheetRow
              icon="chat-outline"
              label={tr('bots.menu.open')}
              onPress={() => openChat(sheet.row)}
            />
            {sheet.row.isDefault ? null : (
              <SheetRow
                icon="pencil-outline"
                label={tr('bots.edit')}
                onPress={() => editBot(sheet.row)}
              />
            )}
            {sheet.row.isDefault ? null : (
              <SheetRow
                icon="trash-can-outline"
                label={armed ? tr('bots.delete.title') : tr('bots.delete')}
                danger
                busy={deleting}
                onPress={() => void deleteBot(sheet.row)}
              />
            )}
            {error ? <Text style={s.sheetError}>{error}</Text> : null}
          </View>
        </View>
      ) : null}
    </View>
  )
}

/**
 * The colored initial disc. Colors are read from `C` at render (the theme
 * mutates its tokens in place), and the slot comes from a stable hash of the
 * name so a bot keeps its color across launches. The default agent gets the
 * mascot instead — it is Moch, not a hire.
 */
function BotDisc({ row }: { row: RosterRow }) {
  const s = useStyles(makeS)
  if (row.isDefault) {
    return (
      <View style={[s.disc, s.discDefault]}>
        <Image source={require('../../assets/mochi-run-1.png')} style={s.discMochi} />
      </View>
    )
  }
  const tints = [C.accent, C.blush, C.green, C.amber]
  const bg = tints[botTintIndex(row.profile)]
  return (
    <View style={[s.disc, { backgroundColor: bg }]}>
      <Text style={s.discText} numberOfLines={1}>{botInitials(row.name)}</Text>
    </View>
  )
}

function SheetRow({
  icon,
  label,
  danger,
  busy,
  onPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap
  label: string
  danger?: boolean
  busy?: boolean
  onPress: () => void
}) {
  const s = useStyles(makeS)
  return (
    <Pressable
      style={({ pressed }) => [s.sheetRow, pressed && s.rowPressed, busy && s.sheetRowBusy]}
      onPress={onPress}
      disabled={busy}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Text style={[s.sheetRowLabel, danger && { color: C.red }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  root: { flex: 1, marginTop: 4 },
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
  scroll: { flex: 1 },
  scrollBody: { paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 14,
    marginHorizontal: 6,
    borderRadius: 12,
  },
  rowOn: { backgroundColor: C.accentSoft },
  rowPressed: { backgroundColor: C.bgHover },
  // Avatar disc: 32dp, the 20dp mascot floats inside it.
  disc: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  discDefault: { backgroundColor: C.accentSoft },
  discMochi: { width: 24, height: 24, resizeMode: 'contain' },
  discText: { color: C.onAccent, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.2 },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: C.textDim, fontSize: 14.5, fontWeight: '500' },
  nameOn: { color: C.text, fontWeight: '600' },
  preview: { color: C.textFaint, fontSize: 12, marginTop: 1 },
  age: { color: C.textFaint, fontSize: 11.5 },
  rowMenu: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  empty: { color: C.textFaint, fontSize: 13, paddingHorizontal: 16, paddingVertical: 10 },
  newDisc: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderStyle: 'dashed',
  },
  newLabel: { color: C.accent, fontSize: 14.5, fontWeight: '600' },

  // In-panel sheet (not a Modal): scrim covers the roster body, card docks at
  // its bottom edge. Same radius/rows as the project sheet.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  sheet: {
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.borderSoft,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  sheetTitle: {
    color: C.text,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  sheetRowBusy: { opacity: 0.5 },
  sheetRowLabel: { color: C.text, fontSize: 15, flex: 1 },
  sheetError: { color: C.red, fontSize: 12.5, paddingHorizontal: 14, paddingVertical: 8 },
})
