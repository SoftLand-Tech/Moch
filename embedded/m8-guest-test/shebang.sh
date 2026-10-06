#!/bin/bash
# M8 guest exec matrix — shebang probe (embedded/EXEC-DESIGN.md §9.2).
# The interpreter named on the shebang line is a GUEST path: proot expands
# shebangs in userspace and routes the interpreter ELF through the loader
# (§3 chain [E]); the kernel's binfmt_script never execs an app-data file.
echo "shebang.sh OK (bash ${BASH_VERSION})"
