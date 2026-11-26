/**
 * Pure gesture decisions for the drawer's panel drag while an IME is up.
 *
 * The drawer must never let a single horizontal gesture both dismiss the
 * keyboard and close the panel: when the IME is visible, the drag is a
 * one-gesture "dismiss the keyboard" mode that settles back to open. Only a
 * later gesture (with no IME) keeps the normal close behaviour.
 *
 * Deliberately free of react-native/expo imports so the plain-node test
 * (`scripts/test-sidebar-keyboard.ts`) can exercise the rules directly.
 *
 * Everything here works on the PanResponder gesture state (dx/dy in px) —
 * there is no keyboard-coordinate math; IME truth comes from RNKC.
 */

/** px of horizontal travel before a panel drag is claimed. */
const DEFAULT_EDGE_CLAIM = 10
/** |dx| must beat |dy| by this factor, so list scrolls and taps win. */
const DEFAULT_DOMINANCE = 1.5

/** The drawer's live interaction state at the moment a drag is claimed. */
export interface PanelDragState {
  /** Drawer is open (progress settled at 1). */
  open: boolean
  /** IME currently visible — `useKeyboardState((s) => s.isVisible)`. */
  keyboardVisible: boolean
  /** Drawer search input is focused; text-selection drags must stay native. */
  searchFocused: boolean
  /** Menu / rename / delete overlay is up; its drags are never panel drags. */
  dialogActive: boolean
}

/** PanResponder's horizontal gesture vector (plus the drawer direction). */
export interface PanelDragVector {
  dx: number
  dy: number
  /** Drawer docks to the right in RTL, so the close direction mirrors. */
  rtl: boolean
  /** Override for the travel threshold (Sidebar's shared EDGE_CLAIM). */
  edgeClaim?: number
  /** Override for the horizontal-dominance factor (Sidebar's DOMINANCE). */
  dominance?: number
}

/**
 * True when the gesture is a deliberate horizontal drag toward the drawer's
 * leading edge — the only drags the panel claims.
 */
function isPanelCloseDrag(v: PanelDragVector): boolean {
  const edgeClaim = v.edgeClaim ?? DEFAULT_EDGE_CLAIM
  const dominance = v.dominance ?? DEFAULT_DOMINANCE
  const towardClose = v.rtl ? v.dx > edgeClaim : v.dx < -edgeClaim
  return towardClose && Math.abs(v.dx) > Math.abs(v.dy) * dominance
}

/**
 * Claim the drag as a ONE-GESTURE IME dismissal: the keyboard is visible and
 * the drag belongs to the panel (not to search text selection, not to a
 * dialog). The caller dismisses the IME on grant, suppresses panel progress
 * for this gesture, and settles back to open.
 */
export function shouldDismissImeOnPanelDrag(
  state: PanelDragState,
  drag: PanelDragVector,
): boolean {
  return (
    state.open &&
    state.keyboardVisible &&
    !state.searchFocused &&
    !state.dialogActive &&
    isPanelCloseDrag(drag)
  )
}

/**
 * Claim the drag as a normal drawer close: no IME is up, so finger progress
 * maps 1 → 0 as before. Search-focused drags never close the drawer (native
 * text selection must keep working); dialog drags are blocked entirely.
 */
export function shouldClaimPanelClose(
  state: PanelDragState,
  drag: PanelDragVector,
): boolean {
  return (
    state.open &&
    !state.keyboardVisible &&
    !state.searchFocused &&
    !state.dialogActive &&
    isPanelCloseDrag(drag)
  )
}
