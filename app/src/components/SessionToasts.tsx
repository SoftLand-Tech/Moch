import React, { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { dismissToast, requestOpenSession, toasts, type SessionToast } from '../lib/attention'
import { C, useStyles } from '../lib/theme'
import { localeAtom, tr, useDir } from '../lib/strings'
import { Icon } from './Icon'
import { Txt } from './ui'
import { useReduceMotion } from './useReduceMotion'

/**
 * In-app counterpart of a push notification: when something happens in a
 * chat the user is not looking at (question arrived, turn finished, turn
 * failed) while the app is FOREGROUNDED, a stack of tappable toasts slides
 * in from the top. Tapping one hops to that chat — the chat the user was in
 * keeps its transcript and its unsent composer draft, so hopping back loses
 * nothing.
 *
 * Presentation follows the redesign's pill/card language: an elevated card
 * (`bgElev`, hairline border, 14 radius) with a tinted status disc, a faint
 * chat-title kicker, a 12.5/700 title and an 11.5 `textDim` body; the trailing
 * chevron mirrors in RTL (useDir). Mounted once in the root layout, above
 * every screen. Backgrounded events never reach this queue — they go out as
 * local notifications instead.
 */

// BUG-017: resolve colors at RENDER time — `C` is mutated in place by
// applyTheme, and a module-scope snapshot freezes the import-time palette
// forever (theme.ts's contract: styles must never be snapshotted at module
// scope). Shapes/timings are palette-independent and stay static.
const KIND_META: Record<SessionToast['kind'], { color: () => string; icon: 'help-circle' | 'checkmark-circle' | 'warning'; ms: number }> = {
  input: { color: () => C.amber, icon: 'help-circle', ms: 9000 },
  done: { color: () => C.greenSoft, icon: 'checkmark-circle', ms: 6500 },
  error: { color: () => C.red, icon: 'warning', ms: 8000 },
}

function ToastCard({ t }: { t: SessionToast }) {
  const s = useStyles(makeS)
  const dir = useDir()
  // Locale switches must re-render the card's own copy/a11y.
  useStore(localeAtom)
  const router = useRouter()
  const meta = KIND_META[t.kind]
  // BUG-056: cards mount at their resting place with opacity 0 and fade/slide
  // in — transform-only animation, so nothing re-layouts under the keyboard.
  // Under the OS reduce-motion setting the card appears in place, no motion.
  const reduceMotion = useReduceMotion()
  const anim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (reduceMotion) {
      anim.setValue(1)
    } else {
      Animated.timing(anim, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    }
    const timer = setTimeout(() => dismissToast(t.id), meta.ms)
    return () => clearTimeout(timer)
  }, [anim, t.id, meta.ms, reduceMotion])

  const open = () => {
    dismissToast(t.id)
    requestOpenSession(t.storedId)
    try { router.navigate('/(tabs)/chat') } catch {}
  }

  return (
    <Animated.View style={{ opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }] }}>
      <Pressable
        style={({ pressed }) => [s.card, { flexDirection: dir.row }, pressed && s.cardPressed]}
        onPress={open}
        accessibilityLabel={`${t.title}. ${t.body}. ${tr('chrome.toast.open')}${t.chatTitle ? ` ${t.chatTitle}` : ''}`}
      >
        <View style={[s.iconWrap, { backgroundColor: meta.color() }]}>
          {/* BUG-080: token ink — the literal was a frozen Mocheme value. */}
          <Icon name={meta.icon} size={15} color={C.onAccent} />
        </View>
        <View style={s.textWrap}>
          {t.chatTitle ? (
            <Txt size={10.5} weight="800" color={C.textFaint} numberOfLines={1} style={s.kicker}>
              {t.chatTitle}
            </Txt>
          ) : null}
          <Txt size={12.5} weight="700" color={C.text} numberOfLines={1}>{t.title}</Txt>
          {t.body ? (
            <Txt size={11.5} color={C.textDim} numberOfLines={2} style={s.body}>{t.body}</Txt>
          ) : null}
        </View>
        {/* BUG-026: an explicit dismiss — the card body itself navigates, so
            closing previously meant waiting out the timer. */}
        <Pressable
          hitSlop={8}
          onPress={() => dismissToast(t.id)}
          accessibilityRole="button"
          accessibilityLabel={tr('chrome.toast.dismiss')}
          style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="close" size={14} color={C.textFaint} />
        </Pressable>
        <Icon name={dir.icon.forward} size={15} color={C.textFaint} />
      </Pressable>
    </Animated.View>
  )
}

export function SessionToasts() {
  const list = useStore(toasts)
  const insets = useSafeAreaInsets()
  if (!list.length) return null
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { paddingTop: insets.top + 10 }]}>
      {list.map((t) => <ToastCard key={t.id} t={t} />)}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: 9,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderRadius: 14,
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
    shadowColor: '#000000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  cardPressed: { backgroundColor: C.bgHover },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  textWrap: { flex: 1, minWidth: 0, gap: 1 },
  closeBtn: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  kicker: { letterSpacing: 0.5, textTransform: 'uppercase' },
  body: { lineHeight: 15.5 },
})
