import React, { useCallback, useEffect, useRef } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { useDir, useT } from '../lib/strings'
import { Txt } from './ui'
import { ackHandoff, handoffRequestAtom } from '../lib/browserRelay'
import { markBrowserUserControl } from '../lib/browserTask'

/**
 * Global browser-handoff prompt.
 *
 * CdpRelay's /<token>/moch/handoff emits "mochHandoff" when a browser tool
 * hits a login wall, CAPTCHA or destructive confirmation. This host renders
 * ONE themed Modal from handoffRequestAtom, acknowledges exactly once, and on
 * accept sends the user to the Browser tab where the page is already live.
 *
 * Mounted once from app/_layout.tsx (both root branches). No text input, so no
 * keyboard avoidance is needed; styling uses the theme tokens only.
 */
export function BrowserHandoffPrompt() {
  const s = useStyles(makeS)
  const t = useT()
  const dir = useDir()
  const req = useStore(handoffRequestAtom)
  /** Request id already answered from THIS modal instance (double-tap guard). */
  const acked = useRef<string | null>(null)

  useEffect(() => {
    if (!req) acked.current = null
  }, [req])

  // The relay waits a bounded time. If the tool call times out, no ack ever
  // reaches the relay, so close the stale prompt rather than leaving a Take
  // over button for a request that no longer exists. The 250ms cushion lets
  // a user tap at the boundary still win.
  useEffect(() => {
    if (!req) return
    const timer = setTimeout(() => {
      if (handoffRequestAtom.get()?.requestId === req.requestId) {
        ackHandoff(req.requestId, false)
      }
    }, (req.timeoutMs ?? 60_000) + 250)
    return () => clearTimeout(timer)
  }, [req])

  const finish = useCallback(
    (accepted: boolean) => {
      if (!req) return
      if (acked.current === req.requestId) return
      acked.current = req.requestId
      // ackHandoff has its own store-level exactly-once guard; the local ref
      // only prevents a second router.push from a fast double tap. If the
      // request already timed out, do NOT navigate — control was not handed
      // over and the model has already been told so.
      if (!ackHandoff(req.requestId, accepted)) return
      if (!accepted) return
      markBrowserUserControl()
      try {
        router.navigate('/(tabs)/browser')
      } catch {
        // The Browser screen may not be routable during a root transition;
        // control is still handed over and the page stays where it was.
      }
    },
    [req],
  )

  const site = req ? siteOf(req.url) : ''
  const reason = req?.reason?.trim() || t('browser.handoff.fallbackReason')

  return (
    <Modal
      visible={!!req}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => finish(false)}
    >
      <View style={s.backdrop}>
        <View style={s.card} accessibilityViewIsModal accessibilityRole="alert">
          <Txt size={15} weight="800" color={C.text}>
            {t('browser.handoff.title')}
          </Txt>
          <Txt size={12.5} color={C.textDim} style={s.reason}>
            {reason}
          </Txt>
          {site ? (
            <Txt size={10.5} mono ltr color={C.textFaint} numberOfLines={1} style={s.site}>
              {site}
            </Txt>
          ) : null}
          <View style={[s.actions, { flexDirection: dir.row }]}>
            <Pressable
              style={({ pressed }) => [s.ghost, pressed && s.pressed]}
              onPress={() => finish(false)}
              accessibilityRole="button"
              accessibilityLabel={t('browser.handoff.notNow')}
            >
              <Txt size={12} weight="700" color={C.textDim}>
                {t('browser.handoff.notNow')}
              </Txt>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.primary, pressed && s.pressed]}
              onPress={() => finish(true)}
              accessibilityRole="button"
              accessibilityLabel={t('browser.handoff.takeOver')}
            >
              <Txt size={12} weight="800" color={C.onAccent}>
                {t('browser.handoff.takeOver')}
              </Txt>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** Host shown for a page URL (scheme + path stripped); the raw URL is data. */
function siteOf(url: string): string {
  const raw = (url || '').trim()
  const hit = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw)
  return (hit ? hit[1] : raw).slice(0, 120)
}

const makeS = () =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.62)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 460,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.bgElev,
      padding: 16,
    },
    reason: { marginTop: 8, lineHeight: 18 },
    site: { marginTop: 6 },
    actions: { marginTop: 16, justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
    ghost: {
      borderRadius: 11,
      borderWidth: 1,
      borderColor: C.border,
      paddingVertical: 9,
      paddingHorizontal: 14,
    },
    primary: {
      borderRadius: 11,
      backgroundColor: C.accent,
      paddingVertical: 9,
      paddingHorizontal: 16,
    },
    pressed: { opacity: 0.65 },
  })
