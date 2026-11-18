import type { Catalog } from './types'

/**
 * Catalog domain: inbox — the Inbox screen (mockup screen 3).
 *
 * `inbox.title`, `inbox.section.*`, `inbox.untitled` are reused from the
 * legacy catalog (their copy already matches). The empty-state copy here is
 * the mockup's wording ("Nothing waiting on you"), which differs from the
 * legacy strings — hence new keys. The age labels intentionally re-state the
 * legacy `inbox.age.*` keys: `inboxAgeLabel` (lib/inbox) resolves them, and
 * owning them here guarantees all four locales translate the relative times
 * regardless of the legacy catalog's translation progress.
 */
export const inbox: Catalog = {
  en: {
    'inbox.empty.headline': 'Nothing waiting on you',
    'inbox.empty.caption': 'Approvals, finished background runs, and alerts appear here.',
    'inbox.age.now': 'just now',
    'inbox.age.minutes': '{n}m ago',
    'inbox.age.hours': '{n}h ago',
    'inbox.age.days': '{n}d ago',
  },
  ar: {
    'inbox.empty.headline': 'لا شيء بانتظارك',
    'inbox.empty.caption': 'الموافقات والتشغيلات المنتهية في الخلفية والتنبيهات تظهر هنا.',
    'inbox.age.now': 'الآن',
    'inbox.age.minutes': 'قبل {n} د',
    'inbox.age.hours': 'قبل {n} س',
    'inbox.age.days': 'قبل {n} ي',
  },
  zh: {
    'inbox.empty.headline': '没有待你处理的事项',
    'inbox.empty.caption': '审批、已完成的后台任务和提醒会显示在这里。',
    'inbox.age.now': '刚刚',
    'inbox.age.minutes': '{n} 分钟前',
    'inbox.age.hours': '{n} 小时前',
    'inbox.age.days': '{n} 天前',
  },
  fr: {
    'inbox.empty.headline': 'Rien ne vous attend',
    'inbox.empty.caption': 'Les approbations, les tâches terminées en arrière-plan et les alertes apparaissent ici.',
    'inbox.age.now': "à l'instant",
    'inbox.age.minutes': 'il y a {n} min',
    'inbox.age.hours': 'il y a {n} h',
    'inbox.age.days': 'il y a {n} j',
  },
}
