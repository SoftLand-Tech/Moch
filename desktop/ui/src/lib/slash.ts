/**
 * Slash commands — the gateway's own registry (commands.catalog), so new
 * server-side commands appear without an app update. Port of the phone's
 * slash.ts essentials: catalog fetch, prefix completion ranking, and the
 * option-style commands that open pickers (/model, /reasoning, /fast…).
 */

import { atom } from 'nanostores'
import { rpc } from './gateway'

export interface SlashCommand {
  name: string // '/new'
  description: string
  usage?: string
  /** Option-style commands render a picker instead of usage text. */
  options?: string[]
}

export const commandCatalog = atom<SlashCommand[]>([])
export const slashError = atom<string>('')

const OPTION_COMMANDS: Record<string, string[]> = {
  '/model': [],
  '/reasoning': ['none', 'low', 'medium', 'high', 'max'],
  '/fast': [],
}

interface CatalogResult {
  pairs?: [string, string][]
  commands?: Array<Record<string, unknown>>
}

export async function refreshCommandCatalog(): Promise<void> {
  try {
    const res = await rpc<CatalogResult>('commands.catalog', {}, 15000)
    let cmds: SlashCommand[] = []
    if (Array.isArray(res.pairs)) {
      cmds = res.pairs.map(([name, description]) => {
        const usageMatch = description.match(/\(usage:\s*(.+?)\)\s*$/)
        return {
          name,
          description: description.replace(/\s*\(usage:.+?\)\s*$/, ''),
          usage: usageMatch ? usageMatch[1] : undefined,
        }
      })
    } else if (Array.isArray(res.commands)) {
      cmds = res.commands.map((c) => ({
        name: String(c.name ?? c.command ?? ''),
        description: String(c.description ?? c.help ?? ''),
        usage: typeof c.usage === 'string' ? c.usage : undefined,
      }))
    }
    for (const [name, options] of Object.entries(OPTION_COMMANDS)) {
      if (!cmds.some((c) => c.name === name)) {
        cmds.push({ name, description: name === '/model' ? 'Switch model' : name === '/reasoning' ? 'Set reasoning effort' : 'Toggle fast mode', options })
      }
    }
    cmds = cmds.filter((c) => c.name.startsWith('/'))
    commandCatalog.set(cmds)
    slashError.set('')
  } catch (e) {
    slashError.set(e instanceof Error ? e.message : String(e))
  }
}

export interface SlashCompletion {
  command: SlashCommand
  /** The argument fragment typed so far ('/model gp' → 'gp'). */
  arg: string
}

/** Rank completions for the current composer text; empty when not a slash line. */
export function completeSlash(text: string, catalog: SlashCommand[]): SlashCompletion[] {
  if (!text.startsWith('/') || text.includes('\n')) return []
  const spaceIdx = text.indexOf(' ')
  const head = spaceIdx === -1 ? text : text.slice(0, spaceIdx)
  const arg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
  const matches = catalog
    .filter((c) => c.name.startsWith(head) || (arg && c.name === head))
    .slice(0, 8)
    .map((command) => ({ command, arg: command.name === head ? arg : '' }))
  return matches
}

/** Dispatch a slash line. Returns true when handled (sent as slash.exec or a picker). */
export async function dispatchSlash(text: string): Promise<boolean> {
  if (!text.startsWith('/')) return false
  const [name, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')
  if (OPTION_COMMANDS[name] && !arg) {
    // Option-style: the composer opens its picker; nothing to send.
    return false
  }
  await rpc('slash.exec', { command: text }, 300000)
  return true
}
