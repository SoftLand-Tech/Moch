/**
 * The Moch Linux guest's apt/npm catalogue (ONBOARDING-V2).
 *
 * Pure data + a small runner so the wizard and Settings render the SAME
 * categories and the install is one code path. Every entry is a real package
 * name for Ubuntu 24.04 (noble) / Debian 12 (bookworm) in the guest; `kind` is
 * how it installs, not what it is.
 *
 * The install is deliberately NOT transactional: one failed package must not
 * roll back the rest. Each row records its own outcome and the wizard shows the
 * failures inline, with a retry for just those.
 *
 * HOW THE RUNNER WORKS: a package install cannot be one blocking RPC —
 * apt-get update + build-essential outlive any sane bridge timeout. So
 * installPackages writes ONE shell script into the guest and starts it under
 * a WATCHER command (buildInstallWatcherCommand in ./installWatcher, BUG-147):
 * one long-lived bridge RPC that starts the installer and stays alive —
 * polling its liveness and the `MOCH:DONE` marker — until the installer is
 * reaped, so the proot tracer never dies ahead of it (an orphaned tracee's
 * syscalls come back broken; installs used to abort mid-apt). Progress still
 * rides a `MOCH:*` line protocol that the RN side tails on a short poll —
 * every UI-facing bridge call stays short; the watcher is the one
 * deliberately long call, and nothing reads its result. `parseInstallLog` is
 * pure so the protocol handling is reviewable in isolation; the watcher
 * command builder is pure and node-safe so scripts/test-install-watcher.ts
 * pins its exact shell.
 */
import { linuxExec } from './mochiRuntime'
import { b64encodeText } from './terminal'
import {
  buildInstallWatcherCommand,
  INSTALL_DONE_MARKER,
  INSTALL_WATCHER_TIMEOUT_S,
} from './installWatcher'

export type PackageKind = 'apt' | 'npm'

export interface PackageItem {
  /** Stable id (persisted). */
  id: string
  /** Human label. */
  name: string
  /** One-line purpose. */
  note: string
  /** apt package name(s), or the npm global spec. */
  install: string
  kind: PackageKind
  /** Requires another id first (node for npm tools). */
  requires?: string
  /** Chef's-kiss default set. */
  default?: boolean
}

export interface PackageCategory {
  id: string
  name: string
  items: PackageItem[]
}

