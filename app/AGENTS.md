# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Keyboard avoidance is MANDATORY for every input (BUG-133)

Under RN 0.86 edge-to-edge (targetSdk 36) the OS **never resizes this app** for the keyboard — the
manifest's `adjustResize` is inert and RN Modals get `adjustNothing`. Any new input WITHOUT explicit
JS-side avoidance will sit under the IME. There is no default behavior to rely on.

**Before shipping any TextInput / autoFocus / focus() / keyboard-opening surface, add avoidance in the
same PR, using one of the repo's proven patterns (never invent coordinate math):**

1. **Bottom-docked composer/box** (chat-pad pattern, see `app/(tabs)/chat.tsx` / `terminal.tsx`):
   `const kb = useReanimatedKeyboardAnimation()` + `paddingBottom: -kb.height.value` on a reanimated
   root containing everything that must rise. The surface's own bottom inset becomes the SINGLE owner:
   `paddingBottom: Math.max(Math.max(insets.bottom, 10) + kb.height.value, 0)` — never stack a
   SafeAreaView bottom edge on top of it (`edges={[]}`), and never a `kb < 0 ? 0 : …` ternary (it hops).
2. **Bottom sheet inside a Modal** (connectors pattern): `KeyboardAvoidingView` from
   `react-native-keyboard-controller` with `behavior="padding"` as the Modal's FULL-SCREEN root
   (wrapping the SafeAreaView, not inside it). NOT RN core's KAV (`behavior: undefined` on Android is a
   literal no-op) and NOT `'height'` (parent-relative frame math — rejected on-device, MIUI undershoot).
3. **Scrollable forms** (index/setup/add-computer/bot/agent pattern): `KeyboardAwareScrollView` from
   `react-native-keyboard-controller` instead of a plain ScrollView, plus
   `keyboardShouldPersistTaps="handled"` so first tap on a CTA isn't eaten.
4. **Top-anchored search over a list**: kbPad on the LIST container only (verifier outline #7) — the
   field stays put, results render above the keys.
5. **WebView**: no built-in IME handling — kbPad on the WebView's container.

`KeyboardProvider` is mounted at the app root over BOTH branches (`app/_layout.tsx`) — keep it that way;
a consumer outside it reads a dead context (shared values stuck at 0) and silently no-ops. Keep the
manifest's `adjustResize` (RNKC's heights depend on ime insets — never adjustPan). Verify on-device in
the next dev build: focused input + everything below it flush above the keys, on every screen you touched.
