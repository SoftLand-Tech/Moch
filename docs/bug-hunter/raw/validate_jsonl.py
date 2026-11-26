#!/usr/bin/env python3
"""Validate JSONL files: every non-empty line must parse as a JSON object."""
import json, sys
ok = True
for path in sys.argv[1:]:
    n = 0
    try:
        with open(path) as f:
            for i, line in enumerate(f, 1):
                if not line.strip():
                    continue
                obj = json.loads(line)
                if not isinstance(obj, dict):
                    print(f"{path}:{i}: not an object"); ok = False
                n += 1
        print(f"{path}: OK ({n} records)")
    except Exception as e:
        print(f"{path}: FAIL — {e}"); ok = False
sys.exit(0 if ok else 1)
