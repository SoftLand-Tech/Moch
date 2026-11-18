import type { Catalog } from './types'

/**
 * Catalog domain: crew (mockup screen 8 — /(tabs)/crew).
 *
 * Column/status/action copy that is new with the redesign. The screen keeps
 * reusing the legacy `crew.*` keys for the board hint, RPC errors, offline
 * banner, complete summary, "Moch" assignee label, reassign label and the
 * empty run-ledger line.
 */
export const crew: Catalog = {
  en: {
    'crew.title': 'Crew',

    // Kanban columns (uppercase colored kicker + mono count).
    'crew.col.ready': 'Ready',
    'crew.col.working': 'Working',
    'crew.col.blocked': 'Blocked',
    'crew.col.done': 'Done',
    'crew.col.empty': 'No tasks',
    'crew.col.done.empty': '— {n} completed tasks —',

    // Task card.
    'crew.completed': 'Completed ✓',
    'crew.chip.frozen': '{name} (frozen)',

    // Run timeline footer (real moch.runs.timeline ledger).
    'crew.runTimeline': 'Run Timeline',
    'crew.run.done': 'done',
    'crew.run.running': 'running',
    'crew.run.failed': 'failed',
    'crew.run.blocked': 'blocked',

    // New-task card (real moch.kanban.create flow).
    'crew.create.title': 'Create Crew Task',
    'crew.create.titlePlaceholder': 'Task title…',
    'crew.create.bodyPlaceholder': 'Instructions…',
    'crew.create.cta': 'Create Task',

    // Board load failure banner ({why} = gateway message).
    'crew.loadFailed': "Couldn't load the board: {why}",
  },
  ar: {
    'crew.title': 'الطاقم',

    'crew.col.ready': 'جاهز',
    'crew.col.working': 'يعمل',
    'crew.col.blocked': 'متوقف',
    'crew.col.done': 'تم',
    'crew.col.empty': 'لا مهام',
    'crew.col.done.empty': '— {n} مهام مكتملة —',

    'crew.completed': 'اكتملت ✓',
    'crew.chip.frozen': '{name} (مجمّد)',

    'crew.runTimeline': 'خط زمني للتشغيل',
    'crew.run.done': 'تم',
    'crew.run.running': 'قيد التشغيل',
    'crew.run.failed': 'فشل',
    'crew.run.blocked': 'متوقف',

    'crew.create.title': 'إنشاء مهمة للطاقم',
    'crew.create.titlePlaceholder': 'عنوان المهمة…',
    'crew.create.bodyPlaceholder': 'التعليمات…',
    'crew.create.cta': 'إنشاء مهمة',

    'crew.loadFailed': 'تعذّر تحميل اللوحة: {why}',
  },
  zh: {
    'crew.title': '团队',

    'crew.col.ready': '就绪',
    'crew.col.working': '进行中',
    'crew.col.blocked': '阻塞',
    'crew.col.done': '完成',
    'crew.col.empty': '暂无任务',
    'crew.col.done.empty': '— 已完成 {n} 个任务 —',

    'crew.completed': '已完成 ✓',
    'crew.chip.frozen': '{name}（已冻结）',

    'crew.runTimeline': '运行时间线',
    'crew.run.done': '完成',
    'crew.run.running': '运行中',
    'crew.run.failed': '失败',
    'crew.run.blocked': '阻塞',

    'crew.create.title': '创建团队任务',
    'crew.create.titlePlaceholder': '任务标题…',
    'crew.create.bodyPlaceholder': '说明…',
    'crew.create.cta': '创建任务',

    'crew.loadFailed': '无法加载看板：{why}',
  },
  fr: {
    'crew.title': 'Équipe',

    'crew.col.ready': 'Prêt',
    'crew.col.working': 'En cours',
    'crew.col.blocked': 'Bloqué',
    'crew.col.done': 'Terminé',
    'crew.col.empty': 'Aucune tâche',
    'crew.col.done.empty': '— {n} tâches terminées —',

    'crew.completed': 'Terminé ✓',
    'crew.chip.frozen': '{name} (gelé)',

    'crew.runTimeline': 'Chronologie des exécutions',
    'crew.run.done': 'terminé',
    'crew.run.running': 'en cours',
    'crew.run.failed': 'échec',
    'crew.run.blocked': 'bloqué',

    'crew.create.title': 'Créer une tâche d’équipe',
    'crew.create.titlePlaceholder': 'Titre de la tâche…',
    'crew.create.bodyPlaceholder': 'Instructions…',
    'crew.create.cta': 'Créer la tâche',

    'crew.loadFailed': 'Impossible de charger le tableau : {why}',
  },
}
