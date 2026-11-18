/**
 * The Moch UI kit — the exact primitives the redesign showcase
 * (docs/redesign/design.html §7) uses for every screen.
 *
 *   m-card / m-elev / m-section-kicker / m-input / m-btn-primary / m-btn-ghost
 *   m-pill (accent|green|amber|red|neutral) / status-dot / shell-icon-btn
 *   app-scroll / segmented switch / toggle / bottom sheet
 *
 * All values come from the mockup's CSS. Styles are theme-reactive
 * (useStyles) so the Relay theme keeps working, and RTL-aware (useDir) so
 * Arabic mirrors correctly.
 */
import React, { forwardRef } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextProps,
  TextStyle,
  View,
  ViewStyle,
  type ScrollViewProps,
} from 'react-native'
import { C, useStyles } from '../lib/theme'
import { useDir } from '../lib/strings'

// ─── Layout metrics (mockup §7) ─────────────────────────────────────────────
export const UI = {
  cardRadius: 14,
  elevRadius: 12,
  inputRadius: 11,
  buttonRadius: 11,
  pillRadius: 999,
  pad: 14,
  cardPad: 12,
  gap: 8,
  screenPadH: 14,
} as const

// ─── Text ───────────────────────────────────────────────────────────────────

export interface TxtProps extends TextProps {
  /** Font size in px (mockup values are small: 10.5–16). */
  size?: number
  weight?: '400' | '500' | '600' | '700' | '800'
  color?: string
  /** Monospace (JetBrains-ish system mono) — URLs, ids, code, cron. */
  mono?: boolean
  center?: boolean
  /** Force LTR text direction (mono data inside an RTL screen). */
  ltr?: boolean
}

/** The app's text primitive: size/weight/color + Arabic-aware direction. */
export function Txt({
  size = 13,
  weight = '400',
  color,
  mono,
  center,
  ltr,
  style,
  children,
  ...rest
}: TxtProps) {
  const dir = useDir()
  const s = useStyles(makeS)
  const writingDirection = ltr ? 'ltr' : dir.writingDirection
  const textAlign = center ? 'center' : ltr ? 'left' : dir.textAlign
  return (
    <Text
      {...rest}
      style={[
        { fontSize: size, fontWeight: weight, color: color ?? C.text, writingDirection, textAlign },
        mono ? s.mono : null,
        style,
      ]}
    >
      {children}
    </Text>
  )
}

// ─── Surfaces ───────────────────────────────────────────────────────────────

type CardProps = {
  children?: React.ReactNode
  style?: StyleProp<ViewStyle>
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'none' | 'summary'
}

/** m-card */
export function Card({ children, style, onPress, onLongPress, disabled, accessibilityLabel, accessibilityRole }: CardProps) {
  const s = useStyles(makeS)
  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityRole={accessibilityRole ?? 'button'}
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [s.card, pressed && s.pressed, style]}
      >
        {children}
      </Pressable>
    )
  }
  return <View style={[s.card, style]}>{children}</View>
}

/** m-elev */
export function Elev({
  children,
  style,
}: {
  children?: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const s = useStyles(makeS)
  return <View style={[s.elev, style]}>{children}</View>
}

/** m-section-kicker (RTL-aware: Arabic drops uppercasing/letter-spacing so joining survives). */
export function Kicker({ children, style }: { children?: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <Text
      style={[
        s.kicker,
        {
          textAlign: dir.textAlign,
          writingDirection: dir.writingDirection,
          textTransform: dir.rtl ? 'none' : 'uppercase',
          letterSpacing: dir.rtl ? 0 : 0.75,
        },
        style,
      ]}
    >
      {children}
    </Text>
  )
}

/** 1px soft separator. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeS)
  return <View style={[s.divider, style]} />
}

// ─── Badges ─────────────────────────────────────────────────────────────────

export type PillKind = 'accent' | 'green' | 'amber' | 'red' | 'neutral'

/** m-pill */
export function Pill({
  kind = 'accent',
  children,
  style,
  textStyle,
  onPress,
  accessibilityLabel,
}: {
  kind?: PillKind
  children?: React.ReactNode
  style?: StyleProp<ViewStyle>
  textStyle?: StyleProp<TextStyle>
  onPress?: () => void
  accessibilityLabel?: string
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  const content =
    typeof children === 'string' || typeof children === 'number' ? (
      <Txt size={10.5} weight="700" color={pillInk(kind)} style={textStyle}>
        {children}
      </Txt>
    ) : (
      children
    )
  const box = <View style={[s.pill, { flexDirection: dir.row }, pillBackground(kind), style]}>{content}</View>
  if (!onPress) return box
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} hitSlop={4}>
      {({ pressed }) => <View style={[s.pill, { flexDirection: dir.row }, pillBackground(kind), pressed && s.pressed, style]}>{content}</View>}
    </Pressable>
  )
}

