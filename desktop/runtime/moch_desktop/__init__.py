"""Moch Desktop — local hermes runtime for the desktop app.

This package boots the SAME vendored hermes-agent tree the phone ships
(``app/hermes-src``, plus the ``moch`` fleet runtime from
``app/python-runtime``) as a headless loopback gateway on this machine:

    Moch Desktop (Tauri)
      └─ spawns: python -m moch_desktop --port <p>
            └─ hermes_cli.web_server.start_server(127.0.0.1, <p>, headless)
                 └─ ws://127.0.0.1:<p>/api/ws  — v7 JSON-RPC, same as the phone

Differences from the Android embedding (``app/python-runtime/moch``):

* No Chaquopy / no Android restrictions: subprocess spawning works, so the
  upstream slash worker and cron paths stay stock. Only the FLEET runtime
  (in-process turn gate, DM bridge, kanban FleetWorker, spawn tool) is
  installed, because that is Moch's own bots surface — flag-gated on
  MOCH_FLEET=1 exactly like the phone.
* The gateway home defaults to a dedicated directory
  (``~/.local/share/moch-desktop/hermes``) so the desktop app never fights
  an existing ``~/.hermes`` install (hermes singletons the gateway with
  gateway.lock). First-run can IMPORT from an existing home (config, auth,
  provider keys, memories, skills) — see ``import_home()``.
* The workspace (where chats run / the terminal starts) is ``~/Moch`` — a
  visible folder in the user's home, not app-private storage.
* The browser is the system Chromium, managed by the Tauri side over CDP;
  when it is up we arm hermes' browser tools at the browser level via
  ``BROWSER_CDP_URL`` (the stock attach mode — no relay needed on desktop).
"""

from __future__ import annotations

__all__ = ["boot", "default_home", "workspace_dir"]
