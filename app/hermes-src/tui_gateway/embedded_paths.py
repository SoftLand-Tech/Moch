"""Guest ↔ host workspace paths for the embedded Moch gateway.

The Linux guest mounts the app's workspace (``MOCH_WORKSPACE``) at ``/workspace``
AND at its own host spelling (moch/linux_env.py build_guest_launch). A user may
type either spelling in the app: project folders and session cwds that start
with ``/workspace`` are guest paths and must be translated to the host path
before the gateway stats/mkdirs them (this process's filesystem is the Android
host, not the guest).

Only paths *inside* that workspace are translated. Any other caller path is
left byte-for-byte alone and is never created — the gateway must not mint
directories outside the bind the app owns.
"""

from __future__ import annotations

import os

GUEST_WORKSPACE = "/workspace"


def embedded_workspace() -> str | None:
    """The HOST dir bound at guest ``/workspace``, or ``None`` outside embedded Moch."""
    ws = str(os.environ.get("MOCH_WORKSPACE") or "").strip()
    return ws or None


def guest_workspace_host_path(raw: object) -> str | None:
    """Translate a guest-style ``/workspace[/...]`` path to its host path.

    Returns ``None`` when not embedded, when the value is not a guest path, or
    when the resolved target would escape the workspace (``/workspace/../x``).
    A bare ``/workspace`` maps to the workspace root itself.
    """
    if not isinstance(raw, str):
        return None
    ws = embedded_workspace()
    if not ws:
        return None
    path = raw.strip().replace("\\", "/")
    if not path:
        return None
    path = path.rstrip("/") or "/"
    if path == GUEST_WORKSPACE:
        return os.path.abspath(ws)
    prefix = GUEST_WORKSPACE + "/"
    if not path.startswith(prefix):
        return None
    rel = path[len(prefix):].lstrip("/")
    ws_abs = os.path.abspath(ws)
    target = os.path.abspath(os.path.normpath(os.path.join(ws_abs, rel)))
    if target != ws_abs and not target.startswith(ws_abs + os.sep):
        return None
    # Symlink-aware containment: a link inside the workspace must not let
    # makedirs/stat escape the bind. realpath resolves every existing prefix
    # (including a missing tail's nearest parent), so this catches both an
    # existing escaping target and `link/new`.
    ws_real = os.path.realpath(ws_abs)
    target_real = os.path.realpath(target)
    if target_real != ws_real and not target_real.startswith(ws_real + os.sep):
        return None
    return target


def map_guest_workspace_path(raw: object) -> object:
    """``host path`` for a guest workspace path, else ``raw`` unchanged."""
    return guest_workspace_host_path(raw) or raw
