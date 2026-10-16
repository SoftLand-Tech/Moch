/**
 * Media attachments — the desktop twin of the phone's mediaSend.ts:
 * images/files picked in the composer ride `image.attach` / `file.attach`
 * on the session, and the text is sent after they land.
 */

import { rpc } from './gateway'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_BYTES = 8 * 1024 * 1024

async function toBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Attach files to a live session. Images go through `image.attach`,
 * everything else through `file.attach`. Returns true when all files
 * attached (the caller may then send the prompt).
 */
export async function attachFiles(sessionId: string, files: File[]): Promise<boolean> {
  let ok = true
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      console.warn('[media] too large, skipping', file.name)
      ok = false
      continue
    }
    try {
      const data = await toBase64(file)
      const name = file.name || 'attachment'
      if (IMAGE_TYPES.includes(file.type)) {
        await rpc('image.attach', {
          session_id: sessionId,
          data,
          mime: file.type,
          name,
        }, 60000)
      } else {
        await rpc('file.attach', {
          session_id: sessionId,
          data,
          mime: file.type || 'application/octet-stream',
          name,
        }, 60000)
      }
    } catch (err) {
      console.warn('[media] attach failed', file.name, err)
      ok = false
    }
  }
  return ok
}