export const PACKAGE_CATEGORIES: PackageCategory[] = [
  {
    id: 'languages',
    name: 'Languages',
    items: [
      { id: 'node', name: 'Node.js + npm', note: 'JavaScript runtime and package manager', install: 'nodejs npm', kind: 'apt', default: true },
      { id: 'python', name: 'Python 3 + pip', note: 'Scripting, data, automation', install: 'python3 python3-pip python3-venv', kind: 'apt', default: true },
      { id: 'php', name: 'PHP', note: 'PHP 8 with the common extensions', install: 'php-cli php-mbstring php-xml php-curl', kind: 'apt' },
      { id: 'go', name: 'Go', note: 'Compiled services and CLIs', install: 'golang-go', kind: 'apt' },
      { id: 'rust', name: 'Rust', note: 'rustc + cargo', install: 'rustc cargo', kind: 'apt' },
      { id: 'java', name: 'Java 17 (JDK)', note: 'JVM tooling', install: 'openjdk-17-jdk-headless', kind: 'apt' },
    ],
  },
  {
    id: 'build',
    name: 'Build tools',
    items: [
      { id: 'build-essential', name: 'Compiler + make', note: 'gcc, g++, make — needed by most native packages', install: 'build-essential', kind: 'apt', default: true },
      { id: 'git', name: 'Git', note: 'Clone and version control', install: 'git', kind: 'apt', default: true },
      { id: 'cmake', name: 'CMake', note: 'C/C++ project builds', install: 'cmake pkg-config', kind: 'apt' },
      { id: 'pkgconfig', name: 'pkg-config', note: 'Library discovery for builds', install: 'pkg-config', kind: 'apt' },
    ],
  },
  {
    id: 'databases',
    name: 'Databases',
    items: [
      { id: 'sqlite', name: 'SQLite', note: 'Single-file database', install: 'sqlite3', kind: 'apt', default: true },
      { id: 'postgres', name: 'PostgreSQL', note: 'Full SQL server', install: 'postgresql', kind: 'apt' },
      { id: 'redis', name: 'Redis', note: 'In-memory cache / queues', install: 'redis-server', kind: 'apt' },
    ],
  },
  {
    id: 'cli',
    name: 'CLI & files',
    items: [
      { id: 'curl', name: 'curl + wget', note: 'Fetch anything', install: 'curl wget ca-certificates', kind: 'apt', default: true },
      { id: 'jq', name: 'jq', note: 'Read and shape JSON', install: 'jq', kind: 'apt', default: true },
      { id: 'ripgrep', name: 'ripgrep + fd', note: 'Fast search', install: 'ripgrep fd-find', kind: 'apt' },
      { id: 'tmux', name: 'tmux', note: 'Persistent terminal sessions', install: 'tmux', kind: 'apt' },
      { id: 'htop', name: 'htop', note: 'Process monitor', install: 'htop', kind: 'apt' },
      { id: 'unzip', name: 'unzip + tar tools', note: 'Archives', install: 'unzip zip xz-utils', kind: 'apt', default: true },
    ],
  },
  {
    id: 'media',
    name: 'Media',
    items: [
      { id: 'ffmpeg', name: 'FFmpeg', note: 'Convert audio and video', install: 'ffmpeg', kind: 'apt' },
      { id: 'imagemagick', name: 'ImageMagick', note: 'Resize and convert images', install: 'imagemagick', kind: 'apt' },
    ],
  },
  {
    id: 'node-tools',
    name: 'Node tools',
    items: [
      { id: 'typescript', name: 'TypeScript', note: 'tsc globally', install: 'typescript', kind: 'npm', requires: 'node' },
      { id: 'pnpm', name: 'pnpm', note: 'Fast package manager', install: 'pnpm', kind: 'npm', requires: 'node' },
      { id: 'yarn', name: 'Yarn', note: 'Classic package manager', install: 'yarn', kind: 'npm', requires: 'node' },
    ],
  },
]

export const ALL_PACKAGES: PackageItem[] = PACKAGE_CATEGORIES.flatMap((c) => c.items)

export function defaultsPackageIds(): string[] {
  return ALL_PACKAGES.filter((p) => p.default).map((p) => p.id)
}

export interface PackageResult {
  id: string
  ok: boolean
  detail: string
}

/** apt package names for the selected ids, in dependency order. */
export function aptCommand(selected: string[]): string | null {
  const set = new Set(selected)
  const pkgs: string[] = []
  for (const item of ALL_PACKAGES) {
    if (item.kind !== 'apt' || !set.has(item.id)) continue
    for (const p of item.install.split(/\s+/)) if (p && !pkgs.includes(p)) pkgs.push(p)
  }
  return pkgs.length ? pkgs.join(' ') : null
}

/** npm globals for the selected ids, in dependency order. */
export function npmCommand(selected: string[]): string | null {
  const set = new Set(selected)
  const specs = ALL_PACKAGES.filter((i) => i.kind === 'npm' && set.has(i.id)).map((i) => i.install)
  return specs.length ? specs.join(' ') : null
}

/** Requirements not met by the selection (e.g. npm tools without node). */
export function missingRequirements(selected: string[]): string[] {
  const set = new Set(selected)
  return ALL_PACKAGES.filter((i) => set.has(i.id) && i.requires && !set.has(i.requires)).map((i) => i.id)
}

/** Expand requirements so node is installed for the npm tools. */
export function withRequirements(selected: string[]): string[] {
  const out = new Set(selected)
  for (const id of [...out]) {
    const item = ALL_PACKAGES.find((i) => i.id === id)
    let req = item?.requires
    while (req) {
      out.add(req)
      req = ALL_PACKAGES.find((i) => i.id === req)?.requires
    }
  }
  return [...out]
}

// ── install runner: detached script + log polling ───────────────────────────

/** Where the runner script and its progress log live inside the guest. */
const INSTALL_SCRIPT_PATH = '/root/.moch-install.sh'
const INSTALL_LOG_PATH = '/root/.moch-install.log'
const INSTALL_APT_LOG_PATH = '/root/.moch-install-apt.log'
const INSTALL_UPDATE_LOG_PATH = '/root/.moch-install-update.log'

