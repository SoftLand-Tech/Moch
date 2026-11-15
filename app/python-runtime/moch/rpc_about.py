"""About-you memory for onboarding (ONBOARDING-V2).

Writes the launch profile's `memories/USER.md` through hermes' own MemoryStore
(`tools.memory_tool.load_on_disk_store`), so the file format, the char budget,
the threat scan and the system-prompt block all stay exactly what the agent
reads. Never invents a second store and never touches MEMORY.md.

`moch.profile.about` is deliberately append-only and idempotent: onboarding can
run twice without duplicating entries, and the UI can show what is already
there.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

_HEADER = "About me"


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _err(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _store():
    from tools.memory_tool import load_on_disk_store

    return load_on_disk_store()


def _entries(target: str = "user") -> list[str]:
    store = _store()
    store.load_from_disk()
    return list(getattr(store, "user_entries" if target == "user" else "memory_entries", []))


def read_about() -> dict:
    try:
        return {"ok": True, "entries": _entries("user")}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "entries": []}


def add_about(entries: list[str]) -> dict:
    """Append entries, skipping blanks and duplicates. Returns the final list."""
    store = _store()
    store.load_from_disk()
    added: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []
    for raw in entries:
        text = " ".join(str(raw or "").split()).strip()
        if not text:
            continue
        try:
            result = store.add("user", text)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{text[:40]}: {type(exc).__name__}: {exc}")
            continue
        if "already exists" in str(result.get("message") or ""):
            skipped.append(text)
        elif result.get("success"):
            added.append(text)
        else:
            errors.append(str(result.get("error") or result.get("message") or "add failed"))
    return {"ok": not errors, "added": added, "skipped": skipped, "errors": errors,
            "entries": list(getattr(store, "user_entries", []))}


def replace_about(entries: list[str]) -> dict:
    """Rewrite the user profile from the onboarding form (explicit user action).

    The MemoryStore has no bulk replace, so this removes every current entry and
    re-adds the submitted ones — drift-checked by the store itself.
    """
    store = _store()
    store.load_from_disk()
    current = list(getattr(store, "user_entries", []))
    for entry in current:
        with contextlib.suppress(Exception):
            store.remove("user", entry[:120])
    store = _store()
    store.load_from_disk()
    return add_about([e for e in entries if str(e or "").strip()])


def _user_md_path() -> Path:
    from tools.memory_tool import get_memory_dir

    return get_memory_dir() / "USER.md"


_REGISTERED = False


def install(tg_server) -> bool:
    global _REGISTERED
    if _REGISTERED:
        return True
    methods = getattr(tg_server, "_methods", None)
    if methods is None:
        return False

    def profile_about(rid, params):
        mode = str(params.get("mode") or "read")
        if mode == "read":
            return _ok(rid, {**read_about(), "path": str(_user_md_path())})
        if mode == "add":
            entries = params.get("entries")
            if not isinstance(entries, list):
                return _err(rid, 4001, "entries must be an array")
            return _ok(rid, add_about(entries))
        if mode == "replace":
            entries = params.get("entries")
            if not isinstance(entries, list):
                return _err(rid, 4001, "entries must be an array")
            return _ok(rid, replace_about(entries))
        return _err(rid, 4002, f"unknown mode: {mode}")

    methods.setdefault("moch.profile.about", profile_about)
    _REGISTERED = True
    return True
