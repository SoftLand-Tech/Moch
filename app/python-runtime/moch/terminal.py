"""Interactive guest PTY sessions — the user's own live Ubuntu terminals.

Unlike ``linux_session.py`` (a pipe shell: ``TERM=dumb``, sentinel
framing, no cursor addressing — ``vim`` can never work there), this module
holds persistent ``/bin/bash -i`` processes attached to real pseudo-terminals
(``pty.openpty``). Each pty sits on the HOST side of the proot boundary: the
guest argv is the same M8 shape as every other entry
(``linux_env.build_guest_launch`` — linker64 + native-lib ``PROOT_LOADER``,
EXEC-DESIGN.md §4.3), only its stdio is the pty slave instead of pipes. ANSI
escape sequences flow through untouched, so fullscreen programs work.

Sessions are a ``session_id -> _Session`` registry. The legacy module-level
functions (``start`` / ``write`` / …) are the ``__default__`` session — the
OpenCode hidden server launch still types into it. The Terminal screen uses
the per-session functions so every tab owns an isolated shell.

Transport to JS is poll-based: each reader thread banks raw byte chunks and
Kotlin drains one session on a timer — no Python→Java callbacks, no native
event emitter. Chunks leave as base64 (guest bytes are not valid UTF-8).

Lifecycle: a session starts on ``start_session``; dies with the process
(daemon thread). A dead shell restarts transparently on the next
``start_session``. Closing one session never touches another. The agent's own
path (``exec_in_guest`` / ``linux_session``) is a SEPARATE proot process —
terminal input can never corrupt agent output and vice versa.

``_build_launch`` is an injectable seam (tests patch it to plain bash —
``linux_env.build_guest_launch`` needs the Android java bridge).
"""

from __future__ import annotations

import base64
import os
import re
import select
import sys
import threading
import time
from collections import deque
from pathlib import Path

# Tunables.
_DRAIN_MAX_CHUNKS = 32
_DRAIN_MAX_BYTES = 256 * 1024
_REPLAY_MAX_BYTES = 64 * 1024
# Inactive tabs are not drained by design. Their pending queue must stay
# bounded even when a job floods output for hours: keep the newest 256 KiB
# (the reattach path repaints from the 64 KiB replay bank, not this queue).
_PENDING_MAX_BYTES = 256 * 1024
_READ_SIZE = 4096

LEGACY_SESSION_ID = "__default__"
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _log(msg: str) -> None:
    print(f"[moch-terminal] {msg}", file=sys.stderr, flush=True)


def _normalize_session_id(session_id: object) -> str | None:
    """Validate + normalize a session id (strip, length-bound, path-safe).

    ``None`` means invalid: empty, non-string, too long, or containing
    anything outside ``[A-Za-z0-9_.-]``. ``.``/``..`` are refused too so an
    id can never be mistaken for a directory. The legacy id passes here but
    is refused by every PUBLIC per-session function below — only the thin
    legacy wrappers may address the OpenCode server's hidden shell.
    """
    if not isinstance(session_id, str):
        return None
    sid = session_id.strip()
    if not sid or sid in (".", "..") or not _SESSION_ID_RE.fullmatch(sid):
        return None
    return sid


def _public_session_id(session_id: object) -> str | None:
    sid = _normalize_session_id(session_id)
    return None if sid == LEGACY_SESSION_ID else sid


def _default_build_launch(guest_argv: list[str], cwd: str | None = None) -> tuple[list[str], dict]:
    from moch import linux_env

    return linux_env.build_guest_launch(guest_argv, cwd)


# Injectable guest-launch seam: tests replace this with (["/bin/bash", "-i"], env).
_build_launch = _default_build_launch


def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


class _Session:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
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
        # bank into the next shell of THIS session nor mark it dead on exit.
        self.gen = 0

    def _bank(self, data: bytes) -> None:
        """Append reader output. Called with ``self.lock`` held."""
        self.chunks.append(data)
        self.chunks_bytes += len(data)
        while self.chunks_bytes > _PENDING_MAX_BYTES and len(self.chunks) > 1:
            old = self.chunks.popleft()
            self.chunks_bytes -= len(old)
        self.replay.append(data)
        self.replay_bytes += len(data)
        while self.replay_bytes > _REPLAY_MAX_BYTES and self.replay:
            overflow = self.replay_bytes - _REPLAY_MAX_BYTES
            head = self.replay[0]
            if len(head) <= overflow:
                self.replay.popleft()
                self.replay_bytes -= len(head)
            else:
                # Keep the bank at exactly the documented 64 KiB ceiling.
                self.replay[0] = head[overflow:]
                self.replay_bytes -= overflow

    def _alive_locked(self) -> bool:
        return not self.dead and self.proc is not None and self.proc.poll() is None


_sessions: dict[str, _Session] = {LEGACY_SESSION_ID: _Session(LEGACY_SESSION_ID)}
_registry_lock = threading.Lock()


