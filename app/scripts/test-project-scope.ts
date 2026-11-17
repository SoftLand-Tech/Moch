// Project → cwd / cwd → project rules (UI-2). Pure: no RN, no stores.
export {}
type Mod = typeof import('../src/lib/projectScope')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const m: Mod = await import('../src/lib/projectScope')

  const rows = [
    { id: 'p-personal', path: '/home/u/work', isNoProject: true },
    { id: 'p-moch', path: '/work/moch' },
    { id: 'p-client', path: '/work/client' },
    { id: 'p-nofolder' },
  ]

  // ── pickProjectCwd ───────────────────────────────────────────────────────
  check('no selection → undefined (runtime default)', m.pickProjectCwd(rows, null) === undefined)
  check('unknown selection → undefined', m.pickProjectCwd(rows, 'p-missing') === undefined)
  check('default bucket never yields its folder', m.pickProjectCwd(rows, 'p-personal') === undefined)
  check('project without a folder → undefined (no guessing)', m.pickProjectCwd(rows, 'p-nofolder') === undefined)
  check('selected project → its path', m.pickProjectCwd(rows, 'p-moch') === '/work/moch')

  // ── projectIdForCwd ──────────────────────────────────────────────────────
  check('exact folder match', m.projectIdForCwd(rows, '/work/moch') === 'p-moch')
  check('child path matches its project', m.projectIdForCwd(rows, '/work/moch/app/src') === 'p-moch')
  check('trailing slash normalized', m.projectIdForCwd(rows, '/work/moch/') === 'p-moch')
  check('sibling prefix is NOT a match', m.projectIdForCwd(rows, '/work/mochawk') === undefined)
  check('unrelated path → no project', m.projectIdForCwd(rows, '/tmp/scratch') === undefined)
  check('empty cwd → no project', m.projectIdForCwd(rows, '') === undefined)
  check('personal bucket does not claim its folder', m.projectIdForCwd(rows, '/home/u/work') === undefined)
  check('backslashes normalize', m.projectIdForCwd(rows, '\\work\\client\\x') === 'p-client')

  // ── longest prefix wins ──────────────────────────────────────────────────
  const nested = [
    { id: 'outer', path: '/work' },
    { id: 'inner', path: '/work/moch' },
  ]
  check('longest prefix wins', m.projectIdForCwd(nested, '/work/moch/app') === 'inner')
  check('outer still matches elsewhere', m.projectIdForCwd(nested, '/work/other') === 'outer')

  // ── normalization ────────────────────────────────────────────────────────
  check('normalize trims + unifies slashes', m.normalizeProjectPath('  /a\\b/c/  ') === '/a/b/c')
  check('root stays root', m.normalizeProjectPath('/') === '/')
  check('empty stays empty', m.normalizeProjectPath('   ') === '')

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

void main()
