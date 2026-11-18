/**
 * i18n completeness gate.
 *
 *   1. Every `tr('domain.key')` / `t('domain.key')` call in app/ + src/ must
 *      resolve in the English catalog (typo protection).
 *   2. Every English key must have a non-empty translation in ar, zh and fr
 *      (the four-locale promise).
 *
 * Run: npx tsx scripts/test-i18n.ts        (exit 1 on any gap)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLES, allKeys } from '../src/lib/i18n'
import type { Locale } from '../src/lib/i18n'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES: Locale[] = ['en', 'ar', 'zh', 'fr']

/** Every source file that may call tr(). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p)
  }
  return out
}

const sources = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src'))]
const KEY_RE = /\b(?:tr|t)\(\s*['"]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"]/g

const used = new Map<string, string[]>()
for (const file of sources) {
  // Strip comments first — doc examples like tr('chat.send') are not usage.
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  for (const m of text.matchAll(KEY_RE)) {
    const key = m[1]
    const list = used.get(key) ?? []
    if (!list.includes(file)) list.push(path.relative(ROOT, file))
    used.set(key, list)
  }
}

const en = BUNDLES.en
const failures: string[] = []

// 1) used keys exist in EN
for (const [key, files] of used) {
  if (!en[key]) failures.push(`missing EN key: ${key}   (used in ${files.join(', ')})`)
}

// 2) every EN key translated in all locales
for (const loc of LOCALES) {
  const bundle = BUNDLES[loc] ?? {}
  const missing = allKeys().filter((k) => !bundle[k] || !bundle[k].trim())
  if (missing.length) {
    failures.push(
      `${loc}: ${missing.length} missing translation(s):\n` + missing.map((k) => `      - ${k}`).join('\n'),
    )
  }
}

// 3) no extra keys outside EN's key set (merge conflicts/typos)
for (const loc of LOCALES) {
  const extras = Object.keys(BUNDLES[loc] ?? {}).filter((k) => !en[k])
  if (extras.length) failures.push(`${loc}: ${extras.length} key(s) absent from EN: ${extras.slice(0, 10).join(', ')}`)
}

const total = allKeys().length
console.log(`i18n: ${total} keys · ${used.size} keys referenced in ${sources.length} source files`)
for (const loc of LOCALES) console.log(`  ${loc}: ${Object.keys(BUNDLES[loc] ?? {}).filter((k) => BUNDLES[loc][k]?.trim()).length} / ${total} translated`)

if (failures.length) {
  console.error(`\n✗ i18n gate failed (${failures.length} problem group(s)):\n`)
  for (const f of failures) console.error('  ' + f + '\n')
  process.exit(1)
}
console.log('\n✓ i18n gate passed')