/** Poll cadence, poll-RPC timeout, and the 30-minute overall cap. */
const INSTALL_POLL_MS = 2500
const INSTALL_POLL_TIMEOUT_S = 10
const INSTALL_CAP_MS = 30 * 60 * 1000
// The watcher RPC's timeout lives in ./installWatcher (INSTALL_WATCHER_TIMEOUT_S,
// 1860 s = the 30-minute watch window + grace, under the bridge's 3600 s cap) so
// the tsx battery can pin it against the bridge ceiling next to the shell it
// belongs to.
/** FAIL lines carry a short stderr tail — never a wall of apt noise. */
const INSTALL_DETAIL_MAX = 300
/** After the poll loop ends, how long we wait for the in-guest watcher to see
 * DONE, reap the installer, and exit so the tracer never outlives nothing. */
const INSTALL_WATCHER_SETTLE_MS = 15_000

export interface InstallItemState {
  ok: boolean
  /** stderr tail of the failing stage, one line (empty when ok). */
  detail: string
}

export interface InstallLogState {
  /** Outcome per item id seen so far. */
  items: Record<string, InstallItemState>
  /** The script printed MOCH:DONE. */
  done: boolean
  /** Last stage token seen: '' | 'update' | 'apt' | 'npm:<id>'. */
  stage: string
}

/**
 * Parse the `MOCH:*` progress lines out of the runner log. Pure: takes the
 * lines of one `tail` snapshot, returns everything they imply — per-item
 * outcomes, whether the run finished, and the stage the script is in now.
 * FAIL tails may contain colons, so the detail is everything after FAIL:.
 */
export function parseInstallLog(lines: string[]): InstallLogState {
  const items: Record<string, InstallItemState> = {}
  let done = false
  let stage = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('MOCH:')) continue
    const parts = line.split(':')
    if (parts[1] === 'STAGE') {
      if (parts[2] === 'UPDATE') stage = 'update'
      else if (parts[2] === 'APT') stage = 'apt'
    } else if (parts[1] === 'NPM' && parts[2] === 'START' && parts[3]) {
      stage = `npm:${parts[3]}`
    } else if (parts[1] === 'ITEM' && parts.length >= 4) {
      const id = parts[2]
      if (parts[3] === 'OK') items[id] = { ok: true, detail: '' }
      else if (parts[3] === 'FAIL') items[id] = { ok: false, detail: parts.slice(4).join(':') }
    } else if (parts[1] === 'DONE') {
      done = true
    }
  }
  return { items, done, stage }
}

/**
 * Set while installPackages polls; cancelPackageInstall flips it so the poll
 * loop stops instead of running to the 30-minute cap against a dead script.
 */
let installCancelled = false

/**
 * Best-effort cancel: kill the detached script in the guest and make the
 * current installPackages call finish early, reporting the items that never
 * produced a log line as failures ('cancelled'). Safe to call any time.
 */
export async function cancelPackageInstall(): Promise<void> {
  installCancelled = true
  await linuxExec('pkill -f .moch-install.sh || true', 10)
}

/**
 * The last runner log, verbatim (main protocol log + the failing stages'
 * side logs), for the wizard's "Show log" expander — a failure whose detail
 * line isn't enough gets its evidence here, no second install needed.
 */
export async function readInstallLog(maxLines = 120): Promise<string> {
  const parts: string[] = []
  const tail = async (path: string, n: number): Promise<string> => {
    const r = await linuxExec(`tail -n ${n} ${path} 2>/dev/null`, 10)
    return r?.ok ? (r.stdout ?? '').trim() : ''
  }
  const main = await tail(INSTALL_LOG_PATH, Math.min(60, maxLines))
  if (main) parts.push(`── installer log ──\n${main}`)
  const update = await tail(INSTALL_UPDATE_LOG_PATH, 15)
  if (update && !/Reading package lists\.* Done/.test(update)) parts.push(`── apt update ──\n${update}`)
  const apt = await tail(INSTALL_APT_LOG_PATH, 15)
  if (apt && !/Reading package lists\.* Done/.test(apt)) parts.push(`── apt install ──\n${apt}`)
  return parts.join('\n\n').slice(-4000)
}

