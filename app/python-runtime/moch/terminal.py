"""Interactive guest PTY session — the user's own live Ubuntu terminal.

Unlike ``linux_session.py`` (a pipe shell: ``TERM=dumb``, sentinel
framing, no cursor addressing — ``vim`` can never work there), this module
holds ONE persistent ``/bin/bash -i`` attached to a real pseudo-terminal
(``pty.openpty``). The pty sits on the HOST side of the proot boundary: the
guest argv is the same M8 shape as every other entry
(``linux_env.build_guest_launch`` — linker64 + native-lib ``PROOT_LOADER``,
EXEC-DESIGN.md §4.3), only its stdio is the pty slave instead of pipes. ANSI
escape sequences flow through untouched, so fullscreen programs work.

Transport to JS is poll-based (v1): the reader thread banks raw byte chunks
and Kotlin drains them on a timer — no Python→Java callbacks, no native
event emitter. Chunks leave as base64 (guest bytes are not valid UTF-8).

Lifecycle: started by ``start()``; dies with the process (daemon thread). A
dead shell restarts transparently on the next ``start()``. The agent's own
path (``exec_in_guest`` / ``linux_session``) is a SEPARATE proot process —
terminal input can never corrupt agent output and vice versa.

``_build_launch`` is an injectable seam (tests patch it to plain bash —
``linux_env.build_guest_launch`` needs the Android java bridge).
"""

from __future__ import annotations

import base64
import os
import select
import sys
import threading
import time
from collections import deque
from pathlib import Path

# Tunables (v1, single session).
_DRAIN_MAX_CHUNKS = 32
_DRAIN_MAX_BYTES = 256 * 1024
_REPLAY_MAX_BYTES = 64 * 1024
_READ_SIZE = 4096


def _log(msg: str) -> None:
    print(f"[moch-terminal] {msg}", file=sys.stderr, flush=True)


def _default_build_launch(guest_argv: list[str]) -> tuple[list[str], dict]:
    from moch import linux_env

    return linux_env.build_guest_launch(guest_argv)


# Injectable guest-launch seam: tests replace this with (["/bin/bash", "-i"], env).
_build_launch = _default_build_launch


def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


class _Session:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.proc = None
        self.master_fd: int | None = None
        self.reader: threading.Thread | None = None
        self.chunks: deque[bytes] = deque()
        self.chunks_bytes = 0
        self.replay: deque[bytes] = deque()
        self.replay_bytes = 0
        self.dead = True
        self.cols = 80
        self.rows = 24
        # Generation: bumped on every start/kill so a stale reader thread
        # (still inside its 0.5s select when its shell died) can neither
        # bank into the next session nor mark it dead on exit.
        self.gen = 0

    def _bank(self, data: bytes) -> None:
        self.chunks.append(data)
        self.chunks_bytes += len(data)
        self.replay.append(data)
        self.replay_bytes += len(data)
        while self.replay_bytes > _REPLAY_MAX_BYTES and self.replay:
            old = self.replay.popleft()
            self.replay_bytes -= len(old)


# SINGLE-SESSION CONTRACT: exactly one interactive pty exists per device —
# the RN Terminal screen, the Hermes bridge, and this module all assume one
# shared _Session behind this module global. A later start() replaces the
# previous shell (it closes the old process first). Multi-instance support
# = follow-up: turn this into a session-id -> _Session registry and thread
# ids through the bridge + TS layers with a multiplexed drain.
_state = _Session()


def pty_available() -> bool:
    """True when the host can allocate a pty (openpty + devpts)."""
    try:
        import pty  # noqa: F401
    except ImportError:
        return False
    try:
        m, s = os.openpty()
    except OSError:
        return False
    os.close(m)
    os.close(s)
    return True


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    try:
        import fcntl
        import struct
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception as exc:  # noqa: BLE001 — best effort (desktop fakes)
        _log(f"winsize ignored: {exc}")


def _reader_loop(master_fd: int, proc, gen: int) -> None:
    while True:
        with _state.lock:
            if gen != _state.gen:
                break  # superseded by a newer session — touch nothing
        try:
            r, _, _ = select.select([master_fd], [], [], 0.5)
        except (OSError, ValueError):
            break
        if not r:
            if proc.poll() is not None:
                break
            continue
        try:
            data = os.read(master_fd, _READ_SIZE)
        except OSError:
            break
        if not data:
            break
        with _state.lock:
            if gen == _state.gen:
                _state._bank(data)
    with _state.lock:
        if gen == _state.gen:
            _state.dead = True
    _log("reader exited (shell dead)")


def _spawn(cols: int, rows: int) -> dict:
    import pty
    import subprocess

    argv, env = _build_launch(["/bin/bash", "-i"])
    env = dict(env)
    env["TERM"] = "xterm-256color"
    env["HOME"] = "/root"
    master_fd, slave_fd = pty.openpty()
    _set_winsize(slave_fd, cols, rows)
    try:
        proc = subprocess.Popen(
            argv,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            close_fds=True,
            preexec_fn=os.setsid,  # own session: \x03 reaches the fg group
        )
    finally:
        os.close(slave_fd)  # parent keeps the master only
    return {"proc": proc, "master_fd": master_fd}


