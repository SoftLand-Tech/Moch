/**
 * Workspace identity + projects (UI-1).
 *
 * Identity is the drawer's Sessions | Bots switch: a UI mode over the SAME
 * gateway, persisted locally so a kill/reopen lands on the surface the user
 * left. Bots are profiles, not a second chat store.
 *
 * Projects are REAL gateway state (`projects.*`, the same tree the desktop
 * client reads). `active_id == null` is the default bucket — the node the
 * server calls "Home" and the UI calls Personal. A synthetic id is never
 * invented for it (the gateway treats an unknown id as a project lookup
 * failure, and `projects.set_active { id: null }` is the only honest way to
 * say "default").
 *
 * `refreshProjects` is offline-safe by contract: a failed fetch keeps the last
 * tree, because the drawer must stay usable on a dead link. The error atom is
 * only populated when there is nothing cached to show (a stale list plus a
 * red banner is noise).
 */
import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from './log'
import { rpc } from './gateway'

// ── Identity ────────────────────────────────────────────────────────────────

export type Identity = 'sessions' | 'bots'

const IDENTITY_KEY = 'hermes.workspace.identity.v1'

export const identityAtom = atom<Identity>('sessions')

let identityLoaded = false

/** Restore the persisted identity once at startup (idempotent, cheap). */
export async function loadIdentity(): Promise<void> {
  if (identityLoaded) return
  identityLoaded = true
  try {
    const saved = await AsyncStorage.getItem(IDENTITY_KEY)
    if (saved === 'sessions' || saved === 'bots') identityAtom.set(saved)
  } catch {
    // Storage failure keeps the default surface; harmless.
  }
}

/** Switch surface and persist it. */
export async function setIdentity(i: Identity): Promise<void> {
  identityAtom.set(i)
  try {
    await AsyncStorage.setItem(IDENTITY_KEY, i)
  } catch {
    // Apply anyway for this run.
  }
}

// ── Projects ────────────────────────────────────────────────────────────────

/** One drawer project row — the flat shape the sidebar renders. */
export interface ProjectRow {
  id: string
  name: string
  color?: string | null
  icon?: string | null
  isNoProject?: boolean
  sessionCount: number
  primaryPath?: string | null
}

/** `projects.tree` node (only the fields this client reads). */
interface ProjectTreeNode {
  id?: string
  label?: string
  path?: string | null
  color?: string | null
  icon?: string | null
  isAuto?: boolean
  isNoProject?: boolean
  sessionCount?: number
  lastActive?: number
  repos?: Array<{ path?: string | null }>
}

interface ProjectsTreeResult {
  projects?: ProjectTreeNode[]
  active_id?: string | null
}

export const projectsAtom = atom<ProjectRow[]>([])
/** `null` = the default/Personal bucket — not an id. */
export const activeProjectIdAtom = atom<string | null>(null)
/** Non-null only when a fetch failed and nothing is cached to fall back to. */
export const projectsErrorAtom = atom<string | null>(null)
export const projectsLoadingAtom = atom(false)

function toProjectRow(n: ProjectTreeNode): ProjectRow | null {
  const id = typeof n.id === 'string' ? n.id.trim() : ''
  if (!id) return null
  const label = typeof n.label === 'string' ? n.label.trim() : ''
  const repoPath = Array.isArray(n.repos) ? n.repos.find((r) => !!r?.path)?.path : null
  return {
    id,
    name: label || id,
    color: n.color ?? null,
    icon: n.icon ?? null,
    isNoProject: !!n.isNoProject,
    sessionCount: typeof n.sessionCount === 'number' && Number.isFinite(n.sessionCount) ? n.sessionCount : 0,
    primaryPath: n.path ?? repoPath ?? null,
  }
}

/**
 * The tree's `active_id` occasionally names the Home bucket explicitly (some
 * flows set_active its synthetic id) — normalized to `null`, which is the only
 * spelling `projects.set_active` and this client agree on. An id the tree no
 * longer carries (archived elsewhere) is also `null`: keeping it would select
 * nothing and filter every row away.
 */
function normalizeActiveId(raw: string | null | undefined, rows: ProjectRow[]): string | null {
  const id = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  if (!id) return null
  if (rows.some((r) => r.id === id && r.isNoProject)) return null
  if (rows.length && !rows.some((r) => r.id === id)) return null
  return id
}

let inflight: Promise<void> | null = null

/**
 * Re-read the project tree. Never throws: offline keeps the last rows. Callers
 * fire-and-forget (`void refreshProjects()`) on drawer open / reconnect.
 */
