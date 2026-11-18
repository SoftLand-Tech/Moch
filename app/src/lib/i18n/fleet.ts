import type { Catalog } from './types'

/**
 * Catalog domain: fleet (mockup screen 7 — /(tabs)/fleet).
 *
 * Only the copy that changed with the redesign lives here; the screen keeps
 * reusing the legacy `fleet.*` keys (translated in all four locales) for the
 * title, empty state, error/offline banners, create RPC errors and a11y
 * labels. Keys in this file override nothing — no legacy key is duplicated.
 */
export const fleet: Catalog = {
  en: {
    // Runtime queue strip (real moch.fleet.status data).
    'fleet.runtime.slots': '{active} / {slots} active queue slots',
    'fleet.runtime.waiting': '{n} waiting',

    // Bot card status + actions.
    'fleet.frozen': 'Frozen',
    'fleet.chat.cta': 'Chat',
    'fleet.freeze.cta': 'Freeze',
    'fleet.unfreeze.cta': 'Unfreeze',

    // Create-bot card (BUG-139 checklist preserved).
    'fleet.create.title': 'Create new bot',
    'fleet.create.new': '+ New Bot',
    'fleet.create.copyUser': 'Copy USER.md memory',
    'fleet.create.copyMemory': 'Share workspace memory files',
    'fleet.create.skill': 'Attach launch skill',
    'fleet.create.submit': 'Create',

    // Starter job seeds (zero-typing path, §2.7).
    'fleet.starter.research': 'Research',
    'fleet.starter.research.job':
      'Research assistant: read my saved sources daily and brief me on what changed.',
    'fleet.starter.deals': 'Deals',
    'fleet.starter.deals.job':
      'Deal watcher: track product pages I name and notify me on price drops.',
    'fleet.starter.code': 'Code (PC)',
    'fleet.starter.code.job':
      'Code helper bound to my linked PC: work in my repos on request.',
    'fleet.starter.journal': 'Private journal',
    'fleet.starter.journal.job':
      'Private journal/finance watcher over my own local files only — never sends anything anywhere.',
  },
  ar: {
    'fleet.runtime.slots': '{active} / {slots} خانات انتظار نشطة',
    'fleet.runtime.waiting': '{n} في الانتظار',

    'fleet.frozen': 'مجمّد',
    'fleet.chat.cta': 'محادثة',
    'fleet.freeze.cta': 'تجميد',
    'fleet.unfreeze.cta': 'إلغاء التجميد',

    'fleet.create.title': 'إنشاء بوت جديد',
    'fleet.create.new': '+ بوت جديد',
    'fleet.create.copyUser': 'نسخ ذاكرة USER.md',
    'fleet.create.copyMemory': 'مشاركة ملفات ذاكرة مساحة العمل',
    'fleet.create.skill': 'إرفاق مهارة تشغيل',
    'fleet.create.submit': 'إنشاء',

    'fleet.starter.research': 'بحث',
    'fleet.starter.research.job':
      'مساعد بحث: اقرأ مصادري المحفوظة يوميًا ولخّص لي ما تغيّر.',
    'fleet.starter.deals': 'عروض',
    'fleet.starter.deals.job':
      'مراقب عروض: تابع صفحات المنتجات التي أحددها وأبلغني بانخفاض الأسعار.',
    'fleet.starter.code': 'برمجة (حاسوب)',
    'fleet.starter.code.job':
      'مساعد برمجة مرتبط بحاسوبي: اعمل في مستودعاتي عند الطلب.',
    'fleet.starter.journal': 'يوميّات خاصة',
    'fleet.starter.journal.job':
      'مراقب يوميّات/مالية خاص على ملفاتي المحلية فقط — لا يرسل أي شيء إلى أي مكان.',
  },
  zh: {
    'fleet.runtime.slots': '{active} / {slots} 个活跃队列槽位',
    'fleet.runtime.waiting': '{n} 个等待中',

    'fleet.frozen': '已冻结',
    'fleet.chat.cta': '对话',
    'fleet.freeze.cta': '冻结',
    'fleet.unfreeze.cta': '解冻',

    'fleet.create.title': '创建新机器人',
    'fleet.create.new': '+ 新建机器人',
    'fleet.create.copyUser': '复制 USER.md 记忆',
    'fleet.create.copyMemory': '共享工作区记忆文件',
    'fleet.create.skill': '附加启动技能',
    'fleet.create.submit': '创建',

    'fleet.starter.research': '调研',
    'fleet.starter.research.job': '研究助理：每天阅读我保存的资料，并向我汇报变化。',
    'fleet.starter.deals': '优惠',
    'fleet.starter.deals.job': '优惠监控：跟踪我指定的商品页面，在降价时通知我。',
    'fleet.starter.code': '代码（电脑）',
    'fleet.starter.code.job': '绑定我已连接电脑的代码助手：按需在我的仓库中工作。',
    'fleet.starter.journal': '私密日记',
    'fleet.starter.journal.job':
      '仅基于我本地文件的私密日记/财务监控 — 绝不会把任何内容发送到任何地方。',
  },
  fr: {
    'fleet.runtime.slots': '{active} / {slots} créneaux de file actifs',
    'fleet.runtime.waiting': '{n} en attente',

    'fleet.frozen': 'Gelé',
    'fleet.chat.cta': 'Discussion',
    'fleet.freeze.cta': 'Geler',
    'fleet.unfreeze.cta': 'Dégeler',

    'fleet.create.title': 'Créer un bot',
    'fleet.create.new': '+ Nouveau bot',
    'fleet.create.copyUser': 'Copier la mémoire USER.md',
    'fleet.create.copyMemory': 'Partager les fichiers mémoire de l’espace de travail',
    'fleet.create.skill': 'Joindre une compétence de lancement',
    'fleet.create.submit': 'Créer',

    'fleet.starter.research': 'Recherche',
    'fleet.starter.research.job':
      'Assistant de recherche : lis mes sources enregistrées chaque jour et résume-moi les changements.',
    'fleet.starter.deals': 'Bons plans',
    'fleet.starter.deals.job':
      'Veille bons plans : suis les pages produits que je nomme et préviens-moi en cas de baisse de prix.',
    'fleet.starter.code': 'Code (PC)',
    'fleet.starter.code.job':
      'Assistant code lié à mon PC connecté : travaille dans mes dépôts sur demande.',
    'fleet.starter.journal': 'Journal privé',
    'fleet.starter.journal.job':
      'Journal/veille financière privé uniquement sur mes fichiers locaux — n’envoie jamais rien nulle part.',
  },
}
