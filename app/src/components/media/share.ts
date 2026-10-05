import { Image } from 'expo-image'
import { cacheKeyFor, isDataUrlPath } from '../../lib/media'
import { dataUrlToLocalFile, downloadMediaFile } from '../../lib/mediaCache'
import type { ChatSegment } from '../../lib/chat'

/**
 * A local file:// uri for sharing/downloading a segment's bytes:
 * 1. an explicit localUri (optimistic user rows),
 * 2. inline data-URL images, written to a cache file (share targets need
 *    real files, not `data:` strings),
 * 3. expo-image's own disk cache, keyed by the same cacheKey the bubble used
 *    (images — zero extra transfer),
 * 4. the relay-media download (audio / docs / first-share of an image).
 */
export async function mediaCachePathFor(seg: ChatSegment): Promise<string | null> {
  if (seg.localUri) return seg.localUri
  if (isDataUrlPath(seg.path)) return dataUrlToLocalFile(seg.path)
  if (!seg.path) return null
  try {
    const cached = await Image.getCachePathAsync(cacheKeyFor(seg.path))
    if (cached) return cached
  } catch {
    /* fall through to the download */
  }
  return downloadMediaFile(seg.path)
}
