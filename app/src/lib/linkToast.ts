/**
 * GH #109 / BUG-074-adjacent: the root layout's pairing/deep-link toast
 * (`linkMsg` in app/_layout.tsx) used to be write-only — set on a bad link or
 * a stale notification tap, then rendered FOREVER: never cleared on a new
 * link or a successful connect, not tap-dismissable, no auto-dismiss.
 *
 * This is the pure half of the fix (node-testable): the transition table the
 * layout funnels every linkMsg change through. The component owns the 7s
 * auto-dismiss timer and the Pressable; this owns what each event MEANS:
 *
 *   reset    — a new deep link arrived, or a dial succeeded: any old toast
 *              must go (it described the PREVIOUS link).
 *   error    — show the message ('' degrades to the generic pairing line; the
 *              old code rendered an empty toast for an Error with no message).
 *   dismiss  — the user tapped the toast.
 *   timeout  — the 7s auto-dismiss fired.
 *
 * This file must stay free of react-native/expo imports (scripts/ runs it in
 * plain node for unit tests).
 */

export const LINK_TOAST_FALLBACK = 'Bad pairing link'

export type LinkToastEvent =
  | { type: 'reset' }
  | { type: 'error'; message?: string }
  | { type: 'dismiss' }
  | { type: 'timeout' }

/** Next toast text for an event — null means "no toast". */
export function linkToast(_prev: string | null, ev: LinkToastEvent): string | null {
  switch (ev.type) {
    case 'error': {
      const msg = (ev.message ?? '').trim()
      return msg || LINK_TOAST_FALLBACK
    }
    case 'reset':
    case 'dismiss':
    case 'timeout':
      return null
  }
}
