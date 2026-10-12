"""Moch spawn_bot tool (BUG-137, M9.1a stage 3): the missing door from bots
to SpawnBotService.

Design (M9 research, verified against this tree):
- Registration rides the EXISTING ``delegation`` toolset via a direct
  ``registry.register`` from this moch boot hook — zero vendored edits. A
  registry-only NEW toolset would never reach sessions (the platform
  reverse-map is static-only), but ``delegation`` already resolves for the
  mobile platform chain (source:'mobile' → hermes-cli composite →
  CONFIGURABLE_TOOLSETS → resolve_toolset merges registry members).
- check_fn gates on MOCH_FLEET (TTL-cached ~30 s process-wide by the
  registry). Boot-time install (before start_server) means every session's
  tool snapshot already includes it; no mid-conversation mutation.
- The parent bot is resolved from the CALL-TIME home (get_hermes_home
  honors the turn's profile override under multiplex); the parent's own
  spawn record (if the parent was itself spawned) supplies parent_depth.
- First-spawn-of-day / big-slice approval: SpawnBotService returns the
  structured ``approval-required`` refusal; we surface it as a REAL on-
  device approval card via ``tools.approval.request_tool_approval`` (the
  RN client already answers these) and re-issue with approved=True.
- Returns are ALWAYS JSON strings via ``tool_result`` (registry contract).
- Honest limits (documented, deliberate): no per-bot "may create helpers"
  toggle exists yet (§2.4 deferral — fleet flag + service caps govern);
  recursion is bounded by the service's depth cap (3 levels inclusive);
  disabling the delegation toolset removes this tool with it.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_SCHEMA = {
    "type": "function",
    "function": {
        "name": "spawn_bot",
        "description": (
            "Spawn an ephemeral crew bot (a scratch agent with its own memory) "
            "to run one task brief in parallel. Use for a self-contained "
            "subtask you don't need to handle inline; the helper is "
            "task-scoped, budget-capped, and reports back to you. Refusals "
            "are structured JSON you can read and relay (caps, depth, budget)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task_brief": {
                    "type": "string",
                    "description": "The task for the helper: goal, scope, and "
                                   "what to report back. This becomes the "
                                   "helper's job description.",
                },
                "est_tokens": {
                    "type": "integer",
                    "description": "Estimated token cost of the task "
                                   "(default 4000).",
                },
            },
            "required": ["task_brief"],
        },
    },
}

_SERVICE = None


def _service():
    """Lazy singleton with the production profiles.create injectable."""
    global _SERVICE
    if _SERVICE is None:
        from moch.spawn_bot import SpawnBotService

        def _profiles_create(name, soul, no_alias=True, mirror_credentials=True):
            # The gateway's own profiles.create RPC: pure Python, seeds the
            # full profile layout, mirrors the MODEL key only (§2.8).
            from tui_gateway import server as _srv
            methods = getattr(_srv, "_methods", {}) or {}
            res = methods["profiles.create"](0, {
                "name": name, "description": soul[:200], "soul": soul,
                "no_alias": True, "mirror_credentials": True})
            if isinstance(res, dict) and "error" in res:
                raise RuntimeError(str(res["error"].get("message")))
            return (res or {}).get("result") or {}

        _SERVICE = SpawnBotService(profiles_create=_profiles_create)
    return _SERVICE


def _parent_identity() -> tuple[str, str]:
    """(profile_name, home) of the CALLING bot — home from the call-time
    override (the turn binds the owning profile under multiplex); name from
    the profile dir, or 'default' when the home IS the launch home."""
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home()).resolve()
    launch = Path(os.environ.get("HERMES_HOME",
                                 str(Path.home() / ".hermes"))).resolve()
    name = "default" if home == launch else home.name
    return name, str(home)


def _parent_depth(service, parent: str) -> int:
    """Depth of the calling bot: 0 for user-created bots, else the depth
    recorded in its own spawn record (ancestry chain)."""
    with_context = service.records().get(parent)
    if isinstance(with_context, dict):
        try:
            return int(with_context.get("depth") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def _check() -> bool:
    """Tool availability: the fleet runtime must be armed."""
    return os.environ.get("MOCH_FLEET", "") == "1"


def _handler(args, **kw):  # noqa: ANN003 — registry contract (task_id/session_id/…)
    from tools.registry import tool_result

    brief = str((args or {}).get("task_brief") or "").strip()
    if not brief:
        return tool_result({"ok": False, "code": "bad-request",
                            "reason": "task_brief required"})
    try:
        est = int((args or {}).get("est_tokens") or 4000)
    except (TypeError, ValueError):
        est = 4000

    service = _service()
    parent, parent_home = _parent_identity()

    res = service.request(parent, parent_home, brief, est_tokens=est,
                          parent_depth=_parent_depth(service, parent),
                          approved=False)

    if res.get("ok") is False and res.get("code") == "approval-required":
        try:
            from tools.approval import request_tool_approval
        except ImportError:
            # No approval machinery on this surface: fail closed, structured.
            return tool_result(res)
        decision = request_tool_approval(
            "spawn_bot",
            f"{res.get('reason')} — slice {res.get('slice')} tokens, "
            f"first spawn today: {res.get('first_spawn_today')}",
            rule_key=f"spawn_bot:{parent}")
        if not decision.get("approved"):
            return tool_result({"ok": False, "code": "denied",
                                "reason": decision.get(
                                    "message") or "user denied the spawn"})
        res = service.request(parent, parent_home, brief, est_tokens=est,
                              parent_depth=_parent_depth(service, parent),
                              approved=True)

    # structured either way — the parent bot can read refusals and relay
    return tool_result(res)


def install() -> bool:
    """Flag-gated, idempotent registration onto the ``delegation`` toolset.
    Called from the gateway boot block BEFORE start_server, so every
    session's tool snapshot includes it (no live-refresh games)."""
    if os.environ.get("MOCH_FLEET") != "1" and \
            os.environ.get("MOCH_EMBEDDED") != "1":
        return False
    from tools.registry import registry
    if any(getattr(e, "name", None) == "spawn_bot"
           for e in registry.get_all_entries()):
        return False
    registry.register(
        name="spawn_bot",
        toolset="delegation",
        schema=json.loads(json.dumps(_SCHEMA)),  # defensive private copy
        handler=_handler,
        check_fn=_check,
        description="Spawn an ephemeral crew bot for a self-contained subtask.",
        emoji="🤖",
    )
    return True