/**
 * The runner script. POSIX sh; `set +e` per stage (which is sh's default,
 * spelled out here on purpose) so one failure never stops the rest. Stage
 * output goes to side logs; only the `MOCH:*` protocol lands in the main log
 * the RN side tails. Started by the WATCHER command (./installWatcher), which
 * keeps a live proot tracer on it until it exits — BUG-147.
 */
function buildInstallScript(aptIds: string[], npmItems: PackageItem[], aptPkgs: string | null): string {
  const lines: string[] = [
    '#!/bin/sh',
    '# Moch guest installer — written by the onboarding wizard, started by the',
    '# in-guest watcher so a live proot tracer covers the whole run. Progress',
    '# is a MOCH:* line protocol on stdout; the RN side tails this log.',
    'set +e',
    'export DEBIAN_FRONTEND=noninteractive',
    '',
  ]
  if (aptPkgs) {
    lines.push(
      `apt_pkgs="${aptPkgs}"`,
      `apt_ids="${aptIds.join(' ')}"`,
      'if [ -n "$apt_pkgs" ]; then',
      '  echo "MOCH:STAGE:UPDATE:START"',
      // A stale/empty resolv.conf is the classic fresh-rootfs killer (DNS
      // seeding is best-effort at bootstrap); re-seed defensively so an
      // update failure can only be a network/apt problem, never DNS.
      '  if ! grep -q "^nameserver" /etc/resolv.conf 2>/dev/null; then',
      '    printf "nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n" > /etc/resolv.conf 2>/dev/null || true',
      '  fi',
      // The first update right after bootstrap often loses a race with the
      // network coming up — one retry before the items are marked failed.
      `  apt-get update -qq >${INSTALL_UPDATE_LOG_PATH} 2>&1`,
      '  upd_rc=$?',
      '  if [ "$upd_rc" -ne 0 ]; then',
      '    sleep 5',
      `    apt-get update -qq >>${INSTALL_UPDATE_LOG_PATH} 2>&1`,
      '    upd_rc=$?',
      '  fi',
      `  upd_tail="$(tail -n 3 ${INSTALL_UPDATE_LOG_PATH} 2>/dev/null | tr '\\n' ' ' | cut -c1-260)"`,
      '  echo "MOCH:STAGE:APT:START"',
      `  apt-get install -y -qq --no-install-recommends $apt_pkgs >${INSTALL_APT_LOG_PATH} 2>&1`,
      '  apt_rc=$?',
      `  apt_tail="$(tail -n 3 ${INSTALL_APT_LOG_PATH} 2>/dev/null | tr '\\n' ' ' | cut -c1-260)"`,
      '  for id in $apt_ids; do',
      '    if [ "$upd_rc" -eq 0 ] && [ "$apt_rc" -eq 0 ]; then',
      '      echo "MOCH:ITEM:$id:OK"',
      '    elif [ "$upd_rc" -ne 0 ]; then',
      '      echo "MOCH:ITEM:$id:FAIL:update: $upd_tail"',
      '    else',
      '      echo "MOCH:ITEM:$id:FAIL:install: $apt_tail"',
      '    fi',
      '  done',
      'fi',
      '',
    )
  }
  for (const item of npmItems) {
    const log = `/root/.moch-install-npm-${item.id}.log`
    lines.push(
      `echo "MOCH:NPM:START:${item.id}"`,
      `npm install -g --no-audit --no-fund ${item.install} >${log} 2>&1`,
      'npm_rc=$?',
      `npm_tail="$(tail -n 3 ${log} 2>/dev/null | tr '\\n' ' ' | cut -c1-260)"`,
      `if [ "$npm_rc" -eq 0 ]; then echo "MOCH:ITEM:${item.id}:OK"; else echo "MOCH:ITEM:${item.id}:FAIL:$npm_tail"; fi`,
      '',
    )
  }
  lines.push(`echo "${INSTALL_DONE_MARKER}"`)
  return lines.join('\n')
}

/**
 * Install the selection: ONE runner script in the guest (apt stage first —
 * one update + one install, apt items sharing its outcome — then each npm
 * global individually), started under the in-guest WATCHER command so a live
 * proot tracer covers the whole run (BUG-147), with UI progress still riding
 * short-timeout log tails. Returns one result per selected item; onStage
 * reports the runner's stage tokens as they change. Failures are per item,
 * never fatal to the set; the whole run is capped at 30 minutes.
 */
