"""Provider credentials, made effective immediately (ONBOARDING-V2).

The vendored gateway's `model.save_key` / `model.disconnect` write `.env`, rotate
config.yaml mirrors and refresh the credential pool — but a LIVE agent keeps the
client it built at session start. On device that read as "I changed/deleted my
key and nothing happened until I restarted the app".

This module wraps both methods and, after the original succeeds, re-points every
live session that used the provider at the new credential:

- `agent.credential_pool.load_pool(provider)` re-reads the pool,
- the session's current model is re-applied through the gateway's own switch
  path, which rebuilds the OpenAI/Anthropic client from disk,
- `session.info` is emitted so the model chip follows.

Nothing here changes behavior when no live session uses the provider (the
common case), and nothing writes a vendored file.
"""

from __future__ import annotations

import contextlib

_REGISTERED = False

_PROVIDER_ENV: dict[str, tuple[str, ...]] = {}


def _provider_env_vars(slug: str) -> tuple[str, ...]:
    """Provider slug -> its `.env` variable(s), from the live registry."""
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY

        cfg = PROVIDER_REGISTRY.get(slug)
        return tuple(getattr(cfg, "api_key_env_vars", ()) or ())
    except Exception:
        return ()


def _live_sessions_for(tg_server, slug: str) -> list[tuple[str, dict, object]]:
    """(sid, session, agent) for every live session whose agent uses `slug`."""
    out: list[tuple[str, dict, object]] = []
    sessions = getattr(tg_server, "_sessions", None)
    if not isinstance(sessions, dict):
        return out
    wanted = (slug or "").strip().lower()
    for sid, session in list(sessions.items()):
        agent = (session or {}).get("agent") if isinstance(session, dict) else None
        if agent is None:
            continue
        provider = str(getattr(agent, "provider", "") or "").strip().lower()
        if provider and provider == wanted:
            out.append((sid, session, agent))
    return out


def _refresh_agent(tg_server, sid: str, session: dict, agent, slug: str) -> tuple[bool, str]:
    """Reload the pool + rebuild the live client for one session."""
    # 1) Pool: the runtime reads it on 401/429 and on the next switch.
    with contextlib.suppress(Exception):
        from agent import credential_pool

        credential_pool.load_pool(slug)

    # 2) Rebuild the client through the gateway's own switch path. A busy
    # session must not swap under a streaming turn: stash it as the pending
    # model switch, which is exactly how a user's /model pick is deferred.
    model = str(getattr(agent, "model", "") or "")
    provider = str(getattr(agent, "provider", "") or "")
    if not model:
        return False, "agent has no model"
    raw = f"{model}" + (f" --provider {provider}" if provider else "")
    try:
        if session.get("running"):
            session["pending_model_switch"] = {
                "raw": raw,
                "confirm_expensive_model": True,
                "display_model": model,
                "display_provider": provider,
            }
            return True, "deferred (turn running)"
        from tui_gateway import prompt_turn

        prompt_turn._apply_model_switch(sid, session, raw, confirm_expensive_model=True)
        with contextlib.suppress(Exception):
            from tui_gateway import methods_config_set

            methods_config_set._emit_session_info(sid, session)
        return True, "rebuilt"
    except Exception as exc:  # noqa: BLE001 — a credential refresh must never break the RPC
        return False, f"{type(exc).__name__}: {exc}"


def install(tg_server) -> bool:
    """Wrap model.save_key / model.disconnect once. Idempotent, all-local."""
    global _REGISTERED
    if _REGISTERED:
        return True
    methods = getattr(tg_server, "_methods", None)
    if methods is None:
        return False
    save = methods.get("model.save_key")
    drop = methods.get("model.disconnect")
    if save is None or drop is None:
        return False

    def wrap(original, *, on_success):
        def handler(rid, params):
            response = original(rid, params)
            try:
                if isinstance(response, dict) and "result" in response:
                    slug = str((params or {}).get("slug") or "").strip()
                    if slug:
                        on_success(slug, params)
            except Exception:
                # Never turn a successful save/delete into an RPC error because
                # the live-session refresh failed; the disk state is the truth.
                pass
            return response

        return handler

    def refresh_all(slug: str, _params) -> None:
        for sid, session, agent in _live_sessions_for(tg_server, slug):
            _refresh_agent(tg_server, sid, session, agent, slug)

    def after_disconnect(slug: str, _params) -> None:
        # A deleted key must not leave the live chat pinned to that provider.
        for sid, session, agent in _live_sessions_for(tg_server, slug):
            session.pop("pending_model_switch", None)
            session.pop("model_override", None)
            _refresh_agent(tg_server, sid, session, agent, slug)

    methods["model.save_key"] = wrap(save, on_success=refresh_all)
    methods["model.disconnect"] = wrap(drop, on_success=after_disconnect)
    _REGISTERED = True
    return True
