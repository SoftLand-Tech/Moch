/**
 * Drawer Bots roster (UI-1, slice D).
 *
 * Product model: a bot is ONE profile with ONE persistent conversation titled
 * exactly `Bot Chat` (`lib/botChat.ts`). So this is a roster of BOTS, not a
 * chat list: one row per profile, tapping opens that bot's canonical chat via
 * the shell's `onOpenBot` (slice B's `openBotChat` does the lookup/create).
 * There is deliberately no per-bot chat list here.
 *
 * Presentation follows the redesign mockup's Bots mode (`renderSidebarDrawer`,
 * bots branch): a "Bots Roster" kicker, one elevated card per bot (avatar,
 * 12.5/700 name + relative age, 11 textDim one-line description, status dot)
 * and a dashed "+ New bot" card. The long-press action sheet stays in-panel
 * (same card language as the project sheet) so it never fights the drawer's
 * close animation, swipe-to-close pan or the web tab-order rules.
 *
 * `+ New bot` opens the existing Fleet screen (the create flow lives there);
 * creating from the drawer would be a second implementation of that flow.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr, useDir } from '../lib/strings'
import { Kicker, Txt } from './ui'
import { attentionById } from '../lib/attention'
import { busyStoredKey, pendingStoredIds } from '../lib/chat'
import { sessionRows } from '../lib/sessionList'
import {
  activeBotAtom,
  refreshFleet,
  setActiveBot,
  type FleetProfile,
} from '../lib/fleet'
import { rpc } from '../lib/gateway'
import {
  DEFAULT_PROFILE,
  botStatusOf,
  rosterRows,
  withSessionPreviews,
  type RosterProfileLike,
  type RosterRow,
} from '../lib/botRosterMeta'
import { StatusDot } from './Sidebar'
import { BotAvatar } from './BotAvatar'

export interface BotsRosterProps {
  /** The roster from `profiles.list` (`fleetProfiles`), or raw wire rows. */
  profiles: readonly (FleetProfile | RosterProfileLike)[]
  /**
   * Open a bot's canonical chat. `''` is the default agent — it has no
   * `Bot Chat` of its own, so its row just returns to the chat surface.
   */
  onOpenBot: (key: string) => void
  /** Open the create flow (the Fleet screen). */
  onNewBot: () => void
  /**
   * Close the drawer before navigating (the Edit action pushes `/bot`; leaving
   * the panel open would keep the drawer over the screen it just opened).
   */
  onCloseDrawer?: () => void
  /** False when the drawer is closed: drops any open sheet/dialog. */
  active?: boolean
}

/** Menu sheet state for one row. The two-tap delete confirm lives in `armed`. */
interface SheetState {
  row: RosterRow
}

/**
 * Compact relative age ("2m", "3h", …) with the unit localized. The roster's
 * pure helper (`relativeAge`) returns English unit suffixes, so the label is
 * rebuilt here at the render site with chrome.age.* keys (SPEC §3).
 */