function pillBackground(kind: PillKind): ViewStyle {
  switch (kind) {
    case 'accent': return { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.border }
    case 'green': return { backgroundColor: C.greenTint }
    case 'amber': return { backgroundColor: C.amberSoft }
    case 'red': return { backgroundColor: C.redSoft }
    default: return { backgroundColor: C.bgElev }
  }
}

function pillInk(kind: PillKind): string {
  switch (kind) {
    case 'accent': return C.accent
    case 'green': return C.greenSoft
    case 'amber': return C.amber
    case 'red': return C.red
    default: return C.textDim
  }
}

export type DotKind = 'green' | 'amber' | 'red' | 'idle'

/** status-dot */
export function Dot({ kind = 'idle', size = 8, style }: { kind?: DotKind; size?: number; style?: StyleProp<ViewStyle> }) {
  const color = kind === 'green' ? C.greenSoft : kind === 'amber' ? C.amber : kind === 'red' ? C.red : C.textFaint
  return (
    <View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, flexShrink: 0 }, style]}
    />
  )
}

// ─── Buttons ────────────────────────────────────────────────────────────────

export interface BtnProps {
  label?: string
  children?: React.ReactNode
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  textStyle?: StyleProp<TextStyle>
  disabled?: boolean
  /** Compact padding for inline/card actions. */
  small?: boolean
  accessibilityLabel?: string
  testID?: string
}

/** m-btn-primary */
export function PrimaryBtn({
  label,
  children,
  onPress,
  style,
  textStyle,
  disabled,
  small,
  accessibilityLabel,
  testID,
}: BtnProps) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (typeof label === 'string' ? label : undefined)}
      testID={testID}
      style={({ pressed }) => [
        s.btnPrimary,
        { flexDirection: dir.row },
        small && { paddingVertical: 6, paddingHorizontal: 10 },
        disabled && s.disabled,
        pressed && s.btnPressed,
        style,
      ]}
    >
      {children ?? (
        <Txt size={small ? 11.5 : 13} weight="700" color={C.onAccent} style={textStyle}>
          {label}
        </Txt>
      )}
    </Pressable>
  )
}

/** m-btn-ghost */
export function GhostBtn({
  label,
  children,
  onPress,
  style,
  textStyle,
  disabled,
  small,
  accessibilityLabel,
  testID,
}: BtnProps) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (typeof label === 'string' ? label : undefined)}
      testID={testID}
      style={({ pressed }) => [
        s.btnGhost,
        { flexDirection: dir.row },
        small && { paddingVertical: 6, paddingHorizontal: 10 },
        disabled && s.disabled,
        pressed && s.btnPressed,
        style,
      ]}
    >
      {children ?? (
        <Txt size={small ? 11.5 : 12.5} weight="600" color={C.text} style={textStyle}>
          {label}
        </Txt>
      )}
    </Pressable>
  )
}

/** shell-icon-btn */
export function HeaderButton({
  onPress,
  children,
  style,
  accessibilityLabel,
  disabled,
}: {
  onPress?: () => void
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
  disabled?: boolean
}) {
  const s = useStyles(makeS)
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [s.shellBtn, disabled && s.disabled, pressed && s.pressed, style]}
    >
      {children}
    </Pressable>
  )
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface FieldProps extends TextInputProps {
  mono?: boolean
  /** Keep the text LTR (URLs, ids) even in Arabic. */
  ltr?: boolean
  /** Container style (the outer themed box). */
  wrapStyle?: StyleProp<ViewStyle>
}

/** m-input. Forwards its ref to the underlying TextInput. */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { mono, ltr, style, wrapStyle, multiline, ...rest },
  ref,
) {
  const dir = useDir()
  const s = useStyles(makeS)
  return (
    <View style={[s.inputWrap, wrapStyle]}>
      <TextInput
        ref={ref}
        {...rest}
        multiline={multiline}
        placeholderTextColor={rest.placeholderTextColor ?? C.textFaint}
        selectionColor={C.accent}
        style={[
          s.input,
          multiline && s.inputMultiline,
          mono && s.monoInput,
          { textAlign: ltr ? 'left' : dir.textAlign, writingDirection: ltr ? 'ltr' : dir.writingDirection },
          style,
        ]}
      />
    </View>
  )
})

// ─── Switches ───────────────────────────────────────────────────────────────

export interface SegmentOption<K extends string = string> {
  key: K
  label: string
}

