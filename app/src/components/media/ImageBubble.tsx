import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { imageFallbackDataUrl, imageSource, isMediaRootPath, probeDownloadError } from '../../lib/mediaCache'
import { fitWithin, formatBytes, isDataUrlPath, shouldAutoDownload } from '../../lib/media'
import { MediaViewerModal } from './MediaViewerModal'

/**
 * ChatGPT-style rounded image bubble: aspect-fit inside a ≤220 px box, radius
 * 16, elevated placeholder, tap → fullscreen viewer. The box is a SQUARE
 * until expo-image's onLoad reports the real pixel dims (its own disk cache
 * owns the bytes — headers + cacheKey on /api/files/download), then the
 * bubble snaps to the image's aspect ratio; `cover` inside a ratio-matched
 * box is an exact fill, so nothing is cropped.
 *
 * Nothing moves on a 3-8 kB/s link until the user asks: only images KNOWN to
 * be ≤ 512 kB auto-fetch — unknown-size gateway images (every receive-side
 * segment) render a tap-to-fetch tile. Inline data: URLs and the send-side
 * local copy render without any fetch. On a gateway error the /api/media
 * data-URL fallback takes over — but only for paths that route can serve
 * (anything else, like a relay-uploads send, would only ever 403 there and
 * mask the real cause); the primary download's own status is probed and
 * mapped instead.
 */
export function ImageBubble({ seg, maxWidth = 220 }: { seg: ChatSegment; maxWidth?: number }) {
  const s = useStyles(makeS)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [fallbackUri, setFallbackUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fetched, setFetched] = useState(false)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  // The send-side local copy is trusted only until it fails to load: its
  // contract is send-side-only, and after a restart the cache file is
  // usually evicted — dropping it re-renders from the durable gateway path.
  const [localUri, setLocalUri] = useState<string | null>(seg.localUri ?? null)

  const inline = isDataUrlPath(seg.path)
  const primary = localUri
    ? { uri: localUri }
    : fallbackUri
      ? { uri: fallbackUri }
      : inline
        ? { uri: seg.path! }
        : seg.path
          ? imageSource(seg.path)
          : null
  // Tap-to-fetch gate: only a KNOWN-small gateway image auto-fetches.
  // Unknown size (receive-side segments carry none today) waits for a tap.
  const needsFetchApproval = !localUri && !fallbackUri && !inline && !fetched && !shouldAutoDownload(seg.size)

  const onError = () => {
    if (localUri) {
      setLocalUri(null)
      return
    }
    if (!seg.path || fallbackUri || inline) {
      setError('Image could not be loaded')
      return
    }
    // /api/media only serves images under the Hermes home's media roots;
    // anything else gets the primary download's own status mapped.
    const load = async () => {
      if (isMediaRootPath(seg.path!)) {
        try {
          setFallbackUri(await imageFallbackDataUrl(seg.path!))
          return
        } catch {
          /* fall through to the primary probe */
        }
      }
      setError((await probeDownloadError(seg.path!)) ?? 'Image could not be loaded')
    }
    void load()
  }

  if (error) {
    return (
      <View style={s.errorTile}>
        <Icon name="image-outline" size={20} color={C.textFaint} />
        <Text style={s.errorText}>{error}</Text>
      </View>
    )
  }

  if (!primary || needsFetchApproval) {
    return (
      <Pressable
        onPress={() => setFetched(true)}
        style={({ pressed }) => [s.errorTile, pressed && s.pressed, { width: maxWidth }]}
        accessibilityLabel={`Load image${seg.name ? ` ${seg.name}` : ''}${seg.size ? ` (${formatBytes(seg.size)})` : ''}`}
      >
        <Icon name="image-outline" size={20} color={C.textFaint} />
        <Text style={s.errorText}>{seg.size ? `${formatBytes(seg.size)} — tap to load` : 'Tap to load'}</Text>
      </Pressable>
    )
  }

  // Aspect-fit box: the real ratio once known, square until then (the
  // elevated background IS the placeholder while the bytes stream in).
  const box = fitWithin(maxWidth, dims?.width, dims?.height) ?? { width: maxWidth, height: maxWidth }

  return (
    <>
      <Pressable
        onPress={() => setViewerOpen(true)}
        style={({ pressed }) => [s.wrap, pressed && s.pressed, box]}
        accessibilityLabel={`Image${seg.name ? `: ${seg.name}` : ''}`}
      >
        <Image
          source={primary}
          style={s.image}
          contentFit="cover"
          cachePolicy="disk"
          recyclingKey={localUri ?? seg.path}
          onLoad={(e) => {
            // v57 ImageLoadEventData: { source: { width, height, … } }.
            const src = e.source
            if (src?.width && src?.height) setDims({ width: src.width, height: src.height })
          }}
          transition={150}
        />
        {seg.size && seg.size > 0 ? <Text style={s.sizeTag}>{formatBytes(seg.size)}</Text> : null}
      </Pressable>
      <MediaViewerModal seg={seg} visible={viewerOpen} onClose={() => setViewerOpen(false)} />
    </>
  )
}

const makeS = () => StyleSheet.create({
  wrap: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: C.bgElev,
  },
  pressed: { opacity: 0.85 },
  image: { width: '100%', height: '100%' },
  sizeTag: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    color: C.text,
    fontSize: 10.5,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  errorTile: {
    minHeight: 76,
    borderRadius: 16,
    backgroundColor: C.bgElev,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: 14,
  },
  errorText: { color: C.textFaint, fontSize: 12 },
})
