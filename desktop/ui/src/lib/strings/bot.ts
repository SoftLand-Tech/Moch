// Bot domain strings, verbatim from the mobile catalog (same keys, same copy).
export const en = {
  'bot.job': 'Job / description',
  'bot.soul': 'SOUL.md — the job description',
  'bot.save': 'Save',
  'bot.saved': 'saved',
  'bot.save.failed': "Couldn't save: {why}",
  'bot.chat': 'Chat with {name}',
  'bot.delete.failed': "Couldn't delete this bot: {why}",
  'bot.delete.title': 'Danger zone',
  'bot.delete.body': 'Deleting tombstones this bot: its scheduled jobs stop firing (ticker skips tombstones), running turns stop at the next boundary. Kanban tasks it holds stay on the board until the M9.4 crew board offers reassignment.',
  'bot.delete.cta': 'Delete this bot',
  'bot.delete.confirm': 'Tap again to confirm deletion',
  'bot.delete.doing': 'Deleting…',
} as const

export const ar: Record<keyof typeof en, string> = {
  'bot.job': 'المهمة / الوصف',
  'bot.soul': 'SOUL.md — وصف المهمة',
  'bot.save': 'حفظ',
  'bot.saved': 'تم الحفظ',
  'bot.save.failed': 'فشل الحفظ: {why}',
  'bot.chat': 'تحدث مع {name}',
  'bot.delete.failed': 'تعذّر حذف هذا البوت: {why}',
  'bot.delete.title': 'منطقة الخطر',
  'bot.delete.body': 'الحذف يضع علامة قبر على هذا البوت: مهامه المجدولة تتوقف (الجدول يتخطى الملفات الموابَرة)، والأدوار الجارية تتوقف عند الحد التالي. مهام كانبان تبقى على اللوحة حتى توفر لوحة الطاقم (M9.4) إعادة الإسناد.',
  'bot.delete.cta': 'احذف هذا البوت',
  'bot.delete.confirm': 'اضغط مرة أخرى للتأكيد',
  'bot.delete.doing': 'جارٍ الحذف…',
}
