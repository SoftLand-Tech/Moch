/**
 * Skills — installed reusable procedures. Two list RPCs exist and disagree:
 * `moch.skills.list` → {skills: [{name, description, path}]} (path RELATIVE to
 * <hermes home>/skills), while `skills.manage {action:'list'}` may return rows
 * OR a category→names map. Both are probed and merged; a wrong shape never
 * throws past this module's callers (only a total failure does).
 */
import { rpc } from './gateway'

export interface Skill {
  name: string
  description: string
  path: string | null
}

type Rec = Record<string, unknown>

const asRec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v
  return null
}

/** Strip the last path segment — handles both separators, keeps drive roots. */
export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

const isAbsolute = (p: string): boolean =>
  p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)

function normalizeSkill(raw: unknown): Skill | null {
  const r = asRec(raw)
  const name = str(r.name) ?? str(r.id)
  if (!name) return null
  return {
    name,
    description: str(r.description) ?? '',
    path: str(r.path) ?? str(r.dir) ?? str(r.location),
  }
}

function rowsFrom(res: unknown): { rows: unknown[]; map: Rec | null } {
  const r = asRec(res)
  if (Array.isArray(r.skills)) return { rows: r.skills, map: null }
  if (Array.isArray(r.items)) return { rows: r.items, map: null }
  if (Array.isArray(res)) return { rows: res as unknown[], map: null }
  if (r.skills !== null && typeof r.skills === 'object') return { rows: [], map: r.skills as Rec }
  return { rows: [], map: null }
}

function check(res: unknown): unknown {
  const r = asRec(res)
  const err = str(r.error)
  if (err) throw new Error(err)
  return res
}

async function viaMoch(): Promise<Skill[]> {
  const res = check(await rpc<unknown>('moch.skills.list', {}, 12000))
  const { rows } = rowsFrom(res)
  return rows.map(normalizeSkill).filter((s): s is Skill => s !== null)
}

async function viaManage(): Promise<Skill[]> {
  const res = check(await rpc<unknown>('skills.manage', { action: 'list' }, 12000))
  const { rows, map } = rowsFrom(res)
  const out = rows.map(normalizeSkill).filter((s): s is Skill => s !== null)
  if (map) {
    // category → [names] shape: flatten, category as the description hint.
    for (const [cat, names] of Object.entries(map)) {
      if (!Array.isArray(names)) continue
      for (const n of names) {
        if (typeof n === 'string' && n) out.push({ name: n, description: `category: ${cat}`, path: null })
      }
    }
  }
  return out
}

/** Union of both sources, deduped by name. Throws only when BOTH fail. */
export async function listSkills(): Promise<Skill[]> {
  const merged = new Map<string, Skill>()
  let lastError: unknown = null
  let anyOk = false
  for (const attempt of [viaMoch, viaManage]) {
    try {
      for (const s of await attempt()) {
        anyOk = true
        // Prefer the richer row (has a path or description).
        const prev = merged.get(s.name)
        if (!prev || ((!prev.path || !prev.description) && (s.path || s.description))) merged.set(s.name, s)
      }
    } catch (e) {
      lastError = e
    }
  }
  if (!anyOk && lastError !== null) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Best-effort absolute directory of a skill folder, for revealPath():
 * absolute paths win (dirname'd when they point at SKILL.md itself), relative
 * ones resolve under <home>/skills (this gateway's moch.skills.list contract),
 * falling back to <workspace>/skills.
 */
export function resolveSkillDir(skill: Skill, home: string | null, workspace: string | null): string | null {
  const p = skill.path?.trim()
  if (p && isAbsolute(p)) {
    const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
    return base.toLowerCase() === 'skill.md' ? dirname(p) : p
  }
  const base = home ?? workspace
  if (!base) return null
  const tail = p ? p.replace(/^[/\\]+/, '') : skill.name
  return `${base.replace(/[/\\]+$/, '')}/skills/${tail}`
}
