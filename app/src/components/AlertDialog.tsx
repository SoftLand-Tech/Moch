/**
 * Themed in-app dialogs — the app-wide replacement for React Native's
 * `Alert.alert`, which renders the OS's stock dialog on Android and is a
 * silent NO-OP on react-native-web (errors just vanished there).
 *
 * Styling rides the theme tokens (C + useStyles), so the same component
 * matches Mocheme and Relay without knowing either exists. Usage is
 * imperative from anywhere — no prop drilling:
 *
 *   await showAlert('Delete this?', 'This cannot be undone.', [
 *     { text: 'Cancel', style: 'cancel' },
 *     { text: 'Delete', style: 'destructive', onPress: () => {...} },
 *   ])
 *
 * The returned promise resolves with the pressed button. Requests queue:
 * a dialog opened while another is showing waits its turn instead of
 * dropping the first promise (a caller awaiting it would hang forever).
 */
import React from 'react'
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import * as Haptics from 'expo-haptics'

export interface AlertButton {
  text: string
  onPress?: () => void
  /** 'destructive' renders red, 'cancel' renders muted, 'default' accent. */
  style?: 'default' | 'cancel' | 'destructive'
}

interface DialogRequest {
  title: string
  message?: string
  buttons: AlertButton[]
  resolve: (b: AlertButton) => void
}

const queue = atom<DialogRequest[]>([])

/**
 * Show a themed dialog. Accepts the `Alert.alert` argument shape (drop-in
 * replacement) or a single options object. Resolves with the button the
 * user pressed; with no custom buttons it shows a single OK.
 */
export function showAlert(
  titleOrOpts: string | { title: string; message?: string; buttons?: AlertButton[] },
  message?: string,
  buttons?: AlertButton[],
): Promise<AlertButton> {
  const opts = typeof titleOrOpts === 'string'
    ? { title: titleOrOpts, message, buttons }
    : titleOrOpts
  return new Promise((resolve) => {
    queue.set([...queue.get(), {
      title: opts.title ?? '',
      message: opts.message,
      buttons: opts.buttons?.length ? opts.buttons : [{ text: 'OK' }],
      resolve,
    }])
  })
}

/** Answer one button and advance the queue. */
function answer(req: DialogRequest, index: number) {
  const btn = req.buttons[index] ?? req.buttons[0]
  if (btn.style === 'destructive') {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
  }
  queue.set(queue.get().filter((r) => r !== req))
  req.resolve(btn)
  btn.onPress?.()
}

export function AlertDialogHost() {
  const s = useStyles(makeS)
  const req = useStore(queue)[0] ?? null
  if (!req) return null

  const cancelIndex = Math.max(req.buttons.findIndex((b) => b.style === 'cancel'), 0)
  const stacked = req.buttons.length > 2

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => answer(req, cancelIndex)}>
      <View style={s.scrimWrap}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]}
          accessibilityLabel="Dismiss dialog"
          onPress={() => answer(req, cancelIndex)}
        />
        <View style={s.card}>
          <Text style={s.title}>{req.title}</Text>
          {req.message ? <Text style={s.message}>{req.message}</Text> : null}
          <View style={stacked ? s.stack : s.row}>
            {req.buttons.map((b, i) => (
              <Pressable
                key={`${b.text}-${i}`}
                style={({ pressed }) => [
                  stacked ? s.stackBtn : s.rowBtn,
                  b.style === 'destructive' && s.destructiveBtn,
                  pressed && s.pressed,
                ]}
                onPress={() => answer(req, i)}
                accessibilityLabel={b.text}
              >
                <Text
                  style={[
                    b.style === 'destructive' ? s.destructiveText
                      : b.style === 'cancel' ? s.cancelText
                        : s.defaultText,
                  ]}
                  numberOfLines={2}
                >
                  {b.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  )
}

const makeS = () => StyleSheet.create({
  scrimWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: {
    backgroundColor: C.bgElev,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.borderSoft,
    padding: 20,
    width: '100%',
    maxWidth: 340,
  },
  title: { color: C.text, fontSize: 17, fontWeight: '800', textAlign: 'left' },
  message: { color: C.textDim, fontSize: 13.5, lineHeight: 19, marginTop: 8 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 20 },
  rowBtn: {
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, minHeight: 42,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgCard,
  },
  stack: { flexDirection: 'column', marginTop: 18, gap: 6 },
  stackBtn: {
    borderRadius: 14, minHeight: 46, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.bgCard,
  },
  destructiveBtn: { backgroundColor: C.redSoft },
  destructiveText: { color: C.red, fontWeight: '800', fontSize: 14.5 },
  cancelText: { color: C.textDim, fontWeight: '700', fontSize: 14.5 },
  defaultText: { color: C.accent, fontWeight: '800', fontSize: 14.5 },
  pressed: { opacity: 0.55 },
})
