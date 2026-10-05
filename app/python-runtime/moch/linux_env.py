"""Moch Linux environment — provisioning and guest execution.

M7.5: a Debian/Ubuntu rootfs running under proot inside the app's private
storage, giving the agent a real Linux userspace (apt, compilers, servers,
browsers). This module handles:

- Bootstrap: download proot + libtalloc from the Termux package repo (GPLv2,
  prebuilt aarch64 Android binaries), extract them from .deb containers,
  then download and extract a distribution rootfs.
- Execution: run commands inside the guest via proot.

The guest lives at ``<home>/linux/rootfs``; the workspace is bind-mounted at
``/workspace`` inside it. Everything stays inside the app sandbox.
"""

from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

TERMUX_BASE = "https://packages.termux.dev/apt/termux-main/pool/main"
PROOT_URL = f"{TERMUX_BASE}/p/proot/proot_5.1.107.96_aarch64.deb"
LIBTALLOC_URL = f"{TERMUX_BASE}/libt/libtalloc/libtalloc_2.5.0_aarch64.deb"

ROOTFS_URLS = {
    "ubuntu-24.04": "https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    # Debian 12 (bookworm) official arm64 base — debuerreumatism artifacts
    "debian-12": "https://github.com/debuerreumaker/docker-debian-artifacts/raw/dist-arm64/bookworm/rootfs.tar.gz",
}

def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


def _log(msg: str) -> None:
    print(f"[moch-linux] {msg}", file=sys.stderr, flush=True)


def _ar_extract_member(ar_path: Path, member_name: str, dest: Path) -> None:
    """Extract a single member from a Unix ar archive (.deb = ar + tar)."""
    data = ar_path.read_bytes()
    if data[:8] != b"!<arch>\n":
        raise ValueError(f"not an ar archive: {ar_path}")
    off = 8
    while off + 60 <= len(data):
        header = data[off : off + 60]
        name = header[0:16].decode("ascii", "replace").rstrip()
        size = int(header[48:58].decode("ascii", "replace").strip())
        body = data[off + 60 : off + 60 + size]
        if name.rstrip("/") == member_name or name == member_name:
            dest.write_bytes(body)
            return
        # ar members are 2-byte aligned
        off += 60 + size + (size % 2)
    raise ValueError(f"member {member_name!r} not found in {ar_path}")


def _download(url: str, dest: Path, chunk_mb: int = 8) -> int:
    """Stream a file to dest; returns bytes written. Logs progress."""
    _log(f"downloading {url.split('/')[-1]} …")
    req = urllib.request.Request(url, headers={"User-Agent": "Moch/1.0"})
    total = 0
    with urllib.request.urlopen(req, timeout=120) as resp, dest.open("wb") as f:
        while True:
            chunk = resp.read(chunk_mb * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            _log(f"  {total / 1e6:.1f} MB")
    return total


def bootstrap(distro: str = "ubuntu-24.04") -> dict:
    """Download proot + libtalloc + rootfs and lay out the guest tree."""
    linux_dir = _linux_dir()
    bin_dir = linux_dir / "bin"
    rootfs = linux_dir / "rootfs"
    bin_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {"ok": False, "steps": []}

    def step(name: str, fn) -> None:
        try:
            fn()
            report["steps"].append(f"{name}: ok")
        except Exception as exc:  # noqa: BLE001
            report["steps"].append(f"{name}: FAILED {type(exc).__name__}: {exc}")
            raise

    if not (bin_dir / "proot").exists():
        def _proot():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                deb = td / "proot.deb"
                _download(PROOT_URL, deb)
                data_tar = td / "data.tar.xz"
                _ar_extract_member(deb, "data.tar.xz", data_tar)
                # Extract just the binary + loader
                with tarfile.open(data_tar, "r:xz") as tf:
                    for member in tf.getmembers():
                        parts = Path(member.name).parts
                        if not parts:
                            continue
                        # bin/proot, libexec/proot/loader
                        rel = "/".join(parts[parts.index("usr") + 1 :]) if "usr" in parts else member.name
                        if rel in ("bin/proot", "libexec/proot/loader", "libexec/proot/loader32"):
                            tf.extract(member, td)
                            src = td / member.name
                            dst = bin_dir / Path(rel).name if rel == "bin/proot" else bin_dir / rel
                            dst.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(src, dst)
                            os.chmod(dst, 0o755)
                if not (bin_dir / "proot").exists():
                    raise FileNotFoundError("proot binary not found in deb")
        step("proot", _proot)

    if not any((bin_dir / "lib").glob("libtalloc.so*")):
        def _talloc():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                deb = td / "libtalloc.deb"
                _download(LIBTALLOC_URL, deb)
                data_tar = td / "data.tar.xz"
                _ar_extract_member(deb, "data.tar.xz", data_tar)
                with tarfile.open(data_tar, "r:xz") as tf:
                    for member in tf.getmembers():
                        if member.name.endswith("lib/libtalloc.so.2"):
                            tf.extract(member, td)
                            src = td / member.name
                            (bin_dir / "lib").mkdir(exist_ok=True)
                            shutil.copy2(src, bin_dir / "lib" / "libtalloc.so.2")
        step("libtalloc", _talloc)

    if not rootfs.exists():
        def _rootfs():
            url = ROOTFS_URLS[distro]
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                tarball = td / "rootfs.tar.gz"
                _download(url, tarball)
                rootfs.mkdir(parents=True, exist_ok=True)
                _log("extracting rootfs (this takes a few minutes)…")
                with tarfile.open(tarball, "r:gz") as tf:
                    tf.extractall(rootfs)
        step("rootfs", _rootfs)

    report["ok"] = True
    return report


def exec_in_guest(command: str, timeout_s: int = 30) -> dict:
    """Run a command inside the guest via proot. Returns stdout/stderr/exit."""
    linux_dir = _linux_dir()
    proot = linux_dir / "bin" / "proot"
    rootfs = linux_dir / "rootfs"
    if not proot.exists() or not rootfs.exists():
        return {"ok": False, "error": "guest not bootstrapped"}
    from moch import hermes_boot

    workspace = hermes_boot._hermes_home() / "workspace"
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(linux_dir / "bin" / "lib")
    argv = [
        str(proot),
        "-r", str(rootfs),
        "-b", f"{workspace}:/workspace",
        "-b", "/dev",
        "-b", "/proc",
        "-0",
        "-w", "/root",
        "/bin/sh", "-c", command,
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_s, env=env)
        return {"ok": proc.returncode == 0, "exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def status() -> dict:
    """Guest state for the bridge."""
    linux_dir = _linux_dir()
    proot = linux_dir / "bin" / "proot"
    rootfs = linux_dir / "rootfs"
    return {
        "bootstrapped": proot.exists() and rootfs.exists(),
        "rootfs_exists": rootfs.exists(),
        "size_mb": round(sum(f.stat().st_size for f in rootfs.rglob("*") if f.is_file()) / 1e6, 1) if rootfs.exists() else 0,
    }
