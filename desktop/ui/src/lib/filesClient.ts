/**
 * filesClient — read-only file access for the context panel's Files tab.
 *
 * Listing goes through the shell's `fs_list` (Tauri) exactly like the old
 * workbench did; previews read through the media-file surface the shell
 * already exposes for chat attachments (`read_media_file` in Tauri, the
 * mirrored `/dev-bridge/read-file` in the browser preview) — same payload
 * shape from both, so the pane never knows which track it is on.
 *
 * Only text previews are promised: `previewKind` classifies by name, and
 * non-text files get an explicit `unsupported` verdict instead of a silent
 * no-op. Nothing here writes, moves, or deletes.
 */
import { invoke, inTauri } from './tauri'

export interface FsEntry {
  name: string
  path: string
  dir: boolean
  size: number
  modified: number
}

/** What the pane can do with a clicked file. */
export type PreviewKind = 'text' | 'unsupported'

/** Hard cap on rendered preview text; larger files read but truncate. */
export const PREVIEW_TEXT_LIMIT = 256 * 1024

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'properties', 'sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'rs', 'go',
  'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'm', 'mm', 'sql', 'csv',
  'tsv', 'env', 'lock', 'log', 'patch', 'diff', 'teal', 'lua',
])

/** Extensionless files that are still text by convention. */
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'notice', 'authors', 'contributors'])

export function previewKind(name: string): PreviewKind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot > 0) return TEXT_EXTENSIONS.has(lower.slice(dot + 1)) ? 'text' : 'unsupported'
  return TEXT_BASENAMES.has(lower) ? 'text' : 'unsupported'
}

export interface FilePreview {
  path: string
  size: number
  /** Decoded text (never null for `text` kind; empty for others). */
  text: string
  /** Server-side refusal: the file exceeds the shell's inline limit. */
  tooLarge: boolean
  /** The decoded text was cut at PREVIEW_TEXT_LIMIT. */
  truncated: boolean
}

/** Wire shape shared by `read_media_file` and `/dev-bridge/read-file`. */
interface MediaPayload {
  path: string
  mime: string
  size: number
  dataB64?: string
  data_b64?: string
  tooLarge?: boolean
  too_large?: boolean
}

export function listDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('fs_list', { path })
}

export async function readTextFile(path: string): Promise<FilePreview> {
  const raw = inTauri
    ? await invoke<MediaPayload>('read_media_file', { path })
    : await fetchJson<MediaPayload>(`/dev-bridge/read-file?path=${encodeURIComponent(path)}`)
  const tooLarge = raw.tooLarge ?? raw.too_large ?? false
  const b64 = raw.dataB64 ?? raw.data_b64 ?? ''
  const bytes = decodeBase64(b64)
  const truncated = !tooLarge && bytes.length > PREVIEW_TEXT_LIMIT
  return {
    path,
    size: raw.size,
    text: tooLarge ? '' : new TextDecoder('utf-8').decode(truncated ? bytes.subarray(0, PREVIEW_TEXT_LIMIT) : bytes),
    tooLarge,
    truncated,
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`read-file -> HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
