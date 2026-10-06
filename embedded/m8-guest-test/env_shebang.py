#!/usr/bin/env python3
"""M8 guest exec matrix — /usr/bin/env shebang probe (EXEC-DESIGN.md §9.2).

A two-level exec chain per run: /usr/bin/env is itself an ELF exec'd through
the loader, then env execve's python3 from PATH — which goes through the
same substitution again. If both levels work, PATH lookup + execvp inside
the guest are healthy.
"""
import sys

print("env_shebang.py OK (python " + sys.version.split()[0] + ")")
