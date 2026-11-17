/**
 * Pure project → cwd resolution (UI-2).
 *
 * The gateway's `session.create` takes a `cwd`, NOT a project id — a chat
 * belongs to a project by the folder it runs in (`projects.tree` nodes carry
 * `path`; `projects.for_cwd` reverses it). These helpers are deliberately free
 * of react-native/expo imports so the plain-node suites can exercise the
 * matching rules without loading the app's module graph.
 */

/** The subset of a project row this module needs. */
export interface ProjectPathRow {
  id: string
  path?: string | null
  isNoProject?: boolean
}

/** Normalize a folder path for comparison (slashes, trailing slash). */
export function normalizeProjectPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  let p = raw.trim().replace(/\\/g, '/')
  if (!p) return ''
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/**
 * The cwd a new chat should open in: the selected project's primary folder.
 * `null`/unknown selection = the default (Personal) bucket, whose honest cwd
 * is the runtime default — so this returns undefined and the caller falls
 * back (the embedded workspace, or the gateway's own default on a remote box).
 *
 * A selected project with no folder ALSO returns undefined: creating in an
 * arbitrary directory would silently file the chat under the wrong project.
 * Callers surface that as a project error instead of guessing.
 */
export function pickProjectCwd(
  rows: readonly ProjectPathRow[],
  activeId: string | null,
): string | undefined {
  if (!activeId) return undefined
  const row = rows.find((r) => r.id === activeId)
  if (!row || row.isNoProject) return undefined
  const path = normalizeProjectPath(row.path)
  return path || undefined
}

/**
 * Reverse lookup: which project owns a cwd. Longest folder prefix wins, on a
 * whole path segment (`/work/app` never claims `/work/apple`).
 */
export function projectIdForCwd(
  rows: readonly ProjectPathRow[],
  cwd: string | null | undefined,
): string | undefined {
  const path = normalizeProjectPath(cwd)
  if (!path) return undefined
  let best: string | undefined
  let bestLen = -1
  for (const row of rows) {
    if (row.isNoProject) continue
    const base = normalizeProjectPath(row.path)
    if (!base) continue
    if (path !== base && !path.startsWith(base === '/' ? '/' : `${base}/`)) continue
    if (base.length > bestLen) {
      best = row.id
      bestLen = base.length
    }
  }
  return best
}
