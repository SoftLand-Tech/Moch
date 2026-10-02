/**
 * Slash command support.
 *
 * The gateway owns the registry — never hardcode a command list. Fetch it at
 * runtime from `commands.catalog` (127 commands + 85 skills on the current
 * build) and rank completions with `complete.slash`, which is the same fuzzy
 * scorer the desktop TUI uses.
 *
 * Wire facts established against a live gateway (do not guess these):
 *  - `complete.slash` returns `text` WITHOUT the leading slash and `display`
 *    WITH it, for both commands and skills. A bare "/" returns the whole
 *    catalog (capped per kind server-side).
 *  - `commands.catalog.skills` keys DO include the leading slash ("/airtable").
 *    Building `/${key}` yields "//airtable", which the gateway rejects.
 *  - Execution is split and the gateway enforces it:
 *      built-ins  -> `slash.exec`   (params: { session_id, command })
 *      skills     -> `command.dispatch` (slash.exec answers 4018
 *                    "skill command: use command.dispatch")
 *    `command.dispatch` is tried first and 4018 means "fall through".
 *
 * Contract source of truth:
 *   ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.generated.ts
 */
import { atom } from 'nanostores'
import { log } from './log'

// src/lib/gateway pulls react-native storage, which plain node (scripts/)
// cannot load — so it is imported lazily and scripts can inject a fake with
// _useGatewayForTests() before calling anything that talks to the wire.
type GatewayModule = typeof import('./gateway')
let gwOverride: GatewayModule | null = null
export function _useGatewayForTests(g: GatewayModule | null) { gwOverride = g }
async function gw(): Promise<GatewayModule> {
  return gwOverride ?? import('./gateway')
}

export interface CatalogCommand {
  description: string
  argument_mode?: string
  desktop?: string
  aliases?: string[]
  subcommands?: string[]
}

export interface SlashSkill {
  usage?: number
  origin?: string
}

export interface CompletionItem {
  text: string
  display?: string
  meta?: string
  kind?: string
  replace_from?: number
}

// ── State ──────────────────────────────────────────────────────────────────

export const commandCatalog = atom<Record<string, CatalogCommand>>({})
export const commandSubcommands = atom<Record<string, string[]>>({})
export const commandAliases = atom<Record<string, string>>({})
export const skillCommands = atom<Record<string, SlashSkill>>({})
export const commandCategories = atom<Array<{ name: string; pairs: Array<[string, string]> }>>([])
/** Bare command name → description (category pairs + a command.resolve top-up). */
export const commandDescriptions = atom<Record<string, string>>({})
/** Bare skill name → description (complete.slash metas; the bare-catalog call is capped per kind). */
export const skillDescriptions = atom<Record<string, string>>({})
export const catalogWarning = atom<string>('')
export const commandWarning = atom<string>('')

let loadedFor: string | null = null

/**
 * Dynamic subcommand choices (complete.slash) per command, cached so repeat
 * opens of the options sheet render instantly instead of re-awaiting the RPC
 * inside an already-open sheet. Wiped whenever the catalog reloads — the
 * gateway owns the option set, so a fresh catalog invalidates it.
 */
export interface CachedCommandChoice {
  value: string
  meta?: string
}
const dynamicChoiceCache = new Map<string, CachedCommandChoice[]>()

export function cachedCommandChoices(command: string): CachedCommandChoice[] | null {
  return dynamicChoiceCache.get(command) ?? null
}

export function rememberCommandChoices(command: string, choices: CachedCommandChoice[]): void {
  dynamicChoiceCache.set(command, choices)
}

// ── Fetch ──────────────────────────────────────────────────────────────────