export async function installPackages(
  selected: string[],
  onProgress?: (r: PackageResult) => void,
  onStage?: (stage: string) => void,
): Promise<PackageResult[]> {
  const wanted = withRequirements(selected)
  const results: PackageResult[] = []
  const emitted = new Set<string>()
  const emit = (r: PackageResult) => {
    if (emitted.has(r.id)) return
    emitted.add(r.id)
    results.push(r)
    onProgress?.(r)
  }
  if (!wanted.length) return results
  installCancelled = false

  const aptIds = ALL_PACKAGES.filter((i) => i.kind === 'apt' && wanted.includes(i.id)).map((i) => i.id)
  const npmItems = ALL_PACKAGES.filter((i) => i.kind === 'npm' && wanted.includes(i.id))
  const ids = [...aptIds, ...npmItems.map((i) => i.id)]

  // Write the script and start it under the WATCHER command in ONE RPC
  // (BUG-147): the watcher starts the installer, then polls its liveness and
  // the done marker in-guest until the installer is reaped — so the proot
  // that traces the whole command stays alive across the entire install
  // window. The old shape (`nohup … & echo started`) returned instantly,
  // proot exited, and the orphaned installer's syscalls came back broken
  // mid-apt. The watcher RPC settles only when the install is over (or the
  // 30-minute window lapsed); a FAILURE settles quickly and is surfaced
  // through the poll loop below so the UI fails fast, same as before.
  const script = buildInstallScript(aptIds, npmItems, aptCommand(wanted))
  let watcherError: string | null = null
  const watcher: Promise<void> = linuxExec(
    buildInstallWatcherCommand(b64encodeText(script), {
      scriptPath: INSTALL_SCRIPT_PATH,
      logPath: INSTALL_LOG_PATH,
    }),
    INSTALL_WATCHER_TIMEOUT_S,
  )
    .then((r) => {
      if (!r || !r.ok) {
        watcherError =
          (r ? `${r.stderr || r.error || r.stdout}`.replace(/\s+/g, ' ').trim().slice(-INSTALL_DETAIL_MAX) : '') ||
          'could not start the installer'
      }
    })
    .catch(() => {
      watcherError = 'could not start the installer'
    })

  // Tail the runner log every 2.5s until MOCH:DONE, the 30-minute cap, a
  // watcher failure, or a cancel. A failed tail (log not written yet, or one
  // bridge hiccup) is not fatal — keep polling; the cap catches a truly dead
  // guest.
  const started = Date.now()
  let stage = ''
  let cancelled = false
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, INSTALL_POLL_MS))
    if (installCancelled) {
      cancelled = true
      break
    }
    if (watcherError) break
    if (Date.now() - started >= INSTALL_CAP_MS) break
    const r = await linuxExec(`tail -n 40 ${INSTALL_LOG_PATH} 2>/dev/null`, INSTALL_POLL_TIMEOUT_S)
    if (!r || !r.ok) continue
    const st = parseInstallLog(r.stdout.split('\n'))
    if (st.stage && st.stage !== stage) {
      stage = st.stage
      onStage?.(stage)
    }
    for (const id of ids) {
      const outcome = st.items[id]
      if (outcome) emit({ id, ok: outcome.ok, detail: outcome.detail.slice(0, INSTALL_DETAIL_MAX) })
    }
    if (st.done) break
  }

  // Anything the log never reported gets an explicit failure — cancelled,
  // the watcher never got the installer going, the cap ran out ('timed
  // out'), or the script simply reported nothing ('no result reported').
  const timedOut = Date.now() - started >= INSTALL_CAP_MS
  const reason = cancelled
    ? 'cancelled'
    : watcherError
      ? watcherError
      : timedOut
        ? 'timed out'
        : 'no result reported'
  for (const id of ids) emit({ id, ok: false, detail: reason })

  // Give the in-guest watcher a moment to observe DONE, reap the installer
  // and exit, so the tracer is alive for every syscall the installer made.
  // On the happy path this resolves within one watcher poll of the loop
  // breaking; if it somehow hangs, the bridge timeout is the backstop and
  // the promise already has its rejection handler attached.
  await Promise.race([watcher, new Promise<void>((resolve) => setTimeout(resolve, INSTALL_WATCHER_SETTLE_MS))])
  return results
}
