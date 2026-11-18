import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'
import { ATTACH_RATE_KBPS, estSecondsFor, formatBytes, formatDuration, mediaKindForPath } from '../../lib/media'
import type { PendingAttachment } from '../../lib/mediaSend'
import { useDir, useT } from '../../lib/strings'

/**
 * Composer preview chip: thumbnail, name+size, remove ×, and the send state
 * machine pick → preparing → uploading(elapsed/est) → ready → failed(retry).
 * The elapsed counter is the ONLY timer here; the estimate is pure math
 * (estSecondsFor at the 3 kB/s worst-case rate — RN fetch has no upload
 * progress).
 */
export function AttachmentChip({
  att,
  onRemove,
  onRetry,
}: {
  att: PendingAttachment
  onRemove: () => void
  onRetry?: () => void
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  const t = useT()
  const active = att.state === 'preparing' || att.state === 'uploading'
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!active) return
    setElapsed(0)
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [active, att.id])

  const isImage = att.kind === 'image' || mediaKindForPath(att.name) === 'image'
  const estS = att.size ? estSecondsFor(att.size, ATTACH_RATE_KBPS) : null
  const stateLabel =
    att.state === 'preparing'
      ? t('chat.attachChip.preparing')
      : att.state === 'uploading'
        ? `${formatDuration(elapsed)}${estS != null && Number.isFinite(estS) ? ` / ~${formatDuration(estS)}` : ''} · ${formatBytes(att.size ?? 0)}`
        : att.state === 'ready'
          ? t('chat.attachChip.sent')
          : att.state === 'failed'
            ? (att.error ?? t('chat.attachChip.failed'))
            : formatBytes(att.size ?? 0)

  return (
    <View style={[s.chip, { flexDirection: dir.row }, att.state === 'failed' && s.chipFailed]}>
      {isImage ? (
        <Image source={{ uri: att.uri }} style={s.thumb} contentFit="cover" transition={100} />
      ) : (
        <View style={s.thumb}>
          <Icon name={att.kind === 'video' ? 'videocam-outline' : att.kind === 'audio' ? 'musical-notes-outline' : 'document-attach-outline'} size={16} color={C.textDim} />
        </View>
      )}
      <View style={s.meta}>
        <Text style={s.name} numberOfLines={1}>{att.name}</Text>
        <Text style={[s.state, att.state === 'failed' && s.stateFailed]} numberOfLines={1}>
          {stateLabel}
        </Text>
      </View>
      {active ? <ActivityIndicator size="small" color={C.accent} /> : null}
      {att.state === 'failed' && onRetry ? (
        <Pressable onPress={onRetry} hitSlop={6} accessibilityLabel={t('chat.attachChip.retryA11y')}>
          <Icon name="refresh" size={14} color={C.accent} />
        </Pressable>
      ) : null}
      <Pressable onPress={onRemove} hitSlop={6} accessibilityLabel={t('chat.attachChip.removeA11y', { name: att.name })}>
        <Icon name="close" size={14} color={C.textDim} />
      </Pressable>
    </View>
  )
}

const makeS = () => StyleSheet.create({
  chip: {
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.bgElev,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 8,
    minWidth: 190,
    maxWidth: 280,
  },
  thumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: C.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  chipFailed: { backgroundColor: C.redSoft, borderColor: C.red },
  meta: { flex: 1 },
  name: { color: C.text, fontSize: 12, fontWeight: '600' },
  state: { color: C.textFaint, fontSize: 10.5, marginTop: 1 },
  stateFailed: { color: C.red },
})
