import type { Catalog } from './types'

/**
 * Catalog domain: bot (mockup screen 13 — app/bot.tsx, presented as a modal).
 *
 * Header/brand/save/provider-warning/delete-wizard copy that is new with the
 * redesign. The screen keeps reusing the legacy `bot.*` keys for save-failure,
 * chat-handoff and delete-failure alerts plus the danger-zone kicker.
 */
export const bot: Catalog = {
  en: {
    'bot.brand': 'MOCH · BOT MODAL',
    'bot.fallbackName': 'Bot',

    // Job + SOUL editor.
    'bot.jobKicker': 'Job',
    'bot.jobPlaceholder': 'What is this bot for?',
    'bot.soulKicker': 'SOUL (System Persona)',

    // Save row.
    'bot.save.cta': 'Save changes',
    'bot.savedBadge': 'saved ✓',
    'bot.synced': 'Synced to profile',

    // No-provider warning + provider mirroring (moch.profiles.mirror_model_key).
    'bot.noprov.title': 'No model provider configured',
    'bot.noprov.body': 'This bot needs an API key before it can reply.',
    'bot.noprov.cta': 'Use my provider',
    'bot.provider.connected.title': 'Provider connected',
    'bot.provider.connected.body': 'Mirrored {keys} from your main bot. Try chatting now.',
    'bot.provider.nothing.title': 'Nothing to mirror',
    'bot.provider.nothing.body':
      'Your main bot has no API keys to mirror. Add one in Connectors first.',
    'bot.provider.failed.title': 'Mirror failed',

    // 3-tap armed delete wizard (real moch.profiles.delete RPC).
    'bot.delete.desc': 'Permanently remove @{name} and its isolated memory.',
    'bot.delete.action': 'Delete bot',
    'bot.delete.actionConfirm': 'Tap again to confirm delete',
    'bot.delete.actionDoing': 'Deleting profile…',
  },
  ar: {
    'bot.brand': 'موك · نافذة البوت',
    'bot.fallbackName': 'بوت',

    'bot.jobKicker': 'المهمة',
    'bot.jobPlaceholder': 'ما الغرض من هذا البوت؟',
    'bot.soulKicker': 'SOUL (شخصية النظام)',

    'bot.save.cta': 'حفظ التغييرات',
    'bot.savedBadge': 'تم الحفظ ✓',
    'bot.synced': 'متزامن مع الملف الشخصي',

    'bot.noprov.title': 'لم يُضبط مزوّد نموذج',
    'bot.noprov.body': 'يحتاج هذا البوت إلى مفتاح API قبل أن يتمكن من الرد.',
    'bot.noprov.cta': 'استخدم مزوّدي',
    'bot.provider.connected.title': 'تم توصيل المزوّد',
    'bot.provider.connected.body': 'تم نسخ {keys} من بوتك الرئيسي. جرّب المحادثة الآن.',
    'bot.provider.nothing.title': 'لا شيء لنسخه',
    'bot.provider.nothing.body':
      'لا يملك بوتك الرئيسي مفاتيح API لنسخها. أضف مفتاحًا من الموصلات أولًا.',
    'bot.provider.failed.title': 'فشل النسخ',

    'bot.delete.desc': 'يزيل @{name} نهائيًا مع ذاكرته المعزولة.',
    'bot.delete.action': 'حذف البوت',
    'bot.delete.actionConfirm': 'اضغط مجددًا لتأكيد الحذف',
    'bot.delete.actionDoing': 'جارٍ حذف الملف الشخصي…',
  },
  zh: {
    'bot.brand': 'MOCH · 机器人弹窗',
    'bot.fallbackName': '机器人',

    'bot.jobKicker': '任务',
    'bot.jobPlaceholder': '这个机器人是做什么的？',
    'bot.soulKicker': 'SOUL（系统人设）',

    'bot.save.cta': '保存更改',
    'bot.savedBadge': '已保存 ✓',
    'bot.synced': '已同步到配置文件',

    'bot.noprov.title': '未配置模型提供方',
    'bot.noprov.body': '这个机器人需要 API 密钥才能回复。',
    'bot.noprov.cta': '使用我的提供方',
    'bot.provider.connected.title': '提供方已连接',
    'bot.provider.connected.body': '已从你的主机器人镜像 {keys}。现在可以尝试对话了。',
    'bot.provider.nothing.title': '没有可镜像的内容',
    'bot.provider.nothing.body': '你的主机器人没有可镜像的 API 密钥。请先在连接器中添加一个。',
    'bot.provider.failed.title': '镜像失败',

    'bot.delete.desc': '永久删除 @{name} 及其隔离记忆。',
    'bot.delete.action': '删除机器人',
    'bot.delete.actionConfirm': '再次点击以确认删除',
    'bot.delete.actionDoing': '正在删除配置文件…',
  },
  fr: {
    'bot.brand': 'MOCH · MODAL BOT',
    'bot.fallbackName': 'Bot',

    'bot.jobKicker': 'Tâche',
    'bot.jobPlaceholder': 'À quoi sert ce bot ?',
    'bot.soulKicker': 'SOUL (persona système)',

    'bot.save.cta': 'Enregistrer les modifications',
    'bot.savedBadge': 'enregistré ✓',
    'bot.synced': 'Synchronisé au profil',

    'bot.noprov.title': 'Aucun fournisseur de modèle configuré',
    'bot.noprov.body': 'Ce bot a besoin d’une clé API avant de pouvoir répondre.',
    'bot.noprov.cta': 'Utiliser mon fournisseur',
    'bot.provider.connected.title': 'Fournisseur connecté',
    'bot.provider.connected.body':
      'Clés {keys} copiées depuis ton bot principal. Essaie de discuter maintenant.',
    'bot.provider.nothing.title': 'Rien à copier',
    'bot.provider.nothing.body':
      'Ton bot principal n’a aucune clé API à copier. Ajoute-en une dans Connecteurs d’abord.',
    'bot.provider.failed.title': 'Échec de la copie',

    'bot.delete.desc': 'Supprime définitivement @{name} et sa mémoire isolée.',
    'bot.delete.action': 'Supprimer le bot',
    'bot.delete.actionConfirm': 'Appuie encore pour confirmer',
    'bot.delete.actionDoing': 'Suppression du profil…',
  },
}
