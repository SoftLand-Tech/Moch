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

/** Host and guest spellings for a workspace folder. OpenCode sessions report
 *  `/workspace/test`; the project DB keeps `<home>/.hermes/workspace/test` so
 *  grouping must recognize both without weakening whole-segment matching. */
/** Convert a host workspace folder to the guest spelling used by OpenCode.
 *  Returns undefined when the folder is outside the workspace. */
export function workspaceHostToGuestPath(
  hostPath: string | null | undefined,
  hostWorkspace: string | null | undefined,
): string | undefined {
  const host = normalizeProjectPath(hostPath)
  const root = normalizeProjectPath(hostWorkspace)
  if (!host || !root) return undefined
  if (host === root) return '/workspace'
  if (host.startsWith(root === '/' ? '/' : `${root}/`)) {
    const rel = host.slice(root === '/' ? 1 : root.length + 1)
    return rel ? `/workspace/${rel}` : '/workspace'
  }
  return undefined
}

function projectPathSpellings(raw: string | null | undefined): string[] {
  const path = normalizeProjectPath(raw)
  if (!path) return []
  const out = [path]
  const marker = '/workspace/'
  const idx = path.lastIndexOf(marker)
  if (idx >= 0) {
    const guest = '/workspace/' + path.slice(idx + marker.length)
    if (guest !== path) out.push(guest)
  }
  return out
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
    for (const base of projectPathSpellings(row.path)) {
      if (path !== base && !path.startsWith(base === '/' ? '/' : `${base}/`)) continue
      if (base.length > bestLen) {
        best = row.id
        bestLen = base.length
      }
    }
  }
  return best
}
