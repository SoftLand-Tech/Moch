/**
 * Test — the guest installer WATCHER command builder (BUG-147), pure and
 * node-safe by construction (src/lib/installWatcher.ts has zero imports, so
 * nothing here touches react-native or the native bridge).
 *
 * Covered:
 *  - command shape: decode → background-start → liveness+marker poll loop →
 *    reap → farewell line. The liveness poll (`kill -0`) and the final
 *    `wait` are the entire point of BUG-147: the proot that traces this one
 *    command must stay alive until the installer is reaped, never die ahead
 *    of it (the old `nohup … & echo started` shape orphaned the installer
 *    mid-apt). The old shape is explicitly banned below.
 *  - timeout math: the default watch window is the wizard's 30-minute cap
 *    (900 polls x 2 s), the bridge timeout adds grace and stays under the
 *    native bridge's hard 3600 s ceiling (HermesBridgeModule rejects more),
 *    and pathological shapes clamp instead of rejecting.
 *  - marker detection: the DONE literal is the single source of truth shared
 *    with the runner script (`echo "MOCH:DONE"`) and the RN-side parser; the
 *    command must grep exactly that marker against the exact log path, and
 *    exit only on liveness-loss OR marker — both break conditions present.
 *
 *   npx tsx scripts/test-install-watcher.ts
 */
import {
  buildInstallWatcherCommand,
  DEFAULT_INSTALL_WATCHER,
  INSTALL_DONE_MARKER,
  INSTALL_WATCHER_BRIDGE_CAP_S,
  INSTALL_WATCHER_EXIT_PREFIX,
  INSTALL_WATCHER_GRACE_S,
  INSTALL_WATCHER_TIMEOUT_S,
  watcherBridgeTimeoutSeconds,
  watcherWindowSeconds,
} from '../src/lib/installWatcher'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const B64 = 'IyEvYmluL3NoCmVjaG8gaGlqYWNrcw==' // arbitrary — shape, not content

function testCommandShape() {
  const cmd = buildInstallWatcherCommand(B64)
  const lines = cmd.split('\n')

  check('decode line writes the script and gates on failure',
    lines[0] === `echo ${B64} | base64 -d > /root/.moch-install.sh || exit 1`, JSON.stringify(lines[0]))
  check('installer is background-started with the exact log redirect',
    lines[1] === 'nohup sh /root/.moch-install.sh >/root/.moch-install.log 2>&1 &', JSON.stringify(lines[1]))
  check('background pid is captured for liveness polling', lines[2] === 'pid=$!')
  check('poll loop is bounded by maxPolls (the hard watch window)',
    lines.some((l) => l.includes(`-lt ${DEFAULT_INSTALL_WATCHER.maxPolls}`)))
  check('liveness poll: kill -0 on the captured pid',
    lines.some((l) => l.includes('kill -0 "$pid" 2>/dev/null || break')))
  check('marker poll: grep -q DONE on the log path',
    lines.some((l) => l.includes(`grep -q '${INSTALL_DONE_MARKER}' /root/.moch-install.log 2>/dev/null && break`)))
  check('poll cadence is interpolated', lines.some((l) => l === `  sleep ${DEFAULT_INSTALL_WATCHER.pollSeconds}`))
  check('counter increments each pass', lines.includes('  n=$((n+1))'))
  check('installer is reaped with wait (never left to the reaper of proot exit)',
    lines.includes('wait "$pid" 2>/dev/null'))
  check('farewell line carries the installer exit code',
    lines[lines.length - 1] === `echo '${INSTALL_WATCHER_EXIT_PREFIX}'"$?"`)

  // The BUG-147 regression guard: the old kick answered with `& echo started`
  // and let proot die under a live installer. No variant of that may return.
  check('old fire-and-forget kick shape is gone', !cmd.includes('echo started'))
  check('backgrounding is its own statement (no `&&` chaining past the `&`)',
    !lines[1].includes('&&'))

  // Overrides flow through verbatim.
  const custom = buildInstallWatcherCommand('QQ==', {
    scriptPath: '/root/other.sh',
    logPath: '/root/other.log',
    pollSeconds: 5,
    maxPolls: 3,
  })
  check('custom paths + cadence flow through',
    custom.includes('-d > /root/other.sh ||') &&
      custom.includes('> /root/other.sh >/root/other.log 2>&1'.replace('> /root/other.sh', 'sh /root/other.sh')) &&
      custom.includes("grep -q 'MOCH:DONE' /root/other.log") &&
      custom.includes('sleep 5') &&
      custom.includes('-lt 3'))
}

function testTimeoutMath() {
  check('default watch window equals the wizard cap: 900 x 2 s = 1800',
    watcherWindowSeconds(DEFAULT_INSTALL_WATCHER.pollSeconds, DEFAULT_INSTALL_WATCHER.maxPolls) === 1800)
  check('bridge timeout = window + grace = 1860',
    INSTALL_WATCHER_TIMEOUT_S === 1800 + INSTALL_WATCHER_GRACE_S && INSTALL_WATCHER_TIMEOUT_S === 1860,
    `got ${INSTALL_WATCHER_TIMEOUT_S}`)
  check('bridge timeout respects the native 3600 s ceiling',
    INSTALL_WATCHER_TIMEOUT_S <= INSTALL_WATCHER_BRIDGE_CAP_S && INSTALL_WATCHER_BRIDGE_CAP_S === 3600)
  check('grace is positive (the final wait/echo always fits inside the RPC)',
    INSTALL_WATCHER_GRACE_S > 0)
  check('pathological shapes clamp to the bridge cap instead of exceeding it',
    watcherBridgeTimeoutSeconds({ scriptPath: 'x', logPath: 'x', pollSeconds: 10, maxPolls: 1000 }) ===
      INSTALL_WATCHER_BRIDGE_CAP_S)
  check('window math is exact multiplication (polls slept, not iterations guessed)',
    watcherWindowSeconds(0.5, 4) === 2 && watcherWindowSeconds(7, 3) === 21)
}

function testMarkerDetection() {
  // The literal the runner script prints (buildInstallScript's final line,
  // `echo "MOCH:DONE"`) and parseInstallLog keys on. One constant, three
  // consumers — this pins the value so a protocol rename breaks HERE first.
  check('DONE marker is the exact MOCH:* protocol literal', INSTALL_DONE_MARKER === 'MOCH:DONE')
  check('watcher exit prefix is namespaced and distinct from item markers',
    INSTALL_WATCHER_EXIT_PREFIX.startsWith('MOCH:') &&
      (INSTALL_WATCHER_EXIT_PREFIX as string) !== (INSTALL_DONE_MARKER as string))

  const cmd = buildInstallWatcherCommand(B64)
  check('exactly one DONE grep in the command (marker detection is the loop break, nothing else)',
    cmd.split(INSTALL_DONE_MARKER).length - 1 === 1)
  check('break conditions are liveness-loss OR marker — both present, both breaking',
    (cmd.match(/\|\| break/g) ?? []).length === 1 && (cmd.match(/&& break/g) ?? []).length === 1)
  check('marker grep targets the same log the runner writes',
    cmd.includes(`grep -q '${INSTALL_DONE_MARKER}' ${DEFAULT_INSTALL_WATCHER.logPath}`))
}

async function main() {
  testCommandShape()
  testTimeoutMath()
  testMarkerDetection()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
