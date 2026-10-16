/**
 * Moch Desktop i18n: EN/AR catalog + tr() + the locale store, ported from the
 * mobile app's src/lib/strings.ts. The fleet., crew. and bot. entries are the
 * mobile catalog VERBATIM (same keys, same copy) so the two surfaces never
 * drift; the nav., status., boot. and chat.composer. entries are
 * desktop-specific. Every user-facing string added to the shell sources from
 * here — retrofit is 10x (mobile plan §2.7 applies to the desktop too).
 */
import { atom } from 'nanostores'

export type Locale = 'en' | 'ar'

const LOCALE_KEY = 'moch.desktop.locale.v1'

function readSavedLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'ar' || saved === 'en') return saved
  } catch {
    // storage unavailable (private mode etc.) — default en
  }
  return 'en'
}

/** Active locale; persisted in localStorage under moch.desktop.locale.v1. */
export const locale = atom<Locale>(readSavedLocale())

/** True when the active locale is RTL (drives [dir="rtl"] + row mirroring). */
export function isRTL(): boolean {
  return locale.get() === 'ar'
}

/** Set <html dir> and lang to match the active locale. Safe to call anytime. */
export function applyDirection(): void {
  const l = locale.get()
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (!root) return
  root.dir = l === 'ar' ? 'rtl' : 'ltr'
  root.lang = l
}

/** Switch locale: update the store, persist, and re-apply document direction. */
export function setLocale(l: Locale): void {
  locale.set(l)
  try {
    localStorage.setItem(LOCALE_KEY, l)
  } catch {
    // best-effort
  }
  applyDirection()
}

type Catalog = Record<string, string>

const EN: Catalog = {
  // ── Fleet (verbatim from the mobile catalog) ──
  'fleet.title': 'Fleet',
  'fleet.empty.title': 'Your fleet starts here',
  'fleet.empty.body':
    'Bots are profiles on this device with their own memory, skills and computer. Describe a job below — creation is instant and nothing about chat changes.',
  'fleet.create': 'New bot',
  'fleet.create.job': 'Describe the job — e.g. watch price drops daily',
  'fleet.create.suggested': 'Suggested name',
  'fleet.create.cta': 'Create bot',
  'fleet.create.ideas': 'Ideas about me',
  'fleet.create.ideas.hint':
    'Copy what Moch knows about you (USER.md) into this bot — it starts familiar instead of a stranger.',
  'fleet.create.memory': "Moch's work memory",
  'fleet.create.memory.hint':
    "Also copy Moch's accumulated MEMORY.md — usually noisy; leave off unless the bot needs the history.",
  'fleet.create.skills': 'Skills to give it',
  'fleet.create.skills.empty': 'No skills found in Moch',
  'fleet.create.skills.unavailable': 'Skill list unavailable on this gateway',
  'fleet.create.err': 'Could not create the bot: {why}',
  'fleet.create.partial':
    'Bot created — some checklist items were skipped (existing files are never overwritten).',
  'fleet.cancel': 'Cancel',
  'fleet.offline': 'Fleet offline',
  'fleet.runtime.idle': 'fleet runtime idle on this gateway',
  'fleet.runtime.active': 'fleet runtime · {active}/{slots} turns',
  'fleet.waiting': '{n} waiting ({prios})',
  'fleet.chat': 'Chat with {name}',
  'fleet.freeze': 'Freeze {name}',
  'fleet.unfreeze': 'Unfreeze {name}',
  'fleet.freeze.failed': "Couldn't freeze/unfreeze {name}: {why}",
  'fleet.refresh': 'Refresh fleet',
  'fleet.detail.back': 'Fleet',

  // ── Crew (verbatim from the mobile catalog) ──
  'crew.hint':
    'Board — tasks you create are picked up by the assignee bot within about a minute. Run ledger below.',
  'crew.new': 'New task',
  'crew.new.title': "Task — e.g. summarize yesterday's prices",
  'crew.new.body': 'Details (optional)',
  'crew.new.assignee': 'Assign to',
  'crew.new.cta': 'Put on board',
  'crew.complete': 'Complete',
  'crew.complete.summary': 'completed from the phone (human override)',
  'crew.assign': 'Reassign',
  'crew.moch': 'Moch',
  'crew.err': 'Action failed: {why}',
  'crew.offline': 'Crew offline — showing the last board',
  'crew.timeline': 'Run ledger',
  'crew.timeline.empty': 'No runs recorded yet.',

  // ── Bot (verbatim from the mobile catalog) ──
  'bot.job': 'Job / description',
  'bot.soul': 'SOUL.md — the job description',
  'bot.save': 'Save',
  'bot.saved': 'saved',
  'bot.save.failed': "Couldn't save: {why}",
  'bot.chat': 'Chat with {name}',
  'bot.delete.failed': "Couldn't delete this bot: {why}",
  'bot.delete.title': 'Danger zone',
  'bot.delete.body':
    'Deleting tombstones this bot: its scheduled jobs stop firing (ticker skips tombstones), running turns stop at the next boundary. Kanban tasks it holds stay on the board until the M9.4 crew board offers reassignment.',
  'bot.delete.cta': 'Delete this bot',
  'bot.delete.confirm': 'Tap again to confirm deletion',
  'bot.delete.doing': 'Deleting…',

  // ── Chat surface (verbatim from the mobile catalog) ──
  'chat.foreign.title': 'Another session on this machine is asking you something',
  'chat.foreign.hint': 'Tap to review and answer it here.',
  'chat.clarify.pending.one': '1 question still needs an answer before sending.',
  'chat.clarify.pending.many': '{n} questions still need answers before sending.',

  // ── Desktop: rail navigation ──
  'nav.chats': 'Chats',
  'nav.fleet': 'Fleet',
  'nav.crew': 'Crew',
  'nav.inbox': 'Inbox',
  'nav.browser': 'Browser',
  'nav.terminal': 'Terminal',
  'nav.automations': 'Automations',
  'nav.skills': 'Skills',
  'nav.connectors': 'Connectors',
  'nav.settings': 'Settings',

  // ── Desktop: status bar ──
  'status.runtime.local': 'local runtime',
  'status.offline': 'offline',
  'status.workspace': 'workspace',
  'status.fullyLocal': 'fully local',
  'status.bots.one': 'bot',
  'status.bots.many': 'bots',
  'status.turns': 'turns',

  // ── Desktop: chat empty states + composer ──
  'chat.empty.title': 'What should Mochi do?',
  'chat.empty.title.bot': 'Talk to {name}',
  'chat.empty.sub':
    "Your agents run entirely on this machine — they can use the terminal, browse the web, remember across chats, and work while you're elsewhere. Ask for anything.",
  'chat.list.empty': 'No chats yet — say hi below.',
  'chat.composer.placeholder': 'Ask Mochi anything — / for commands',
  'chat.composer.placeholder.bot': 'Message {name}…',
  'chat.composer.placeholder.steer': 'Steer the running turn — delivered at the next boundary…',

  // ── Desktop: boot veil ──
  'boot.error.title': 'The local runtime hit a problem',
  'boot.retry': 'Retry',
  'boot.local':
    'The hermes agents, your bots and everything else live right here on this machine — nothing leaves it.',
  'boot.connecting': 'connecting to the gateway…',
}