/** 2-column segmented switch (Sessions|Bots, Commands|Skills, Yours|Browse). */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  tone = 'card',
  style,
}: {
  options: SegmentOption<K>[]
  value: K
  onChange: (key: K) => void
  tone?: 'card' | 'bg'
  style?: StyleProp<ViewStyle>
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <View style={[s.segWrap, { flexDirection: dir.row }, tone === 'bg' ? { backgroundColor: C.bg } : null, style]}>
      {options.map((o) => {
        const active = o.key === value
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [s.segItem, active && s.segItemOn, pressed && s.pressed]}
          >
            <Txt size={11.5} weight="700" color={active ? C.onAccent : C.textDim} center>
              {o.label}
            </Txt>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Settings/reasoning toggle. */
export function Toggle({
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  value: boolean
  onChange: (v: boolean) => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      style={[s.toggleTrack, { backgroundColor: value ? C.accent : C.bgHover }, style]}
    >
      <View
        style={[
          s.toggleKnob,
          {
            backgroundColor: value ? C.onAccent : '#fff',
            left: dir.rtl ? undefined : 2,
            right: dir.rtl ? 2 : undefined,
            transform: [{ translateX: value ? (dir.rtl ? -18 : 18) : 0 }],
          },
        ]}
      />
    </Pressable>
  )
}

// ─── Bottom sheet pieces ────────────────────────────────────────────────────

export function SheetGrabber({ style }: { style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeS)
  return <View style={[s.grabber, style]} />
}

export function SheetCard({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeS)
  return <View style={[s.sheetCard, style]}>{children}</View>
}

/** Scrim for hand-rolled overlays (Modal or absolute fill). */
export function SheetBackdrop({
  children,
  onPress,
  style,
}: {
  children?: React.ReactNode
  onPress?: () => void
  style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.62)' }, style]} onPress={onPress}>
      {children}
    </Pressable>
  )
}

// ─── Screen scroll ──────────────────────────────────────────────────────────

/** app-scroll — the standard padded scroll container for tab screens. */
export function ScreenScroll({
  children,
  contentContainerStyle,
  style,
  ...rest
}: ScrollViewProps & { children?: React.ReactNode }) {
  const s = useStyles(makeS)
  return (
    <ScrollView
      {...rest}
      style={[s.scroll, style]}
      contentContainerStyle={[s.scrollContent, contentContainerStyle]}
      keyboardShouldPersistTaps={rest.keyboardShouldPersistTaps ?? 'handled'}
    >
      {children}
    </ScrollView>
  )
}

export function Spinner({ size = 'small', color }: { size?: 'small' | 'large'; color?: string }) {
  return <ActivityIndicator size={size} color={color ?? C.textDim} />
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const makeS = () =>
  StyleSheet.create({
    mono: { fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }) },
    pressed: { opacity: 0.72 },
    disabled: { opacity: 0.45 },
    btnPressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },
    card: {
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: UI.cardRadius,
      padding: UI.cardPad,
      marginBottom: 10,
    },
    elev: {
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: UI.elevRadius,
      padding: 10,
    },
    kicker: {
      fontSize: 10.5,
      fontWeight: '700',
      letterSpacing: 0.75,
      textTransform: 'uppercase',
      color: C.textFaint,
      marginTop: 12,
      marginBottom: 6,
      marginHorizontal: 2,
    },
    divider: { height: 1, backgroundColor: C.borderSoft },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderRadius: UI.pillRadius,
    },
    btnPrimary: {
      backgroundColor: C.accent,
      borderRadius: UI.buttonRadius,
      paddingVertical: 9,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 6,
      minHeight: 36,
    },
    btnGhost: {
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: UI.buttonRadius,
      paddingVertical: 8,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 6,
      minHeight: 34,
    },
    shellBtn: {
      width: 32,
      height: 32,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: C.btnTint,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    inputWrap: {
      width: '100%',
      backgroundColor: C.inputBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: UI.inputRadius,
      overflow: 'hidden',
    },
    input: {
      color: C.text,
      fontSize: 13,
      paddingVertical: 9,
      paddingHorizontal: 11,
      minHeight: 36,
    },
    inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
    monoInput: { fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }) },
    segWrap: {
      flexDirection: 'row',
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 10,
      padding: 3,
      gap: 2,
    },
    segItem: {
      flex: 1,
      borderRadius: 8,
      paddingVertical: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segItemOn: { backgroundColor: C.accent },
    toggleTrack: { width: 42, height: 24, borderRadius: 12 },
    toggleKnob: { position: 'absolute', top: 2, width: 20, height: 20, borderRadius: 10 },
    grabber: {
      width: 36,
      height: 4,
      borderRadius: 999,
      backgroundColor: C.textFaint,
      opacity: 0.45,
      alignSelf: 'center',
      marginBottom: 10,
    },
    sheetCard: {
      backgroundColor: C.bgElev,
      borderTopWidth: 1,
      borderColor: C.border,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingTop: 10,
      paddingHorizontal: 14,
      paddingBottom: 26,
      maxHeight: '78%',
    },
    scroll: { flex: 1 },
    scrollContent: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 18 },
  })
