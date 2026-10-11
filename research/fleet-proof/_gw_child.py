#!/usr/bin/env python3
"""Child process for boot_gateway_subprocess: env comes fully prepared."""
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "app" / "hermes-src"))
sys.path.insert(0, str(REPO / "app" / "python-runtime"))

cfg = json.loads(os.environ.get("PROBE_CONFIG") or "{}")
if cfg:
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)

    def emit(block, indent=0):
        out = []
        for k, v in block.items():
            pad = "  " * indent
            if isinstance(v, dict):
                out.append(f"{pad}{k}:")
                out.extend(emit(v, indent + 1))
            elif isinstance(v, bool):
                out.append(f"{pad}{k}: {str(v).lower()}")
            else:
                out.append(f"{pad}{k}: {v}")
        return out

    (home / "config.yaml").write_text("\n".join(emit(cfg)) + "\n", encoding="utf-8")

from tui_gateway import server as tg_server
from moch.slash_worker_bridge import InProcessSlashWorker
tg_server._SlashWorker = InProcessSlashWorker
from hermes_cli.web_server import start_server
start_server(host="127.0.0.1", port=int(os.environ["PROBE_PORT"]),
             open_browser=False, headless=True)
