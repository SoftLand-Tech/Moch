/**
 * Media attachments — the desktop twin of the phone's mediaSend.ts:
 * upload to the gateway over REST (`/api/files/upload-stream`), then
 * `image.attach {path}` / `file.attach {path, name}` with the returned
 * server path, BEFORE the prompt goes out. file.attach answers `ref_text`
 * the prompt should reference (returned for callers that want it).
 */

import { gatewayInfo, gwFetch } from './gateway'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_BYTES = 8 * 1024 * 1024

function sanitizeBasename(name: string): string {
  const base = name.split('/').pop() ?? 'file'
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'
}

function randTag(): string {
  return Math.random().toString(36).slice(2, 6)
}

async function uploadToGateway(file: File): Promise<string> {
  const info = gatewayInfo.get()
  if (!info?.home) throw new Error('gateway not connected')
  const root = info.home
  const remotePath = `${root}/relay-uploads/${Date.now()}_${randTag()}-${sanitizeBasename(file.name)}`
  // Multipart through the proxy (gwFetch) — CORS blocks a direct fetch.
  const boundary = `----moch${randTag()}${Date.now()}`
  const name = sanitizeBasename(file.name)
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
  const pathField = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${remotePath}`
  const tail = `\r\n--${boundary}--\r\n`
  const headB = new TextEncoder().encode(head)
  const fileB = new Uint8Array(await file.arrayBuffer())
  const restB = new TextEncoder().encode(pathField + tail)
  const body = new Uint8Array(headB.length + fileB.length + restB.length)
  body.set(headB, 0)
  body.set(fileB, headB.length)
  body.set(restB, headB.length + fileB.length)
  let text: string
  try {
    text = (await gwFetch('/api/files/upload-stream', {
      method: 'POST',
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    })) as string
  } catch (err) {
    if (String(err).includes('HTTP 404')) {
      // Older gateway: JSON data-URL endpoint.
      return uploadViaJson(file, remotePath)
    }
    throw err
  }
  const parsed = JSON.parse(text || '{}') as { path?: string }
  if (!parsed.path) throw new Error('upload returned no path')
  return parsed.path
}

async function uploadViaJson(file: File, remotePath: string): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  const text = (await gwFetch('/api/files/upload', {
    method: 'POST',
    body: JSON.stringify({ path: remotePath, data_url: `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}` }),
    contentType: 'application/json',
  })) as string
  const body = JSON.parse(text || '{}') as { path?: string }
  if (!body.path) throw new Error('upload returned no path')
  return body.path
}

export interface AttachResult {
  ok: boolean
  /** ref_text values from file.attach, in order (mention them in the prompt). */
  refTexts: string[]
  /** Gateway paths of attached images (cleanup on failure). */
  imagePaths: string[]
}

/**
 * Attach files to a live session, then the caller sends the prompt.
 * Uploads land under <hermes home>/relay-uploads; image.attach/file.attach
 * bind them to the session.
 */
export async function attachFiles(sessionId: string, files: File[]): Promise<boolean> {
  const { rpc } = await import('./gateway')
  const refTexts: string[] = []
  const imagePaths: string[] = []
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      console.warn('[media] too large, skipping', file.name)
      continue
    }
    try {
      const path = await uploadToGateway(file)
      if (IMAGE_TYPES.includes(file.type)) {
        await rpc('image.attach', { session_id: sessionId, path }, 60000)
        imagePaths.push(path)
      } else {
        const res = await rpc<{ ref_text?: string }>('file.attach', {
          session_id: sessionId,
          path,
          name: sanitizeBasename(file.name),
        }, 60000)
        if (res?.ref_text) refTexts.push(res.ref_text)
      }
    } catch (err) {
      console.warn('[media] attach failed', file.name, err)
      // Best-effort cleanup of already-attached images on failure.
      for (const p of imagePaths) {
        void rpc('image.detach', { session_id: sessionId, path: p }).catch(() => undefined)
      }
      return false
    }
  }
  return true
}
