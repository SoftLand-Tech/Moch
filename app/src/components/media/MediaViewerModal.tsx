import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, Dimensions, type LayoutChangeEvent } from 'react-native'
import { Image } from 'expo-image'
import * as Sharing from 'expo-sharing'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { imageSource } from '../../lib/mediaCache'
import { isDataUrlPath } from '../../lib/media'
import { mediaCachePathFor } from './share'

/**
 * Fullscreen image viewer: RN Modal (no extra deps), solid brand scrim,
 * pinch-zoom via the ScrollView's zoom scales (gesture-handler deliberately
 * not used), name + share header. Share prefers expo-image's own disk cache
 * (the bytes are already on disk) before downloading.
 */
export function MediaViewerModal({
  seg,
  visible,
  onClose,
}: {
  seg: ChatSegment
  visible: boolean
  onClose: () => void
}) {
  const s = useStyles(makeS)
  const [sharing, setSharing] = useState(false)
  // A % height inside a ScrollView contentContainer measures as 0 on Android
  // (the container's size depends on its content), which laid the image out
  // invisible — the "black screen" viewer. Explicit pixels instead: the
  // window is right on the first frame, onLayout refines on rotate.
  const [vp, setVp] = useState(() => {
    const d = Dimensions.get('window')
    return { width: d.width, height: d.height }
  })
  const onZoomLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    if (Math.abs(width - vp.width) > 1 || Math.abs(height - vp.height) > 1) setVp({ width, height })
  }
  // Same stale-local healing as the bubble: a send-side uri that fails to
  // load is dropped so the gateway path / inline data URL takes over (the
  // bubble may already have healed its own copy — this state re-seeds from
  // the segment, so it heals independently here).
  const [localUri, setLocalUri] = useState<string | null>(seg.localUri ?? null)
  if (!visible) return null
  // Inline data-URL segments (native-vision history) render straight from
  // the string — no gateway fetch, no cache key.
  const source = localUri
    ? { uri: localUri }
    : isDataUrlPath(seg.path)
      ? { uri: seg.path }
      : seg.path
        ? imageSource(seg.path)
        : null

  const share = async () => {
    if (!seg.path || !source || sharing) return
    setSharing(true)
    try {
      // Skip the (possibly stale) send-side uri — mediaCachePathFor re-derives
      // the durable source.
      const local = localUri ?? (await mediaCachePathFor({ ...seg, localUri: undefined }))
      if (local) await Sharing.shareAsync(local, { mimeType: seg.mime ?? 'image/jpeg' })
    } catch {
      /* the user sees nothing shared — acceptable for the viewer's share */
    } finally {
      setSharing(false)
    }
  }

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={s.scrim}>
        <View style={s.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close viewer">
            <Icon name="close" size={22} color={C.text} />
          </Pressable>
          <Text style={s.name} numberOfLines={1}>
            {seg.name ?? 'Image'}
          </Text>
          <Pressable onPress={() => void share()} hitSlop={10} accessibilityLabel="Share image">
            {sharing ? <Icon name="hourglass-outline" size={20} color={C.textFaint} /> : <Icon name="share-outline" size={20} color={C.text} />}
          </Pressable>
        </View>
        <ScrollView
          style={s.zoom}
          contentContainerStyle={s.zoomContent}
          onLayout={onZoomLayout}
          maximumZoomScale={4}
          minimumZoomScale={1}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        >
          {source ? (
            // Tap the image to dismiss (ChatGPT's tap-out) — single taps only;
            // the scroll view's native pinch/pan keeps winning multi-touch.
            <Pressable onPress={onClose} accessibilityLabel="Close viewer">
              <Image
                source={source}
                style={{ width: vp.width, height: vp.height }}
                contentFit="contain"
                cachePolicy="disk"
                onError={() => {
                  if (localUri) setLocalUri(null)
                }}
              />
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  scrim: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 10,
  },
  name: { flex: 1, color: C.text, fontSize: 14, fontWeight: '600' },
  zoom: { flex: 1 },
  zoomContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
})
