/**
 * CommandOutput — the one card family every slash-command output renders as.
 *
 * Card variants (result/error/usage/status/list/catalog) share one shell
 * (inset bgCard card, hairline border, header = status icon + `/command` pill
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
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { Pill, Txt } from './ui'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import Markdown from '@ronradtke/react-native-markdown-display'
import type { ChatMessage } from '../lib/chat'
import { commandCatalog, skillCommands, slashLabel, parseStatusPairs, type CommandMeta, type CommandVariant } from '../lib/slash'
import { C, useStyles } from '../lib/theme'
import { makeCardMdStyles, mdLinkified, onMdLinkPress, withDir } from './Chat'
import { useDir, useT } from '../lib/strings'

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

/** Theme-reactive icon/tone per variant (tokens must never be snapshotted). */
const toneFor = (variant: CommandVariant): { icon: keyof typeof Ionicons.glyphMap; color: string } => {
  switch (variant) {
    case 'result':
      return { icon: 'terminal-outline', color: C.accent }
    case 'error':
      return { icon: 'alert-circle', color: C.red }
    case 'usage':
      return { icon: 'warning-outline', color: C.amber }
    case 'status':
    case 'list':
      return { icon: 'list-outline', color: C.accent }
    case 'notice':
      return { icon: 'information-circle-outline', color: C.textFaint }
    case 'success':
      return { icon: 'checkmark-circle', color: C.greenSoft }
    default:
      return { icon: 'grid-outline', color: C.accent }
  }
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

/** Command/skill count label — singular/plural handled by the catalog. */
function countLabel(t: (key: string, vars?: Record<string, string | number>) => string, n: number, kind: 'command' | 'skill'): string {
  if (kind === 'command') return n === 1 ? t('chat.cmd.commandOne') : t('chat.cmd.commandMany', { n })
  return n === 1 ? t('chat.cmd.skillOne') : t('chat.cmd.skillMany', { n })
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
  const dir = useDir()
  const t = useT()
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
  const tone = toneFor(variant)
  // Defensive slashLabel — cmd.name is normalized at the push site, but the
  // card never trusts its inputs (ModelPickerSheet pushes a bare 'model').
  const chipLabel = slashLabel(cmd.name)
  const stateLabel = t(variant === 'error' ? 'chat.cmd.state.failed' : 'chat.cmd.state.completed')
  const a11y = t('chat.cmd.outputA11y', { command: chipLabel, state: stateLabel })
  const allLines = m.text.split(/\r?\n/)

  // ── Local-notice surfaces: bare rows, deliberately outside the card shell ──
  if (variant === 'notice') {
    return (
      <View style={[s.bareRow, { flexDirection: dir.row }]} accessibilityLabel={a11y}>
        <Icon name="information-circle-outline" size={13} color={C.textFaint} />
        <Text style={s.noticeText} selectable>{m.text}</Text>
      </View>
    )
  }
  if (variant === 'success') {
    return (
      <View style={[s.successRow, { flexDirection: dir.row }]} accessibilityLabel={a11y}>
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
  const headMeta = COLLAPSIBLE_VARIANTS.has(variant) && allLines.length > COLLAPSE_LINES
    ? `${fmtTime(m.ts)} · ${t('chat.cmd.lines', { n: allLines.length })}`
    : fmtTime(m.ts)
  const chipKind = variant === 'error' ? 'red' : variant === 'usage' ? 'amber' : 'accent'
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
        s.card,
        (variant === 'error' || variant === 'usage') && { borderLeftWidth: 3, borderLeftColor: variant === 'error' ? C.red : C.amber },
      ]}
      accessibilityLabel={a11y}
    >
      {/* Header: status icon + /command pill + time */}
      <View style={[s.head, { flexDirection: dir.row }]}>
        <Icon name={tone.icon} size={13} color={tone.color} />
        <Pill kind={chipKind} style={s.chip} textStyle={s.chipText}>
          {chipLabel}
        </Pill>
        <Txt size={10} mono ltr color={C.textFaint} style={s.headTime}>{headMeta}</Txt>
      </View>

      <View style={s.body}>
        {variant === 'result' || (variant === 'status' && !statusUsable) ? (
          // BUG-135: linkified markdown-it + in-app link handler (shared
          // instance exported from Chat.tsx) — result bodies often carry
          // bare URLs, previously dead text.
          <Markdown style={withDir(md as Record<string, object>, dir)} markdownit={mdLinkified} onLinkPress={onMdLinkPress}>
            {shown.join('\n')}
          </Markdown>
        ) : variant === 'error' || variant === 'usage' ? (
          <>
            <View style={[s.alertBox, { backgroundColor: variant === 'error' ? C.redSoft : C.amberSoft }]}>
              <Text style={s.alertText} selectable>{shown.join('\n')}</Text>
            </View>
            {cmd.suggestion && onInsert ? (
              <Pressable
                onPress={() => insert(slashLabel(cmd.suggestion!))}
                style={({ pressed }) => [s.suggestRow, { flexDirection: dir.row }, pressed && s.pressedSoft]}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('chat.cmd.useSuggestionA11y', { command: slashLabel(cmd.suggestion) })}
              >
                <Icon name="return-down-back" size={13} color={C.textFaint} />
                <Text style={s.suggestLead}>
                  {t('chat.cmd.didYouMeanLead')}{' '}
                  <Text style={s.suggestCmd}>{slashLabel(cmd.suggestion)}</Text>
                </Text>
                <Icon name={dir.icon.forward} size={12} color={C.textFaint} />
              </Pressable>
            ) : cmd.suggestion ? (
              <Text style={s.leftoverText}>{t('chat.cmd.didYouMean', { command: slashLabel(cmd.suggestion) })}</Text>
            ) : null}
            {cmd.hint ? (
              <View style={[s.hintRow, { flexDirection: dir.row }]}>
                <Text style={s.hintText}>{cmd.hint}</Text>
                {onOpenCatalog ? (
                  <Pressable
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                      onOpenCatalog()
                    }}
                    style={({ pressed }) => [s.hintChip, pressed && s.pressedSoft]}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.cmd.browseAllA11y')}
                  >
                    <Icon name="terminal-outline" size={12} color={C.textDim} />
                    <Txt size={11.5} weight="700" color={C.textDim}>{t('chat.cmd.browseAll')}</Txt>
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
                <View key={i} style={[s.statusRow, { flexDirection: dir.row }, !last && s.statusRowLine]}>
                  <Text style={s.statusLabel}>{r.pair[0]}</Text>
                  <Text style={[s.statusValue, { textAlign: dir.rtl ? 'left' : 'right' }]} selectable numberOfLines={3}>{r.pair[1]}</Text>
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
                  {row.marker ? (
                    <Text style={[s.listIndex, s.mono, { textAlign: dir.rtl ? 'left' : 'right' }]}>{row.marker}</Text>
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Text style={s.listTitle} numberOfLines={1}>{row.title}</Text>
                    {row.sub ? <Text style={s.listSub} numberOfLines={1}>{row.sub}</Text> : null}
                  </View>
                  {tappable ? <Icon name={dir.icon.forward} size={13} color={C.textFaint} /> : null}
                </>
              )
              return tappable ? (
                <Pressable
                  key={i}
                  onPress={() => insert(row.token!)}
                  style={({ pressed }) => [s.listRow, { flexDirection: dir.row }, pressed && s.listRowPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.cmd.useSuggestionA11y', { command: row.title })}
                >
                  {body}
                </Pressable>
              ) : (
                <View key={i} style={[s.listRow, { flexDirection: dir.row }]}>{body}</View>
              )
            })}
          </>
        ) : (
          // catalog — the raw dump is never rendered (it stays in m.text for
          // copy/persistence); the body is a summary plus the browser footer.
          <Text style={s.catalogSummary} selectable>{catalogSummaryText(catalog, skills, t)}</Text>
        )}

        {showToggle ? (
          <Pressable
            onPress={() => setExpanded(!expanded)}
            style={({ pressed }) => [s.moreBtn, pressed && s.pressedSoft]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={expanded ? t('chat.cmd.collapse') : t('chat.cmd.showAll', { n: allLines.length })}
          >
            <Txt size={11.5} weight="700" color={C.accent}>
              {expanded ? t('chat.cmd.collapse') : t('chat.cmd.showAll', { n: allLines.length })}
            </Txt>
          </Pressable>
        ) : null}
      </View>

      {variant === 'catalog' && onOpenCatalog ? (
        <Pressable
          onPress={onOpenCatalog}
          style={({ pressed }) => [s.footer, { flexDirection: dir.row }, pressed && s.footerPressed]}
          accessibilityRole="button"
          accessibilityLabel={t('chat.cmd.openBrowserA11y')}
        >
          <Icon name="grid-outline" size={14} color={C.accent} />
          <Txt size={12.5} weight="700" color={C.accent}>{t('chat.cmd.openBrowser')}</Txt>
          <Icon name={dir.icon.forward} size={13} color={C.textFaint} style={s.footerChevron} />
        </Pressable>
      ) : null}

      {COPY_VARIANTS.has(variant) ? (
        <View style={[s.actions, { flexDirection: dir.row }]}>
          <Pressable
            onPress={copy}
            hitSlop={8}
            style={({ pressed }) => [s.iconBtn, pressed && s.iconPressed]}
            accessibilityRole="button"
            accessibilityLabel={t('chat.cmd.copyA11y', { command: chipLabel })}
          >
            <Icon name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? C.greenSoft : C.textFaint} />
          </Pressable>
          {copied ? <Text style={s.copiedText}>{t('common.copied')}</Text> : null}
        </View>
      ) : null}
    </View>
  )
})

