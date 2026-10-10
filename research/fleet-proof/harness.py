"""Shared harness for the M9.0 fleet probes (PC-first proofs).

Boots the real embedded gateway stack exactly like the app does
(app/python-runtime/moch/gateway_server.py), but pointed at a throwaway
HERMES_HOME, and speaks the same v7 JSON-RPC the RN client speaks
(``ws://127.0.0.1:<port>/api/ws?token=...``).

Usage:
    from harness import Probe, boot_gateway

    p = Probe("p1")
    gw = boot_gateway(p, home_tag="p1")
    res = gw.rpc("profiles.list", {})
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]          # worktrees/m9-fleet
HERMES_SRC = REPO / "app" / "hermes-src"
MOCH_RT = REPO / "app" / "python-runtime"
PROOF_ROOT = Path(os.environ.get("FLEET_PROOF_ROOT", "/tmp/moch-fleet-proof"))

VENV_PY = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"


def _ensure_paths() -> None:
    for p in (str(HERMES_SRC), str(MOCH_RT)):
        if p not in sys.path:
            sys.path.insert(0, p)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def port_accepts(port: int, timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


class Probe:
    """Tiny result recorder: p.ok(name, detail) / p.fail(name, detail) / p.note(...)."""

    def __init__(self, tag: str):
        self.tag = tag
        self.lines: list[str] = []
        self.failed = False

    def ok(self, name: str, detail: str = "") -> None:
        self.lines.append(f"PASS  {name}" + (f" — {detail}" if detail else ""))

    def fail(self, name: str, detail: str = "") -> None:
        self.failed = True
        self.lines.append(f"FAIL  {name}" + (f" — {detail}" if detail else ""))

    def note(self, text: str) -> None:
        self.lines.append(f"NOTE  {text}")

    def section(self, text: str) -> None:
        self.lines.append("")
        self.lines.append(f"## {text}")

    def finish(self) -> str:
        head = f"# {self.tag} — {'FAIL' if self.failed else 'PASS'}"
        out = head + "\n" + "\n".join(self.lines) + "\n"
        PROOF_ROOT.mkdir(parents=True, exist_ok=True)
        (PROOF_ROOT / f"{self.tag}.txt").write_text(out, encoding="utf-8")
        print(out)
        return out


def write_home_config(home: Path, cfg: dict) -> None:
    """Minimal YAML writer for the flat configs the probes need (no deps)."""
    def emit(block, indent=0):
        out = []
        for k, v in block.items():
            pad = "  " * indent
            if isinstance(v, dict):
                out.append(f"{pad}{k}:")
                out.extend(emit(v, indent + 1))
            elif isinstance(v, bool):
                out.append(f"{pad}{k}: {str(v).lower()}")
            elif isinstance(v, list):
                out.append(f"{pad}{k}:")
                for item in v:
                    out.append(f"{pad}  - {item}")
            else:
                out.append(f"{pad}{k}: {v}")
        return out

    (home / "config.yaml").write_text("\n".join(emit(cfg)) + "\n", encoding="utf-8")


def boot_gateway(probe: Probe, home_tag: str, multiplex: bool | None = True) -> dict:
    """Boot the embedded gateway stack against a fresh HERMES_HOME.

    Returns {home, port, token}. Mirrors moch.gateway_server._run_server:
    env before import, InProcessSlashWorker swap, start_server on a daemon
    thread, readiness = port accepts.
    """
    _ensure_paths()
    home = PROOF_ROOT / home_tag / "home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_DESKTOP"] = "1"
    os.environ["HERMES_SERVE_HEADLESS"] = "1"
    token = secrets.token_urlsafe(32)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    if multiplex is not None:
        write_home_config(home, {"gateway": {"multiplex_profiles": multiplex}})

    port = free_port()
    err: list[str] = []

    def _run() -> None:
        try:
            # Production boot path (single source of truth): moch.gateway_server
            # imports tui_gateway, swaps InProcessSlashWorker, installs the
            # M9 fleet runtime (flag-gated) and starts the serve backend.
            from moch import gateway_server as mgs
            mgs._run_server(port)
        except BaseException:  # noqa: BLE001
            err.append(traceback.format_exc(limit=8))

    threading.Thread(target=_run, name="probe-gateway", daemon=True).start()
    deadline = time.time() + 90.0
    while time.time() < deadline:
        if err:
            probe.fail("gateway boot", err[0].splitlines()[-1])
            return {"home": home, "port": port, "token": token, "up": False}
        if port_accepts(port):
            probe.ok("gateway up", f"port={port} home={home}")
            return {"home": home, "port": port, "token": token, "up": True}
        time.sleep(0.25)
    probe.fail("gateway boot", "timed out waiting for port")
    return {"home": home, "port": port, "token": token, "up": False}


def boot_gateway_subprocess(probe: Probe, home_tag: str, multiplex: bool | None = True) -> dict:
    """Boot a gateway in its OWN process (like the app does). Env is per-process,
    so token/config are honored independently of any earlier in-process gateway."""
    _ensure_paths()
    import subprocess
    home = PROOF_ROOT / home_tag / "home"
    home.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    port = free_port()
    cfg = {"gateway": {"multiplex_profiles": multiplex}} if multiplex is not None else {}
    child = Path(__file__).parent / "_gw_child.py"
    env = dict(os.environ)
    env.update({
        "HERMES_HOME": str(home),
        "HERMES_DESKTOP": "1",
        "HERMES_SERVE_HEADLESS": "1",
        "HERMES_DASHBOARD_SESSION_TOKEN": token,
        "PROBE_PORT": str(port),
        "PROBE_CONFIG": json.dumps(cfg),
    })
    proc = subprocess.Popen([str(VENV_PY), str(child)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 90.0
    while time.time() < deadline:
        if port_accepts(port):
            probe.ok("subprocess gateway up", f"port={port} home={home}")
            return {"home": home, "port": port, "token": token, "up": True, "proc": proc}
        if proc.poll() is not None:
            probe.fail("subprocess gateway up", f"child exited rc={proc.returncode}")
            return {"home": home, "port": port, "token": token, "up": False, "proc": proc}
        time.sleep(0.25)
    probe.fail("subprocess gateway up", "timeout")
    return {"home": home, "port": port, "token": token, "up": False, "proc": proc}


class RpcError(Exception):
    def __init__(self, method: str, error: dict):
        self.method = method
        self.error = error
        super().__init__(f"{method} -> error {error.get('code')}: {error.get('message')}")


class WsClient:
    """Minimal sync JSON-RPC client over /api/ws (websockets lib)."""

    def __init__(self, port: int, token: str):
        import asyncio
        import websockets

        self._asyncio = asyncio
        self._ws = None
        self._port, self._token = port, token
        self._id = 0
        self._pending: dict[int, dict] = {}
        self._events: list[dict] = []
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()

        async def _connect():
            return await websockets.connect(
                f"ws://127.0.0.1:{port}/api/ws?token={token}",
                max_size=64 * 1024 * 1024)

        fut = asyncio.run_coroutine_threadsafe(_connect(), self._loop)
        self._ws = fut.result(timeout=20)
        self._recv_task = asyncio.run_coroutine_threadsafe(self._pump(), self._loop)

    async def _pump(self) -> None:
        try:
            async for raw in self._ws:
                obj = json.loads(raw)
                if isinstance(obj, dict) and obj.get("method") == "event":
                    self._events.append(obj.get("params") or {})
                elif isinstance(obj, dict) and "id" in obj:
                    self._pending[int(obj["id"])] = obj
        except Exception:
            pass

    def rpc(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        self._id += 1
        rid = self._id
        frame = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        fut = self._asyncio.run_coroutine_threadsafe(self._ws.send(json.dumps(frame)), self._loop)
        fut.result(timeout=15)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if rid in self._pending:
                obj = self._pending.pop(rid)
                if "error" in obj:
                    raise RpcError(method, obj["error"])
                return obj.get("result") or {}
            time.sleep(0.02)
        raise TimeoutError(f"{method}: no reply in {timeout}s")

    def drain_events(self) -> list[dict]:
        evs, self._events = self._events, []
        return evs

    def close(self) -> None:
        try:
            self._asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop).result(timeout=5)
        except Exception:
            pass
