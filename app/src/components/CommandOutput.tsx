/**
 * CommandOutput — the one card family every slash-command output renders as.
 *
 * Card variants (result/error/usage/status/list/catalog) share one shell
 * (inset bgCard card, hairline border, header = status icon + `/command` chip
 * + time) with a body renderer keyed by the CommandVariant slash.ts already
 * classified — this component never looks at the raw text to decide what it
 * is. notice and success are local-notice surfaces: bare, headerless rows
 * outside the card shell, to keep the everyday transcript light.
 *
 * The raw catalog dump is never rendered — it stays in m.text as stored data
 * (copy/search/persistence); the catalog card body is a summary plus the
 * browser footer, per spec. Expand/collapse is local state on purpose: it
 * resets when the row recycles and is never persisted. Listen is deliberately
 * omitted — machine output, not prose.
 */
import React, { useState } from 'react'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import Markdown from '@ronradtke/react-native-markdown-display'
import type { ChatMessage } from '../lib/chat'
import { commandCatalog, skillCommands, slashLabel, parseStatusPairs, type CommandMeta, type CommandVariant } from '../lib/slash'
import { C, pill, useStyles } from '../lib/theme'
import { makeCardMdStyles } from './Chat'

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Bodies long enough to need the copy affordance. */
const COPY_VARIANTS: ReadonlySet<CommandVariant> = new Set(['result', 'error', 'usage', 'status', 'list', 'catalog'])

/** Variants whose body renders the collapsed `shown` slice — the toggle only applies to these. */
const COLLAPSIBLE_VARIANTS: ReadonlySet<CommandVariant> = new Set(['result', 'error', 'usage', 'status', 'list'])

/** Collapse kicks in past this many lines (or 1600 chars), showing the first 24. */
const COLLAPSE_LINES = 24

const THEME_BY_VARIANT: Record<CommandVariant, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  result: { icon: 'terminal-outline', color: C.accent },
  error: { icon: 'alert-circle', color: C.red },
  usage: { icon: 'warning-outline', color: C.amber },
  status: { icon: 'list-outline', color: C.accent },
  list: { icon: 'list-outline', color: C.accent },
  notice: { icon: 'information-circle-outline', color: C.textFaint },
  success: { icon: 'checkmark-circle', color: C.greenSoft },
  catalog: { icon: 'grid-outline', color: C.accent },
}

/** Split a description at the first ' — ' or ': ' into title + sub. */
function splitDesc(s: string): { title: string; sub: string } {
  const t = s.replace(/^[—–-]+\s*/, '').trim()
  const sep = / — |: /.exec(t)
  if (!sep) return { title: t, sub: '' }
  return { title: t.slice(0, sep.index).trim(), sub: t.slice(sep.index + sep[0].length).trim() }
}

/** Split a list row into its index marker, insertable command, and title/sub. */
function rowParts(line: string): { marker: string; token: string | null; title: string; sub: string } | null {
  const m = /^\s*(\/[\w-]+|\d+[.)])\s*(.*)$/.exec(line)
  if (!m) return null
  if (m[1].startsWith('/')) {
    const { sub } = splitDesc(m[2])
    return { marker: '', token: slashLabel(m[1]), title: slashLabel(m[1]), sub }
  }
  const rest = m[2]
  const lead = /^\/[\w-]+/.exec(rest)
  if (lead) {
    const { sub } = splitDesc(rest.slice(lead[0].length))
    return { marker: m[1], token: slashLabel(lead[0]), title: slashLabel(lead[0]), sub }
  }
  const { title, sub } = splitDesc(rest)
  const anyTok = /\/[\w-]+/.exec(rest)
  return { marker: m[1], token: anyTok ? slashLabel(anyTok[0]) : null, title, sub }
}

