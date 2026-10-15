/** Palette ranking tests — pure module, runs in plain node via tsx. */
import { rankItems, scoreItem } from '../src/ui/shell/paletteRank'

let failures = 0
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures++
    console.error('FAIL', name)
  } else {
    console.log('ok', name)
  }
}

const screens = [
  { id: 'screen:chat', title: 'Chat' },
  { id: 'screen:crew', title: 'Crew' },
  { id: 'screen:automations', title: 'Automations' },
]

check('empty query matches all', rankItems('', screens).length === 3)
check('exact prefix first', rankItems('ch', screens)[0]?.id === 'screen:chat')
check(
  'word prefix matches after space',
  rankItems('auto', [{ id: 'a', title: 'My Automations' }])[0]?.id === 'a',
)
check(
  'substring ranks below word-prefix',
  scoreItem('uto', { id: 'x', title: 'Automations' }) < scoreItem('auto', { id: 'x', title: 'Automations' }),
)
check('no match excluded', rankItems('zzz', screens).length === 0)
check(
  'recency breaks ties',
  rankItems('new', [
    { id: 'old', title: 'New chat', recency: 100 },
    { id: 'older', title: 'New chat', recency: 50 },
  ])[0]?.id === 'old',
)
check(
  'hint substring matches',
  rankItems('search', [{ id: 's', title: 'Find', hint: 'search everywhere' }]).length === 1,
)

if (failures > 0) {
  console.error(`${failures} failures`)
  process.exit(1)
}
console.log('palette ranking: all green')
