/** Example tasks for the Home grid — six cards sourced from the LIVE slash
 * catalog. The gateway owns the registry (never hardcode the list): the
 * curated entries below only pin ordering, copy and icon for names we know
 * read well as cards; a name the gateway doesn't serve is skipped, and the
 * rest of the loaded catalog backfills. */
import type { ComponentType } from 'react'
import type { CatalogCommand, SlashSkill } from '../../../../../app/src/lib/slash'
import { IconBolt, IconBranch, IconBrowser, IconCron, IconGoal, IconLearn, IconPlan, IconResearch, IconReview } from './icons'

export interface ExampleTask {
  /** Bare command name (or skill name without the leading slash). */
  name: string
  /** What a click drops into the chat composer. */
  draft: string
  title: string
  blurb: string
  Icon: ComponentType<{ size?: number }>
}

/** Curated candidates, best first. Names must exist in the live catalog
 * (command, or skill under its "/name" key) to render. */
const CURATED: ExampleTask[] = [
  {
    name: 'research',
    draft: '/research ',
    title: 'Deep research',
    blurb: 'Investigate a topic and get a sourced write-up.',
    Icon: IconResearch,
  },
  {
    name: 'plan',
    draft: '/plan ',
    title: 'Plan before code',
    blurb: 'Write an implementation plan without executing anything.',
    Icon: IconPlan,
  },
  {
    name: 'review',
    draft: '/review ',
    title: 'Review my work',
    blurb: 'An independent subagent reviews the latest changes.',
    Icon: IconReview,
  },
  {
    name: 'goal',
    draft: '/goal ',
    title: 'Set a standing goal',
    blurb: 'Moch keeps working toward it across turns.',
    Icon: IconGoal,
  },
  {
    name: 'cron',
    draft: '/cron add ',
    title: 'Schedule a task',
    blurb: 'Set up a job that runs on a schedule, no babysitting.',
    Icon: IconCron,
  },
  {
    name: 'learn',
    draft: '/learn ',
    title: 'Teach a new skill',
    blurb: 'Turn anything you describe into a reusable skill.',
    Icon: IconLearn,
  },
  {
    name: 'browser',
    draft: '/browser ',
    title: 'Use the browser',
    blurb: 'Point the agent at your live Chromium via CDP.',
    Icon: IconBrowser,
  },
  {
    name: 'worktree',
    draft: '/worktree ',
    title: 'Spin up a worktree',
    blurb: 'Isolate risky work in its own git worktree.',
    Icon: IconBranch,
  },
]

/** Session-meta and TUI-only commands — real registry entries, but no one
 * wants them as an example card. */
const META: Record<string, true> = {
  help: true, commands: true, start: true, new: true, clear: true, redraw: true,
  history: true, save: true, retry: true, undo: true, topic: true, title: true,
  prompt: true, stop: true, pause: true, approve: true, deny: true, status: true,
  context: true, egress: true, model: true, voice: true, paste: true, image: true,
  subscription: true, journey: true, pet: true, export: true, import: true,
  snapshot: true, reload: true, 'reload-mcp': true, 'reload-skills': true,
  config: true, compress: true, handoff: true,
}

export function pickExampleTasks(
  catalog: Record<string, CatalogCommand>,
  skills: Record<string, SlashSkill>,
  descriptions: Record<string, string>,
): ExampleTask[] {
  const picked: ExampleTask[] = []
  const seen = new Set<string>()
  for (const t of CURATED) {
    if (picked.length >= 6) break
    if (catalog[t.name] || skills[`/${t.name}`]) {
      picked.push(t)
      seen.add(t.name)
    }
  }
  if (picked.length < 6) {
    const rest = Object.keys(descriptions)
      .filter((n) => !seen.has(n) && !META[n] && !n.startsWith('/'))
      .sort()
    for (const name of rest) {
      if (picked.length >= 6) break
      if (!catalog[name] && !skills[`/${name}`]) continue
      picked.push({
        name,
        draft: `/${name} `,
        title: name.charAt(0).toUpperCase() + name.slice(1),
        blurb: descriptions[name] || `Run /${name} in a new chat.`,
        Icon: IconBolt,
      })
    }
  }
  return picked
}