def _lookup(session_id: str) -> _Session | None:
    with _registry_lock:
        return _sessions.get(session_id)


def _get_or_create(session_id: str) -> _Session:
    with _registry_lock:
        session = _sessions.get(session_id)
        if session is None:
            session = _Session(session_id)
            _sessions[session_id] = session
        return session


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


def _reader_loop(session: _Session, master_fd: int, proc, gen: int) -> None:
    while True:
        with session.lock:
            if gen != session.gen:
                break  # superseded by a newer shell in THIS session — touch nothing
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
        with session.lock:
            if gen == session.gen:
                session._bank(data)
    with session.lock:
        if gen == session.gen:
            session.dead = True
    _log(f"reader exited (shell dead: {session.session_id})")


def _spawn(session_id: str, cols: int, rows: int, cwd: str | None) -> dict:
    import pty
    import subprocess

    guest_argv = ["/bin/bash", "-i"]
    # cwd=None calls the seam with one argument so old desktop test patches
    # (``lambda argv: …``) keep working; a real cwd is a host path that
    # build_guest_launch translates/binds.
    if cwd is None:
        argv, env = _build_launch(guest_argv)
    else:
        argv, env = _build_launch(guest_argv, cwd)
    env = dict(env)
    # TERM only: HOME=/root and the guest PATH prefix come from
    # build_guest_launch now (BUG-134 — one HOME for every guest path, so
    # gh/git/ssh credentials written here are visible to agent exec too).
    env["TERM"] = "xterm-256color"
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
    _log(f"spawned {session_id}")
    return {"proc": proc, "master_fd": master_fd}


def _close_locked(session: _Session) -> None:
    """Close THIS session's pty + shell. Caller holds ``session.lock``."""
    proc, fd = session.proc, session.master_fd
    session.proc = None
    session.master_fd = None
    session.reader = None
    session.dead = True
    session.gen += 1  # orphan any lingering reader before it can clobber the next shell
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


def _clear_locked(session: _Session) -> None:
    session.chunks.clear()
    session.chunks_bytes = 0
    # BUG-115: the replay bank must reset with the shell it belonged to.
    session.replay.clear()
    session.replay_bytes = 0


def start_session(
    session_id: str,
    cwd: str | None = None,
    cols: int = 80,
    rows: int = 24,
    _allow_legacy: bool = False,
) -> dict:
    """Start (or reuse) one interactive shell for ``session_id``.

    ``cwd`` is a HOST path (the active project's ``primaryPath``) or None.
    ``linux_env.build_guest_launch`` maps it into the guest: paths under the
    workspace become ``/workspace/<rel>``, guest ``/workspace[/...]`` paths map
    back to the host workspace, and another existing host path is self-bound
    and used as the workdir. None/missing paths stay at ``/workspace``. This
    function never creates directories.
    """
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id"}
    cwd_value: str | None
    if cwd is None:
        cwd_value = None
    elif isinstance(cwd, str):
        cwd_value = cwd.strip() or None
    else:
        return {"ok": False, "error": "invalid cwd"}

    session = _get_or_create(sid)
    cols_n = int(cols) or 80
    rows_n = int(rows) or 24
    with session.lock:
        if session.proc is not None and session.proc.poll() is None and not session.dead:
            return {"ok": True, "already_running": True}
        _close_locked(session)
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
            spawned = _spawn(sid, cols_n, rows_n, cwd_value)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        session.proc = spawned["proc"]
        session.master_fd = spawned["master_fd"]
        _clear_locked(session)
        session.dead = False
        session.cols = cols_n
        session.rows = rows_n
        session.gen += 1
        gen = session.gen
        reader = threading.Thread(
            target=_reader_loop,
            args=(session, session.master_fd, session.proc, gen),
            daemon=True,
            name=f"moch-term-{sid}",
        )
        session.reader = reader
        reader.start()
    _log(f"interactive shell started ({sid}, {cols_n}x{rows_n})")
    return {"ok": True, "already_running": False}


def write_session(session_id: str, data_b64: str, _allow_legacy: bool = False) -> dict:
    """Write bytes (base64) to one session's stdin. ``\\x03`` = Ctrl+C."""
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id"}
    try:
        data = base64.b64decode(data_b64, validate=True)
    except Exception:
        return {"ok": False, "error": "bad base64"}
    session = _lookup(sid)
    if session is None:
        return {"ok": False, "error": "unknown session"}
    with session.lock:
        if session.master_fd is None or session.dead:
            return {"ok": False, "error": "terminal not running"}
        try:
            os.write(session.master_fd, data)
            return {"ok": True, "bytes": len(data)}
        except OSError as exc:
            return {"ok": False, "error": f"write: {exc}"}