const AR: Catalog = {
  // ── الأسطول (منقول حرفيًا من تطبيق الهاتف) ──
  'fleet.title': 'الأسطول',
  'fleet.empty.title': 'أسطولك يبدأ من هنا',
  'fleet.empty.body':
    'البوتات ملفات على هذا الجهاز لها ذاكرة ومهارات وجهاز خاص بها. صِف المهمة بالأسفل — الإنشاء فوري ولا يتغير شيء في المحادثة.',
  'fleet.create': 'بوت جديد',
  'fleet.create.job': 'صِف المهمة — مثال: تابع تخفيضات الأسعار يوميًا',
  'fleet.create.suggested': 'اسم مقترح',
  'fleet.create.cta': 'أنشئ البوت',
  'fleet.create.ideas': 'معرفة من أنا',
  'fleet.create.ideas.hint':
    'انسخ ما يعرفه موك عنك (USER.md) إلى هذا البوت — يبدأ عارفًا بك بدلًا من غريب.',
  'fleet.create.memory': 'ذاكرة موك العاملة',
  'fleet.create.memory.hint':
    'انسخ أيضًا ذاكرة موك المتراكمة (MEMORY.md) — عادة مشوشة؛ اتركها مطفأة ما لم يحتج البوت التاريخ.',
  'fleet.create.skills': 'مهارات تمنحها له',
  'fleet.create.skills.empty': 'لا توجد مهارات لدى موك',
  'fleet.create.skills.unavailable': 'قائمة المهارات غير متاحة على هذه البوابة',
  'fleet.create.err': 'تعذّر إنشاء البوت: {why}',
  'fleet.create.partial':
    'تم إنشاء البوت — تم تخطي بعض عناصر القائمة (الملفات الموجودة لا تُستبدل أبدًا).',
  'fleet.cancel': 'إلغاء',
  'fleet.offline': 'الأسطول غير متصل',
  'fleet.runtime.idle': 'وقت تشغيل الأسطول خامل على هذه البوابة',
  'fleet.runtime.active': 'وقت التشغيل · {active}/{slots} مهام',
  'fleet.waiting': '{n} في الانتظار ({prios})',
  'fleet.chat': 'تحدث مع {name}',
  'fleet.freeze': 'تجميد {name}',
  'fleet.unfreeze': 'إلغاء تجميد {name}',
  'fleet.freeze.failed': 'تعذّر تجميد/إلغاء تجميد {name}: {why}',
  'fleet.refresh': 'تحديث الأسطول',
  'fleet.detail.back': 'الأسطول',

  // ── الطاقم (منقول حرفيًا من تطبيق الهاتف) ──
  'crew.hint':
    'اللوحة — المهام التي تنشئها يتناولها بوت المكلّف خلال دقيقة تقريبًا. سجل الأدوار بالأسفل.',
  'crew.new': 'مهمة جديدة',
  'crew.new.title': 'المهمة — مثال: لخّص أسعار الأمس',
  'crew.new.body': 'تفاصيل (اختياري)',
  'crew.new.assignee': 'عيّن إلى',
  'crew.new.cta': 'أضف إلى اللوحة',
  'crew.complete': 'إكمال',
  'crew.complete.summary': 'أُكملت من الهاتف (تجاوز بشري)',
  'crew.assign': 'إعادة تعيين',
  'crew.moch': 'موك',
  'crew.err': 'فشل الإجراء: {why}',
  'crew.offline': 'طاقم العمل غير متصل — يُعرض آخر لوح',
  'crew.timeline': 'سجل الأدوار',
  'crew.timeline.empty': 'لا أدوار مسجلة بعد.',

  // ── البوت (منقول حرفيًا من تطبيق الهاتف) ──
  'bot.job': 'المهمة / الوصف',
  'bot.soul': 'SOUL.md — وصف المهمة',
  'bot.save': 'حفظ',
  'bot.saved': 'تم الحفظ',
  'bot.save.failed': 'فشل الحفظ: {why}',
  'bot.chat': 'تحدث مع {name}',
  'bot.delete.failed': 'تعذّر حذف هذا البوت: {why}',
  'bot.delete.title': 'منطقة الخطر',
  'bot.delete.body':
    'الحذف يضع علامة قبر على هذا البوت: مهامه المجدولة تتوقف (الجدول يتخطى الملفات الموابَرة)، والأدوار الجارية تتوقف عند الحد التالي. مهام كانبان تبقى على اللوحة حتى توفر لوحة الطاقم (M9.4) إعادة الإسناد.',
  'bot.delete.cta': 'احذف هذا البوت',
  'bot.delete.confirm': 'اضغط مرة أخرى للتأكيد',
  'bot.delete.doing': 'جارٍ الحذف…',

  // ── واجهة المحادثة (منقول حرفيًا من تطبيق الهاتف) ──
  'chat.foreign.title': 'جلسة أخرى على هذا الجهاز تطلب منك إجابة',
  'chat.foreign.hint': 'اضغط لمراجعتها والإجابة عليها من هنا.',
  'chat.clarify.pending.one': 'سؤال واحد لا يزال بحاجة إلى إجابة قبل الإرسال.',
  'chat.clarify.pending.many': '{n} أسئلة لا تزال بحاجة إلى إجابات قبل الإرسال.',

  // ── سطح المكتب: شريط التنقل ──
  'nav.chats': 'المحادثات',
  'nav.fleet': 'الأسطول',
  'nav.crew': 'الطاقم',
  'nav.inbox': 'الوارد',
  'nav.browser': 'المتصفح',
  'nav.terminal': 'الطرفية',
  'nav.automations': 'الأتمتة',
  'nav.skills': 'المهارات',
  'nav.connectors': 'الموصّلات',
  'nav.settings': 'الإعدادات',

  // ── سطح المكتب: شريط الحالة ──
  'status.runtime.local': 'وقت تشغيل محلي',
  'status.offline': 'غير متصل',
  'status.workspace': 'مساحة العمل',
  'status.fullyLocal': 'محلي بالكامل',
  'status.bots.one': 'بوت',
  'status.bots.many': 'بوتات',
  'status.turns': 'مهام',

  // ── سطح المكتب: حالات الفراغ في المحادثة والمُحرِّر ──
  'chat.empty.title': 'ماذا يفعل موتشي؟',
  'chat.empty.title.bot': 'تحدث مع {name}',
  'chat.empty.sub':
    'وكلاؤك يعملون بالكامل على هذا الجهاز — يمكنهم استخدام الطرفية وتصفح الويب والتذكّر عبر المحادثات والعمل أثناء انشغالك. اطلب أي شيء.',
  'chat.list.empty': 'لا محادثات بعد — قل مرحبًا بالأسفل.',
  'chat.composer.placeholder': 'اسأل موتشي أي شيء — اكتب / للأوامر',
  'chat.composer.placeholder.bot': 'راسل {name}…',
  'chat.composer.placeholder.steer': 'وجّه الدور الجاري — يُسلَّم عند الحد التالي…',

  // ── سطح المكتب: شاشة الإقلاع ──
  'boot.error.title': 'واجه وقت التشغيل المحلي مشكلة',
  'boot.retry': 'إعادة المحاولة',
  'boot.local': 'وكلاء هيرميس وبوتاتك وكل شيء آخر يعيشون هنا على هذا الجهاز — لا شيء يغادره.',
  'boot.connecting': 'جارٍ الاتصال بالبوابة…',
}

const CATALOGS: Record<Locale, Catalog> = { en: EN, ar: AR }

/**
 * Translate a key in the active locale. {placeholders} interpolate from vars.
 * Falls back to the EN text, then to the key itself (missing keys never crash).
 */
export function tr(key: string, vars?: Record<string, string | number>): string {
  const loc = locale.get()
  let out = CATALOGS[loc]?.[key] ?? EN[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(`{${k}}`, String(v))
    }
  }
  return out
}

// Apply the persisted direction on first import so the very first paint matches.
applyDirection()
