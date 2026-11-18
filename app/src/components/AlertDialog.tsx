/**
 * Themed in-app dialogs — the app-wide replacement for React Native's
 * `Alert.alert`, which renders the OS's stock dialog on Android and is a
 * silent NO-OP on react-native-web (errors just vanished there).
 *
 * Presentation follows the redesign's bottom-sheet card language: an elevated
 * `bgElev` card with a hairline border and 20 radius, a 15/800 title, a 12.5
 * `textDim` message, then the app's `GhostBtn` (cancel) / `PrimaryBtn`
 * (default) / red primary (destructive) buttons. RTL mirrors the button row.
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
import { Modal, View, Pressable, StyleSheet } from 'react-native'
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr, useDir } from '../lib/strings'
import { GhostBtn, PrimaryBtn, Txt } from './ui'
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
      buttons: opts.buttons?.length ? opts.buttons : [{ text: tr('chrome.alert.ok') }],
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
  const dir = useDir()
  // Themed copy (a11y fallbacks) follows the app language.
  useStore(localeAtom)
  const req = useStore(queue)[0] ?? null
  if (!req) return null

  const cancelIndex = Math.max(req.buttons.findIndex((b) => b.style === 'cancel'), 0)
  const stacked = req.buttons.length > 2

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => answer(req, cancelIndex)}>
      <View style={[s.scrimWrap, { flexDirection: dir.row }]}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]}
          accessibilityLabel={tr('chrome.alert.dismiss')}
          onPress={() => answer(req, cancelIndex)}
        />
        <View style={s.card}>
          <Txt size={15} weight="800" color={C.text}>{req.title}</Txt>
          {req.message ? (
            <Txt size={12.5} color={C.textDim} style={s.message}>{req.message}</Txt>
          ) : null}
          <View
            style={[
              stacked ? s.stack : s.row,
              { flexDirection: stacked ? 'column' : dir.row },
            ]}
          >
            {req.buttons.map((b, i) => {
              const btnStyle = stacked ? s.stackBtn : undefined
              if (b.style === 'destructive') {
                return (
                  <PrimaryBtn
                    key={`${b.text}-${i}`}
                    onPress={() => answer(req, i)}
                    accessibilityLabel={b.text}
                    style={[btnStyle, s.dangerBtn]}
                  >
                    <Txt size={13} weight="700" color="#FFFFFF" numberOfLines={2}>{b.text}</Txt>
                  </PrimaryBtn>
                )
              }
              if (b.style === 'cancel') {
                return (
                  <GhostBtn
                    key={`${b.text}-${i}`}
                    label={b.text}
                    onPress={() => answer(req, i)}
                    style={btnStyle}
                  />
                )
              }
              return (
                <PrimaryBtn
                  key={`${b.text}-${i}`}
                  label={b.text}
                  onPress={() => answer(req, i)}
                  style={btnStyle}
                />
              )
            })}
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
    borderColor: C.border,
    padding: 18,
    width: '100%',
    maxWidth: 340,
    gap: 8,
  },
  message: { lineHeight: 18 },
  row: { justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  stack: { marginTop: 12, gap: 6 },
  stackBtn: { alignSelf: 'stretch' },
  dangerBtn: { backgroundColor: C.red },
})
