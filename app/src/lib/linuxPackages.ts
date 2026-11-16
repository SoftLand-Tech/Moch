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
 * installPackages writes ONE shell script into the guest, detaches it with
 * nohup, and tails its log on a short poll, parsing a `MOCH:*` line protocol.
 * Every bridge call stays short; the guest does the waiting. `parseInstallLog`
 * is pure so the protocol handling is reviewable in isolation.
 */
import { linuxExec } from './mochiRuntime'
import { b64encodeText } from './terminal'

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

/** Poll cadence, kick/poll bridge timeouts, and the 30-minute overall cap. */
const INSTALL_POLL_MS = 2500
const INSTALL_KICK_TIMEOUT_S = 20
const INSTALL_POLL_TIMEOUT_S = 10
const INSTALL_CAP_MS = 30 * 60 * 1000
/** FAIL lines carry a short stderr tail — never a wall of apt noise. */
const INSTALL_DETAIL_MAX = 300

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
 * The detached runner script. POSIX sh; `set +e` per stage (which is sh's
 * default, spelled out here on purpose) so one failure never stops the rest.
 * Stage output goes to side logs; only the `MOCH:*` protocol lands in the
 * main log the RN side tails.
 */
function buildInstallScript(aptIds: string[], npmItems: PackageItem[], aptPkgs: string | null): string {
  const lines: string[] = [
    '#!/bin/sh',
    '# Moch guest installer — written by the onboarding wizard, run detached',
    '# (nohup) so no single bridge RPC has to outlive apt-get. Progress is a',
    '# MOCH:* line protocol on stdout; the RN side tails this log.',
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
      `  apt-get update -qq >${INSTALL_APT_LOG_PATH} 2>&1`,
      '  upd_rc=$?',
      '  echo "MOCH:STAGE:APT:START"',
      `  apt-get install -y -qq --no-install-recommends $apt_pkgs >${INSTALL_APT_LOG_PATH} 2>&1`,
      '  apt_rc=$?',
      `  apt_tail="$(tail -n 3 ${INSTALL_APT_LOG_PATH} 2>/dev/null | tr '\\n' ' ' | cut -c1-260)"`,
      '  for id in $apt_ids; do',
      '    if [ "$upd_rc" -eq 0 ] && [ "$apt_rc" -eq 0 ]; then',
      '      echo "MOCH:ITEM:$id:OK"',
      '    else',
      '      echo "MOCH:ITEM:$id:FAIL:$apt_tail"',
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
  lines.push('echo "MOCH:DONE"')
  return lines.join('\n')
}

/**
 * Install the selection: ONE detached script in the guest (apt stage first —
 * one update + one install, apt items sharing its outcome — then each npm
 * global individually), polled over a short-timeout tail so no bridge RPC
 * outlives apt-get. Returns one result per selected item; onStage reports
 * the runner's stage tokens as they change. Failures are per item, never
 * fatal to the set; the whole run is capped at 30 minutes.
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

  // Write the script (base64 — no quoting hell) and detach it in ONE short
  // RPC. `& echo started` answers before apt does any real work; nohup keeps
  // the script running after proot's sh exits.
  const script = buildInstallScript(aptIds, npmItems, aptCommand(wanted))
  const kick = await linuxExec(
    `echo ${b64encodeText(script)} | base64 -d > ${INSTALL_SCRIPT_PATH} && sh -c 'nohup sh ${INSTALL_SCRIPT_PATH} >${INSTALL_LOG_PATH} 2>&1 & echo started'`,
    INSTALL_KICK_TIMEOUT_S,
  )
  if (!kick || !kick.ok) {
    const detail =
      (kick ? `${kick.stderr || kick.error || kick.stdout}`.replace(/\s+/g, ' ').trim().slice(-INSTALL_DETAIL_MAX) : '') ||
      'could not start the installer'
    for (const id of ids) emit({ id, ok: false, detail })
    return results
  }

  // Poll the log every 2.5s until MOCH:DONE, the 30-minute cap, or a cancel.
  // A failed tail (log not written yet, or one bridge hiccup) is not fatal —
  // keep polling; the cap catches a truly dead guest.
  const started = Date.now()
  let stage = ''
  let cancelled = false
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, INSTALL_POLL_MS))
    if (installCancelled) {
      cancelled = true
      break
    }
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

  // Anything the log never reported gets an explicit failure — the cap ran
  // out ('timed out') or the script was killed ('cancelled').
  const reason = cancelled ? 'cancelled' : Date.now() - started >= INSTALL_CAP_MS ? 'timed out' : 'no result reported'
  for (const id of ids) emit({ id, ok: false, detail: reason })
  return results
}
