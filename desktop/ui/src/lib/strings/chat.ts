// Chat surface strings, verbatim from the mobile catalog (same keys, same copy), plus the desktop empty states and composer.
export const en = {
  'chat.foreign.title': 'Another session on this machine is asking you something',
  'chat.foreign.hint': 'Tap to review and answer it here.',
  'chat.clarify.pending.one': '1 question still needs an answer before sending.',
  'chat.clarify.pending.many': '{n} questions still need answers before sending.',
  'chat.empty.title': 'What should Mochi do?',
  'chat.empty.title.bot': 'Talk to {name}',
  'chat.empty.sub': "Your agents run entirely on this machine — they can use the terminal, browse the web, remember across chats, and work while you're elsewhere. Ask for anything.",
  'chat.list.empty': 'No chats yet — say hi below.',
  'chat.composer.placeholder': 'Ask Mochi anything — / for commands',
  'chat.composer.placeholder.bot': 'Message {name}…',
  'chat.composer.placeholder.steer': 'Steer the running turn — delivered at the next boundary…',
} as const

export const ar: Record<keyof typeof en, string> = {
  'chat.foreign.title': 'جلسة أخرى على هذا الجهاز تطلب منك إجابة',
  'chat.foreign.hint': 'اضغط لمراجعتها والإجابة عليها من هنا.',
  'chat.clarify.pending.one': 'سؤال واحد لا يزال بحاجة إلى إجابة قبل الإرسال.',
  'chat.clarify.pending.many': '{n} أسئلة لا تزال بحاجة إلى إجابات قبل الإرسال.',
  'chat.empty.title': 'ماذا يفعل موتشي؟',
  'chat.empty.title.bot': 'تحدث مع {name}',
  'chat.empty.sub': 'وكلاؤك يعملون بالكامل على هذا الجهاز — يمكنهم استخدام الطرفية وتصفح الويب والتذكّر عبر المحادثات والعمل أثناء انشغالك. اطلب أي شيء.',
  'chat.list.empty': 'لا محادثات بعد — قل مرحبًا بالأسفل.',
  'chat.composer.placeholder': 'اسأل موتشي أي شيء — اكتب / للأوامر',
  'chat.composer.placeholder.bot': 'راسل {name}…',
  'chat.composer.placeholder.steer': 'وجّه الدور الجاري — يُسلَّم عند الحد التالي…',
}
