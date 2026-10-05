"""Persistent guest shell session — the always-on Linux command engine.

Instead of spawning proot per command (process-launch tax on every call),
this module starts ONE proot-backed /bin/bash process at boot and keeps it
alive. Commands are written to its stdin; output is read from stdout until
a sentinel marker. This is the "Termux-fast" path: no boot cost, no ptrace
setup per command — just a pipe write + read.

Lifecycle: started by ``start()`` after the guest is bootstrapped; dies with
the process (daemon thread). If the shell dies (OOM, crash), the next
``run()`` transparently restarts it.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

_state: dict = {"proc": None, "lock": threading.Lock(), "started": False}
_SENTINEL = "__MOCH_CMD_DONE__"


def _log(msg: str) -> None:
    print(f"[moch-linux-session] {msg}", file=sys.stderr, flush=True)


def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


def _build_argv() -> list[str]:
    linux_dir = _linux_dir()
    proot = linux_dir / "bin" / "proot"
    rootfs = linux_dir / "rootfs"
    from moch import hermes_boot

    workspace = hermes_boot._hermes_home() / "workspace"
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(linux_dir / "bin" / "lib")
    env["TERM"] = "dumb"
    env["HOME"] = "/root"
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    return (
        [str(proot), "-r", str(rootfs), "-b", f"{workspace}:/workspace",
         "-b", "/dev", "-b", "/proc", "-0", "-w", "/root", "/bin/bash", "--norc", "--noprofile"],
        env,
    )


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
            _log("persistent shell started")
            # Prime: wait for the first prompt
            proc.stdin.write(f"echo {(_SENTINEL)}\n")
            proc.stdin.flush()
            _read_until_sentinel(proc, timeout=10)
            return {"ok": True, "already_running": False}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _read_until_sentinel(proc: subprocess.Popen, timeout: float = 60.0) -> str:
    """Read stdout lines until the sentinel appears; returns the output."""
    lines: list[str] = []
    deadline = time.monotonic() + timeout
    import selectors

    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            events = sel.select(timeout=0.5)
            for key, _ in events:
                line = proc.stdout.readline()
                if not line:
                    raise RuntimeError("shell stdout closed")
                stripped = line.rstrip("\n")
                if _SENTINEL in stripped:
                    return "\n".join(lines)
                lines.append(stripped)
        raise TimeoutError(f"guest command timed out after {timeout}s")
    finally:
        sel.unregister(proc.stdout)
        sel.close()


def run(command: str, timeout_s: float = 60.0) -> dict:
    """Execute a command in the persistent guest shell. Returns stdout + exit code."""
    with _state["lock"]:
        proc = _state["proc"]
        if proc is None or proc.poll() is not None:
            _log("shell dead, restarting…")
            result = start()
            if not result.get("ok"):
                return result
            proc = _state["proc"]
        try:
            # Execute + emit sentinel + capture exit code
            wrapped = f"({command}) ; __rc=$? ; echo {(_SENTINEL)} ; echo $__rc"
            proc.stdin.write(wrapped + "\n")
            proc.stdin.flush()
            output = _read_until_sentinel(proc, timeout=timeout_s)
            # Next line is the exit code
            import selectors

            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ)
            exit_code = -1
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                events = sel.select(timeout=1)
                for _key, _ in events:
                    rc_line = proc.stdout.readline().strip()
                    if rc_line.isdigit():
                        exit_code = int(rc_line)
                    break
                if exit_code >= 0:
                    break
            sel.unregister(proc.stdout)
            sel.close()
            return {"ok": exit_code == 0, "exit": exit_code, "stdout": output}
        except TimeoutError:
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
        _log("persistent shell stopped")


import contextlib  # noqa: E402 — used in run/stop
