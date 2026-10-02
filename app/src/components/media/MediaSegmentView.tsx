import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { ImageBubble } from './ImageBubble'
import { VideoBubble } from './VideoBubble'
import { AudioBubble } from './AudioBubble'
import { FileCard } from './FileCard'

/**
 * The one seam MessageBubble renders media through — both roles, all kinds.
 * Kind dispatch + the "gateway can't serve it anymore" error tile; everything
 * visual lives in the per-kind components.
 */
export function MediaSegmentView({ seg }: { seg: ChatSegment }) {
  const s = useStyles(makeS)
  if (seg.state === 'missing' && !seg.localUri) {
    return (
      <View style={s.errorTile}>
        <Icon name="cloud-offline-outline" size={18} color={C.textFaint} />
        <Text style={s.errorText}>{seg.name ? `${seg.name} is no longer on the gateway` : 'No longer on gateway'}</Text>
      </View>
    )
  }
  switch (seg.mediaType) {
    case 'image':
      return <ImageBubble seg={seg} />
    case 'video':
      return <VideoBubble seg={seg} />
    case 'audio':
      return <AudioBubble seg={seg} />
    default:
      // 'file' and unknown extensions — same card, generic icon.
      return <FileCard seg={seg} />
  }
}

const makeS = () => StyleSheet.create({
  errorTile: {
    minHeight: 60,
    borderRadius: 16,
    backgroundColor: C.bgElev,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: 12,
  },
  errorText: { color: C.textFaint, fontSize: 12 },
})
