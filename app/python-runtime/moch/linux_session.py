"""Persistent guest shell session — the always-on Linux command engine.

Instead of spawning proot per command (process-launch tax on every call),
this module starts ONE proot-backed /bin/bash process at boot and keeps it
alive. Commands are written to its stdin; output is read from stdout until
a sentinel marker. This is the "Termux-fast" path: no boot cost, no ptrace
setup per command — just a pipe write + read.

Lifecycle: started by ``start()`` after the guest is bootstrapped; dies with
the process (daemon thread). If the shell dies (OOM, crash), the next
``run()`` transparently restarts it. If a command times out, the session is
POISONED (the sentinel/rc of the timed-out command are still in the pipe);
the next ``run()`` respawns the shell rather than trusting the desynced
stream (BH-000051 / GitHub #104 — correctness over reuse).

M8: launched through ``linux_env.build_guest_launch`` like every other guest
entry (linker64 + native-lib PROOT_LOADER — EXEC-DESIGN.md §4.4).
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

# RLock, not Lock: run() holds the lock across its whole body and calls
# start() (dead-shell respawn, BH-000051 poison respawn) which re-acquires —
# a plain Lock deadlocked there (latent in the old dead-shell path too).
_state: dict = {"proc": None, "lock": threading.RLock(), "started": False, "poisoned": False}
_SENTINEL = "__MOCH_CMD_DONE__"
# BH-000051 / GitHub #104: how long the best-effort drain after a timed-out
# command may block before the session is left for the respawn on next run().
_DRAIN_TIMEOUT_S = 3.0


def _log(msg: str) -> None:
    print(f"[moch-linux-session] {msg}", file=sys.stderr, flush=True)


def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


def _build_argv() -> tuple[list[str], dict]:
    """Shared M8 launch path: the linker64 prefix + native-lib PROOT_LOADER
    come from linux_env.build_guest_launch — the ONE argv/env shape for every
    guest entry (the M7.5 version execve'd the app-data proot directly and
    died EACCES under targetSdk 29+)."""
    from moch import linux_env

    argv, env = linux_env.build_guest_launch(["/bin/bash", "--norc", "--noprofile"])
    # Session-only extras: a quiet non-interactive shell with the guest's
    # own PATH/HOME — commands travel the pipes, there is no tty.
    env["TERM"] = "dumb"
    env["HOME"] = "/root"
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    return argv, env


def wrap_command(command: str) -> str:
    """The one command wrapper (BH-000051 / GitHub #104, extracted for tests):
    run the payload, then emit the sentinel and the exit code as two separate
    lines the reader protocol consumes."""
    return f"({command}) ; __rc=$? ; echo {_SENTINEL} ; echo $__rc"


def start() -> dict:
    """Start the persistent shell. Idempotent."""
    with _state["lock"]:
        if _state["proc"] and _state["proc"].poll() is None:
            return {"ok": True, "already_running": True}
        linux_dir = _linux_dir()
        if not (linux_dir / "bin" / "proot").exists() or not (linux_dir / "rootfs").exists():
            return {"ok": False, "error": "guest not bootstrapped"}
        try:
            argv, env = _build_argv()
            proc = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
            _state["proc"] = proc
            _state["started"] = True
            _state["poisoned"] = False  # a fresh shell has a fresh stream
            _log("persistent shell started")
            # Prime: wait for the first prompt
            proc.stdin.write(f"echo {(_SENTINEL)}\n")
            proc.stdin.flush()
            _read_reply(proc, timeout=10, want_rc=False)
            return {"ok": True, "already_running": False}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _read_reply(
    proc: subprocess.Popen, timeout: float = 60.0, want_rc: bool = True
) -> tuple[str, int | None]:
    """Read ONE command reply off the pipe: output lines until the sentinel,
    then (unless ``want_rc`` is False) the exit-code line that follows it.
    Returns ``(output, rc|None)``; raises TimeoutError past ``timeout``.

    BH-000051 / GitHub #104: reads RAW fd chunks and parses every complete
    line out of each chunk. The old shape (readline through the text wrapper,
    sentinel and rc read in two separate select loops) could leave the rc —
    or the whole sentinel+rc pair — buffered inside Python's TextIOWrapper,
    where select() cannot see it; those bytes then surfaced as the "reply"
    of the NEXT command (wrong stdout, wrong exit code). Chunk parsing keeps
    the reader in lockstep with the pipe: one command, one complete reply,
    nothing left over.
    """
    import selectors

    fd = proc.stdout.fileno()
    sel = selectors.DefaultSelector()
    sel.register(fd, selectors.EVENT_READ)
    lines: list[str] = []
    buf = b""
    got_sentinel = False
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            events = sel.select(timeout=0.5)
            for _key, _ in events:
                chunk = os.read(fd, 65536)
                if not chunk:
                    raise RuntimeError("shell stdout closed")
                buf += chunk
                # parse EVERY complete line already in hand — buffered lines
                # must never wait for another select() round
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", "replace")
                    if not got_sentinel:
                        if _SENTINEL in line:
                            got_sentinel = True
                            if not want_rc:
                                return "\n".join(lines), None
                        else:
                            lines.append(line)
                    else:
                        rc = line.strip()
                        return "\n".join(lines), int(rc) if rc.lstrip("-").isdigit() else -1
        raise TimeoutError(f"guest command timed out after {timeout}s")
    finally:
        sel.unregister(fd)
        sel.close()


def _drain_after_timeout(proc: subprocess.Popen, timeout: float = _DRAIN_TIMEOUT_S) -> None:
    """Best-effort drain after a timed-out command (BH-000051 / GitHub #104).

    The timed-out payload's sentinel + rc lines are still in the pipe (the
    shell keeps running the command); consume one full reply if it arrives
    within ``timeout`` so the stream does not sit with stale protocol bytes.
    Purely hygiene: the session is already marked poisoned and the next
    ``run()`` respawns the shell — correctness over reuse.
    """
    try:
        _read_reply(proc, timeout=timeout, want_rc=True)
    except Exception:  # noqa: BLE001 — best-effort by contract
        pass


def run(command: str, timeout_s: float = 60.0) -> dict:
    """Execute a command in the persistent guest shell. Returns stdout + exit code."""
    with _state["lock"]:
        if _state.get("poisoned"):
            # BH-000051 / GitHub #104: a previous command timed out and left
            # its sentinel/rc in the stream — trusting that stream would feed
            # the NEXT command the stale sentinel (wrong output, wrong exit
            # code, sometimes both). Correctness over reuse: respawn the
            # guest shell through the same path as a dead one.
            _log("session poisoned by a timed-out command — respawning shell…")
            proc = _state["proc"]
            if proc is not None:
                with contextlib.suppress(Exception):
                    proc.kill()
            _state["proc"] = None
            _state["poisoned"] = False
        proc = _state["proc"]
        if proc is None or proc.poll() is not None:
            _log("shell dead, restarting…")
            result = start()
            if not result.get("ok"):
                return result
            proc = _state["proc"]
        try:
            # Execute + emit sentinel + capture exit code — one atomic reply
            # (sentinel AND its rc line) off the pipe, nothing left behind
            wrapped = wrap_command(command)
            proc.stdin.write(wrapped + "\n")
            proc.stdin.flush()
            output, exit_code = _read_reply(proc, timeout=timeout_s, want_rc=True)
            return {"ok": exit_code == 0, "exit": exit_code, "stdout": output}
        except TimeoutError:
            # BH-000051: the sentinel/rc of THIS command are still coming.
            # Mark the session poisoned (never trust the stream again) and
            # drain best-effort; the next run() respawns.
            _state["poisoned"] = True
            _drain_after_timeout(proc)
            return {"ok": False, "error": "command timed out"}
        except Exception as exc:  # noqa: BLE001
            _log(f"run failed: {exc}; killing shell for restart")
            with contextlib.suppress(Exception):
                proc.kill()
            _state["proc"] = None
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def is_running() -> bool:
    proc = _state["proc"]
    return proc is not None and proc.poll() is None


def stop() -> None:
    """Kill the persistent shell (used on reset/uninstall)."""
    with _state["lock"]:
        proc = _state["proc"]
        if proc and proc.poll() is None:
            with contextlib.suppress(Exception):
                proc.stdin.write("exit\n")
                proc.stdin.flush()
                proc.wait(timeout=3)
            if proc.poll() is None:
                proc.kill()
        _state["proc"] = None
        _state["poisoned"] = False
        _log("persistent shell stopped")


import contextlib  # noqa: E402 — used in run/stop