export function refreshProjects(): Promise<void> {
  if (inflight) return inflight
  projectsLoadingAtom.set(true)
  inflight = (async () => {
    try {
      const res = await rpc<ProjectsTreeResult>('projects.tree', {})
      const nodes = Array.isArray(res?.projects) ? res.projects : []
      const rows = nodes.map(toProjectRow).filter((r): r is ProjectRow => r != null)
      projectsAtom.set(rows)
      activeProjectIdAtom.set(normalizeActiveId(res?.active_id, rows))
      projectsErrorAtom.set(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load projects'
      log('info', 'projects', `projects.tree failed: ${msg}`)
      // Offline-safe: the last tree stays. Only complain when the drawer would
      // otherwise render an empty section with no explanation.
      if (!projectsAtom.get().length) projectsErrorAtom.set(msg)
    } finally {
      projectsLoadingAtom.set(false)
      inflight = null
    }
  })()
  return inflight
}

/**
 * Select a project (`null` = Personal). Optimistic so the drawer highlight
 * follows the tap, with a rollback if the gateway refuses — a selection that
 * silently snapped back later would look like a lost tap.
 */
export async function setActiveProject(id: string | null): Promise<void> {
  const prev = activeProjectIdAtom.get()
  if (prev === id) return
  activeProjectIdAtom.set(id)
  try {
    await rpc('projects.set_active', { id })
  } catch (err) {
    activeProjectIdAtom.set(prev)
    const msg = err instanceof Error ? err.message : 'Could not select the project'
    log('warn', 'projects', `projects.set_active failed: ${msg}`)
  }
}

/** The effective project for a new chat: selected, else null (= Personal). */
export function newChatProjectId(): string | null {
  return activeProjectIdAtom.get()
}

/** Longest folder prefix wins; no path metadata means "no project". */
export function projectForCwd(cwd: string): ProjectRow | undefined {
  const path = normalizePath(cwd)
  if (!path) return undefined
  let best: ProjectRow | undefined
  let bestLen = -1
  for (const p of projectsAtom.get()) {
    if (p.isNoProject) continue
    const base = normalizePath(p.primaryPath)
    if (!base) continue
    // Prefix match on a whole path segment, so /work/app never claims /work/apple.
    if (path !== base && !path.startsWith(base === '/' ? '/' : `${base}/`)) continue
    if (base.length > bestLen) {
      best = p
      bestLen = base.length
    }
  }
  return best
}

function normalizePath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  let p = raw.trim().replace(/\\/g, '/')
  if (!p) return ''
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

// ── Project mutations (the drawer's project sheet) ──────────────────────────
// Each throws on failure so the dialog can render the reason (Alert.alert is a
// web no-op) and refreshes the tree on success so the counts stay honest.

export async function createProject(name: string, folder?: string): Promise<void> {
  const clean = name.trim()
  if (!clean) throw new Error('Project name required')
  const path = folder?.trim()
  await rpc('projects.create', {
    name: clean,
    ...(path ? { folders: [path] } : {}),
    use: true,
  })
  await refreshProjects()
}

export async function renameProject(id: string, name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) throw new Error('Project name required')
  await rpc('projects.update', { id, name: clean })
  await refreshProjects()
}

export async function archiveProject(id: string, restore = false): Promise<void> {
  // An archived project must not stay selected — the server drops it from the
  // tree, and a dangling active id would filter every chat row away.
  if (activeProjectIdAtom.get() === id) await setActiveProject(null)
  await rpc('projects.archive', restore ? { id, restore: true } : { id })
  await refreshProjects()
}

export async function deleteProject(id: string): Promise<void> {
  if (activeProjectIdAtom.get() === id) await setActiveProject(null)
  await rpc('projects.delete', { id })
  await refreshProjects()
}

/**
 * Ready-made `Promise<errorMessage | null>` wrappers for the drawer's project
 * sheet — the same shape as the chat actions in ScreenShell, because
 * `Alert.alert` is a silent no-op on web: the dialog renders the message.
 */
export const projectActions = {
  create: async (name: string, folder?: string): Promise<string | null> => {
    try {
      await createProject(name, folder)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not create the project'
    }
  },
  rename: async (id: string, name: string): Promise<string | null> => {
    try {
      await renameProject(id, name)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not rename the project'
    }
  },
  archive: async (id: string): Promise<string | null> => {
    try {
      await archiveProject(id)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not archive the project'
    }
  },
  remove: async (id: string): Promise<string | null> => {
    try {
      await deleteProject(id)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not delete the project'
    }
  },
}
