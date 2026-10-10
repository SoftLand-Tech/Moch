"""Moch fleet audit log (M9.1a): one append-only jsonl per install.

Location: ``<HERMES_HOME>/fleet/audit.jsonl`` (HERMES_HOME is read at CALL time,
not import time, so profile/home switching inside one process is honored).

Design per M9-BOTS.md v1.2.1 §2.8:
  - one fleet audit log for the whole install — DMs, spawns, freezes, approval
    decisions, outbound sends (extends the upstream A2A audit precedent);
  - size-capped rotation: 2 segments x 5 MB (``audit.jsonl`` + ``audit.jsonl.1``);
    when the live segment exceeds the cap it is rotated to ``.1`` (dropping the
    old ``.1``). Before renaming, a final ``{"event": "audit.rotate"}`` line is
    appended to the rotated segment so segment boundaries are visible in the
    data itself; the next event starts a fresh ``audit.jsonl``.
  - writing is best-effort: ``record()`` NEVER raises (a broken audit sink must
    not break the fleet); failures are swallowed after a stderr note.

Event vocabulary (all names dotted-lowercase; ``record`` stays generic — callers
may add new event types, keep the vocabulary documented here):
  - ``dm.send`` / ``dm.reply``        — DM-plane envelope accepted for delivery
  - ``spawn.request``                 — a spawn admission attempt started
  - ``spawn.approved``                — a spawn passed admission and was created
  - ``spawn.refused``                 — a spawn was refused (``code`` field)
  - ``spawn.tombstone``               — a spawned bot was tombstoned/melted
  - ``spawn.done``                    — a spawned bot's task completed
  - ``freeze`` / ``unfreeze``         — fleet kill-switch transitions
  - ``approval.decision``             — an approval card answered (grant/deny)
  - ``outbound.send``                 — bot-authored outbound message sent
  - ``audit.rotate``                  — log segment rotation marker (internal)
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024  # per segment
SEGMENTS = 2                 # audit.jsonl + audit.jsonl.1

_LOCK = threading.Lock()


def _paths() -> tuple[Path, Path]:
    """(live segment, rotated segment) — derived from HERMES_HOME at call time."""
    root = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "fleet"
    return root / "audit.jsonl", root / "audit.jsonl.1"


def record(event: str, **fields) -> None:
    """Append one event line: ``{"ts": ..., "event": event, **fields}``.

    Best-effort: never raises. Thread-safe.
    """
    line = json.dumps({"ts": time.time(), "event": event, **fields},
                      separators=(",", ":"), default=str)
    with _LOCK:
        try:
            _append(line)
        except Exception as exc:  # noqa: BLE001 — audit must never break the caller
            try:
                print(f"moch.audit: record failed: {exc}", file=sys.stderr)
            except Exception:
                pass


def _rotate(live: Path, rotated: Path) -> None:
    """Append the rotation marker, drop the oldest segment, continue fresh."""
    with open(live, "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.time(), "event": "audit.rotate"},
                           separators=(",", ":")) + "\n")
    if rotated.exists():
        rotated.unlink()
    live.rename(rotated)
    live.touch()


def _append(line: str) -> None:
    live, rotated = _paths()
    live.parent.mkdir(parents=True, exist_ok=True)
    if live.exists() and live.stat().st_size >= MAX_BYTES:
        # segment already above the cap before this write: rotate first
        _rotate(live, rotated)
    with open(live, "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()
    if live.stat().st_size >= MAX_BYTES:
        # the line we just wrote pushed the segment over the cap: rotate now
        # so the live segment never rests above the cap
        _rotate(live, rotated)


def events(limit: int = 100) -> list[dict]:
    """Read back the last ``limit`` events (audit viewer tail).

    Reads the live segment first, then the rotated one only if needed.
    Malformed lines are skipped; read errors yield an empty/partial list.
    """
    if limit <= 0:
        return []
    live, rotated = _paths()
    out: list[dict] = []
    try:
        _tail_into(live, limit, out)
        if len(out) < limit and rotated.is_file():
            _tail_into(rotated, limit - len(out), out)
    except Exception as exc:  # noqa: BLE001
        print(f"moch.audit: events() failed: {exc}", file=sys.stderr)
    return list(reversed(out))


def _tail_into(path: Path, limit: int, out: list[dict]) -> None:
    """Append the last <=limit parsed events from ``path`` to ``out`` (tail order)."""
    data = path.read_text(encoding="utf-8", errors="replace").splitlines()
    picked = 0
    for raw in reversed(data):
        if picked >= limit:
            break
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict):
            out.append(ev)
            picked += 1
