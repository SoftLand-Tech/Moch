import React, { useEffect, useRef } from 'react'
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from '../Icon'
import { C, useStyles } from '../../lib/theme'

/**
 * ChatGPT's attach flow: a bottom action sheet, not an OS alert. Three source
 * rows (photo/video library, camera, file) plus Cancel, sliding up over a
 * dim scrim. Plain RN Modal + Animated — no gesture-handler (deliberately
 * avoided everywhere in this app). Tap-out on the scrim and the hardware
 * back button both close it.
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
    { icon: 'images-outline', label: 'Photo or video library', onPress: onLibrary },
    { icon: 'camera-outline', label: 'Take photo', onPress: onCamera },
    { icon: 'document-outline', label: 'File', onPress: onFile },
  ]

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={s.scrim} onPress={close} accessibilityLabel="Close attachment picker" />
        <Animated.View style={[s.panel, { transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [260, 0] }) }] }]}>
          <View style={s.grabber} />
          <Text style={s.title}>Add attachment</Text>
          {rows.map((row) => (
            <Pressable
              key={row.label}
              style={({ pressed }) => [s.row, pressed && s.rowPressed]}
              onPress={() => {
                close()
                row.onPress()
              }}
              accessibilityRole="button"
              accessibilityLabel={row.label}
            >
              <View style={s.rowIcon}>
                <Icon name={row.icon} size={19} color={C.text} />
              </View>
              <Text style={s.rowText}>{row.label}</Text>
            </Pressable>
          ))}
          <Pressable style={({ pressed }) => [s.cancel, pressed && s.rowPressed]} onPress={close} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.scrim },
  panel: {
    backgroundColor: C.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 20,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, marginBottom: 10 },
  title: { color: C.textFaint, fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', paddingHorizontal: 10, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 14, minHeight: 48 },
  rowPressed: { backgroundColor: C.bgHover },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { color: C.text, fontSize: 15, fontWeight: '500' },
  cancel: { marginTop: 6, alignItems: 'center', paddingVertical: 13, borderRadius: 22, backgroundColor: C.bgCard, minHeight: 46, justifyContent: 'center' },
  cancelText: { color: C.textDim, fontSize: 14.5, fontWeight: '700' },
})
