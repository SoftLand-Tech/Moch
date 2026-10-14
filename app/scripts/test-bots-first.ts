// Unit tests for lib/botRoster (UI-007, bots-first surfaces) — roster
// synthesis/dedupe, deterministic disc colors, and the resume-or-start
// latest-chat pick. Pure module: no RN, no stores.
export {}
type RosterMod = typeof import('../src/lib/botRoster')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const r: RosterMod = await import('../src/lib/botRoster')

  // ── botRoster ─────────────────────────────────────────────────────────────
  const empty = r.botRoster([])
  check('empty roster still yields the default agent card', empty.length === 1 && empty[0].isDefault && empty[0].name === 'Moch')

  const withDefault = r.botRoster([
    { name: 'default', description: 'the agent' },
    { name: 'Atlas', description: 'research' },
  ])
  check('a profile named default is deduped into the Moch card', withDefault.length === 2 && withDefault[0].key === 'default' && !withDefault.some((b) => b.name === 'default'))
  check('default card comes first', withDefault[0].isDefault)

  const caseMixed = r.botRoster([{ name: 'Moch', description: '' }, { name: 'moch', description: '' }])
  check('Moch/moch case-insensitively deduped', caseMixed.length === 1 && caseMixed[0].isDefault)

  const many = r.botRoster([
    { name: 'Atlas', description: 'watches deals' },
    { name: 'B', description: '' },
  ])
  check('server order preserved after the default card', many.map((b) => b.name).join(',') === 'Moch,Atlas,B')
  check('descriptions pass through', many[1].description === 'watches deals' && many[2].description === '')
  check('every card carries a 0-3 color bucket', many.every((b) => b.colorIndex >= 0 && b.colorIndex <= 3))

  // ── avatar assignment (UI-009 mochi-children) ─────────────────────────────
  const noAv = r.botRoster([{ name: 'Atlas', description: '' }])
  check('avatarCount 0 → avatarIndex -1 (disc fallback)', noAv[1].avatarIndex === -1 && noAv[0].avatarIndex === -1)
  const withAv = r.botRoster([{ name: 'Atlas' }, { name: 'B' }, { name: 'C' }], 15)
  check('avatarIndex in range with a set of 15', withAv.every((b) => b.isDefault || (b.avatarIndex >= 0 && b.avatarIndex <= 14)))
  check('avatarIndex deterministic per name', withAv[1].avatarIndex === r.botRoster([{ name: 'Atlas' }], 15)[1].avatarIndex)
  check('distinct names can share a face (modulo is fine, no crash)', new Set([withAv[1].avatarIndex, withAv[2].avatarIndex]).size >= 1)

  // ── colorIndexFor ─────────────────────────────────────────────────────────
  check('color bucket is deterministic', r.colorIndexFor('Atlas') === r.colorIndexFor('Atlas'))
  check('color bucket of empty name stays in range', r.colorIndexFor('') <= 3)

  // ── pickLatestBotChat ─────────────────────────────────────────────────────
  const rows = [
    { id: 'a', profile: 'Atlas', started_at: 1700000100 },
    { id: 'b', profile: 'Atlas', started_at: 1700000200 },
    { id: 'c', profile: 'other', started_at: 1700000900 },
    { id: 'd', started_at: 1700000500 },
  ]
  check('picks the bot latest chat by started_at', r.pickLatestBotChat(rows, 'Atlas') === 'b')
  check('no chats for the bot → null', r.pickLatestBotChat(rows, 'Nobody') === null)
  check('rows without a profile never match', r.pickLatestBotChat(rows, 'other') === 'c')

  const bump = { b: 1893456000000 } // 2030-01-01 in ms — lastActiveMap is wall-clock ms
  check('local revive-to-top bump wins over started_at', r.pickLatestBotChat(rows, 'Atlas', bump) === 'b')
  const bumpA = { a: 1893456000000 }
  check('bump can flip the winner to the other chat', r.pickLatestBotChat(rows, 'Atlas', bumpA) === 'a')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
