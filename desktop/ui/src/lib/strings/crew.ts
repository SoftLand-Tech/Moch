// Crew domain strings, verbatim from the mobile catalog (same keys, same copy).
export const en = {
  'crew.hint': 'Board — tasks you create are picked up by the assignee bot within about a minute. Run ledger below.',
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
} as const

export const ar: Record<keyof typeof en, string> = {
  'crew.hint': 'اللوحة — المهام التي تنشئها يتناولها بوت المكلّف خلال دقيقة تقريبًا. سجل الأدوار بالأسفل.',
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
}