/** Live registry counts for the catalog summary. */
function catalogSummaryText(
  cmds: Record<string, unknown>,
  skills: Record<string, unknown>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const cmdCount = Object.keys(cmds).length
  const skillCount = Object.keys(skills).length
  const counts = [
    cmdCount ? countLabel(t, cmdCount, 'command') : '',
    skillCount ? countLabel(t, skillCount, 'skill') : '',
  ].filter(Boolean).join(' · ')
  const status = counts ? t('chat.cmd.catalogCounted', { counts }) : t('chat.cmd.catalogNotLoaded')
  return t('chat.cmd.catalogSummary', { status, hint: t('chat.cmd.catalogHint') })
}

const makeS = () => StyleSheet.create({
  mono: { fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }) },
  card: {
    backgroundColor: C.bgCard,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: C.borderSoft,
    marginVertical: 5,
    overflow: 'hidden',
  },
  head: { alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2 },
  chip: { paddingVertical: 1, paddingHorizontal: 6 },
  chipText: { fontSize: 10.5, fontWeight: '800' },
  headTime: { marginLeft: 'auto' },
  body: { paddingHorizontal: 10, paddingTop: 2, paddingBottom: 8, gap: 6 },
  alertBox: { borderRadius: 10, padding: 9 },
  alertText: { color: C.textDim, fontSize: 12, lineHeight: 17 },
  suggestRow: {
    alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: C.bgElev, borderRadius: 999, minHeight: 30, paddingHorizontal: 10, marginTop: 4,
  },
  suggestLead: { color: C.textDim, fontSize: 11.5 },
  suggestCmd: { color: C.accent, fontSize: 11.5, fontWeight: '700' },
  hintRow: { alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hintText: { color: C.textFaint, fontSize: 11, flexShrink: 1 },
  hintChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: C.bgElev, borderWidth: 1, borderColor: C.border,
    borderRadius: 999, paddingHorizontal: 10, height: 28,
  },
  statusRow: { gap: 10, paddingVertical: 6, alignItems: 'flex-start' },
  statusRowLine: { borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  statusLabel: { flex: 1, color: C.textFaint, fontSize: 11.5, fontWeight: '600' },
  statusValue: { flex: 1.4, color: C.text, fontSize: 11.5, fontWeight: '500', textAlign: 'right' },
  statusLeftover: { paddingVertical: 6 },
  leftoverText: { color: C.textFaint, fontSize: 11, lineHeight: 16 },
  listRow: {
    alignItems: 'center', gap: 8, borderRadius: 9, minHeight: 40, paddingHorizontal: 6, marginHorizontal: -6,
  },
  listRowPressed: { backgroundColor: C.bgHover },
  listIndex: { minWidth: 20, color: C.textFaint, fontSize: 10.5, fontWeight: '800' },
  listTitle: { color: C.text, fontSize: 12, fontWeight: '600' },
  listSub: { color: C.textFaint, fontSize: 10.5, marginTop: 1 },
  catalogSummary: { color: C.textFaint, fontSize: 11.5, lineHeight: 17 },
  bareRow: { alignItems: 'flex-start', gap: 6, paddingVertical: 6 },
  noticeText: { color: C.textDim, fontSize: 12, lineHeight: 17, flex: 1 },
  successRow: {
    alignItems: 'flex-start', gap: 8,
    backgroundColor: C.greenTint, borderWidth: 1, borderColor: C.borderSoft, borderRadius: 11,
    paddingHorizontal: 10, paddingVertical: 8, marginVertical: 5,
  },
  successText: { color: C.text, fontSize: 12, fontWeight: '500', lineHeight: 17, flex: 1 },
  successTime: { color: C.textFaint, fontSize: 10.5 },
  moreBtn: { alignSelf: 'flex-start' },
  footer: {
    borderTopWidth: 1, borderTopColor: C.borderSoft,
    alignItems: 'center', gap: 7, paddingHorizontal: 10, minHeight: 38,
  },
  footerPressed: { backgroundColor: C.bgHover },
  footerChevron: { marginLeft: 'auto' },
  actions: { alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 4 },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  iconPressed: { opacity: 0.55 },
  pressedSoft: { opacity: 0.55 },
  copiedText: { color: C.textFaint, fontSize: 10.5 },
})
