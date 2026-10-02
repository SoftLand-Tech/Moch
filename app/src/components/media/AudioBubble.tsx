import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { cacheKeyFor, formatBytes, formatDuration } from '../../lib/media'
import { downloadMediaFile } from '../../lib/mediaCache'
import { mediaStateForKey } from '../../lib/mediaState'

/**
 * Voice-note bubble: play/pause with a brand-cyan progress bar and duration.
 * Bytes download into relay-media on first play (progress per cache key);
 * existence IS the cache, so replays are instant. A failed download renders
 * an inline error row whose tap retries the same download.
 */
export function AudioBubble({ seg }: { seg: ChatSegment }) {
  const s = useStyles(makeS)
  // mediaStateForKey always returns a live computed (idle for unknown keys),
  // so an optimistic row without a gateway path yet just subscribes to idle.
  const load = useStore(mediaStateForKey(seg.path ? cacheKeyFor(seg.path) : '_idle_'))
  const [localUri, setLocalUri] = useState<string | null>(seg.localUri ?? null)
  const pendingPlay = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const player = useAudioPlayer(localUri)
  const status = useAudioPlayerStatus(player)

  useEffect(() => {
    if (localUri && pendingPlay.current) {
  const s = useStyles(makeS)
      pendingPlay.current = false
      player.play()
    }
  }, [localUri, player])

  // Leaving the screen mid-download abandons the transfer (downloadMediaFile
  // resets the per-key store to idle on abort).
  useEffect(() => () => abortRef.current?.abort(), [])

  const busyDownloading = load.status === 'loading'
  // Determinate transfer progress from the same store FileCard renders —
  // a frozen disabled bubble is indistinguishable from a stuck one on a
  // 3 kB/s link. Total unknown → the same 4% indeterminate creep.
  const dlPct = busyDownloading && load.total ? Math.min(100, Math.round((load.received / load.total) * 100)) : null
  const duration = status.duration && Number.isFinite(status.duration) ? status.duration : 0
  const progress = duration > 0 ? Math.min(1, status.currentTime / duration) : 0
  const errorMsg = load.status === 'error' ? load.message : null

  const toggle = async () => {
    try {
      // While bytes stream in, the play button IS the cancel affordance.
      if (busyDownloading) {
        abortRef.current?.abort()
        return
      }
      if (status.playing) {
        player.pause()
        return
      }
      if (!localUri) {
        if (!seg.path) return
        pendingPlay.current = true
        const ctrl = new AbortController()
        abortRef.current = ctrl
        try {
          const uri = await downloadMediaFile(seg.path, { signal: ctrl.signal })
          setLocalUri(uri)
        } catch (err) {
          if (ctrl.signal.aborted) pendingPlay.current = false
          throw err
        } finally {
          if (abortRef.current === ctrl) abortRef.current = null
        }
        return
      }
      player.play()
    } catch {
      /* mediaState carries the error; the bar stays idle */
    }
  }

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Pressable
          style={({ pressed }) => [s.btn, pressed && s.pressed]}
          onPress={() => void toggle()}
          accessibilityLabel={busyDownloading ? 'Cancel download' : status.playing ? 'Pause audio' : 'Play audio'}
        >
          <Icon
            name={busyDownloading ? 'close' : status.playing ? 'pause' : 'play'}
            size={16}
            color={C.onAccent}
          />
        </Pressable>
        <View style={s.body}>
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: `${busyDownloading ? (dlPct ?? 4) : Math.round(progress * 100)}%` }]} />
          </View>
          <Text style={s.meta}>
            {busyDownloading
              ? `${seg.name ?? 'Audio'} · ${dlPct != null ? `${dlPct}%` : 'downloading…'}`
              : duration > 0
                ? `${formatDuration(status.currentTime)} / ${formatDuration(duration)}`
                : (seg.name ?? 'Audio')}
            {seg.size && !localUri && !busyDownloading ? ` · ${formatBytes(seg.size)}` : ''}
          </Text>
        </View>
      </View>
      {errorMsg && !busyDownloading ? (
        <Pressable style={({ pressed }) => [s.errorRow, pressed && s.pressed]} onPress={() => void toggle()} accessibilityLabel="Retry download">
          <Icon name="alert-circle" size={13} color={C.red} />
          <Text style={s.errorText} numberOfLines={1}>{errorMsg}</Text>
          <Icon name="refresh" size={13} color={C.accent} />
        </Pressable>
      ) : null}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  wrap: {
    backgroundColor: C.bgElev,
    borderRadius: 16,
    minWidth: 200,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  btn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  body: { flex: 1, gap: 5 },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: C.bgHover, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  meta: { color: C.textFaint, fontSize: 11.5 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.borderSoft },
  errorText: { color: C.red, fontSize: 11.5, flexShrink: 1, flex: 1 },
})
