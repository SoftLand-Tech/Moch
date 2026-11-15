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
 */
import { guestRun } from './thinker'

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

/** apt package names for the selected ids, in dependency order. */export function aptCommand(selected: string[]): string | null {
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

/**
 * Install the selection. apt first (one update + one install), then each npm
 * global individually so one failure cannot hide the rest. Returns one result
 * per selected item (apt items share the apt outcome).
 */
export async function installPackages(selected: string[], onProgress?: (r: PackageResult) => void): Promise<PackageResult[]> {
  const wanted = withRequirements(selected)
  const results: PackageResult[] = []
  const emit = (r: PackageResult) => { results.push(r); onProgress?.(r) }

  const apt = aptCommand(wanted)
  if (apt) {
    const upd = await guestRun('apt-get update -qq', 180_000)
    if (!upd.ok) {
      emit({ id: 'apt', ok: false, detail: (upd.stderr || upd.stdout || 'apt-get update failed').slice(0, 300) })
    } else {
      const inst = await guestRun(`DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${apt}`, 900_000)
      const detail = (inst.ok ? inst.stdout : (inst.stderr || inst.stdout)).slice(-300)
      for (const item of ALL_PACKAGES) {
        if (item.kind !== 'apt' || !wanted.includes(item.id)) continue
        emit({ id: item.id, ok: inst.ok, detail })
      }
    }
  }

  for (const item of ALL_PACKAGES) {
    if (item.kind !== 'npm' || !wanted.includes(item.id)) continue
    const r = await guestRun(`npm install -g --no-audit --no-fund ${item.install}`, 600_000)
    emit({ id: item.id, ok: r.ok, detail: (r.ok ? r.stdout : (r.stderr || r.stdout)).slice(-300) })
  }
  return results
}
