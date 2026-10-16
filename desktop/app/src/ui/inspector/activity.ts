/** Pure derivations for the inspector's live-run panel. Everything here
 * takes engine shapes (ToolItem / TodoItem / McpRuntime) and returns view
 * data — no atoms, no React, no side effects, so the shell can reuse the
 * same numbers the panel renders. */
import type { ToolItem, TodoItem } from '../../../../../app/src/lib/chat'
import type { McpRuntime } from '../../../../../app/src/lib/mcpState'

export interface RunProgress {
  done: number
  total: number
  /** 0–100 rounded; 0 when the run has no checklist. */
  pct: number
}

/** Checklist progress: done items over total. */
export function progressOf(todos: TodoItem[]): RunProgress {
  const total = todos.length
  const done = todos.filter((t) => t.done).length
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
}

export type ToolKind = 'shell' | 'file' | 'search' | 'web' | 'other'

/** Coarse kind for a row icon — substring match on the engine tool name. */
export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n === 'bash' || n.includes('shell') || n.includes('exec') || n.includes('command')) return 'shell'
  if (n.includes('write') || n.includes('edit') || n.includes('patch')) return 'file'
  if (n.includes('grep') || n.includes('glob') || n.includes('find') || n.includes('search')) return 'search'
  if (n.includes('web') || n.includes('fetch') || n.includes('browser')) return 'web'
  return 'other'
}

export interface ActivityRow {
  key: string
  name: string
  kind: ToolKind
  detail?: string
  status: ToolItem['status']
  durationS?: number
}

/** The run's tool log as feed rows, newest first. */
export function runActivity(tools: ToolItem[]): ActivityRow[] {
  return [...tools].reverse().map((t) => ({
    key: t.id || `${t.name}:${t.preview ?? ''}`,
    name: t.name,
    kind: toolKind(t.name),
    detail: t.preview,
    status: t.status,
    durationS: t.durationS,
  }))
}

export interface ToolCount {
  name: string
  count: number
  kind: ToolKind
}

/** Per-tool tally in first-seen order, e.g. bash ×2 · read ×4. */
export function toolCounts(tools: ToolItem[]): ToolCount[] {
  const order: ToolCount[] = []
  const byName = new Map<string, ToolCount>()
  for (const t of tools) {
    const hit = byName.get(t.name)
    if (hit) hit.count += 1
    else {
      const row: ToolCount = { name: t.name, count: 1, kind: toolKind(t.name) }
      byName.set(t.name, row)
      order.push(row)
    }
  }
  return order
}

export interface FileRow {
  key: string
  path: string
  tool: string
  status: ToolItem['status']
}

/** Paths the run's file tools touched, newest first, one row per path
 *  (the newest entry wins). The engine carries the path in the tool
 *  preview's first line. */
export function fileRows(tools: ToolItem[]): FileRow[] {
  const out: FileRow[] = []
  const seen = new Set<string>()
  for (const t of [...tools].reverse()) {
    const n = t.name.toLowerCase()
    const fileTool = n.includes('write') || n.includes('edit') || n === 'patch' || n.startsWith('apply_patch')
    if (!fileTool) continue
    const path = previewPath(t.preview)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ key: `${t.id}:${path}`, path, tool: t.name, status: t.status })
  }
  return out
}

/** First line of a tool preview, minus quotes and a `path:` label. */
function previewPath(preview?: string): string | undefined {
  if (!preview) return undefined
  const line = preview.split('\n', 1)[0]?.trim() ?? ''
  const bare = line
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^path:\s*/i, '')
    .trim()
  return bare.length > 0 ? bare : undefined
}

/** Relative wall-clock label ("just now", "4m ago") for a ms timestamp. */
export function relative(ms: number, now: number = Date.now()): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** ok = done/connected, work = running, warn = connecting, err = failed,
 *  off = idle/neutral. */
export type DotTone = 'ok' | 'work' | 'warn' | 'err' | 'off'

/** Status dot tone for one MCP server tile, from cached runtime state. */
export function mcpDot(rt?: McpRuntime): DotTone {
  const s = rt?.status
  if (rt?.connected || s === 'connected') return 'ok'
  if (s === 'connecting') return 'warn'
  if (s === 'failed') return 'err'
  return 'off'
}
