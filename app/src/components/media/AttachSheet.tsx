import React, { useEffect, useRef } from 'react'
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { GhostBtn } from '../ui'
import { C, useStyles } from '../../lib/theme'
import { useDir, useT } from '../../lib/strings'

/**
 * ChatGPT's attach flow: a bottom action sheet, not an OS alert. Three source
 * cards (photo/video library, camera, file) in the mockup's 3-column grid plus
 * Cancel, sliding up over a dim scrim. Plain RN Modal + Animated — no
 * gesture-handler (deliberately avoided everywhere in this app). Tap-out on the
 * scrim and the hardware back button both close it.
 */
export interface AttachSheetProps {
  visible: boolean
  onClose: () => void
  onLibrary: () => void
  onCamera: () => void
  onFile: () => void
}

export function AttachSheet({ visible, onClose, onLibrary, onCamera, onFile }: AttachSheetProps) {
  const s = useStyles(makeS)
  const dir = useDir()
  const t = useT()
  const slide = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible) {
      slide.setValue(0)
      Animated.timing(slide, { toValue: 1, duration: 200, useNativeDriver: true }).start()
    }
  }, [visible, slide])

  const close = () => {
    // Fire the exit animation and report closed immediately — the parent
    // unmounts the Modal; the 200 ms slide-in already gave it life.
    onClose()
  }

  const rows: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }> = [
    { icon: 'images-outline', label: t('chat.attach.library'), onPress: onLibrary },
    { icon: 'camera-outline', label: t('chat.attach.camera'), onPress: onCamera },
    { icon: 'document-outline', label: t('chat.attach.file'), onPress: onFile },
  ]

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={s.scrim} onPress={close} accessibilityLabel={t('chat.attach.closeA11y')} />
        <Animated.View style={[s.panel, { transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [260, 0] }) }] }]}>
          <View style={s.grabber} />
          <Text style={s.title}>{t('chat.attach.title')}</Text>
          <View style={[s.grid, { flexDirection: dir.row }]}>
            {rows.map((row) => (
              <Pressable
                key={row.label}
                style={({ pressed }) => [s.tile, pressed && s.tilePressed]}
                onPress={() => {
                  close()
                  row.onPress()
                }}
                accessibilityRole="button"
                accessibilityLabel={row.label}
              >
                <View style={s.tileIcon}>
                  <Icon name={row.icon} size={20} color={C.accent} />
                </View>
                <Text style={s.tileText} numberOfLines={2}>{row.label}</Text>
              </Pressable>
            ))}
          </View>
          <GhostBtn
            label={t('common.cancel')}
            onPress={close}
            style={s.cancel}
          />
        </Animated.View>
      </View>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.scrim },
  // sheet-card: bgElev, radius 24 top, padding 10 14 26.
  panel: {
    backgroundColor: C.bgElev,
    borderTopWidth: 1,
    borderColor: C.border,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 26,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 999, backgroundColor: C.textFaint, opacity: 0.45, marginBottom: 10 },
  title: { color: C.text, fontSize: 14, fontWeight: '800', marginBottom: 10 },
  grid: { gap: 8, marginBottom: 10 },
  tile: {
    flex: 1,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 6,
  },
  tilePressed: { opacity: 0.72 },
  tileIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  tileText: { color: C.text, fontSize: 11.5, fontWeight: '700', textAlign: 'center' },
  cancel: { width: '100%' },
})
