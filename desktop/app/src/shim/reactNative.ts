/**
 * react-native shim for the few platform imports the shared engine makes
 * (AppState, Platform, I18nManager, NativeModules). Desktop answers:
 * always foreground, always web/LTR, no native modules (mochiRuntime
 * guards every HermesBridge access on its absence).
 */
export const AppState = {
  addEventListener(_kind: string, _cb: (state: string) => void): { remove(): void } {
    return { remove() {} }
  },
  get state(): string {
    return 'active'
  },
}

export const Platform = {
  OS: 'web' as const,
  select<T>(spec: { ios?: T; android?: T; web?: T; default?: T }): T {
    return (spec.web ?? spec.default) as T
  },
}

export const I18nManager = {
  isRTL: false,
  allowRTL(): void {},
  forceRTL(): void {},
}

export const NativeModules = {}
