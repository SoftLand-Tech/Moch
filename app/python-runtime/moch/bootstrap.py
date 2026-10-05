"""Milestone 1 bootstrap: prove the embedded interpreter is alive.

Runs inside the app process via Chaquopy, called from
com.hermes.pocket.hermes.HermesRuntime on a background thread. The selftest
deliberately touches C-accelerated stdlib (json/hashlib) so the proof is of a
working runtime, not just attribute lookups. The hermes agent itself lands in
Milestone 2 and must keep its own entry points separate from this module.
"""

import hashlib
import json
import platform
import sys
import time


def startup_info():
    return {
        "python": sys.version.split(" ")[0],
        "implementation": sys.implementation.name,
        "platform": platform.platform(),
        "machine": platform.machine(),
    }


def python_version():
    """String-only accessor for the Kotlin status probe (keeps the JNI
    contract to callAttr().toString() — no dict traversal across the bridge)."""
    return sys.version.split(" ")[0]


def selftest():
    payload = json.dumps({"moch": "milestone-1"}).encode("utf-8")
    return {
        "ok": True,
        "digest": hashlib.sha256(payload).hexdigest()[:16],
        "monotonic": time.monotonic() > 0,
        **startup_info(),
    }