/** Load the command registry. No-op when already loaded for this session. */
export async function loadCatalog(opts?: { force?: boolean; sessionId?: string }): Promise<void> {
  if (!opts?.force && loadedFor) return
  const { rpc } = await gw()
  try {
    const res = await rpc<CatalogResult>('commands.catalog', opts?.sessionId ? { session_id: opts.sessionId } : {})
    const cmds = res.commands ?? {}
    dynamicChoiceCache.clear()
    commandCatalog.set(cmds)
    commandSubcommands.set(res.sub ?? {})
    commandAliases.set(res.canon ?? {})
    skillCommands.set(res.skills ?? {})
    commandCategories.set(res.categories ?? [])
    // `commands` entries carry no description on the wire (probe: 0/127) —
    // the category pairs do. command.resolve tops up the rest right after.
    const descs: Record<string, string> = {}
    for (const cat of res.categories ?? []) {
      for (const [key, desc] of cat.pairs) {
        const bare = key.replace(/^\//, '').toLowerCase()
        if (desc && !descs[bare]) descs[bare] = desc
      }
    }
    commandDescriptions.set(descs)
    catalogWarning.set(res.warning ?? '')
    loadedFor = opts?.sessionId ?? '*'
    log('info', 'slash', `catalog: ${Object.keys(cmds).length} commands, ${Object.keys(res.skills ?? {}).length} skills`)
    void resolveCommandDescGaps()
  } catch (err) {
    log('info', 'slash', `commands.catalog failed: ${String(err)}`)
    commandWarning.set(err instanceof Error ? err.message : 'Could not load commands')
  }
}

interface CatalogResult {
  pairs?: Array<[string, string]>
  sub?: Record<string, string[]>
  canon?: Record<string, string>
  commands?: Record<string, CatalogCommand>
  categories?: Array<{ name: string; pairs: Array<[string, string]> }>
  skills?: Record<string, SlashSkill>
  skill_count?: number
  warning?: string
}

export function resetCatalog() {
  loadedFor = null
  dynamicChoiceCache.clear()
  commandCatalog.set({})
  commandSubcommands.set({})
  commandAliases.set({})
  skillCommands.set({})
  commandCategories.set([])
  commandDescriptions.set({})
  skillDescriptions.set({})
  catalogWarning.set('')
  commandWarning.set('')
}

/**
 * The category pairs omit ~1/4 of commands (aliases, TUI-only built-ins) but
 * `command.resolve` answers for every one of them (~2ms, local). Tops up
 * `commandDescriptions` after loadCatalog, in small batches, fire-and-forget:
 * the tab renders the pairs' 96 descriptions instantly and the stragglers
 * fill in as resolves land. command.resolve does NOT answer for skills
 * (4011) — those go through loadSkillDescriptions.
 */
async function resolveCommandDescGaps(): Promise<void> {
  try {
    const { rpc } = await gw()
    const missing = [...new Set(
      Object.keys(commandCatalog.get())
        .map((k) => k.replace(/^\//, '').toLowerCase())
        .filter((k) => k && !commandDescriptions.get()[k]),
    )]
    for (let i = 0; i < missing.length; i += 8) {
      const settled = await Promise.all(missing.slice(i, i + 8).map(async (name) => {
        try {
          const r = await rpc<{ canonical?: string; description?: string }>('command.resolve', { name })
          return r?.description?.trim() ? ([name, r.description.trim()] as const) : null
        } catch {
          return null
        }
      }))
      const next = { ...commandDescriptions.get() }
      let dirty = false
      for (const pair of settled) {
        if (pair && !next[pair[0]]) {
          next[pair[0]] = pair[1]
          dirty = true
        }
      }
      if (dirty) commandDescriptions.set(next)
    }
  } catch (err) {
    log('info', 'slash', `command.resolve description top-up failed: ${String(err)}`)
  }
}

/**
 * Skill descriptions via `complete.slash` — one targeted query per skill, so
 * the server's per-kind cap on bare "/" (30 of ~88 arrive with the palette)
 * can't bite. Progressive: the atom updates as each batch lands, so the
 * skills tab fills in while it scrolls. Skills are 4011 on command.resolve,
 * so this meta scrape is the only wire source.
 */
export async function loadSkillDescriptions(): Promise<void> {
  const names = [...new Set(
    Object.keys(skillCommands.get())
      .map((k) => k.replace(/^\//, ''))
      .filter((k) => k && !skillDescriptions.get()[k]),
  )]
  if (!names.length) return
  const { rpc } = await gw()
  for (let i = 0; i < names.length; i += 8) {
    const settled = await Promise.all(names.slice(i, i + 8).map(async (bare) => {
      try {
        const res = await rpc<{ items?: CompletionItem[] }>('complete.slash', { text: `/${bare}` })
        // The exact query returns text with a trailing space (it is a
        // completion payload meant for insertion) — trim before matching.
        const hit = (res?.items ?? []).find((it) => (it.text ?? '').trim().replace(/^\//, '').toLowerCase() === bare.toLowerCase())
        const desc = hit?.meta?.replace(/^⚡\s*/, '').trim()
        return desc ? ([bare, desc] as const) : null
      } catch {
        return null
      }
    }))
    const next = { ...skillDescriptions.get() }
    let dirty = false
    for (const pair of settled) {
      if (pair && !next[pair[0]]) {
        next[pair[0]] = pair[1]
        dirty = true
      }
    }
    if (dirty) skillDescriptions.set(next)
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

export interface ParsedCommand {
  name: string
  args: string
  raw: string
}

export function parseSlashCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase()
  if (!name) return null
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
  return { name, args, raw: text }
}

/**
 * Collapse a user-typed command name to one canonical word, no slashes.
 * Handles "//airtable" (skill keys already carry a slash) and "Airtable".
 */
export function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase()
}

/** Map an alias/underscore variant to its canonical name, no slash. */
export function canonicalName(name: string): string {
  const key = normalizeCommandName(name)
  const canon = commandAliases.get()
  return (canon[key] ?? canon[`/${key}`] ?? key).replace(/^\//, '')
}

// ── Interactive hints (from the gateway's own registry) ────────────────────

/**
 * The composer mode the gateway declares for a command — "options" means the
 * argument is one of `subsFor()`, "mixed" adds free text on top. The desktop
 * composer reads the same field (hermes_cli/commands.py::infer_argument_mode),
 * so the app never hardcodes which commands want a picker.
 */
export function argumentModeFor(canonical: string): 'options' | 'mixed' | 'text' | null {
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  const mode = def?.argument_mode
  return mode === 'options' || mode === 'mixed' || mode === 'text' ? mode : null
}

/** Subcommand choices the gateway lists for a command (e.g. /reasoning levels). */
export function subsFor(canonical: string): string[] {
  const key = `/${canonical}`
  const fromSub = commandSubcommands.get()[key] ?? commandSubcommands.get()[canonical]
  if (fromSub?.length) return fromSub
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  return def?.subcommands ?? []
}

/** Catalog description for a canonical command name ('' when unknown). */
export function describeCommand(canonical: string): string {
  const cmds = commandCatalog.get()
  const def = cmds[canonical] ?? cmds[`/${canonical}`]
  return def?.description ?? ''
}

/**
 * What native UI a bare `/command` should open instead of the gateway's
 * usage text. `model` gets the full provider/model/scope picker; commands the
 * gateway marks options/mixed get a subcommand chooser — static `sub` lists
 * when the catalog has them, dynamic ones via `complete.slash` when not
 * (e.g. /personality lists the personality names). Everything else runs
 * through the gateway as before (text commands often work bare: /reset…).
 * Bare /new is intercepted app-side in the chat screen (local newChat()).
 *
 * Bare `/help` // `/commands` ALWAYS open the command catalog browser — the
 * sheet self-loads the registry with a spinner when it has not landed yet, so
 * the browser is reachable even on an unloaded session. This check
 * deliberately sits BEFORE the argumentModeFor branch, so a gateway that
 * marks /help options/mixed still gets the browser instead of the
 * subcommand chooser.
 */
export function interactiveTarget(
  canonical: string,
  args: string,
): 'model-picker' | 'options' | 'catalog' | null {
  if (args) return null
  if (canonical === 'help' || canonical === 'commands') return 'catalog'
  if (canonical === 'model') return 'model-picker'
  const mode = argumentModeFor(canonical)
  if (mode === 'options' || mode === 'mixed') return 'options'
  return null
}

// ── Completion ─────────────────────────────────────────────────────────────

/**
 * Ranked completions from the gateway's own scorer — the same fuzzy ranking
 * the desktop TUI uses, so a query like "/mo" also matches commands whose
 * description mentions it. Falls back to a local prefix match if the call
 * fails, so the palette still works offline.
 */
export async function completeSlash(prefix: string, sessionId?: string): Promise<CompletionItem[]> {
  const text = prefix.startsWith('/') ? prefix : `/${prefix}`
  try {
    const { rpc } = await gw()
    const res = await rpc<{ items?: CompletionItem[]; replace_from?: number }>('complete.slash', {
      text,
      ...(sessionId ? { session_id: sessionId } : {}),
    })
    if (res?.items?.length) return res.items
  } catch (err) {
    log('info', 'slash', `complete.slash failed, using local match: ${String(err)}`)
  }
  return localComplete(text)
}

/**
 * Synchronous local completion from the loaded registry — the slash palette
 * paints this instantly on keystroke, then the ranked `complete.slash` RPC
 * refines it when it lands.
 */
export function localCompleteSync(text: string): CompletionItem[] {
  return localComplete(text)
}

function localComplete(text: string): CompletionItem[] {
  const body = text.slice(1)
  const spaceIdx = body.indexOf(' ')
  const namePart = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().replace(/^\/+/, '')
  const cmds = commandCatalog.get()
  const canon = commandAliases.get()

  if (spaceIdx !== -1 && namePart) {
    const canonical = (canon[namePart] ?? namePart).replace(/^\//, '')
    const subs = commandSubcommands.get()[`/${canonical}`] ?? []
    const argPart = body.slice(spaceIdx + 1).split(/\s/)[0].toLowerCase()
    return subs
      .filter((o) => !argPart || o.toLowerCase().startsWith(argPart))
      .slice(0, 20)
      .map((o) => ({ text: o, display: `/${canonical} ${o}`, kind: 'option' }))
  }

  const out: CompletionItem[] = []
  for (const [name, def] of Object.entries(cmds)) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    out.push({ text: name, display: name.startsWith('/') ? name : `/${name}`, meta: def.description?.slice(0, 90), kind: 'command' })
    if (out.length >= 60) break
  }
  // Skill keys already carry the leading slash — do not add another.
  for (const [name, skill] of Object.entries(skillCommands.get())) {
    if (namePart && !name.toLowerCase().includes(namePart)) continue
    const bare = name.replace(/^\//, '')
    out.push({ text: bare, display: `/${bare}`, meta: `skill · ${skill.origin ?? 'local'}`, kind: 'skill' })
    if (out.length >= 90) break
  }
  return out
}

// ── Output classification ──────────────────────────────────────────────────

/**
 * How a command's output renders in the transcript. Classification happens
 * here — before the UI ever sees the text — so the card family stays dumb.
 * Structural shapes (catalog dumps, lists, kv tables) win over prose
 * heuristics, and usage prose is only trusted at guard-text scale (≤4 lines:
 * long text is output, not an error).
 */
export type CommandVariant =
  | 'result'
  | 'error'
  | 'usage'
  | 'catalog'
  | 'status'
  | 'list'
  | 'notice'
  | 'success'

/** The per-message label the transcript renders a command output card from. */
export interface CommandMeta {
  name: string
  variant: CommandVariant
  /** "Did you mean /x" — tappable; inserts the corrected command. */
  suggestion?: string
  /** One-line recovery hint (e.g. "Type /help for the full list."). */
  hint?: string
}

/**
 * Normalize both SlashOutcome.name conventions — directiveToOutcome's
 * label-with-slash ("/model") and the catch paths' bare canonical ("model") —
 * to exactly one leading slash. One guard feeds card chips, a11y labels, and
 * composer insertion, so "//model" can never render or land in the input.
 */
export function slashLabel(n: string): string {
  return '/' + n.replace(/^\/+/, '').trim()
}

/** The recovery hint attached whenever the prose points the user at /help. */
const USAGE_HINT = 'Type /help for the full list.'

/**
 * Pull suggestion/hint out of gateway usage prose — the identical regexes
 * whether the prose arrived as short slash.exec output or as a thrown error
 * (dispatch failure / slash.exec catch). Empty object when nothing matches.
 */
export function extractUsage(text: string): { suggestion?: string; hint?: string } {
  const out: { suggestion?: string; hint?: string } = {}
  const mean = /did you mean \/?([\w-]+)/i.exec(text)
  if (mean) out.suggestion = `/${mean[1]}`
  if (/type \/help/i.test(text) || /unknown command/i.test(text) || /^usage:/im.test(text)) {
    out.hint = USAGE_HINT
  }
  return out
}

/** Distinct `/token`s in `text` that resolve to a loaded catalog/skill key. */
export function catalogTokenHits(text: string): number {
  const cmds = commandCatalog.get()
  const skills = skillCommands.get()
  if (!Object.keys(cmds).length && !Object.keys(skills).length) return 0
  const hits = new Set<string>()
  for (const m of text.matchAll(/\/([\w-]+)/g)) {
    const bare = m[1].toLowerCase()
    if (cmds[bare] || cmds[`/${bare}`] || skills[bare] || skills[`/${bare}`]) hits.add(bare)
  }
  return hits.size
}

/** Line counts for the list grammar: total non-empty lines vs slash-led/numbered rows. */
export function listRowStats(text: string): { lines: number; rows: number } {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim())
  let rows = 0
  for (const line of lines) {
    if (/^\s*(\/[\w-]+|\d+[.)])/.test(line)) rows++
  }
  return { lines: lines.length, rows }
}

/** `label: value` pairs from the lines that have one (status bodies). */
export function parseStatusPairs(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const line of text.trim().split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][^:]{0,38})\s*:\s+(\S.*)$/.exec(line)
    if (m) pairs.push([m[1].trim(), m[2].trim()])
  }
  return pairs
}

/**
 * Classify slash.exec / directive output for the card family. Rule order is
 * the contract, pinned by scripts/test-command-output.ts:
 *   1. catalog — ≥12 distinct registry tokens AND ≥25% of the registry (a
 *      dump is recognized by volume first, so a footer can never steal it);
 *   2. list — ≥3 lines and ≥50% numbered/slash-led rows;
 *   3. status — ≥3 lines and ≥60% `label: value`;
 *   4. usage prose — only ≤4 lines (the guard-text scale);
 *   5. notice — a single line ≤160 chars;
 *   6. result — markdown/prose default (bullet lists included; the md
 *      renderer already owns those).
 */
export function classifyOutput(text: string): CommandVariant {
  const t = text.trim()
  if (!t) return 'notice'
  const lines = t.split(/\r?\n/).filter((l) => l.trim())

  const registrySize = Object.keys(commandCatalog.get()).length + Object.keys(skillCommands.get()).length
  if (registrySize > 0) {
    const hits = catalogTokenHits(t)
    if (hits >= 12 && hits * 4 >= registrySize) return 'catalog'
  }

  const { lines: nLines, rows } = listRowStats(t)
  if (nLines >= 3 && rows * 2 >= nLines) return 'list'

  const pairs = parseStatusPairs(t)
  if (nLines >= 3 && pairs.length * 10 >= nLines * 6) return 'status'

  if (nLines <= 4) {
    const u = extractUsage(t)
    if (u.suggestion || u.hint) return 'usage'
  }

  if (nLines === 1 && t.length <= 160) return 'notice'

  return 'result'
}

// ── Execution ──────────────────────────────────────────────────────────────

export type SlashOutcome =
  | {
      /**
       * show — render `text` as a local message (command printed something).
       * Every show outcome carries a `subtype` so the card family knows which
       * body to render; error/usage outcomes add the extracted suggestion/hint.
       */
      action: 'show'
      subtype: CommandVariant
      /** Tappable "Did you mean /x" — inserts the corrected command. */
      suggestion?: string
      /** One-line recovery hint under the body. */
      hint?: string
      text: string
      /** Canonical command name, for labelling the output. */
      name: string
    }
  | {
      /** send — send `text` as a real turn (the gateway asked for it). */
      action: 'send'
      text: string
      /** Canonical command name, for labelling the output. */
      name: string
    }
  | {
      /** prefill — put `text` in the composer without sending. */
      action: 'prefill'
      text: string
      /** Canonical command name, for labelling the output. */
      name: string
    }
  | {
      /** none — nothing to do */
      action: 'none'
      text: string
      /** Canonical command name, for labelling the output. */
      name: string
    }

/**
 * Run a slash command exactly the way the real Hermes does.
 *
 * Stage order mirrors the gateway: quick command -> plugin -> bundle -> skill
 * (all via `command.dispatch`, which returns a directive), then built-ins via
 * `slash.exec`. A 4018 from dispatch means "not one of mine" and is the
 * signal to fall through — it is not an error.
 */
export async function runCommand(input: string, sessionId: string): Promise<SlashOutcome> {
  const parsed = parseSlashCommand(input)
  if (!parsed) return { action: 'none', text: '', name: '' }

  const { rpc } = await gw()
  const canonical = canonicalName(parsed.name)
  const label = `/${canonical}`
  const argText = parsed.args

  // Skills and quick/plugin/bundle commands. Send the bare name — the
  // gateway rejects "//name", and skill keys already carry a slash.
  try {
    const d = await rpc<DispatchDirective>('command.dispatch', {
      name: canonical,
      arg: argText || null,
      session_id: sessionId,
    })
    if (d && d.type && d.type !== 'none') {
      return directiveToOutcome(d, label)
    }
  } catch (err) {
    const code = (err as { code?: number }).code
    // 4018 = "not a quick/plugin/bundle/skill command" -> built-in, fall through.
    // Anything else is a real failure worth surfacing (usage, permissions...).
    if (code !== 4018 && code !== -32601) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', 'slash', `dispatch /${canonical} failed: ${msg}`)
      // A failed call is red no matter how helpful the prose is — but the
      // gateway's usage text still feeds the card's suggestion/hint rows.
      return {
        action: 'show',
        text: `${label} — ${msg.replace(/^command\.dispatch:\s*/, '')}`,
        name: canonical,
        subtype: 'error',
        ...extractUsage(msg),
      }
    }
  }

  // Built-in. `slash.exec` takes `command` as a single string.
  const command = argText ? `${label} ${argText}` : label
  try {
    const res = await rpc<{ output?: string; warning?: string; type?: string; message?: string }>('slash.exec', {
      session_id: sessionId,
      command,
    })
    // slash.exec can reroute to a directive (queue/steer/goal/loop do this).
    if (res?.type && !res.output) {
      return directiveToOutcome(res as DispatchDirective, label)
    }
    if (res?.warning) log('info', 'slash', res.warning)
    const text = res?.output?.trim() || `${label} — done`
    const subtype = classifyOutput(text)
    return {
      action: 'show',
      text,
      name: canonical,
      subtype,
      ...(subtype === 'usage' ? extractUsage(text) : {}),
    }
  } catch (err) {
    // The gateway's own message is what Hermes would print — surface it in
    // the chat rather than an alert, so it stays in the transcript. A failed
    // call stays red; the usage prose inside still drives suggestion/hint.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      action: 'show',
      text: `${label} — ${msg.replace(/^slash\.exec:\s*/, '')}`,
      name: canonical,
      subtype: 'error',
      ...extractUsage(msg),
    }
  }
}

interface DispatchDirective {
  type?: 'exec' | 'alias' | 'plugin' | 'send' | 'skill' | 'prefill' | 'none'
  output?: string
  target?: string
  message?: string
  notice?: string
  display?: string
  name?: string
  status?: string
}

function directiveToOutcome(d: DispatchDirective, label: string): SlashOutcome {
  switch (d.type) {
    case 'send':
      // The gateway wants this text sent as a real turn (e.g. /queue <prompt>).
      return { action: 'send', text: d.message ?? d.output ?? '', name: label }
    case 'prefill':
      // Put it in the composer for the user to review and send.
      return { action: 'prefill', text: d.output ?? d.message ?? '', name: label }
    case 'none':
      return { action: 'none', text: '', name: label }
    default: {
      // exec / alias / plugin / skill — all print something. Shape-classified
      // like slash.exec output so the card family renders one body each.
      const text = [d.output, d.notice].filter(Boolean).join('\n').trim() || `${label} — done`
      return { action: 'show', text, name: label, subtype: classifyOutput(text) }
    }
  }
}
