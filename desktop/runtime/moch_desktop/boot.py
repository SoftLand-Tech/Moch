"""Home resolution + environment preparation for the desktop runtime."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import sys
from pathlib import Path

TOKEN_FILENAME = ".moch-gateway-token"
STATE_FILENAME = "desktop-runtime.json"


def repo_root() -> Path:
    """The Moch repo root (this package lives at <root>/desktop/runtime/moch_desktop)."""
    return Path(__file__).resolve().parents[3]


def hermes_src() -> Path:
    """The vendored hermes tree. Overridable for packaged builds."""
    override = os.environ.get("MOCH_HERMES_SRC", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return repo_root() / "app" / "hermes-src"


def moch_python_runtime() -> Path:
    """The moch fleet runtime package root (contains the ``moch`` package)."""
    override = os.environ.get("MOCH_PYTHON_RUNTIME", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return repo_root() / "app" / "python-runtime"


def state_dir() -> Path:
    """App state dir (gateway home lives inside; shared with the Tauri side).

    ``MOCH_DESKTOP_STATE_DIR`` overrides everything (dev/test sandboxes).
    """
    override = os.environ.get("MOCH_DESKTOP_STATE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / "moch-desktop"


def default_home() -> Path:
    override = os.environ.get("MOCH_DESKTOP_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    return state_dir() / "hermes"


def workspace_dir() -> Path:
    """Where chats run and the terminal starts: a visible ``~/Moch`` folder.

    Falls back to ``<state>/workspace`` when the home dir is not writable
    (dev sandboxes).
    """
    override = os.environ.get("MOCH_WORKSPACE", "").strip()
    if override:
        return Path(override).expanduser()
    candidate = Path.home() / "Moch"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except OSError:
        return state_dir() / "workspace"


def python_path_entries() -> list[str]:
    """sys.path entries the runtime (and its children) need."""
    return [str(hermes_src()), str(moch_python_runtime())]


def load_or_mint_token(home: Path) -> str:
    """Stable per-install gateway token (same scheme as the phone)."""
    token_file = home / TOKEN_FILENAME
    try:
        token = token_file.read_text(encoding="utf-8").strip()
        if token:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(token_file, 0o600)
    except OSError:
        pass
    return token


def prepare_home(home: Path) -> dict:
    """Create the home layout and export the env hermes reads. Idempotent."""
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)

    ws = workspace_dir()
    ws.mkdir(parents=True, exist_ok=True)
    os.environ["MOCH_WORKSPACE"] = str(ws)

    # Curated optional-MCP manifests (hermes' own override hook).
    optional_mcps = home / "optional-mcps"
    optional_mcps.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HERMES_OPTIONAL_MCPS", str(optional_mcps))

    # The in-app browser is the product: pin the built-in backend (see
    # _pin_builtin_browser) unless the user chose otherwise.
    _pin_builtin_browser(home)

    scratch = state_dir() / "cache" / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(scratch)
    os.environ.setdefault("HERMES_SCRATCH_DIR", str(scratch))

    # Children (slash worker, cron jobs) spawn `sys.executable`; PYTHONPATH
    # carries hermes + moch to them.
    entries = python_path_entries()
    existing = os.environ.get("PYTHONPATH", "")
    merged = entries + ([existing] if existing else [])
    os.environ["PYTHONPATH"] = ":".join(merged)
    for entry in entries:
        if entry not in sys.path:
            sys.path.insert(0, entry)

    return {"home": str(home), "workspace": str(ws)}


IMPORT_SKIP_DIRS = {
    # volatile / machine-specific — never copied on import
    "cache", "gateway.sock", "gateway.pid", "gateway.lock", "gateway-starts.log",
    "fleet", "spawns", "linux", "browser", "state.db", "state.db-wal", "state.db-shm",
    "sessions", "backups", "audio_cache", "image_cache", "images", "cron",
    "desktop-runtime.json", ".moch-gateway-token",
}
IMPORT_COPY_ENTRIES = {
    # name -> is_dir
    "config.yaml": False, "auth.json": False, ".env": False, "USER.md": False,
    "memories": True, "skills": True, "profiles": True, "optional-mcps": True,
}


def import_home(source: Path, target: Path) -> dict:
    """First-run import from an existing hermes home (e.g. ``~/.hermes``).

    Copies identity + provider config + memories + skills + profiles — never
    volatile state (locks, DBs, caches). Existing files in the target are
    never overwritten.
    """
    copied: list[str] = []
    skipped: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    for name in IMPORT_COPY_ENTRIES:
        src = source / name
        dst = target / name
        if not src.exists():
            skipped.append(name)
            continue
        if dst.exists():
            skipped.append(name)
            continue
        try:
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=False)
            else:
                shutil.copy2(src, dst)
            copied.append(name)
        except OSError:
            skipped.append(name)
    return {"copied": copied, "skipped": skipped, "source": str(source), "target": str(target)}


def _pin_builtin_browser(home: Path) -> None:
    """Pin `browser.backend: off` in the DESKTOP home's config (if unset).

    With the Browser Use CLI installed (common on a dev machine) and the
    backend unset, hermes defaults to browser-use CLI mode: `browser_exec`
    replaces the built-in browser_* tools and the CLI drives ITS OWN browser
    (or the user's daily one) — ignoring the app's armed CDP Chromium. The
    desktop's product is the built-in tools pointed at the in-app browser,
    so pin them here. An explicit user choice is never overridden.
    """
    cfg = home / "config.yaml"
    try:
        import yaml

        data: dict = {}
        if cfg.exists():
            data = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            return
        browser = data.get("browser")
        if not isinstance(browser, dict):
            browser = {}
        if str(browser.get("backend") or "").strip():
            return  # explicit choice — leave it
        browser["backend"] = "off"
        data["browser"] = browser
        cfg.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    except Exception:
        # Never break boot over config pinning.
        pass


def write_runtime_state(port: int, token: str) -> None:
    """Connection facts for the Tauri side (it also holds them in memory)."""
    path = state_dir() / STATE_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "port": port,
                "token": token,
                "home": os.environ.get("HERMES_HOME", ""),
                "workspace": os.environ.get("MOCH_WORKSPACE", ""),
                "pid": os.getpid(),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
