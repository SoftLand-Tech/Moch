/**
 * M9.2 i18n foundation: externalized strings for the fleet surfaces with an
 * EN/AR catalog and an RTL flag. New screens MUST source user-facing copy from
 * here (plan §2.7: externalized from M9.2 onward — retrofit is 10×).
 *
 * Scope note: this catalog covers the fleet screens; retrofitting chat.tsx and
 * friends is a later, mechanical pass.
 */
import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { I18nManager } from 'react-native'

export type Locale = 'en' | 'ar'

export const localeAtom = atom<Locale>('en')

const LOCALE_KEY = 'hermes.locale.v1'

export async function loadLocale(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(LOCALE_KEY)
    if (saved === 'ar' || saved === 'en') localeAtom.set(saved)
  } catch {
    // default en
  }
}

export async function setLocale(l: Locale): Promise<void> {
  localeAtom.set(l)
  try {
    await AsyncStorage.setItem(LOCALE_KEY, l)
  } catch {
    // best-effort
  }
}

/** True when the active locale is RTL (drives row direction + back chevrons). */
export function isRTL(): boolean {
  return localeAtom.get() === 'ar' || I18nManager.isRTL
}

type Catalog = Record<string, string>

const EN: Catalog = {
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

  'bot.job': 'Job / description',
  'bot.soul': 'SOUL.md — the job description',
  'bot.save': 'Save',
  'bot.saved': 'saved',
  'bot.save.failed': "Couldn't save: {why}",
  'bot.chat': 'Chat with {name}',
  'bot.chat.failed': "Couldn't open this bot's chat: {why}",
  'bot.delete.failed': "Couldn't delete this bot: {why}",
  'bot.delete.title': 'Danger zone',
  'bot.delete.body':
    'Deleting tombstones this bot: its scheduled jobs stop firing (ticker skips tombstones), running turns stop at the next boundary. Kanban tasks it holds stay on the board until the M9.4 crew board offers reassignment.',
  'bot.delete.cta': 'Delete this bot',
  'bot.delete.confirm': 'Tap again to confirm deletion',
  'bot.delete.doing': 'Deleting…',

  // Linux guest install/reset failures (Settings rows, BUG-016 pattern).
  'linux.install.failed': "The install didn't finish — check the connection and try again. ({why})",
  'linux.reset.failed': "The reset didn't finish — check the connection and try again. ({why})",

  // #108 automations edit: the full prompt couldn't be fetched — the form
  // shows the 100-char preview instead.
  'automations.promptLoadFailed': "Couldn't load the full prompt — showing a truncated preview",

  // BUG-086 aggregate card for questions from sessions this app isn't
  // tracking (automation/CLI on the host) — chat-surface keys live here so
  // the card is bilingual from day one.
  'chat.foreign.title': 'Another session on this machine is asking you something',
  'chat.foreign.hint': 'Tap to review and answer it here.',
  // BUG-118 (BH-000093): the Browser screen's relay-failure retry button —
  // the error branch used to be a dead end.
  'browser.retry': 'Retry',
  // BH-000025: the batch-clarify card's gate hint — missing answers are
  // indistinguishable from deliberate skips on the server, so Send waits.
  'chat.clarify.pending.one': '1 question still needs an answer before sending.',
  'chat.clarify.pending.many': '{n} questions still need answers before sending.',
  'pair.plain.title': 'Unencrypted connection',
  'pair.plain.body':
    'Connect to {host} without TLS? The connection is not encrypted, so your pairing token travels in the clear — anyone watching the network can read it.',
  'pair.plain.confirm': 'Connect anyway',
  'pair.plain.cancel': 'Cancel',

  // BUG-074 / #111 / #131: Chats-screen row meta. Known `source` tokens the
  // gateway itself mints are localized (anything else falls back to the raw
  // token); unknown message counts render "—" instead of a lying 0; the
  // delete-while-running refusal gets friendly copy instead of raw server
  // English ("cannot delete an active session").
  'sessions.source.mobile': 'Phone',
  'sessions.source.tui': 'Terminal (TUI)',
  'sessions.source.cli': 'CLI',
  'sessions.source.webui': 'Web',
  'sessions.source.desktop': 'Desktop',
  'sessions.source.cron': 'Scheduled',
  'sessions.source.kanban': 'Crew board',
  'sessions.source.subagent': 'Sub-agent',
  'sessions.source.test': 'Test',
  'sessions.source.local': 'Local',
  'sessions.source.acp': 'ACP',
  'sessions.source.webhook': 'Webhook',
  'sessions.source.api_server': 'API',
  'sessions.source.msgraph_webhook': 'MS Graph',
  'sessions.source.telegram': 'Telegram',
  'sessions.source.discord': 'Discord',
  'sessions.source.whatsapp': 'WhatsApp',
  'sessions.source.slack': 'Slack',
  'sessions.source.signal': 'Signal',
  'sessions.source.email': 'Email',
  'sessions.source.sms': 'SMS',
  'sessions.delete.failed': 'Delete failed',
  'sessions.delete.busy': 'This chat is busy on the computer — stop it there before deleting.',

  // UI-1 sidebar: identity switch, project rail, nav rows. The drawer's own
  // chrome is localized here so the Sessions/Bots split and the projects list
  // are bilingual from day one (no JSX literals).
  'sidebar.sessions': 'Sessions',
  'sidebar.chats': 'Chat',
  'sidebar.bots': 'Bots',
  'sidebar.projects': 'Projects',
  'sidebar.allProjects': 'All projects',
  'sidebar.personal': 'Personal',
  'sidebar.newProject': 'New project',
  'sidebar.renameProject': 'Rename project',
  'sidebar.setDefault': 'Set as default',
  'sidebar.archive': 'Archive',
  'sidebar.delete': 'Delete',
  'sidebar.library': 'Library',
  'sidebar.inbox': 'Inbox',
  'sidebar.browser': 'Browser',
  'sidebar.terminal': 'Terminal',
  'sidebar.automations': 'Automations',
  'sidebar.settings': 'Settings',
  'sidebar.cancel': 'Cancel',
  'sidebar.save': 'Save',
  'sidebar.newChat': 'New chat',
  'sidebar.pin': 'Pin',
  'sidebar.unpin': 'Unpin',
  'sidebar.unarchive': 'Unarchive',
  'sidebar.rename': 'Rename',
  'sidebar.searchChats': 'Search chats…',
  'sidebar.clearSearch': 'Clear search',
  'sidebar.closeMenu': 'Close menu',
  'sidebar.renameChatTitle': 'Rename chat',
  'sidebar.chatName': 'Chat name',
  'sidebar.deleteChatTitle': 'Delete this chat?',
  'sidebar.deleteChatBody': '“{title}” is permanently removed from Moch.',
  'sidebar.projectActionsHint': 'Long press for project actions',
  'sidebar.archivedChats': 'archived chats',
  'sidebar.collapse': 'Collapse',
  'sidebar.expand': 'Expand',
  'sidebar.noMatch': 'No chats matching “{query}”',
  'sidebar.openChat': 'Open {title}',
  'sidebar.chatOptions': 'Options for {title}',
  'project.name.label': 'Project name',
  'project.name.placeholder': 'Project name',
  'project.folder.label': 'Folder path (optional)',
  'project.folder.placeholder': 'Folder path (optional)',
  'project.folder.hint': 'Leave empty to create an empty project, or paste a folder to own its chats.',
  'project.create': 'Create',
  'project.delete.title': 'Delete this project?',
  'project.delete.body': '“{name}” is deleted. Its chats stay — they move to All projects.',
  'project.error.create': 'Could not create the project',
  'project.error.rename': 'Could not rename the project',
  'project.error.archive': 'Could not archive the project',
  'project.error.delete': 'Could not delete the project',

  // Inbox (slice C): the "what needs me" screen — ask / done / error.
  'inbox.title': 'Inbox',
  'inbox.section.ask': 'Needs you',
  'inbox.section.done': 'Finished',
  'inbox.section.error': 'Failed',
  'inbox.empty.title': 'Nothing needs you',
  'inbox.empty.body': 'Questions, finished turns and failures land here.',
  'inbox.untitled': 'Untitled',
  'inbox.age.now': 'just now',
  'inbox.age.minutes': '{n}m ago',
  'inbox.age.hours': '{n}h ago',
  'inbox.age.days': '{n}d ago',
}

