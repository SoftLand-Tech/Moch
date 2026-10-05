"""In-process slash worker for the embedded Android runtime.

hermes' ``_SlashWorker`` runs slash commands (automations "Run now", /cmd
handling) by spawning ``sys.executable -m tui_gateway.slash_worker``. Under
Chaquopy ``sys.executable`` is an app_process64 Android VM, which cannot
boot from a regular app process ("Error changing dalvik-cache ownership:
Permission denied") — so every child-interpreter spawn is dead on arrival.

This bridge keeps hermes' worker logic (the ``HermesCLI`` built by
``tui_gateway.slash_worker.main`` + its ``_run`` command executor) but runs
it on a daemon thread inside the gateway process, exposing the exact
``_SlashWorker`` surface the gateway consumes (``run``/``close``/
``stderr_tail``). Installed by ``moch.gateway_server`` via monkeypatch on
``tui_gateway.server._SlashWorker``.

Trade-offs vs the subprocess: no crash isolation (a hung command pins a
pool thread — same exposure as an ordinary prompt turn) and worker builds
are serialized by a global lock because ``HERMES_SESSION_KEY`` is process
env in the original child. Fine on a phone.
"""

from __future__ import annotations

import contextlib
import io
import logging
import threading

logger = logging.getLogger(__name__)

# One at a time across workers: the subprocess kept per-session state in a
# child env; in-process that env is shared, so builds and runs serialize.
_env_lock = threading.RLock()

_BUILD_TIMEOUT_S = 120.0


def _session_env(session_key: str):
    import os

    backup = (os.environ.get("HERMES_SESSION_KEY"), os.environ.get("HERMES_INTERACTIVE"))
    os.environ["HERMES_SESSION_KEY"] = session_key
    os.environ["HERMES_INTERACTIVE"] = "1"
    return backup


def _restore_env(backup) -> None:
    import os

    key, interactive = backup
    for name, value in (("HERMES_SESSION_KEY", key), ("HERMES_INTERACTIVE", interactive)):
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


class InProcessSlashWorker:
    """Drop-in for ``tui_gateway.server._SlashWorker`` (embedded runtime)."""

    def __init__(self, session_key: str, model: str = "", profile_home=None):
        self.session_key = session_key
        self.stderr_tail: list[str] = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._cli = None
        self._dead: str | None = None
        self._closed = False
        threading.Thread(
            target=self._build,
            args=(session_key, model or ""),
            name=f"moch-slash-build-{session_key[:8]}",
            daemon=True,
        ).start()

    def _build(self, session_key: str, model: str) -> None:
        backup = None
        try:
            with _env_lock:
                backup = _session_env(session_key)
                from cli import HermesCLI

                buf = io.StringIO()
                # Mirror the subprocess: CLI construction output is noise for
                # the caller; real failures land in stderr_tail (the surface
                # _SlashWorker.run reports on pipe close).
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    self._cli = HermesCLI(
                        model=model or None, compact=True, resume=session_key, verbose=False
                    )
        except Exception as exc:  # noqa: BLE001 — surfaced via run() like a dead child
            self._dead = f"{type(exc).__name__}: {exc}"
            self.stderr_tail = (self.stderr_tail + [self._dead])[-80:]
            logger.error("embedded slash worker build failed: %s", self._dead)
        finally:
            if backup is not None:
                _restore_env(backup)
            self._ready.set()

    def run(self, command: str) -> str:
        if self._closed:
            raise RuntimeError("slash worker closed")
        if self._dead is not None:
            raise RuntimeError(f"slash worker exited: {self._dead}")
        if not self._ready.wait(_BUILD_TIMEOUT_S) and self._cli is None:
            raise RuntimeError("slash worker build timed out")
        if self._cli is None:
            raise RuntimeError(f"slash worker exited: {self._dead or 'unknown error'}")
        with self._lock:
            with _env_lock:
                backup = _session_env(self.session_key)
                try:
                    from tui_gateway.slash_worker import _run

                    return str(_run(self._cli, command))
                except Exception as exc:  # noqa: BLE001 — matches worker error surface
                    raise RuntimeError(str(exc)) from exc
                finally:
                    _restore_env(backup)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._cli = None
