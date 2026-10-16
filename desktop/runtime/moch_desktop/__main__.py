"""Entrypoint: ``python -m moch_desktop [--port N] [--home PATH] [--import-from PATH]``.

The Tauri side spawns this with a free port and HERMES_PARENT_PID set (the
gateway's parent-death watchdog then exits if the app ever dies without
reaping it).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Make `moch_desktop` importable when launched by absolute path (Tauri runs
# the venv python with this file's parent NOT on sys.path).
_HERE = Path(__file__).resolve().parents[1]
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from moch_desktop import boot as _boot  # noqa: E402
from moch_desktop import server as _server  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="moch_desktop", description="Moch Desktop local hermes runtime")
    parser.add_argument("--port", type=int, default=0, help="gateway port (0 = pick a free port)")
    parser.add_argument("--home", default="", help="override the hermes home directory")
    parser.add_argument("--workspace", default="", help="override the workspace directory (default ~/Moch)")
    parser.add_argument("--import-from", default="", help="first-run: import identity/config from an existing hermes home (e.g. ~/.hermes)")
    parser.add_argument("--status", action="store_true", help="print runtime facts and exit")
    args = parser.parse_args(argv)

    if args.home:
        os.environ["MOCH_DESKTOP_HOME"] = args.home
    if args.workspace:
        os.environ["MOCH_WORKSPACE"] = args.workspace

    home = _boot.default_home()
    fresh = not home.exists() or not any(home.iterdir())

    if args.import_from:
        source = Path(args.import_from).expanduser()
        if source.is_dir():
            result = _boot.import_home(source, home)
            print(f"[moch-desktop] import from {source}: copied={result['copied']} skipped={result['skipped']}", flush=True)

    if args.status:
        import json

        print(json.dumps({
            "home": str(home),
            "fresh": fresh,
            "workspace": str(_boot.workspace_dir()),
            "hermesSrc": str(_boot.hermes_src()),
            "stateDir": str(_boot.state_dir()),
        }))
        return 0

    port = args.port
    if port <= 0:
        import socket

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = int(s.getsockname()[1])

    _server.start(port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