const AR: Catalog = {
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

  'bot.job': 'المهمة / الوصف',
  'bot.soul': 'SOUL.md — وصف المهمة',
  'bot.save': 'حفظ',
  'bot.saved': 'تم الحفظ',
  'bot.save.failed': 'فشل الحفظ: {why}',
  'bot.chat': 'تحدث مع {name}',
  'bot.chat.failed': 'تعذّر فتح محادثة هذا البوت: {why}',
  'bot.delete.failed': 'تعذّر حذف هذا البوت: {why}',
  'bot.delete.title': 'منطقة الخطر',
  'bot.delete.body':
    'الحذف يضع علامة قبر على هذا البوت: مهامه المجدولة تتوقف (الجدول يتخطى الملفات الموابَرة)، والأدوار الجارية تتوقف عند الحد التالي. مهام كانبان تبقى على اللوحة حتى توفر لوحة الطاقم (M9.4) إعادة الإسناد.',
  'bot.delete.cta': 'احذف هذا البوت',
  'bot.delete.confirm': 'اضغط مرة أخرى للتأكيد',
  'bot.delete.doing': 'جارٍ الحذف…',

  // Linux guest install/reset failures (Settings rows, BUG-016 pattern).
  'linux.install.failed': 'لم يكتمل التثبيت — تحقّق من الاتصال وحاول مجددًا. ({why})',
  'linux.reset.failed': 'لم يكتمل إعادة التعيين — تحقّق من الاتصال وحاول مجددًا. ({why})',

  // #108 automations edit: the full prompt couldn't be fetched — the form
  // shows the 100-char preview instead.
  'automations.promptLoadFailed': 'تعذّر تحميل الأمر الكامل — يُعرض مقتطعًا',

  // BUG-086 aggregate card for questions from sessions this app isn't
  // tracking (automation/CLI on the host).
  'chat.foreign.title': 'جلسة أخرى على هذا الجهاز تطلب منك إجابة',
  'chat.foreign.hint': 'اضغط لمراجعتها والإجابة عليها من هنا.',
  // BUG-118 (BH-000093): the Browser screen's relay-failure retry button.
  'browser.retry': 'إعادة المحاولة',
  // BH-000025: the batch-clarify card's gate hint.
  'chat.clarify.pending.one': 'سؤال واحد لا يزال بحاجة إلى إجابة قبل الإرسال.',
  'chat.clarify.pending.many': '{n} أسئلة لا تزال بحاجة إلى إجابات قبل الإرسال.',
  'pair.plain.title': 'اتصال غير مشفّر',
  'pair.plain.body':
    'الاتصال بـ {host} بدون TLS؟ الاتصال غير مشفّر، لذا سينتقل رمز الاقتران مكشوفًا — أي من يراقب الشبكة يستطيع قراءته.',
  'pair.plain.confirm': 'اتصال رغم ذلك',
  'pair.plain.cancel': 'إلغاء',

  // BUG-074 / #111 / #131 (see the EN block above).
  'sessions.source.mobile': 'الهاتف',
  'sessions.source.tui': 'الطرفية (TUI)',
  'sessions.source.cli': 'سطر الأوامر',
  'sessions.source.webui': 'الويب',
  'sessions.source.desktop': 'سطح المكتب',
  'sessions.source.cron': 'مجدولة',
  'sessions.source.kanban': 'لوحة الطاقم',
  'sessions.source.subagent': 'وكيل فرعي',
  'sessions.source.test': 'اختبار',
  'sessions.source.local': 'محلي',
  'sessions.source.acp': 'ACP',
  'sessions.source.webhook': 'Webhook',
  'sessions.source.api_server': 'API',
  'sessions.source.msgraph_webhook': 'MS Graph',
  'sessions.source.telegram': 'تيليجرام',
  'sessions.source.discord': 'ديسكورد',
  'sessions.source.whatsapp': 'واتساب',
  'sessions.source.slack': 'سلاك',
  'sessions.source.signal': 'سيجنال',
  'sessions.source.email': 'البريد',
  'sessions.source.sms': 'رسائل نصية',
  'sessions.delete.failed': 'تعذّر الحذف',
  'sessions.delete.busy': 'هذه المحادثة تعمل الآن على الحاسوب — أوقفها هناك قبل الحذف.',

  // UI-1 sidebar (see the EN block above).
  'sidebar.sessions': 'المحادثات',
  'sidebar.chats': 'المحادثة',
  'sidebar.bots': 'البوتات',
  'sidebar.projects': 'المشاريع',
  'sidebar.allProjects': 'كل المشاريع',
  'sidebar.personal': 'شخصي',
  'sidebar.newProject': 'مشروع جديد',
  'sidebar.renameProject': 'إعادة تسمية المشروع',
  'sidebar.setDefault': 'اجعله الافتراضي',
  'sidebar.archive': 'أرشفة',
  'sidebar.delete': 'حذف',
  'sidebar.library': 'المكتبة',
  'sidebar.inbox': 'الوارد',
  'sidebar.browser': 'المتصفح',
  'sidebar.terminal': 'الطرفية',
  'sidebar.automations': 'الأتمتة',
  'sidebar.settings': 'الإعدادات',
  'sidebar.cancel': 'إلغاء',
  'sidebar.save': 'حفظ',
  'sidebar.newChat': 'محادثة جديدة',
  'sidebar.pin': 'تثبيت',
  'sidebar.unpin': 'إلغاء التثبيت',
  'sidebar.unarchive': 'إلغاء الأرشفة',
  'sidebar.rename': 'إعادة تسمية',
  'sidebar.searchChats': 'ابحث في المحادثات…',
  'sidebar.clearSearch': 'مسح البحث',
  'sidebar.closeMenu': 'إغلاق القائمة',
  'sidebar.renameChatTitle': 'إعادة تسمية المحادثة',
  'sidebar.chatName': 'اسم المحادثة',
  'sidebar.deleteChatTitle': 'حذف هذه المحادثة؟',
  'sidebar.deleteChatBody': 'سيُحذف «{title}» نهائيًا من موك.',
  'sidebar.projectActionsHint': 'اضغط مطولًا لإجراءات المشروع',
  'sidebar.archivedChats': 'المحادثات المؤرشفة',
  'sidebar.collapse': 'طيّ',
  'sidebar.expand': 'توسيع',
  'sidebar.noMatch': 'لا محادثات تطابق «{query}»',
  'sidebar.openChat': 'افتح {title}',
  'sidebar.chatOptions': 'خيارات {title}',
  'project.name.label': 'اسم المشروع',
  'project.name.placeholder': 'اسم المشروع',
  'project.folder.label': 'مسار المجلد (اختياري)',
  'project.folder.placeholder': 'مسار المجلد (اختياري)',
  'project.folder.hint': 'اتركه فارغًا لإنشاء مشروع فارغ، أو ألصق مجلدًا لتملك محادثاته.',
  'project.create': 'إنشاء',
  'project.delete.title': 'حذف هذا المشروع؟',
  'project.delete.body': 'سيُحذف «{name}». محادثاته تبقى — تنتقل إلى كل المشاريع.',
  'project.error.create': 'تعذّر إنشاء المشروع',
  'project.error.rename': 'تعذّر إعادة تسمية المشروع',
  'project.error.archive': 'تعذّر أرشفة المشروع',
  'project.error.delete': 'تعذّر حذف المشروع',

  // Inbox (slice C) — see the EN block above.
  'inbox.title': 'الوارد',
  'inbox.section.ask': 'بانتظارك',
  'inbox.section.done': 'انتهت',
  'inbox.section.error': 'فشلت',
  'inbox.empty.title': 'لا شيء بانتظارك',
  'inbox.empty.body': 'الأسئلة والأدوار المنتهية والإخفاقات تظهر هنا.',
  'inbox.untitled': 'بلا عنوان',
  'inbox.age.now': 'الآن',
  'inbox.age.minutes': 'قبل {n} د',
  'inbox.age.hours': 'قبل {n} س',
  'inbox.age.days': 'قبل {n} ي',
}

const CATALOGS: Record<Locale, Catalog> = { en: EN, ar: AR }

/** Translate a key in the active locale; {placeholders} interpolate from vars. */
export function tr(key: string, vars?: Record<string, string | number>): string {
  const loc = localeAtom.get()
  let out = CATALOGS[loc]?.[key] ?? EN[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(`{${k}}`, String(v))
    }
  }
  return out
}
