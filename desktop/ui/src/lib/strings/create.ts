// Create-overlay domain strings (the hiring flow). Checklist rows reuse the
// existing fleet.create.* keys — that content is the same recycled flow.
export const en = {
  'create.title': 'Hire a bot',
  'create.job.label': 'The job',
  'create.job.placeholder': 'One or two plain sentences. This bot\u2019s whole life is built around them.',
  'create.name.label': 'Name',
  'create.soul.label': 'Soul draft',
  'create.soul.hint': 'The working agreement it starts with. Editable later in its editor.',
  'create.look.label': 'Look',
  'create.start.label': 'Start the bot with',
  'create.look.color': 'Color',
  'create.look.avatar': 'Avatar',
  'create.look.avatar.none': 'Initials',
  'create.look.avatar.greeting': 'Greeting',
  'create.look.avatar.listening': 'Listening',
  'create.look.avatar.deep-thinking': 'Deep in thought',
  'create.look.avatar.confused': 'Puzzled',
  'create.look.avatar.connecting': 'Connecting',
  'create.look.avatar.approval': 'Showing results',
  'create.look.avatar.celebration': 'Celebrating',
  'create.starter.research.label': 'Research assistant',
  'create.starter.research.job':
    'Help me research topics: gather sources, verify claims, and return tight briefs with the key findings up top.',
  'create.starter.deals.label': 'Deal hunter',
  'create.starter.deals.job':
    'Hunt deals on things I am looking for. Check regularly and flag only the genuinely good ones, with a note on why.',
  'create.starter.code.label': 'Code helper',
  'create.starter.code.job':
    'Help me write and review code in this workspace. Keep changes small, tested, and explained.',
  'create.starter.journal.label': 'Daily journal',
  'create.starter.journal.job':
    'Check in each evening and keep a short journal of my day \u2014 one entry per day, easy to reread.',
  'create.cta': 'Create bot',
  'create.cta.busy': 'Creating {name}\u2026',
  'create.cancel': 'Cancel',
  'create.err': 'Could not create the bot: {why}',
  'create.err.late': '{name} exists, but its thread or introduction failed: {why}',
  'create.openanyway': 'Open {name} anyway',
  'create.intro.prompt':
    'You have just been created as {name}, a Moch bot. Your job, as written by your owner: {job}\n\nBefore any real work, introduce yourself in this thread. In two or three sentences of your own words, state how you understood your job, then ask for anything you are missing to do it well. This introduction is your only task right now.',
} as const

export const ar: Record<keyof typeof en, string> = {
  'create.title': 'وظّف بوتًا',
  'create.job.label': 'المهمة',
  'create.job.placeholder': 'جملة أو جملتان بلغة بسيطة. حياة هذا البوت كلها تُبنى عليهما.',
  'create.name.label': 'الاسم',
  'create.soul.label': 'مسودة الروح',
  'create.soul.hint': 'اتفاق العمل الذي يبدأ به. يمكن تعديله لاحقًا في محرره.',
  'create.look.label': 'المظهر',
  'create.start.label': 'يبدأ البوت بـ',
  'create.look.color': 'اللون',
  'create.look.avatar': 'الصورة',
  'create.look.avatar.none': 'الأحرف الأولى',
  'create.look.avatar.greeting': 'التحية',
  'create.look.avatar.listening': 'الإنصات',
  'create.look.avatar.deep-thinking': 'غارق في التفكير',
  'create.look.avatar.confused': 'محتار',
  'create.look.avatar.connecting': 'يتصل',
  'create.look.avatar.approval': 'يعرض النتائج',
  'create.look.avatar.celebration': 'يحتفل',
  'create.starter.research.label': 'مساعد بحث',
  'create.starter.research.job':
    'ساعدني في البحث: اجمع المصادر، تحقق من الادعاءات، وأعد ملخصات محكمة بأهم النتائج في المقدمة.',
  'create.starter.deals.label': 'صائد العروض',
  'create.starter.deals.job':
    'تتبع العروض على ما أبحث عنه. راجع بانتظام ولا ترفع إلا العروض الجيدة فعلًا، مع ملاحظة عن سبب جدواها.',
  'create.starter.code.label': 'مساعد برمجة',
  'create.starter.code.job':
    'ساعدني في كتابة الأكواد ومراجعتها في مساحة العمل هذه. اجعل التغييرات صغيرة ومختبرة ومشروحة.',
  'create.starter.journal.label': 'مفكرة يومية',
  'create.starter.journal.job':
    'راسلني كل مساء واحتفظ بمفكرة قصيرة ليومي — مدخل واحد يوميًا، سهل القراءة لاحقًا.',
  'create.cta': 'أنشئ البوت',
  'create.cta.busy': 'جارٍ إنشاء {name}\u2026',
  'create.cancel': 'إلغاء',
  'create.err': 'تعذّر إنشاء البوت: {why}',
  'create.err.late': '{name} موجود، لكن فشل فتح حواره أو تقديمه: {why}',
  'create.openanyway': 'افتح {name} رغم ذلك',
  'create.intro.prompt':
    'لقد أنشئت للتو باسم {name}، أحد بوتات موك. مهمتك كما كتبها صاحبك: {job}\n\nقبل أي عمل حقيقي، قدّم نفسك في هذا الحوار. في جملتين أو ثلاث بكلماتك الخاصة، اشرح كيف فهمت مهمتك، ثم اطلب ما ينقصك لأدائها على الوجه الصحيح. هذا التقديم هو مهمتك الوحيدة الآن.',
}
