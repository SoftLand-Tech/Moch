/**
 * FS client — the Files surface's typed client over the gateway's
 * dashboard REST. Auth and timeouts come from the shared apiFetch
 * (X-Hermes-Session-Token from the connConfig store).
 *
 * Endpoints verified against the live headless gateway (127.0.0.1:9118,
 * 2026-10-16):
 *   GET    /api/files?path=<abs dir>   → { path, parent, entries[{name, path,
 *                                          is_directory, size, mtime, mime_type}] }
 *   GET    /api/files/read?path=<file> → { name, path, size, mime_type,
 *                                          data_url: "data:<mime>;base64,…" }
 *   DELETE /api/files  body {path}     → { ok: true }
 *
 * The gateway's older GET /api/fs/list also exists but returns a bare
 * {entries:[{name,path,isDirectory}]} — no parent, size, or mtime — so
 * listDir speaks /api/files. This module is the wire boundary: snake_case
 * stops here, the UI sees only the domain types below.
 */
import { apiFetch } from '../../../../app/src/lib/http'

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  /** Epoch seconds, as the gateway reports mtime. */
  mtimeSec: number | null
  mime: string | null
}

export interface FsListing {
  path: string
  /** Parent directory, null at the filesystem root. */
  parent: string | null
  entries: FsEntry[]
}

export interface FsFile {
  name: string
  path: string
  size: number | null
  mime: string | null
  /** Gateway-supplied data: URL; decode with dataUrlText for text files. */
  dataUrl: string
}

interface WireEntry {
  name: string
  path: string
  is_directory?: boolean
  size?: number | null
  mtime?: number | null
  mime_type?: string | null
}

interface WireListing {
  path: string
  parent?: string | null
  entries?: WireEntry[]
}

interface WireFile {
  name: string
  path: string
  size?: number | null
  mime_type?: string | null
  data_url: string
}

function toEntry(e: WireEntry): FsEntry {
  return {
    name: e.name,
    path: e.path,
    isDirectory: e.is_directory === true,
    size: e.size ?? null,
    mtimeSec: e.mtime ?? null,
    mime: e.mime_type ?? null,
  }
}

/** List one directory. Throws (apiFetch) on HTTP errors. */
export async function listDir(path: string): Promise<FsListing> {
  const w = await apiFetch<WireListing>(`/api/files?path=${encodeURIComponent(path)}`)
  return { path: w.path, parent: w.parent ?? null, entries: (w.entries ?? []).map(toEntry) }
}

/** Read one file as the gateway's data: URL. Throws on HTTP errors. */
export async function readFile(path: string): Promise<FsFile> {
  const w = await apiFetch<WireFile>(`/api/files/read?path=${encodeURIComponent(path)}`)
  return {
    name: w.name,
    path: w.path,
    size: w.size ?? null,
    mime: w.mime_type ?? null,
    dataUrl: w.data_url,
  }
}

/** Delete one file. The gateway rejects directories here. Throws on HTTP errors. */
export async function removeFile(path: string): Promise<void> {
  await apiFetch('/api/files', { method: 'DELETE', body: { path } })
}

const TEXT_MIME_RE =
  /^text\/|json|xml|yaml|toml|javascript|ecmascript|typescript|python|shell|x-sh|sql|csv|ini|diff|graphql/

const TEXT_EXT: Record<string, true> = {
  bash: true, c: true, cc: true, cfg: true, conf: true, cpp: true, css: true, csv: true,
  diff: true, env: true, go: true, h: true, hpp: true, htm: true, html: true, ini: true,
  java: true, js: true, json: true, jsonl: true, jsx: true, kt: true, lock: true, log: true,
  lua: true, md: true, patch: true, php: true, py: true, rb: true, rs: true, sh: true,
  sql: true, svg: true, toml: true, ts: true, tsx: true, txt: true, xml: true, yaml: true,
  yml: true,
}

/**
 * Can this file render as text in the preview pane? Text by mime, by
 * known extension when the gateway reports no mime, and never past
 * maxBytes — the read endpoint has no range form, so the whole file
 * would cross the wire.
 */
export function isTextFile(file: { mime: string | null; name: string; size: number | null }, maxBytes: number): boolean {
  if (file.size != null && file.size > maxBytes) return false
  if (file.mime) return TEXT_MIME_RE.test(file.mime)
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return TEXT_EXT[ext] === true
}

/** Decode a gateway data: URL into text (base64 → UTF-8). */
export function dataUrlText(dataUrl: string): string {
  const marker = 'base64,'
  const i = dataUrl.indexOf(marker)
  const bin = atob(i >= 0 ? dataUrl.slice(i + marker.length) : dataUrl)
  const bytes = new Uint8Array(bin.length)
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
  return new TextDecoder().decode(bytes)
}
