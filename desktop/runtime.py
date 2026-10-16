"""Moch Desktop runtime runner.

Runs the SAME embedded gateway the phone app runs
(app/python-runtime/moch/gateway_server.py) as a supervised child process:

  - MOCH_FLEET=1 (BUG-109: without it moch.fleet.status / moch.kanban.tasks /
    moch.profiles.delete answer "unknown method" — the bots/crew surface
    literally does not install)
  - in-process slash worker, fleet admission gate, dm bridge
  - HERMES_DESKTOP=1 (cron ticker for automations)
  - headless serve via hermes_cli.web_server (no cli.py interactive checks,
    so a fresh provider-less home still boots — setup happens over RPC)

Emits one machine-readable line for the Rust shell:
  MOCH_GATEWAY_INFO {"port": ..., "token": ..., ..., "pty_port": ...}
then blocks forever (the gateway runs on a daemon thread).

Also runs the Terminal PTY bridge: one bash on a PTY per WebSocket client,
on 127.0.0.1:<pty_port> (MOCH_PTY_PORT, default 9335). The bridge lives in
its own daemon thread/event loop and never takes the gateway down.
"""
import asyncio
import fcntl
import hmac
import json
import os
import pty
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
import urllib.request


def _on_sigterm(_signum, _frame):
    # The Rust supervisor SIGTERMs us on exit — leave quietly instead of
    # unwinding with a traceback. Take the agent browser with us.
    _stop_browser()
    sys.exit(0)


signal.signal(signal.SIGTERM, _on_sigterm)

FORK = os.environ.get("MOCH_FORK_SRC", "")
RUNTIME_PKGS = os.environ.get("MOCH_RUNTIME_PKGS", "")
for p in (FORK, RUNTIME_PKGS):
    if p and p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("MOCH_FLEET", "1")
os.environ.setdefault("HERMES_DESKTOP", "1")

# Agent browser: a Moch-owned Chromium with a CDP debug port, spawned
# before the gateway so the tool-catalog memo (model_tools.py:278-285)
# sees BROWSER_CDP_URL. The agent tool layer does NOT auto-discover CDP —
# it reads exactly this env var (tools/browser_tool_cdp.py:51-60).
_browser_proc = None


def _stop_browser():
    global _browser_proc
    if _browser_proc is not None:
        try:
            _browser_proc.terminate()
            _browser_proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                _browser_proc.kill()
            except Exception:  # noqa: BLE001
                pass
        _browser_proc = None


