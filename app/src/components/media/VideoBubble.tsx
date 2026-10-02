import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useEvent } from 'expo'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { probeDownloadError, videoSource } from '../../lib/mediaCache'
import { formatBytes } from '../../lib/media'

/**
 * Video bubble: a compact tile (name + size + play) that swaps for the
 * player on tap — `useVideoPlayer(source)` lives in a child that only mounts
 * on tap, so no bytes flow until the user asks. v57 API: the source object
 * carries the auth headers; `<VideoView player={…}>` (VideoView has no
 * `source` prop), and `useEvent(player, 'statusChange', …)` reports
 * idle/loading/readyToPlay/error.
 *
 * The tile taps through whenever a source exists (path OR localUri — an
 * optimistic row mid-upload plays its local copy; gating on the path alone
 * made the tap a silent no-op until the upload finished). Loading shows a
 * spinner; a failed stream maps its real gateway status (probeDownloadError)
 * into a retry row — matching the image/audio/file bubbles.
 */
export function VideoBubble({ seg }: { seg: ChatSegment }) {
  const s = useStyles(makeS)
  const [playing, setPlaying] = useState(false)
  // Bumping the attempt remounts the player (its source is fixed at mount).
  const [attempt, setAttempt] = useState(0)
  // The send-side copy is trusted only until it fails to play — its contract
  // is send-side-only, so a failure (cache evicted after a restart) drops it
  // and the next mount streams the durable gateway path instead.
  const [localUri, setLocalUri] = useState<string | null>(seg.localUri ?? null)

  if (playing && (seg.path || localUri)) {
    return (
      <VideoPlayerMount
        key={attempt}
        seg={localUri ? { ...seg, localUri } : seg}
        onStaleLocal={() => {
          setLocalUri(null)
          setAttempt((n) => n + 1)
        }}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  }

  return (
    <Pressable
      style={({ pressed }) => [s.tile, pressed && s.pressed]}
      onPress={() => { if (seg.path || localUri) setPlaying(true) }}
      accessibilityLabel={`Play video${seg.name ? `: ${seg.name}` : ''}`}
    >
      <View style={s.playCircle}>
        <Icon name="play" size={16} color={C.onAccent} />
      </View>
      <View style={s.meta}>
        <Text style={s.name} numberOfLines={1}>{seg.name ?? 'Video'}</Text>
        {seg.size ? <Text style={s.sub}>{formatBytes(seg.size)}</Text> : null}
      </View>
    </Pressable>
  )
}

/** Mounted only while playing — the hook is created with the authed source. */
function VideoPlayerMount({
  seg,
  onStaleLocal,
  onRetry,
}: {
  seg: ChatSegment
  onStaleLocal: () => void
  onRetry: () => void
}) {
  const s = useStyles(makeS)
  const player = useVideoPlayer(
    // Local optimistic copies play straight from disk; gateway videos stream.
    seg.localUri ? { uri: seg.localUri } : videoSource(seg.path!),
    (p) => {
      // The tap IS the play intent; the player never autoplays on mount otherwise.
      p.play()
    },
  )
  // v57 expo-video: statusChange delivers { status, oldStatus?, error? }.
  const evt = useEvent(player, 'statusChange', { status: player.status })
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // Heal-then-error: a failed LOCAL copy hands playback to the gateway path
  // (remount); a failed gateway stream gets its real HTTP status probed and
  // mapped into the retry row.
  useEffect(() => {
    if (evt.status !== 'error') return
    if (seg.localUri && seg.path) {
      onStaleLocal()
      return
    }
    let alive = true
    const probe = seg.path ? probeDownloadError(seg.path) : Promise.resolve(null)
    void probe.then((mapped) => {
      if (alive) setErrMsg(mapped ?? 'Video could not be played')
    })
    return () => { alive = false }
  }, [evt.status, seg.localUri, seg.path, onStaleLocal])

  if (errMsg) {
    return (
      <Pressable
        style={({ pressed }) => [s.tile, pressed && s.pressed]}
        onPress={onRetry}
        accessibilityLabel="Retry video"
      >
        <Icon name="alert-circle" size={16} color={C.red} />
        <Text style={s.errorText} numberOfLines={1}>{errMsg}</Text>
        <Icon name="refresh" size={14} color={C.accent} />
      </Pressable>
    )
  }

  return (
    <View style={s.playerWrap}>
      <VideoView
        player={player}
        style={s.player}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
      />
      {evt.status === 'loading' ? (
        <View style={s.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color={C.accent} />
        </View>
      ) : null}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.bgElev,
    borderRadius: 16,
    padding: 12,
    minHeight: 60,
  },
  pressed: { opacity: 0.85 },
  playCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { flex: 1 },
  name: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  sub: { color: C.textFaint, fontSize: 11.5, marginTop: 1 },
  playerWrap: { borderRadius: 16, overflow: 'hidden' },
  player: { width: 260, height: 170, backgroundColor: C.bgElev },
  loadingOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: C.red, fontSize: 12.5, flexShrink: 1, flex: 1 },
})