function ageLabel(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ''
  const delta = Date.now() - ms
  if (delta < 60_000) return tr('chrome.age.lessMinute')
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return tr('chrome.age.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return tr('chrome.age.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return tr('chrome.age.days', { n: days })
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return tr('chrome.age.weeks', { n: weeks })
  return tr('chrome.age.months', { n: Math.floor(days / 30) })
}

export function BotsRoster({ profiles, onOpenBot, onNewBot, onCloseDrawer, active = true }: BotsRosterProps) {
  const s = useStyles(makeS)
  const dir = useDir()
  // Locale switches must re-render the roster's own copy.
  useStore(localeAtom)
  const router = useRouter()

  const sessions = useStore(sessionRows)
  // Rows: the roster overlaid with what the session list knows (preview/age),
  // since `profiles.list` carries no preview for a bot's Bot Chat.
  const rows = useMemo(
    () => withSessionPreviews(rosterRows(profiles), sessions),
    [profiles, sessions],
  )

  // Per-bot status: every session id we can attribute to a profile, then the
  // drawer's single dot policy (an ask beats busy beats done/error).
  const busyKey = useStore(busyStoredKey)
  const busy = useMemo(() => new Set(busyKey ? busyKey.split(',') : []), [busyKey])
  const attention = useStore(attentionById)
  const pendingList = useStore(pendingStoredIds)
  const pending = useMemo(() => new Set(pendingList), [pendingList])
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
    setSheet({ row })
  }

  const openChat = (row: RosterRow) => {
    closeSheet()
    onOpenBot(row.key)
  }

  const editBot = (row: RosterRow) => {
    closeSheet()
    onCloseDrawer?.()
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

  return (
    <View style={s.root}>
      <Kicker style={s.kicker}>{tr('chrome.bots.kicker')}</Kicker>

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
          const age = ageLabel(row.lastActiveTs)
          // Highlight the bot whose canonical Bot Chat is on screen — Moch
          // (the default bot) included. A normal chat from the Sessions
          // surface has no bot marker, so nothing is highlighted there.
          const on = myActiveBot === row.profile
          const name = row.name
          const subtitle = row.preview
            || row.description
            || (row.isDefault ? tr('bots.agent') : '')
          return (
            <Pressable
              key={row.profile}
              style={({ pressed }) => [
                s.card,
                { flexDirection: dir.row },
                on && s.cardOn,
                pressed && s.rowPressed,
              ]}
              onPress={() => openChat(row)}
              onLongPress={() => openSheet(row)}
              delayLongPress={350}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={name}
              accessibilityHint={tr('bots.menu.hint')}
            >
              <BotAvatar profile={row.profile} isDefault={row.isDefault} size={32} />
              <View style={s.rowText}>
                <View style={[s.titleRow, { flexDirection: dir.row }]}>
                  <Txt size={12.5} weight="700" color={C.text} numberOfLines={1} style={s.name}>
                    {name}
                  </Txt>
                  {age ? <Txt size={10} color={C.textFaint}>{age}</Txt> : null}
                </View>
                {subtitle ? (
                  <Txt size={11} color={C.textDim} numberOfLines={1}>
                    {subtitle}
                  </Txt>
                ) : null}
              </View>
              <Pressable
                style={s.rowMenu}
                hitSlop={6}
                onPress={() => openSheet(row)}
                accessibilityLabel={tr('bots.actions', { name })}
              >
                <MaterialCommunityIcons name="dots-horizontal" size={15} color={C.textFaint} />
              </Pressable>
              <StatusDot status={status} />
            </Pressable>
          )
        })}

        {rows.length === 0 ? (
          <Txt size={13} color={C.textFaint} style={s.empty}>{tr('bots.empty')}</Txt>
        ) : null}

        <Pressable
          style={({ pressed }) => [s.newCard, pressed && s.rowPressed]}
          onPress={onNewBot}
          accessibilityRole="button"
          accessibilityLabel={tr('bots.new')}
        >
          <Txt size={12} weight="700" color={C.accent} numberOfLines={1}>
            {tr('chrome.bots.newCard')}
          </Txt>
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
            <Txt size={10.5} weight="700" color={C.textFaint} style={s.sheetTitle} numberOfLines={1}>
              {sheet.row.name}
            </Txt>
            {/* Every row is a bot with ONE canonical Bot Chat — Moch included. */}
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
            {error ? <Txt size={12.5} color={C.red} style={s.sheetError}>{error}</Txt> : null}
          </View>
        </View>
      ) : null}
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
  const dir = useDir()
  return (
    <Pressable
      style={({ pressed }) => [s.sheetRow, { flexDirection: dir.row }, pressed && s.rowPressed, busy && s.sheetRowBusy]}
      onPress={onPress}
      disabled={busy}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <MaterialCommunityIcons name={icon} size={18} color={danger ? C.red : C.text} />
      <Txt size={15} color={danger ? C.red : C.text} style={s.sheetRowLabel} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

const makeS = () => StyleSheet.create({
  root: { flex: 1 },
  kicker: { marginTop: 2, marginBottom: 8 },
  scroll: { flex: 1 },
  scrollBody: { paddingBottom: 8, gap: 6 },
  card: {
    alignItems: 'center',
    gap: 9,
    padding: 8,
    borderRadius: 11,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    minHeight: 50,
  },
  cardOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  rowPressed: { backgroundColor: C.bgHover },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  name: { flexShrink: 1 },
  rowMenu: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  empty: { paddingHorizontal: 8, paddingVertical: 8 },
  newCard: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: C.border,
    minHeight: 38,
  },

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
    borderColor: C.border,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  sheetTitle: {
    letterSpacing: 0.75,
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sheetRow: {
    alignItems: 'center',
    gap: 14,
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  sheetRowBusy: { opacity: 0.5 },
  sheetRowLabel: { flex: 1 },
  sheetError: { paddingHorizontal: 14, paddingVertical: 8 },
})
