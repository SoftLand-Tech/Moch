/**
 * Terminal-completion gate for `message.complete` (BUG-130), node-safe so the
 * truth table lives in scripts/test-turn-complete.ts. No imports from
 * chat.ts or the gateway — this file must load in plain node.
 *
 * WHY: the gateway emits `message.complete` from FOUR sites
 * (contracts/events.py `MessageCompletePayload` documents the same split):
 *   1. the real turn end        — prompt_turn.py::_complete_turn_payload
 *                                  (always carries `usage` AND `status`;
 *                                  server `_get_usage` always returns a dict)
 *   2. auto-continue terminal   — session_auto_continue.py
 *      error                      (carries `usage` + `status:"error"`)
 *   3. compute-host end         — compute_host_bridge.py
 *                                  (carries `text` + `status:"error"`)
 *   4. the SUBAGENT MIRROR      — tui_gateway/agent_callbacks.py::
 *                                  _mirror_subagent_to_child
 *                                  (carries `text` ONLY — no usage, no status)
 *
 * The mirror (#4) can arrive while the parent turn is still running. Treating
 * it as terminal flips the composer to idle mid-turn: the Stop button and
 * Steer chip vanish (chat.tsx gates both on `busy`) and the user loses the
 * ability to stop or steer a turn that is actually still going.
 *
 * The mirror is the ONLY payload with neither `usage` nor `status`, so field
 * presence is a sound terminal discriminator.
 */

/** True when a `message.complete` payload genuinely ends the turn (vs the
 *  subagent mirror's text-only mid-turn update). */
export function isTerminalComplete(p: { usage?: unknown; status?: unknown }): boolean {
  return p.usage !== undefined || p.status !== undefined
}
