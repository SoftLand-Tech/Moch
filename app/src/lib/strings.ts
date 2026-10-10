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
  'fleet.cancel': 'Cancel',
  'fleet.offline': 'Fleet offline',
  'fleet.runtime.idle': 'fleet runtime idle on this gateway',
  'fleet.runtime.active': 'fleet runtime · {active}/{slots} turns',
  'fleet.waiting': '{n} waiting ({prios})',
  'fleet.chat': 'Chat with {name}',
  'fleet.freeze': 'Freeze {name}',
  'fleet.unfreeze': 'Unfreeze {name}',
  'fleet.refresh': 'Refresh fleet',
  'fleet.detail.back': 'Fleet',

  'bot.job': 'Job / description',
  'bot.soul': 'SOUL.md — the job description',
  'bot.save': 'Save',
  'bot.saved': 'saved',
  'bot.chat': 'Chat with {name}',
  'bot.delete.title': 'Danger zone',
  'bot.delete.body':
    'Deleting tombstones this bot: its scheduled jobs stop firing (ticker skips tombstones), running turns stop at the next boundary. Kanban tasks it holds stay on the board until the M9.4 crew board offers reassignment.',
  'bot.delete.cta': 'Delete this bot',
  'bot.delete.confirm': 'Tap again to confirm deletion',
  'bot.delete.doing': 'Deleting…',
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
  'fleet.cancel': 'إلغاء',
  'fleet.offline': 'الأسطول غير متصل',
  'fleet.runtime.idle': 'وقت تشغيل الأسطول خامل على هذه البوابة',
  'fleet.runtime.active': 'وقت التشغيل · {active}/{slots} مهام',
  'fleet.waiting': '{n} في الانتظار ({prios})',
  'fleet.chat': 'تحدث مع {name}',
  'fleet.freeze': 'تجميد {name}',
  'fleet.unfreeze': 'إلغاء تجميد {name}',
  'fleet.refresh': 'تحديث الأسطول',
  'fleet.detail.back': 'الأسطول',

  'bot.job': 'المهمة / الوصف',
  'bot.soul': 'SOUL.md — وصف المهمة',
  'bot.save': 'حفظ',
  'bot.saved': 'تم الحفظ',
  'bot.chat': 'تحدث مع {name}',
  'bot.delete.title': 'منطقة الخطر',
  'bot.delete.body':
    'الحذف يضع علامة قبر على هذا البوت: مهامه المجدولة تتوقف (الجدول يتخطى الملفات الموابَرة)، والأدوار الجارية تتوقف عند الحد التالي. مهام كانبان تبقى على اللوحة حتى توفر لوحة الطاقم (M9.4) إعادة الإسناد.',
  'bot.delete.cta': 'احذف هذا البوت',
  'bot.delete.confirm': 'اضغط مرة أخرى للتأكيد',
  'bot.delete.doing': 'جارٍ الحذف…',
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