def start(cols: int = 80, rows: int = 24) -> dict:
    """Start the interactive shell. Idempotent while alive."""
    with _state.lock:
        if _state.proc is not None and _state.proc.poll() is None and not _state.dead:
            return {"ok": True, "already_running": True}
        _close_locked()
        if not pty_available():
            return {"ok": False, "error": "pty unavailable on this device"}
        try:
            linux_dir = _linux_dir()
        except Exception as exc:  # noqa: BLE001 — hermes home unresolvable
            return {"ok": False, "error": f"hermes home: {exc}"}
        if not (linux_dir / "bin" / "proot").exists() or not (linux_dir / "rootfs").exists():
            # Desktop-test seam: when _build_launch is patched, the guest
            # check is meaningless — the patched argv is the shell already.
            if _build_launch is _default_build_launch:
                return {"ok": False, "error": "guest not bootstrapped"}
        try:
            spawned = _spawn(int(cols) or 80, int(rows) or 24)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        _state.proc = spawned["proc"]
        _state.master_fd = spawned["master_fd"]
        _state.chunks.clear()
        _state.chunks_bytes = 0
        _state.dead = False
        _state.cols = int(cols) or 80
        _state.rows = int(rows) or 24
        _state.gen += 1
        gen = _state.gen
        reader = threading.Thread(
            target=_reader_loop, args=(_state.master_fd, _state.proc, gen), daemon=True
        )
        _state.reader = reader
        reader.start()
        _log(f"interactive shell started ({_state.cols}x{_state.rows})")
        return {"ok": True, "already_running": False}


def _close_locked() -> None:
    proc, fd = _state.proc, _state.master_fd
    _state.proc = None
    _state.master_fd = None
    _state.reader = None
    _state.dead = True
    _state.gen += 1  # orphan any lingering reader before it can clobber the next session
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def write(data_b64: str) -> dict:
    """Write bytes (base64) to the shell's stdin. ``\\x03`` = Ctrl+C."""
    try:
        data = base64.b64decode(data_b64, validate=True)
    except Exception:
        return {"ok": False, "error": "bad base64"}
    with _state.lock:
        if _state.master_fd is None or _state.dead:
            return {"ok": False, "error": "terminal not running"}
        try:
            os.write(_state.master_fd, data)
            return {"ok": True, "bytes": len(data)}
        except OSError as exc:
            return {"ok": False, "error": f"write: {exc}"}


def drain() -> dict:
    """Take up to _DRAIN_MAX_CHUNKS banked output chunks (base64 list)."""
    out: list[str] = []
    taken = 0
    with _state.lock:
        while _state.chunks and len(out) < _DRAIN_MAX_CHUNKS and taken < _DRAIN_MAX_BYTES:
            raw = _state.chunks.popleft()
            _state.chunks_bytes -= len(raw)
            taken += len(raw)
            out.append(base64.b64encode(raw).decode("ascii"))
        alive = not _state.dead and _state.proc is not None and _state.proc.poll() is None
    return {"ok": True, "chunks": out, "alive": alive}


def replay() -> dict:
    """Last ~64KB of output for reattach (cold screen repaint)."""
    with _state.lock:
        blob = b"".join(_state.replay)
        alive = not _state.dead and _state.proc is not None and _state.proc.poll() is None
    return {
        "ok": True,
        "chunk": base64.b64encode(blob).decode("ascii"),
        "alive": alive,
    }


def resize(cols: int, rows: int) -> dict:
    """TIOCSWINSZ the pty (rotation / font-size reflow)."""
    with _state.lock:
        if _state.master_fd is None or _state.dead:
            return {"ok": False, "error": "terminal not running"}
        _set_winsize(_state.master_fd, int(cols) or 80, int(rows) or 24)
        _state.cols = int(cols) or 80
        _state.rows = int(rows) or 24
        return {"ok": True, "cols": _state.cols, "rows": _state.rows}


def kill() -> dict:
    """Kill the shell (the dieable half). Next start() boots fresh."""
    with _state.lock:
        _close_locked()
        _state.chunks.clear()
        _state.chunks_bytes = 0
    _log("interactive shell killed")
    return {"ok": True}


def is_running() -> bool:
    with _state.lock:
        return not _state.dead and _state.proc is not None and _state.proc.poll() is None


def probe() -> dict:
    """On-device spike (phase 0): can this device do PTY + guest boot?

    Returns each capability separately so the UI can gate precisely:
    ``pty`` (openpty works), ``guest`` (rootfs present), ``shell``
    (a shell actually echoed through the pty).
    """
    result: dict = {"pty": pty_available(), "guest": False, "shell": False}
    if not result["pty"]:
        result["error"] = "pty unavailable on this device"
        return result
    try:
        linux_dir = _linux_dir()
        result["guest"] = (linux_dir / "bin" / "proot").exists() and (linux_dir / "rootfs").exists()
    except Exception:  # noqa: BLE001
        result["guest"] = False
    if _build_launch is _default_build_launch and not result["guest"]:
        result["error"] = "guest not bootstrapped"
        return result
    # Shell echo round-trip through a throwaway pty shell.
    import pty as _pty
    import subprocess

    try:
        argv, env = _build_launch(["/bin/bash", "-i"])
        env = dict(env)
        env["TERM"] = "xterm-256color"
        m, s = _pty.openpty()
        try:
            proc = subprocess.Popen(
                argv, stdin=s, stdout=s, stderr=s, env=env, close_fds=True
            )
        finally:
            pass
        os.close(s)
        marker = f"MOCH_PROBE_{os.getpid()}"
        os.write(m, f"echo {marker}\n".encode())
        deadline = time.monotonic() + 15
        buf = b""
        while time.monotonic() < deadline:
            r, _, _ = select.select([m], [], [], 0.5)
            if r:
                try:
                    piece = os.read(m, _READ_SIZE)
                except OSError:
                    break
                if not piece:
                    break
                buf += piece
                if marker.encode() in buf:
                    result["shell"] = True
                    break
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:  # noqa: BLE001
            pass
        os.close(m)
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result