/** Data-driven tappability: the row's command must resolve in the loaded registry. */
function resolvesInRegistry(token: string, cmds: Record<string, unknown>, skills: Record<string, unknown>): boolean {
  const bare = token.replace(/^\//, '').toLowerCase()
  return !!(cmds[bare] || cmds[`/${bare}`] || skills[bare] || skills[`/${bare}`])
}

/**
 * Memoized like MessageBubble (it renders inside one): classification and the
 * message object are write-once, so a card only re-renders on row recycle.
 * `onInsert` / `onOpenCatalog` must be stable callbacks from the chat screen.
 */
export const CommandCard = React.memo(function CommandCard({
  m, onInsert, onOpenCatalog,
}: {
  m: ChatMessage
  /** Puts a command line in the composer (suggestion + list rows). */
  onInsert?: (line: string) => void
  /** Opens the command catalog browser (error hint chip, catalog footer). */
  onOpenCatalog?: () => void
}) {
  const s = useStyles(makeS)
  const md = useStyles(makeCardMdStyles)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Subscribed, not .get(): the memoized row never re-reads, so a card restored
  // from a persisted transcript before loadCatalog completes would otherwise
  // bake in an empty registry until the row recycles.
  const catalog = useStore(commandCatalog)
  const skills = useStore(skillCommands)
  const cmd: CommandMeta | undefined = m.cmd
  // Empty output has nothing to card — pushLocalMessage normally trims these
  // away before a row ever exists; this guards pre-existing/corner resumes.
  if (!cmd || !m.text.trim()) return null

  const variant = cmd.variant
  const tone = THEME_BY_VARIANT[variant]
  // Defensive slashLabel — cmd.name is normalized at the push site, but the
  // card never trusts its inputs (ModelPickerSheet pushes a bare 'model').
  const chipLabel = slashLabel(cmd.name)
  const state = variant === 'error' ? 'failed' : 'completed'
  const allLines = m.text.split(/\r?\n/)

  // ── Local-notice surfaces: bare rows, deliberately outside the card shell ──
  if (variant === 'notice') {
    return (
      <View style={s.bareRow} accessibilityLabel={`${chipLabel} output, ${state}`}>
        <Icon name="information-circle-outline" size={13} color={C.textFaint} />
        <Text style={s.noticeText} selectable>{m.text}</Text>
      </View>
    )
  }
  if (variant === 'success') {
    return (
      <View style={s.successRow} accessibilityLabel={`${chipLabel} output, ${state}`}>
        <Icon name="checkmark-circle" size={14} color={C.greenSoft} />
        <Text style={s.successText} selectable>{m.text}</Text>
        <Text style={s.successTime}>{fmtTime(m.ts)}</Text>
      </View>
    )
  }

  // ── Card shell ─────────────────────────────────────────────────────────────
  const overLimit = allLines.length > 28 || m.text.length > 1600
  // The slice only removes lines, so a short-but-wide body (>1600 chars, ≤24
  // lines) has nothing for the toggle to reveal — never render it then.
  const showToggle = COLLAPSIBLE_VARIANTS.has(variant) && overLimit && allLines.length > COLLAPSE_LINES
  const truncated = COLLAPSIBLE_VARIANTS.has(variant) && overLimit && !expanded
  const shown = truncated ? allLines.slice(0, COLLAPSE_LINES) : allLines
  const headMeta = `${fmtTime(m.ts)}${COLLAPSIBLE_VARIANTS.has(variant) && allLines.length > COLLAPSE_LINES ? ` · ${allLines.length} lines` : ''}`
  const chipTone =
    variant === 'error'
      ? { bg: C.redSoft, fg: C.red }
      : variant === 'usage'
        ? { bg: C.amberSoft, fg: C.amber }
        : { bg: C.accentSoft, fg: C.accent }
  // Status degrades to the result body when the lines don't actually parse.
  const statusUsable = variant === 'status' && parseStatusPairs(m.text).length >= 2

  const copy = async () => {
    await Clipboard.setStringAsync(m.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const insert = (line: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onInsert?.(line)
  }

  return (
    <View
      style={[
        // marginHorizontal 16 mirrors MessageBubble's botWrap paddingHorizontal
        // (Chat.tsx) — the card owns its inset because it replaces that wrapper.
        s.card,
        (variant === 'error' || variant === 'usage') && { borderLeftWidth: 3, borderLeftColor: variant === 'error' ? C.red : C.amber },
      ]}
      accessibilityLabel={`${chipLabel} output, ${state}`}
    >
      {/* Header: status icon + /command chip + time */}
      <View style={s.head}>
        <Icon name={tone.icon} size={14} color={tone.color} />
        <View style={[s.chip, { backgroundColor: chipTone.bg }]}>
          <Text style={[s.chipText, { color: chipTone.fg }]}>{chipLabel}</Text>
        </View>
        <Text style={s.headTime}>{headMeta}</Text>
      </View>

      <View style={s.body}>
        {variant === 'result' || (variant === 'status' && !statusUsable) ? (
          <Markdown style={md}>{shown.join('\n')}</Markdown>
        ) : variant === 'error' || variant === 'usage' ? (
          <>
            <View style={[s.alertBox, { backgroundColor: variant === 'error' ? C.redSoft : C.amberSoft }]}>
              <Text style={s.alertText} selectable>{shown.join('\n')}</Text>
            </View>
            {cmd.suggestion && onInsert ? (
              <Pressable
                onPress={() => insert(slashLabel(cmd.suggestion!))}
                style={({ pressed }) => [s.suggestRow, pressed && s.pressedSoft]}
                hitSlop={6}
                accessibilityLabel={`Use suggested command ${slashLabel(cmd.suggestion)}`}
              >
                <Icon name="return-down-back" size={14} color={C.textFaint} />
                <Text style={s.suggestLead}>
                  Did you mean <Text style={s.suggestCmd}>{slashLabel(cmd.suggestion)}</Text>
                </Text>
                <Icon name="chevron-forward" size={13} color={C.textFaint} />
              </Pressable>
            ) : cmd.suggestion ? (
              <Text style={s.leftoverText}>Did you mean {slashLabel(cmd.suggestion)}?</Text>
            ) : null}
            {cmd.hint ? (
              <View style={s.hintRow}>
                <Text style={s.hintText}>{cmd.hint}</Text>
                {onOpenCatalog ? (
                  <Pressable
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                      onOpenCatalog()
                    }}
                    style={({ pressed }) => [s.hintChip, pressed && s.pressedSoft]}
                    hitSlop={6}
                    accessibilityLabel="Browse all commands"
                  >
                    <Icon name="terminal-outline" size={12} color={C.textDim} />
                    <Text style={s.hintChipText}>Browse all commands</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : statusUsable ? (
          (() => {
            const rows = shown
              .map((line) => ({ line, pair: parseStatusPairs(line)[0] ?? null }))
              .filter((r) => r.pair || r.line.trim())
            return rows.map((r, i) => {
              const last = i === rows.length - 1
              return r.pair ? (
                <View key={i} style={[s.statusRow, !last && s.statusRowLine]}>
                  <Text style={s.statusLabel}>{r.pair[0]}</Text>
                  <Text style={s.statusValue} selectable numberOfLines={3}>{r.pair[1]}</Text>
                </View>
              ) : (
                <View key={i} style={[s.statusLeftover, !last && s.statusRowLine]}>
                  <Text style={s.leftoverText}>{r.line}</Text>
                </View>
              )
            })
          })()
        ) : variant === 'list' ? (
          <>
            {shown.map((line, i) => {
              const row = rowParts(line)
              if (!row) return line.trim() ? <Text key={i} style={s.leftoverText}>{line}</Text> : null
              // Tappable only when the command resolves in the loaded registry —
              // never name-based, so unknown /tokens from raw dumps stay inert.
              const tappable = !!(row.token && onInsert && resolvesInRegistry(row.token, catalog, skills))
              const body = (
                <>
                  {row.marker ? <Text style={s.listIndex}>{row.marker}</Text> : null}
                  <View style={{ flex: 1 }}>
                    <Text style={s.listTitle} numberOfLines={1}>{row.title}</Text>
                    {row.sub ? <Text style={s.listSub} numberOfLines={1}>{row.sub}</Text> : null}
                  </View>
                  {tappable ? <Icon name="chevron-forward" size={13} color={C.textFaint} /> : null}
                </>
              )
              return tappable ? (
                <Pressable
                  key={i}
                  onPress={() => insert(row.token!)}
                  style={({ pressed }) => [s.listRow, pressed && s.listRowPressed]}
                  accessibilityLabel={`Insert ${row.title}`}
                >
                  {body}
                </Pressable>
              ) : (
                <View key={i} style={s.listRow}>{body}</View>
              )
            })}
          </>
        ) : (
          // catalog — the raw dump is never rendered (it stays in m.text for
          // copy/persistence); the body is a summary plus the browser footer.
          <Text style={s.catalogSummary} selectable>{catalogSummaryText(catalog, skills)}</Text>
        )}

        {showToggle ? (
          <Pressable
            onPress={() => setExpanded(!expanded)}
            style={({ pressed }) => [s.moreBtn, pressed && s.pressedSoft]}
            hitSlop={6}
            accessibilityLabel={expanded ? 'Collapse output' : `Show all ${allLines.length} lines`}
          >
            <Text style={s.moreText}>{expanded ? 'Collapse output' : `Show all ${allLines.length} lines`}</Text>
          </Pressable>
        ) : null}
      </View>

      {variant === 'catalog' && onOpenCatalog ? (
        <Pressable
          onPress={onOpenCatalog}
          style={({ pressed }) => [s.footer, pressed && s.footerPressed]}
          accessibilityLabel="Open command browser"
        >
          <Icon name="grid-outline" size={14} color={C.accent} />
          <Text style={s.footerText}>Open command browser</Text>
          <Icon name="chevron-forward" size={14} color={C.textFaint} style={s.footerChevron} />
        </Pressable>
      ) : null}

      {COPY_VARIANTS.has(variant) ? (
        <View style={s.actions}>
          <Pressable
            onPress={copy}
            hitSlop={8}
            style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
            accessibilityLabel={`Copy ${chipLabel} output`}
          >
            <Icon name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? C.greenSoft : C.textFaint} />
          </Pressable>
          {copied ? <Text style={s.copiedText}>Copied</Text> : null}
        </View>
      ) : null}
    </View>
  )
})

/** Live registry counts for the catalog summary. */
function catalogSummaryText(cmds: Record<string, unknown>, skills: Record<string, unknown>): string {
  const cmdCount = Object.keys(cmds).length
  const skillCount = Object.keys(skills).length
  const counts = [
    cmdCount ? `${cmdCount} command${cmdCount === 1 ? '' : 's'}` : '',
    skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
  return `${counts ? `${counts} in the gateway catalog` : 'The gateway catalog is not loaded'}. Open the browser to browse or insert.`
}

const makeS = () => StyleSheet.create({
  card: {
    backgroundColor: C.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.borderSoft,
    marginHorizontal: 16,
    marginVertical: 6,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  chip: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  chipText: { fontSize: 12.5, fontWeight: '800' },
  headTime: { marginLeft: 'auto', color: C.textFaint, fontSize: 11 },
  body: { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 8, gap: 6 },
  alertBox: { borderRadius: 12, padding: 10 },
  alertText: { color: C.textDim, fontSize: 13.5, lineHeight: 19 },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: C.bgElev, borderRadius: 10, minHeight: 44, paddingHorizontal: 10, marginTop: 8,
  },
  suggestLead: { color: C.textDim, fontSize: 12.5 },
  suggestCmd: { color: C.accent, fontSize: 13, fontWeight: '700' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hintText: { color: C.textFaint, fontSize: 12, flexShrink: 1 },
  hintChip: {
    ...pill(28),
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: C.bgElev, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10,
  },
  hintChipText: { color: C.textDim, fontSize: 12.5, fontWeight: '700' },
  statusRow: { flexDirection: 'row', gap: 10, paddingVertical: 7, alignItems: 'flex-start' },
  statusRowLine: { borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  statusLabel: { flex: 1, color: C.textFaint, fontSize: 12.5, fontWeight: '600' },
  statusValue: { flex: 1.4, color: C.text, fontSize: 13, fontWeight: '500', textAlign: 'right' },
  statusLeftover: { paddingVertical: 7 },
  leftoverText: { color: C.textFaint, fontSize: 12, lineHeight: 17 },
  listRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, minHeight: 44, paddingHorizontal: 8, marginHorizontal: -8,
  },
  listRowPressed: { backgroundColor: C.bgHover },
  listIndex: { minWidth: 22, textAlign: 'right', color: C.textFaint, fontSize: 11.5, fontWeight: '800' },
  listTitle: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  listSub: { color: C.textFaint, fontSize: 11.5, marginTop: 1 },
  catalogSummary: { color: C.textFaint, fontSize: 12.5, lineHeight: 18 },
  bareRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  noticeText: { color: C.textDim, fontSize: 13, lineHeight: 18, flex: 1 },
  successRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: C.greenTint, borderWidth: 1, borderColor: C.borderSoft, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, marginHorizontal: 16, marginVertical: 6,
  },
  successText: { color: C.text, fontSize: 13, fontWeight: '500', lineHeight: 18, flex: 1 },
  successTime: { color: C.textFaint, fontSize: 11 },
  moreBtn: { alignSelf: 'flex-start' },
  moreText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  footer: {
    borderTopWidth: 1, borderTopColor: C.borderSoft,
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 42,
  },
  footerPressed: { backgroundColor: C.bgHover },
  footerText: { color: C.accent, fontSize: 13, fontWeight: '700' },
  footerChevron: { marginLeft: 'auto' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingBottom: 6 },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 15 },
  iconPressed: { opacity: 0.55 },
  pressedSoft: { opacity: 0.55 },
  copiedText: { color: C.textFaint, fontSize: 11 },
})
