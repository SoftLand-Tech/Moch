/**
 * Pure builder for the guest installer WATCHER command — BUG-147.
 *
 * Node-safe on purpose: zero imports, nothing from react-native, so the tsx
 * battery in `scripts/test-install-watcher.ts` can pin the exact shell this
 * generates without dragging the native bridge into the test process.
 *
 * WHY THIS SHAPE EXISTS: the installer used to be detached with `nohup … &`
 * and the kick RPC returned at once — which also ended the proot that was
 * TRACING the installer (proot traces every guest syscall; see the
 * spawn_in_guest docstring in python-runtime/moch/linux_env.py). An
 * installer whose tracer died mid-run gets broken futex syscalls back and
 * aborts — installs died mid-apt with ENOSPC-style lies (BUG-147). The fix
 * keeps ONE exec_in_guest call alive for the whole install window: start the
 * installer, poll its liveness and the MOCH:DONE marker, reap it, then exit.
 * The proot tracer now outlives the installer, exactly like an interactive
 * terminal session does.
 *
 * The RN side (linuxPackages.installPackages) still tails the same log on a
 * short poll for UI progress; the watcher's only job is to keep the tracer
 * alive until the installer is done, then let it exit cleanly.
 */

/** The runner script's last protocol line (also parsed by parseInstallLog). */
export const INSTALL_DONE_MARKER = 'MOCH:DONE'

/** The watcher's own farewell line: the installer's exit code rides it. */
export const INSTALL_WATCHER_EXIT_PREFIX = 'MOCH:WATCHER:EXIT:'

export interface InstallWatcherOptions {
  /** Where the decoded runner script is written inside the guest. */
  scriptPath: string
  /** The runner's progress log (truncated fresh at spawn by the redirect). */
  logPath: string
  /** Seconds between liveness/marker polls. */
  pollSeconds: number
  /** Hard cap on poll passes — the watch window is maxPolls * pollSeconds. */
  maxPolls: number
}

/**
 * Defaults tuned to the install wizard's 30-minute overall cap
 * (linuxPackages INSTALL_CAP_MS): 900 polls x 2 s = a 30-minute watch
 * window, inside the native bridge's 3600 s ceiling (HermesBridgeModule
 * rejects timeouts above 3600).
 */
export const DEFAULT_INSTALL_WATCHER: InstallWatcherOptions = {
  scriptPath: '/root/.moch-install.sh',
  logPath: '/root/.moch-install.log',
  pollSeconds: 2,
  maxPolls: 900,
}

/** Worst-case seconds the watcher shell can stay alive (all polls slept). */
export function watcherWindowSeconds(pollSeconds: number, maxPolls: number): number {
  return pollSeconds * maxPolls
}

/**
 * Bridge timeout for the watcher RPC: the watch window plus a grace tail so
 * the shell's final `wait`/echo (after the last poll, or after the installer
 * finishes just past it) still lands inside the RPC. Clamped to the bridge's
 * hard 3600 s ceiling. An RPC timeout here means the 30-minute cap already
 * failed — the same failure shape the old cap path had, not a new one.
 */
export const INSTALL_WATCHER_GRACE_S = 60
export const INSTALL_WATCHER_BRIDGE_CAP_S = 3600
export function watcherBridgeTimeoutSeconds(opts: InstallWatcherOptions = DEFAULT_INSTALL_WATCHER): number {
  return Math.min(watcherWindowSeconds(opts.pollSeconds, opts.maxPolls) + INSTALL_WATCHER_GRACE_S, INSTALL_WATCHER_BRIDGE_CAP_S)
}

/** The bridge timeout for the DEFAULT watcher shape (pinned by tests). */
export const INSTALL_WATCHER_TIMEOUT_S = watcherBridgeTimeoutSeconds()

/**
 * The ONE command the installer kicks with (run via `/bin/sh -c` inside the
 * guest's proot, by exec_in_guest):
 *
 *   1. decode the runner script (base64 — no quoting hell);
 *   2. start it detached-ish in the background of THIS shell (`$!` is ours);
 *   3. poll — while the installer process is alive and MOCH:DONE hasn't
 *      landed in the log, sleep and count, up to maxPolls (the hard cap);
 *   4. reap the installer with `wait` and print its exit code.
 *
 * Only then does the shell exit — so the proot tracing this whole command
 * stays alive until the installer is reaped, which is the entire point of
 * BUG-147. POSIX sh only (guest /bin/sh is dash-family).
 */
export function buildInstallWatcherCommand(scriptB64: string, opts: Partial<InstallWatcherOptions> = {}): string {
  const o = { ...DEFAULT_INSTALL_WATCHER, ...opts }
  return [
    `echo ${scriptB64} | base64 -d > ${o.scriptPath} || exit 1`,
    `nohup sh ${o.scriptPath} >${o.logPath} 2>&1 &`,
    'pid=$!',
    'n=0',
    `while [ "$n" -lt ${o.maxPolls} ]; do`,
    '  kill -0 "$pid" 2>/dev/null || break',
    `  grep -q '${INSTALL_DONE_MARKER}' ${o.logPath} 2>/dev/null && break`,
    `  sleep ${o.pollSeconds}`,
    '  n=$((n+1))',
    'done',
    'wait "$pid" 2>/dev/null',
    `echo '${INSTALL_WATCHER_EXIT_PREFIX}'"$?"`,
  ].join('\n')
}
