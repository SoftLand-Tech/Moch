/**
 * Settings overlay domain — the account row's surface: section nav, the
 * models panel, and close labels. Section names for connectors and skills
 * reuse the shell's nav.* keys; model-picker strings reuse chat.model.*.
 */
export const en = {
  'settings.account': 'You',
  'settings.close': 'Close',
  'settings.nav.general': 'General',
  'settings.nav.models': 'Models',
  'settings.model.current': 'Current',
  'settings.model.hint': 'The model new chats start with.',
}

export const ar: Record<keyof typeof en, string> = {
  'settings.account': 'أنت',
  'settings.close': 'إغلاق',
  'settings.nav.general': 'عام',
  'settings.nav.models': 'النماذج',
  'settings.model.current': 'الحالي',
  'settings.model.hint': 'النموذج الذي تبدأ به المحادثات الجديدة.',
}
