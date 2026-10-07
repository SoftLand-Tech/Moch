import React, { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { dismissToast, requestOpenSession, toasts, type SessionToast } from '../lib/attention'
import { C, useStyles } from '../lib/theme'

/**
 * In-app counterpart of a push notification: when something happens in a
 * chat the user is not looking at (question arrived, turn finished, turn
 * failed) while the app is FOREGROUNDED, a stack of tappable toasts slides
 * in from the top. Tapping one hops to that chat — the chat the user was in
 * keeps its transcript and its unsent composer draft, so hopping back loses
 * nothing.
 *
 * Mounted once in the root layout, above every screen. Backgrounded events
 * never reach this queue — they go out as local notifications instead.
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
  const router = useRouter()
  const meta = KIND_META[t.kind]
  // Cards mount at their resting place with opacity 0 and fade/slide in —
  // transform-only animation, so nothing re-layouts under the keyboard.
  const anim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
    const timer = setTimeout(() => dismissToast(t.id), meta.ms)
    return () => clearTimeout(timer)
  }, [anim, t.id, meta.ms])

  const open = () => {
    dismissToast(t.id)
    requestOpenSession(t.storedId)
    try { router.navigate('/(tabs)/chat') } catch {}
  }

  return (
    <Animated.View style={{ opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }] }}>
      <Pressable
        style={({ pressed }) => [s.card, pressed && s.cardPressed]}
        onPress={open}
        accessibilityLabel={`${t.title}. ${t.body}. Open conversation${t.chatTitle ? ` ${t.chatTitle}` : ''}`}
      >
        <View style={[s.iconWrap, { backgroundColor: meta.color() }]}>
          <Icon name={meta.icon} size={17} color="#081114" />
        </View>
        <View style={s.textWrap}>
          {t.chatTitle ? <Text style={s.kicker} numberOfLines={1}>{t.chatTitle}</Text> : null}
          <Text style={s.title} numberOfLines={1}>{t.title}</Text>
          {t.body ? <Text style={s.body} numberOfLines={2}>{t.body}</Text> : null}
        </View>
        {/* BUG-026: an explicit dismiss — the card body itself navigates, so
            closing previously meant waiting out the timer. */}
        <Pressable
          hitSlop={8}
          onPress={() => dismissToast(t.id)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="close" size={15} color={C.textFaint} />
        </Pressable>
        <Icon name="chevron-forward" size={16} color={C.textFaint} />
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
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
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: { flex: 1, gap: 1 },
  closeBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: C.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  title: { color: C.text, fontSize: 14, fontWeight: '700' },
  body: { color: C.textDim, fontSize: 12.5, lineHeight: 16.5 },
})