def drain_session(session_id: str, _allow_legacy: bool = False) -> dict:
    """Take up to _DRAIN_MAX_CHUNKS banked output chunks (base64 list)."""
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id", "chunks": [], "alive": False}
    session = _lookup(sid)
    if session is None:
        return {"ok": True, "chunks": [], "alive": False}
    out: list[str] = []
    taken = 0
    with session.lock:
        while (
            session.chunks
            and len(out) < _DRAIN_MAX_CHUNKS
            and taken < _DRAIN_MAX_BYTES
        ):
            raw = session.chunks.popleft()
            session.chunks_bytes -= len(raw)
            taken += len(raw)
            out.append(base64.b64encode(raw).decode("ascii"))
        alive = session._alive_locked()
    return {"ok": True, "chunks": out, "alive": alive}


def replay_session(session_id: str, _allow_legacy: bool = False) -> dict:
    """Reattach snapshot for one session (last ~64KB, base64).

    Atomically consumes the pending drain queue: those bytes are already in
    the replay bank (up to the 64 KiB cap), so the next ``drain_session``
    returns only output produced after this snapshot. That keeps a remounted
    xterm from painting the same bytes twice.
    """
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id", "chunk": "", "alive": False}
    session = _lookup(sid)
    if session is None:
        return {"ok": True, "chunk": "", "alive": False}
    with session.lock:
        blob = b"".join(session.replay)
        session.chunks.clear()
        session.chunks_bytes = 0
        alive = session._alive_locked()
    return {
        "ok": True,
        "chunk": base64.b64encode(blob).decode("ascii"),
        "alive": alive,
    }


def clear_session(session_id: str, _allow_legacy: bool = False) -> dict:
    """Drop one session's scrollback (live queue + replay bank), keep the shell.

    The Terminal header's Clear must stay cleared when its tab is switched
    away and reattached; wiping only the TS bank would let the old replay
    resurrect on the next remount.
    """
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id"}
    session = _lookup(sid)
    if session is None:
        return {"ok": True}
    with session.lock:
        _clear_locked(session)
    return {"ok": True}


def resize_session(session_id: str, cols: int, rows: int, _allow_legacy: bool = False) -> dict:
    """TIOCSWINSZ one pty (rotation / font-size reflow)."""
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id"}
    session = _lookup(sid)
    if session is None:
        return {"ok": False, "error": "unknown session"}
    with session.lock:
        if session.master_fd is None or session.dead:
            return {"ok": False, "error": "terminal not running"}
        session.cols = int(cols) or 80
        session.rows = int(rows) or 24
        _set_winsize(session.master_fd, session.cols, session.rows)
        return {"ok": True, "cols": session.cols, "rows": session.rows}


def kill_session(session_id: str, _allow_legacy: bool = False) -> dict:
    """Kill one shell and drop its registry entry. Other sessions untouched."""
    sid = _public_session_id(session_id) if not _allow_legacy else _normalize_session_id(session_id)
    if sid is None:
        return {"ok": False, "error": "invalid session id"}
    session = _lookup(sid)
    if session is None:
        return {"ok": True}
    with session.lock:
        _close_locked(session)
        _clear_locked(session)
    if sid != LEGACY_SESSION_ID:
        with _registry_lock:
            _sessions.pop(sid, None)
    _log(f"interactive shell killed ({sid})")
    return {"ok": True}


def is_session_running(session_id: str) -> bool:
    sid = _normalize_session_id(session_id)
    if sid is None:
        return False
    session = _lookup(sid)
    if session is None:
        return False
    with session.lock:
        return session._alive_locked()


# ── Legacy default session ──────────────────────────────────────────────────
# The OpenCode hidden server launch still types into this one shell; keep
# every signature and result shape exactly as before.


def start(cols: int = 80, rows: int = 24) -> dict:
    """Start the legacy interactive shell. Idempotent while alive."""
    return start_session(LEGACY_SESSION_ID, None, cols, rows, _allow_legacy=True)


def write(data_b64: str) -> dict:
    """Write bytes (base64) to the legacy shell's stdin."""
    return write_session(LEGACY_SESSION_ID, data_b64, _allow_legacy=True)


def drain() -> dict:
    """Take up to _DRAIN_MAX_CHUNKS banked output chunks (base64 list)."""
    return drain_session(LEGACY_SESSION_ID, _allow_legacy=True)


def replay() -> dict:
    """Last ~64KB of output for reattach (cold screen repaint)."""
    return replay_session(LEGACY_SESSION_ID, _allow_legacy=True)


def resize(cols: int, rows: int) -> dict:
    """TIOCSWINSZ the legacy pty (rotation / font-size reflow)."""
    return resize_session(LEGACY_SESSION_ID, cols, rows, _allow_legacy=True)


def kill() -> dict:
    """Kill the legacy shell (the dieable half). Next start() boots fresh."""
    return kill_session(LEGACY_SESSION_ID, _allow_legacy=True)


def is_running() -> bool:
    return is_session_running(LEGACY_SESSION_ID)


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
