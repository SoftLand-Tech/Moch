// Loads the real strings module (and each domain catalog) with esbuild, then
// proves three things: EN/AR key parity, no key drift against the committed
// snapshot, and that strings.ts merges every domain file on disk.
//
//   node scripts/check-strings.mjs check      verify parity + zero drift
//   node scripts/check-strings.mjs snapshot   (re)write the baseline after intentional key changes
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const UI_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let failed = false
const STRINGS_TS = path.join(UI_ROOT, 'src/lib/strings.ts')
const STRINGS_DIR = path.join(UI_ROOT, 'src/lib/strings')
const SNAPSHOT = path.join(UI_ROOT, 'scripts/strings-snapshot.json')

async function loadModule(file, names) {
  const bundled = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  let code = bundled.outputFiles[0].text
  for (const name of names) {
    if (!new RegExp(`\\b(?:const|var|let) ${name}\\b`).test(code)) {
      throw new Error(`${name} not found in bundled ${path.relative(UI_ROOT, file)}`)
    }
  }
  code += `\nexport { ${names.map((n) => `${n} as __probe_${n}`).join(', ')} }\n`
  const dir = await mkdtemp(path.join(tmpdir(), 'moch-strings-'))
  try {
    const js = path.join(dir, 'module.mjs')
    await writeFile(js, code)
    const mod = await import(pathToFileURL(js).href)
    return Object.fromEntries(names.map((n) => [n, mod[`__probe_${n}`]]))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function assertParity(label, en, ar) {
  const enKeys = new Set(Object.keys(en))
  const arKeys = new Set(Object.keys(ar))
  const missingAr = [...enKeys].filter((k) => !arKeys.has(k))
  const missingEn = [...arKeys].filter((k) => !enKeys.has(k))
  if (missingAr.length || missingEn.length) {
    console.error(`${label}: EN/AR key parity broken`)
    if (missingAr.length) console.error(`  in EN but not AR: ${missingAr.join(', ')}`)
    if (missingEn.length) console.error(`  in AR but not EN: ${missingEn.join(', ')}`)
    failed = true
  }
}

function canonical(catalog) {
  const out = {}
  for (const key of Object.keys(catalog.en).sort()) out[key] = [catalog.en[key], catalog.ar[key]]
  return out
}

function failDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (!b) changed.push(`added   ${key}`)
    else if (!a) changed.push(`removed ${key}`)
    else if (a[0] !== b[0]) changed.push(`EN changed ${key}`)
    else if (a[1] !== b[1]) changed.push(`AR changed ${key}`)
  }
  console.error(`key drift vs ${path.relative(UI_ROOT, SNAPSHOT)}: ${changed.length} difference(s)`)
  for (const line of changed.slice(0, 20)) console.error(`  ${line}`)
  if (changed.length > 20) console.error(`  … and ${changed.length - 20} more`)
  failed = true
}

const command = process.argv[2] ?? 'check'
const strings = await loadModule(STRINGS_TS, ['EN', 'AR'])
const catalog = { en: strings.EN, ar: strings.AR }
assertParity('catalog', catalog.en, catalog.ar)

let domainEntries = []
try {
  domainEntries = await readdir(STRINGS_DIR, { withFileTypes: true })
} catch {
  // no per-domain catalogs yet (single-file layout); only catalog checks apply
}
const domains = domainEntries
  .filter((e) => e.isFile() && e.name.endsWith('.ts') && e.name !== 'index.ts')
  .map((e) => e.name.replace(/\.ts$/, ''))
  .sort()

if (domains.length > 0) {
  const stringsSource = await readFile(STRINGS_TS, 'utf8')
  const merged = { en: {}, ar: {} }
  for (const domain of domains) {
    const mod = await loadModule(path.join(STRINGS_DIR, `${domain}.ts`), ['en', 'ar'])
    assertParity(`strings/${domain}.ts`, mod.en, mod.ar)
    for (const key of Object.keys(mod.en)) {
      if (key in merged.en) {
        console.error(`duplicate key ${key} appears in more than one domain file`)
        failed = true
      }
      merged.en[key] = mod.en[key]
      merged.ar[key] = mod.ar[key]
    }
    if (!stringsSource.includes(`./strings/${domain}'`)) {
      console.error(`src/lib/strings.ts does not import domain file strings/${domain}.ts`)
      failed = true
    }
  }
  const catalogKeys = new Set(Object.keys(catalog.en))
  const mergedKeys = new Set(Object.keys(merged.en))
  const unmerged = [...mergedKeys].filter((k) => !catalogKeys.has(k))
  const stray = [...catalogKeys].filter((k) => !mergedKeys.has(k))
  if (unmerged.length) console.error(`keys on disk but not in the merged catalog: ${unmerged.join(', ')}`)
  if (stray.length) console.error(`keys in strings.ts outside any domain file: ${stray.join(', ')}`)
  if (unmerged.length || stray.length) failed = true
  const valueDrift = [...mergedKeys].filter(
    (k) => merged.en[k] !== catalog.en[k] || merged.ar[k] !== catalog.ar[k],
  )
  if (valueDrift.length) {
    console.error(`domain merge changes values for: ${valueDrift.join(', ')}`)
    failed = true
  }
}

const current = canonical(catalog)

if (command === 'snapshot') {
  if (failed) {
    console.error('fix the parity/merge errors above before snapshotting')
  } else {
    await writeFile(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`wrote ${path.relative(UI_ROOT, SNAPSHOT)}: ${Object.keys(current).length} keys`)
  }
} else if (command === 'check') {
  let baseline
  try {
    baseline = JSON.parse(await readFile(SNAPSHOT, 'utf8'))
  } catch {
    console.error(`no readable snapshot at ${path.relative(UI_ROOT, SNAPSHOT)}; run: node scripts/check-strings.mjs snapshot`)
    failed = true
  }
  if (baseline && !failed) {
    const before = JSON.stringify(baseline)
    const after = JSON.stringify(current)
    if (before === after) {
      console.log(
        `zero drift: ${Object.keys(current).length} keys match the snapshot exactly`,
      )
    } else {
      failDiff(baseline, current)
    }
  }
} else {
  console.error(`unknown command: ${command} (use check or snapshot)`)
  failed = true
}

if (!failed && domains.length > 0) {
  console.log(`parity OK across ${domains.length} domain file(s): ${domains.join(', ')}`)
}
process.exit(failed ? 1 : 0)