def _spawn_browser():
    """Spawn chromium with --remote-debugging-port and publish BROWSER_CDP_URL.

    Same flag set the repo's own launcher uses (hermes_cli/browser_connect.py:
    764-766) plus --headless + --window-size; readiness = 2xx from GET
    /json/version (:777-800). A Moch-owned --user-data-dir is mandatory:
    Chromium >=136 refuses CDP on the default profile (:315-317) and a
    same-profile singleton silently absorbs the launch (:898-904). Headless,
    not windowed: a windowed Chromium stops compositing when fully occluded,
    so Page.startScreencast frames go stale; headless composites regardless
    (and defaults to 800x600 without an explicit --window-size). Returns the
    listening port or None."""
    global _browser_proc
    if os.environ.get("MOCH_BROWSER", "1") != "1":
        return None
    exe = None
    for name in ("chromium", "chromium-browser", "google-chrome",
                 "google-chrome-stable"):
        exe = shutil.which(name)
        if exe:
            break
    if not exe:
        print("agent browser: no chromium/chrome on PATH — skipping",
              file=sys.stderr, flush=True)
        return None
    home = os.environ.get("HERMES_HOME", "")
    profile = os.path.join(home, "browser", "chrome-profile")
    os.makedirs(profile, exist_ok=True)
    preferred = int(os.environ.get("MOCH_BROWSER_PORT", "9222"))
    for port in range(preferred, preferred + 10):
        try:
            _browser_proc = subprocess.Popen(
                [exe,
                 f"--remote-debugging-port={port}",
                 f"--user-data-dir={profile}",
                 # Headless: an occluded windowed Chromium pushes no compositor
                 # output, so the Browser pane's screencast freezes. Headless
                 # composites regardless; 1440x900 so frames are full-size.
                 "--headless",
                 "--window-size=1440,900",
                 "--no-first-run",
                 "--no-default-browser-check"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True)
        except Exception as e:  # noqa: BLE001
            print(f"agent browser spawn failed: {e}", file=sys.stderr,
                  flush=True)
            return None
        url = f"http://127.0.0.1:{port}/json/version"
        for _ in range(30):  # 15s readiness window
            time.sleep(0.5)
            if _browser_proc.poll() is not None:
                break  # died/singleton-absorbed — try the next port
            try:
                with urllib.request.urlopen(url, timeout=1) as r:  # noqa: S310
                    if 200 <= r.status < 300:
                        os.environ["BROWSER_CDP_URL"] = (
                            f"http://127.0.0.1:{port}")
                        # loopback probes must not ride a system proxy
                        os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
                        print(f"agent browser: {exe} ready on :{port}",
                              flush=True)
                        return port
            except Exception:  # noqa: BLE001
                continue
        _stop_browser()  # never came up on this port — try the next one
    print("agent browser: no free debug port "
          f"({preferred}..{preferred + 9})", file=sys.stderr, flush=True)
    return None


from moch import gateway_server  # noqa: E402

# ---------------------------------------------------------------------------
# Terminal PTY bridge — one bash on a PTY per WebSocket client.
#
# Own daemon thread + event loop; a crash in the bridge (or in one session)
# must never take the gateway process down, so every layer is guarded and
# the server restarts with a backoff instead of dying.
#
# Protocol (loopback only, token-gated):
#   server -> client  binary frames: raw PTY bytes
#   client -> server  text frames:   keystroke bytes (utf-8)
#   client -> server  text frame JSON: {"type":"resize","cols":C,"rows":R}
#   client -> server  binary frames: keystroke bytes (accepted, same as text)
#
# The port is fixed by default (9335) because the UI can only learn runtime
# facts through what runtime.py publishes: the actual port is mirrored into
# the handshake info as "pty_port" (printed line + .moch-gateway.json).
# ---------------------------------------------------------------------------

PTY_HOST = "127.0.0.1"
PTY_PORT_DEFAULT = int(os.environ.get("MOCH_PTY_PORT", "9335"))

# Lazy-bound at module scope but failure-tolerant: a missing websockets
# package must disable only the bridge, never the gateway process.
try:
    from websockets.asyncio.server import serve
except ImportError:  # pragma: no cover
    serve = None


class PtySession:
    """One client's shell: master fd + child pid + pump wiring.

    Owns exactly one bash on one PTY; two connections never share state.
    close() is idempotent — every failure path funnels into it.
    """

    def __init__(self, conn):
        self._conn = conn
        self._pid, self._fd = pty.fork()
        if self._pid == 0:  # child — exec a shell, never returns
            os.environ["TERM"] = "xterm-256color"
            os.environ.setdefault("COLORTERM", "truecolor")
            for sh in ("bash", "/bin/bash", "/bin/sh"):
                try:
                    os.execvp(sh, [sh])
                except OSError:
                    continue
            os._exit(127)  # execvp failed even for /bin/sh
        os.set_blocking(self._fd, False)
        self._closed = False
        self._pending = bytearray()  # keystrokes the pty hasn't accepted yet
        self._output: asyncio.Queue[bytes] = asyncio.Queue()
        self._loop = asyncio.get_running_loop()
        self._pump_task = self._loop.create_task(self._pump())
        # Shell exit (EIO/EOF) ends the pump; the session — and the
        # websocket — must close with it, not linger on a dead pty.
        self._pump_task.add_done_callback(self._on_pump_done)
        self._sender_task = self._loop.create_task(self._sender())

    def _on_pump_done(self, task) -> None:
        if not task.cancelled():
            self._loop.create_task(self.close())

    # -- client -> pty -----------------------------------------------------

    def write(self, data: bytes) -> None:
        if self._closed:
            return
        self._pending.extend(data)
        try:
            self._loop.add_writer(self._fd, self._flush_input)
        except (ValueError, OSError):
            pass

    def _flush_input(self) -> None:
        if self._closed:
            return
        try:
            n = os.write(self._fd, bytes(self._pending))
        except BlockingIOError:
            return  # stays registered; retried when writable again
        except OSError:
            self._loop.create_task(self.close())
            return
        del self._pending[:n]
        if not self._pending:
            try:
                self._loop.remove_writer(self._fd)
            except (ValueError, OSError):
                pass

    def resize(self, cols: int, rows: int) -> None:
        if self._closed:
            return
        packed = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
        try:
            fcntl.ioctl(self._fd, termios.TIOCSWINSZ, packed)
        except OSError:
            pass  # pty already gone; close() will follow

    # -- pty -> client -----------------------------------------------------

    async def _pump(self) -> None:
        # Readability is event-driven (add_reader); the coroutine itself just
        # parks on `done` until close() or the shell exits.
        done = self._loop.create_future()
        try:
            self._loop.add_reader(self._fd, self._on_readable, done)
            await done
        except asyncio.CancelledError:
            raise
        finally:
            try:
                self._loop.remove_reader(self._fd)
            except (ValueError, OSError):
                pass

    def _on_readable(self, done) -> None:
        if self._closed:
            return
        try:
            chunk = os.read(self._fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            done.set_result(None)  # EIO: shell exited (Linux PTY behavior)
            return
        if not chunk:
            done.set_result(None)  # EOF
            return
        self._output.put_nowait(chunk)

    async def _sender(self) -> None:
        # Forwards PTY output to the websocket; send() applies backpressure.
        while True:
            chunk = await self._output.get()
            try:
                await self._conn.send(chunk)
            except Exception:
                await self.close()

    # -- teardown ----------------------------------------------------------

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._pump_task.cancel()
        self._sender_task.cancel()
        loop = self._loop
        for remove in (loop.remove_reader, loop.remove_writer):
            try:
                remove(self._fd)
            except (ValueError, OSError):
                pass
        try:
            os.close(self._fd)  # kernel SIGHUPs the shell's process group
        except OSError:
            pass
        try:
            os.kill(self._pid, signal.SIGHUP)
        except OSError:
            pass
        threading.Thread(target=self._reap, daemon=True).start()
        try:
            await self._conn.close(1000, "session ended")
        except Exception:
            pass

    def _reap(self) -> None:
        try:
            os.waitpid(self._pid, 0)
        except (ChildProcessError, OSError):
            pass


def _reject_bad_upgrade(connection, token: str, hostport: str):
    """Handshake gate mirroring the shell's static-server posture: the Host
    header must be our own loopback address (DNS-rebinding guard) and the
    client must know the session token (same one the gateway requires)."""
    req = connection.request
    host = req.headers.get("Host", "")
    if not hmac.compare_digest(host.encode(), hostport.encode()):
        return connection.respond(403, "forbidden")
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(req.path).query)
    given = (query.get("token") or [""])[0]
    if not hmac.compare_digest(given.encode(), token.encode()):
        return connection.respond(401, "bad token")
    return None


def _pty_bridge_main(token: str, ready: threading.Event, holder: list) -> None:
    """Thread entry with its own event loop. A crashed server restarts with
    a backoff instead of taking the process — and its gateway — down."""

    if serve is None:
        holder.append(None)
        ready.set()
        print("pty bridge: websockets package unavailable — terminal disabled",
              file=sys.stderr, flush=True)
        return

    async def serve_forever() -> None:
        for candidate in range(PTY_PORT_DEFAULT, PTY_PORT_DEFAULT + 10):
            hostport = f"{PTY_HOST}:{candidate}"

            async def on_request(connection, _headers, hostport=hostport):
                return _reject_bad_upgrade(connection, token, hostport)

            async def on_session(connection) -> None:
                session = PtySession(connection)
                try:
                    async for msg in connection:
                        if isinstance(msg, bytes):
                            session.write(msg)
                        elif msg.startswith('{"type"'):
                            try:
                                frame = json.loads(msg)
                            except ValueError:
                                continue
                            if frame.get("type") == "resize":
                                session.resize(int(frame.get("cols", 80)),
                                               int(frame.get("rows", 24)))
                        else:
                            session.write(msg.encode("utf-8"))
                except Exception:
                    pass  # one bad client must not touch the server
                finally:
                    await session.close()

            try:
                async with serve(on_session, PTY_HOST, candidate,
                                 process_request=on_request) as server:
                    holder.append(candidate)
                    ready.set()
                    await server.serve_forever()
                return  # clean stop
            except OSError:
                continue  # port busy — try the next one
        holder.append(None)
        ready.set()
        print(f"pty bridge: no free port "
              f"({PTY_PORT_DEFAULT}..{PTY_PORT_DEFAULT + 9})",
              file=sys.stderr, flush=True)

    while True:
        try:
            asyncio.run(serve_forever())
            return
        except Exception as e:  # noqa: BLE001 — the bridge must outlive bugs
            print(f"pty bridge crashed, restarting: {e!r}",
                  file=sys.stderr, flush=True)
            if not ready.is_set():
                holder.append(None)
                ready.set()
            time.sleep(3)


def _start_pty_bridge(token: str):
    """Start the bridge thread; returns the bound port (or None). Waits
    briefly for the bind so the handshake can publish the real port."""
    ready = threading.Event()
    holder: list = []
    threading.Thread(target=_pty_bridge_main, args=(token, ready, holder),
                     daemon=True, name="moch-pty-bridge").start()
    ready.wait(timeout=10)
    return holder[0] if holder else None


PORT = int(os.environ.get("MOCH_GATEWAY_PORT", "9118"))

BROWSER_PORT = _spawn_browser()

info = gateway_server.start(port=PORT)
if BROWSER_PORT:
    info = dict(info)
    info["browser_port"] = BROWSER_PORT
# Terminal bridge: must be up before the handshake is written so pty_port is
# published to whoever reads it. Runs in its own thread; failure here never
# blocks the gateway — the UI just reports the terminal as unavailable.
PTY_PORT = _start_pty_bridge(info.get("token", ""))
if PTY_PORT:
    info = dict(info)
    info["pty_port"] = PTY_PORT
print("MOCH_GATEWAY_INFO " + json.dumps(info), flush=True)

# File-based handshake for the Rust shell — immune to pipe buffering.
# chmod 0600 immediately after writing: the file carries the live session
# token, and a umask-default 0644 exposes it to every local user.
info_path = os.path.join(os.environ.get("HERMES_HOME", ""), ".moch-gateway.json")
try:
    with open(info_path, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.chmod(info_path, 0o600)
except Exception as e:  # noqa: BLE001
    print(f"gateway info file write failed: {e}", file=sys.stderr, flush=True)

# Keep the process alive; the gateway runs on a daemon thread and its own
# supervisor retries transient boot failures inside start().
while True:
    time.sleep(60)
