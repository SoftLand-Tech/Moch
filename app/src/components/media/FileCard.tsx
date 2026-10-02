import React, { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Sharing from 'expo-sharing'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../../lib/theme'
import type { ChatSegment } from '../../lib/chat'
import { cacheKeyFor, fileIconForPath, formatBytes } from '../../lib/media'
import { downloadMediaFile } from '../../lib/mediaCache'
import { mediaStateForKey } from '../../lib/mediaState'

/**
 * Document/file card, ChatGPT's attachment card: type icon (per extension,
 * generic icon for unknown ones), name, size. First tap downloads — the thin
 * brand-cyan bar along the bottom edge fills with the real transfer progress
 * from the per-key mediaState store (determinate; no fake spinner). Once the
 * bytes are local, tap opens the file (falling back to the share sheet when
 * no app claims it) and the share button hands it to the OS. Download errors
 * render a retry row wired to the same download.
 */
export function FileCard({ seg }: { seg: ChatSegment }) {
  const s = useStyles(makeS)
  const load = useStore(mediaStateForKey(seg.path ? cacheKeyFor(seg.path) : '_idle_'))
  const [localUri, setLocalUri] = useState<string | null>(seg.localUri ?? null)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchThen = async (after?: (uri: string) => void) => {
    if (busy || !seg.path) return
    setBusy(true)
    try {
      const uri = localUri ?? (await downloadMediaFile(seg.path))
      setLocalUri(uri)
      after?.(uri)
    } catch {
      /* the error row below carries the mapped message; mediaState has it */
    } finally {
      setBusy(false)
    }
  }

  const share = async () => {
    if (!seg.path && !localUri) return
    setSharing(true)
    await fetchThen((uri) => {
      void Sharing.shareAsync(uri, { mimeType: seg.mime ?? 'application/octet-stream' }).catch(() => {})
    })
    setSharing(false)
  }

  /** Open with the OS; a file no app claims still lands in the share sheet
   *  (the share sheet always offers "open with"), never a dead tap. */
  const open = async () => {
    await fetchThen(async (uri) => {
      try {
        await Linking.openURL(uri)
      } catch {
        try {
          await Sharing.shareAsync(uri, { mimeType: seg.mime ?? 'application/octet-stream' })
        } catch {}
      }
    })
  }

  const loading = busy || load.status === 'loading'
  const pct = load.status === 'loading' && load.total ? Math.min(100, Math.round((load.received / load.total) * 100)) : null
  const errorMsg = load.status === 'error' ? load.message : null

  return (
    <View style={s.card}>
      <Pressable
        style={({ pressed }) => [s.row, pressed && s.pressed]}
        onPress={() => { void (localUri ? open() : fetchThen()) }}
        disabled={loading}
        accessibilityLabel={`File${seg.name ? `: ${seg.name}` : ''}${
          loading ? ', downloading' : localUri ? ', tap to open' : ', tap to download'
        }`}
      >
        <Icon name={fileIconForPath(seg.name ?? seg.path ?? '') as keyof typeof Ionicons.glyphMap} size={22} color={C.accent} />
        <View style={s.meta}>
          <Text style={s.name} numberOfLines={1}>{seg.name ?? seg.path?.split('/').pop() ?? 'File'}</Text>
          <Text style={s.sub}>
            {seg.size ? formatBytes(seg.size) : ''}
            {loading ? (pct != null ? ` · ${pct}%` : ' · downloading…') : ''}
          </Text>
        </View>
        {localUri && !loading ? (
          <Pressable onPress={() => void share()} hitSlop={8} accessibilityLabel="Share file">
            {sharing ? <Icon name="hourglass-outline" size={16} color={C.textFaint} /> : <Icon name="share-outline" size={16} color={C.textDim} />}
          </Pressable>
        ) : null}
      </Pressable>
      {loading ? (
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${pct ?? 4}%` }]} />
        </View>
      ) : null}
      {errorMsg && !loading ? (
        <Pressable style={({ pressed }) => [s.errorRow, pressed && s.pressed]} onPress={() => void fetchThen()} accessibilityLabel="Retry download">
          <Icon name="alert-circle" size={14} color={C.red} />
          <Text style={s.errorText} numberOfLines={1}>{errorMsg}</Text>
          <Icon name="refresh" size={14} color={C.accent} />
        </Pressable>
      ) : null}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  card: {
    backgroundColor: C.bgElev,
    borderRadius: 16,
    minWidth: 220,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  pressed: { opacity: 0.85 },
  meta: { flex: 1 },
  name: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  sub: { color: C.textFaint, fontSize: 11.5, marginTop: 1 },
  progressTrack: { height: 3, backgroundColor: C.bgHover },
  progressFill: { height: 3, backgroundColor: C.accent },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.borderSoft },
  errorText: { color: C.red, fontSize: 11.5, flexShrink: 1, flex: 1 },
})
