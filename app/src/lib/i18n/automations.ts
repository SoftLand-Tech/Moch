import type { Catalog } from './types'

/**
 * Catalog domain: automations (mockup screen 9).
 *
 * Scheduled cron jobs on the gateway. Job names, schedules, prompts, job ids
 * and server status tokens are data and stay untranslated; this catalog owns
 * the screen chrome, action labels, relative next-run labels and dialog copy.
 * The "full prompt could not be loaded" banner reuses the legacy key
 * `automations.promptLoadFailed`.
 */
export const automations: Catalog = {
  en: {
    'automations.title': 'Automations',
    'automations.intro': 'Jobs run on gateway · Persistent across restarts',
    'automations.newA11y': 'New automation',

    'automations.error.load': 'Could not load automations',
    'automations.error.retry': '{error} — tap to retry',
    'automations.offline': 'Not connected — tap to reconnect',

    'automations.empty.title': 'No automations yet',
    'automations.empty.body': 'Tap + to schedule your first job, or create one from chat with /cron add',
    'automations.empty.cta': 'New automation',

    'automations.card.expandA11y': 'Expand {name}',
    'automations.card.collapseA11y': 'Collapse {name}',
    'automations.card.paused': 'Paused',
    'automations.card.last': 'last: {status}',
    'automations.card.idLabel': 'ID',
    'automations.card.tapToCopy': 'Tap to copy',
    'automations.card.copied': 'Copied ✓',
    'automations.card.copyA11y': 'Copy job ID {id}',
    'automations.card.deliver': 'deliver: {target}',
    'automations.next.minutes': 'in {n}m',
    'automations.next.hours': 'in {n}h',
    'automations.next.days': 'in {n}d',
    'automations.next.due': 'due',

    'automations.detail.next': 'Next run',
    'automations.detail.last': 'Last run',
    'automations.detail.repeat': 'Repeat',
    'automations.detail.pausedBecause': 'Paused because',
    'automations.detail.lastError': 'Last error',

    'automations.action.run': 'Run now',
    'automations.action.pause': 'Pause',
    'automations.action.resume': 'Resume',
    'automations.action.edit': 'Edit',
    'automations.action.delete': 'Delete',

    'automations.status.paused': 'Paused “{name}”',
    'automations.status.resumed': 'Resumed “{name}”',
    'automations.status.deleted': 'Deleted “{name}”',
    'automations.status.created': 'Created “{name}”',
    'automations.status.updated': 'Updated',
    'automations.status.queued': 'Queued “{name}” to run',

    'automations.alert.actionFailed': 'Action failed',
    'automations.alert.deleteTitle': 'Delete this automation?',
    'automations.alert.missing.title': 'Missing fields',
    'automations.alert.missing.body': 'Name, schedule and prompt are all needed.',
    'automations.alert.createFailed': 'Create failed',
    'automations.alert.editFailed': 'Edit failed',

    'automations.form.newTitle': 'New automation',
    'automations.form.editTitle': 'Edit automation',
    'automations.form.name': 'Name',
    'automations.form.nameA11y': 'Automation name',
    'automations.form.name.placeholder': 'daily-standup',
    'automations.form.schedule': 'Schedule (cron)',
    'automations.form.scheduleA11y': 'Schedule',
    'automations.form.schedule.placeholder': 'e.g. every 30m',
    'automations.form.schedule.hint':
      'Intervals: every 30m · every 2h — one-shot: in 45m — weekly: every monday 9:00',
    'automations.form.prompt': 'Prompt',
    'automations.form.promptA11y': 'Prompt',
    'automations.form.prompt.placeholder': 'Check my inbox and summarize what needs a reply today.',
    'automations.form.prompt.hint':
      'Jobs run in a fresh session with no chat context — write self-contained prompts.',
    'automations.form.create': 'Create',
  },
  ar: {
    'automations.title': 'الأتمتة',
    'automations.intro': 'تُشغَّل المهام على البوابة · وتبقى بعد إعادة التشغيل',
    'automations.newA11y': 'أتمتة جديدة',

    'automations.error.load': 'تعذّر تحميل الأتمتات',
    'automations.error.retry': '{error} — اضغط لإعادة المحاولة',
    'automations.offline': 'غير متصل — اضغط لإعادة الاتصال',

    'automations.empty.title': 'لا توجد أتمتات بعد',
    'automations.empty.body': 'اضغط + لجدولة أول مهمة، أو أنشئ واحدة من المحادثة عبر /cron add',
    'automations.empty.cta': 'أتمتة جديدة',

    'automations.card.expandA11y': 'وسّع {name}',
    'automations.card.collapseA11y': 'اطوِ {name}',
    'automations.card.paused': 'متوقف مؤقتًا',
    'automations.card.last': 'آخر: {status}',
    'automations.card.idLabel': 'المعرّف',
    'automations.card.tapToCopy': 'اضغط للنسخ',
    'automations.card.copied': 'تم النسخ ✓',
    'automations.card.copyA11y': 'انسخ معرّف المهمة {id}',
    'automations.card.deliver': 'التسليم: {target}',
    'automations.next.minutes': 'بعد {n} د',
    'automations.next.hours': 'بعد {n} س',
    'automations.next.days': 'بعد {n} ي',
    'automations.next.due': 'مستحقة',

    'automations.detail.next': 'التشغيل التالي',
    'automations.detail.last': 'آخر تشغيل',
    'automations.detail.repeat': 'التكرار',
    'automations.detail.pausedBecause': 'أُوقف لأن',
    'automations.detail.lastError': 'آخر خطأ',

    'automations.action.run': 'شغّل الآن',
    'automations.action.pause': 'إيقاف مؤقت',
    'automations.action.resume': 'استئناف',
    'automations.action.edit': 'تعديل',
    'automations.action.delete': 'حذف',

    'automations.status.paused': 'أُوقف «{name}»',
    'automations.status.resumed': 'استُؤنف «{name}»',
    'automations.status.deleted': 'حُذف «{name}»',
    'automations.status.created': 'أُنشئ «{name}»',
    'automations.status.updated': 'تم التحديث',
    'automations.status.queued': 'أُدرج «{name}» للتشغيل',

    'automations.alert.actionFailed': 'فشل الإجراء',
    'automations.alert.deleteTitle': 'حذف هذه الأتمتة؟',
    'automations.alert.missing.title': 'حقول ناقصة',
    'automations.alert.missing.body': 'الاسم والجدول والأمر كلها مطلوبة.',
    'automations.alert.createFailed': 'فشل الإنشاء',
    'automations.alert.editFailed': 'فشل التعديل',

    'automations.form.newTitle': 'أتمتة جديدة',
    'automations.form.editTitle': 'تعديل الأتمتة',
    'automations.form.name': 'الاسم',
    'automations.form.nameA11y': 'اسم الأتمتة',
    'automations.form.name.placeholder': 'daily-standup',
    'automations.form.schedule': 'الجدول (cron)',
    'automations.form.scheduleA11y': 'الجدول',
    'automations.form.schedule.placeholder': 'مثال: every 30m',
    'automations.form.schedule.hint':
      'الفترات: every 30m · every 2h — لمرة واحدة: in 45m — أسبوعيًا: every monday 9:00',
    'automations.form.prompt': 'الأمر',
    'automations.form.promptA11y': 'الأمر',
    'automations.form.prompt.placeholder': 'افحص بريدي ولخّص ما يحتاج إلى ردّ اليوم.',
    'automations.form.prompt.hint':
      'تعمل المهام في جلسة جديدة بلا سياق المحادثة — اكتب أوامر مكتفية بذاتها.',
    'automations.form.create': 'إنشاء',
  },
  zh: {
    'automations.title': '自动化',
    'automations.intro': '任务在网关上运行 · 重启后依然保留',
    'automations.newA11y': '新建自动化',

    'automations.error.load': '无法加载自动化',
    'automations.error.retry': '{error} — 点击重试',
    'automations.offline': '未连接 — 点击重新连接',

    'automations.empty.title': '还没有自动化',
    'automations.empty.body': '点击 + 安排第一个任务，或在对话中用 /cron add 创建',
    'automations.empty.cta': '新建自动化',

    'automations.card.expandA11y': '展开 {name}',
    'automations.card.collapseA11y': '收起 {name}',
    'automations.card.paused': '已暂停',
    'automations.card.last': '上次：{status}',
    'automations.card.idLabel': 'ID',
    'automations.card.tapToCopy': '点击复制',
    'automations.card.copied': '已复制 ✓',
    'automations.card.copyA11y': '复制任务 ID {id}',
    'automations.card.deliver': '投递：{target}',
    'automations.next.minutes': '{n} 分钟后',
    'automations.next.hours': '{n} 小时后',
    'automations.next.days': '{n} 天后',
    'automations.next.due': '已到期',

    'automations.detail.next': '下次运行',
    'automations.detail.last': '上次运行',
    'automations.detail.repeat': '重复',
    'automations.detail.pausedBecause': '暂停原因',
    'automations.detail.lastError': '上次错误',

    'automations.action.run': '立即运行',
    'automations.action.pause': '暂停',
    'automations.action.resume': '恢复',
    'automations.action.edit': '编辑',
    'automations.action.delete': '删除',

    'automations.status.paused': '已暂停“{name}”',
    'automations.status.resumed': '已恢复“{name}”',
    'automations.status.deleted': '已删除“{name}”',
    'automations.status.created': '已创建“{name}”',
    'automations.status.updated': '已更新',
    'automations.status.queued': '“{name}”已排队运行',

    'automations.alert.actionFailed': '操作失败',
    'automations.alert.deleteTitle': '删除此自动化？',
    'automations.alert.missing.title': '缺少必填项',
    'automations.alert.missing.body': '名称、计划和提示词都是必填的。',
    'automations.alert.createFailed': '创建失败',
    'automations.alert.editFailed': '编辑失败',

    'automations.form.newTitle': '新建自动化',
    'automations.form.editTitle': '编辑自动化',
    'automations.form.name': '名称',
    'automations.form.nameA11y': '自动化名称',
    'automations.form.name.placeholder': 'daily-standup',
    'automations.form.schedule': '计划（Cron）',
    'automations.form.scheduleA11y': '计划',
    'automations.form.schedule.placeholder': '例如：every 30m',
    'automations.form.schedule.hint':
      '间隔：every 30m · every 2h —— 一次性：in 45m —— 每周：every monday 9:00',
    'automations.form.prompt': '提示词',
    'automations.form.promptA11y': '提示词',
    'automations.form.prompt.placeholder': '检查我的收件箱，并总结今天需要回复的内容。',
    'automations.form.prompt.hint': '任务在新会话中运行，没有对话上下文 —— 请写自包含的提示词。',
    'automations.form.create': '创建',
  },
  fr: {
    'automations.title': 'Automatisations',
    'automations.intro': "Les tâches s'exécutent sur la passerelle · Persistantes après redémarrage",
    'automations.newA11y': 'Nouvelle automatisation',

    'automations.error.load': 'Impossible de charger les automatisations',
    'automations.error.retry': '{error} — appuyez pour réessayer',
    'automations.offline': 'Non connecté — appuyez pour reconnecter',

    'automations.empty.title': 'Aucune automatisation pour le moment',
    'automations.empty.body':
      'Appuyez sur + pour planifier votre première tâche, ou créez-en une depuis la discussion avec /cron add',
    'automations.empty.cta': 'Nouvelle automatisation',

    'automations.card.expandA11y': 'Développer {name}',
    'automations.card.collapseA11y': 'Réduire {name}',
    'automations.card.paused': 'En pause',
    'automations.card.last': 'dernière : {status}',
    'automations.card.idLabel': 'ID',
    'automations.card.tapToCopy': 'Appuyer pour copier',
    'automations.card.copied': 'Copié ✓',
    'automations.card.copyA11y': "Copier l'ID de la tâche {id}",
    'automations.card.deliver': 'livraison : {target}',
    'automations.next.minutes': 'dans {n} min',
    'automations.next.hours': 'dans {n} h',
    'automations.next.days': 'dans {n} j',
    'automations.next.due': 'imminente',

    'automations.detail.next': 'Prochaine exécution',
    'automations.detail.last': 'Dernière exécution',
    'automations.detail.repeat': 'Répétition',
    'automations.detail.pausedBecause': 'Mise en pause car',
    'automations.detail.lastError': 'Dernière erreur',

    'automations.action.run': 'Exécuter',
    'automations.action.pause': 'Pause',
    'automations.action.resume': 'Reprendre',
    'automations.action.edit': 'Modifier',
    'automations.action.delete': 'Supprimer',

    'automations.status.paused': '« {name} » mise en pause',
    'automations.status.resumed': '« {name} » reprise',
    'automations.status.deleted': '« {name} » supprimée',
    'automations.status.created': '« {name} » créée',
    'automations.status.updated': 'Mise à jour',
    'automations.status.queued': '« {name} » en file d’exécution',

    'automations.alert.actionFailed': "Échec de l'action",
    'automations.alert.deleteTitle': 'Supprimer cette automatisation ?',
    'automations.alert.missing.title': 'Champs manquants',
    'automations.alert.missing.body': 'Le nom, la planification et le prompt sont tous requis.',
    'automations.alert.createFailed': 'Échec de la création',
    'automations.alert.editFailed': 'Échec de la modification',

    'automations.form.newTitle': 'Nouvelle automatisation',
    'automations.form.editTitle': "Modifier l'automatisation",
    'automations.form.name': 'Nom',
    'automations.form.nameA11y': "Nom de l'automatisation",
    'automations.form.name.placeholder': 'daily-standup',
    'automations.form.schedule': 'Planification (cron)',
    'automations.form.scheduleA11y': 'Planification',
    'automations.form.schedule.placeholder': 'ex. : every 30m',
    'automations.form.schedule.hint':
      'Intervalles : every 30m · every 2h — ponctuel : in 45m — hebdomadaire : every monday 9:00',
    'automations.form.prompt': 'Prompt',
    'automations.form.promptA11y': 'Prompt',
    'automations.form.prompt.placeholder':
      "Vérifie ma boîte de réception et résume ce qui demande une réponse aujourd'hui.",
    'automations.form.prompt.hint':
      "Les tâches s'exécutent dans une session neuve, sans contexte de discussion — rédigez des prompts autonomes.",
    'automations.form.create': 'Créer',
  },
}
