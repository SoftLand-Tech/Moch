# Moch full redesign — implementation spec (branch `redesign/full-ui-i18n`)

Source of truth for visuals: **`docs/redesign/design.html`** (20-screen interactive showcase,
390×844 phone viewport). Open it in a browser to compare. Every screen in the app must look like
its counterpart in that file. Design tokens in the mockup are an exact match to
`app/src/lib/theme.ts` (`C` / `S` live tokens) — never hardcode a palette color that exists as a
token; use `C.*`.

The mockup is a static HTML mock. The app is a real product: **functionality, data flow, state
machines, RPCs, deep links, error handling and accessibility must all be preserved.** Only the
presentation layer changes.

---

## 1. Non-negotiable rules

1. **Keep every existing behavior.** Before rewriting a file, list its JSX features/handlers.
   After the rewrite every one must still be reachable (same flow, same RPC). If the mockup does
   not show a feature (search field, pull-to-refresh, retry banner, long-press menu, …), keep it —
   restyled in the new visual language, placed where it does not fight the mockup layout.
2. **Mockup = visual spec.** Match structure, order, spacing, radii, font sizes, colors, pill
   kinds, card/elevation usage, and the mockup's state variants (the `states` array in
   `SCREENS`). Where the mockup shows sample/mock data, bind the same UI to the real store/state.
3. **No new npm dependencies.** No emulator/testing on this device.
4. **Own files only.** Do not edit shared files outside your assignment
   (`theme.ts`, `components/ui.tsx`, `components/MochiMark.tsx`, `lib/i18n/index.ts`,
   `lib/i18n/types.ts`, `lib/strings.ts`, `ScreenShell.tsx`, `Sidebar.tsx`, `ModelPickerSheet.tsx`
   are Lead-owned). Your own i18n catalog file is yours. If you need a new shared primitive,
   message the Lead instead of editing shared files.
5. **i18n is mandatory and complete.** Every user-visible string you touch goes through `tr()`:
   no English literals left in JSX, `placeholder`, `accessibilityLabel`, `AlertDialog` buttons, or
   alert copy. Add the keys to **your** catalog file with all four locales (en, ar, zh, fr).
   Markup/`mono`/user data (model ids, URLs, cron, session titles, bot names) stay untranslated.
6. **RTL (Arabic) is mandatory** for everything you style: use `useDir()` (see §4) for row
   direction, text alignment/writing direction, asymmetric padding, and chevron icon flipping.
7. **Theme-reactive styles.** Build `StyleSheet` factories with `useStyles(makeS)` reading `C`/`S`
   (existing convention) so the Relay theme switch keeps working. Never snapshot `C` at module
   scope.
8. Typecheck must pass: `cd app && npx tsc --noEmit -p tsconfig.json` (plus scripts project).
   `npm run lint` must stay clean for your files.

---

## 2. UI kit — `app/src/components/ui.tsx` (use it, don't fork it)

Import from `../../src/components/ui` (adjust depth). Values are the mockup's exact CSS values.

| Export | What it is | Mockup CSS |
|---|---|---|
| `<Txt size={13} weight="600" color={C.textDim} mono center numberOfLines>` | the app's text primitive. `size` = px number, `weight` = '400'…'800', `mono` = monospace, `center`, plus normal `TextProps`. Applies Arabic writing direction. | text runs |
| `<Card onPress? style>` | m-card | `bgCard, border 1 border, radius 14, padding 12, marginBottom 10` |
| `<Elev style>` | m-elev | `bgElev, border 1 border, radius 12, padding 10` |
| `<Kicker>` | m-section-kicker | `10.5/700 upper, letterSpacing 0.75, textFaint, marginTop 12, marginBottom 6, marginH 2` |
| `<Pill kind="accent"\|"green"\|"amber"\|"red"\|"neutral">` | m-pill | `10.5/700, pad 2×8, radius 999`; accent = accentSoft/accent + border; green = greenTint/greenSoft; amber; red; neutral = bgElev/textDim |
| `<Dot kind="green"\|"amber"\|"red"\|"idle" size?>` | status-dot | 8×8 circle |
| `<PrimaryBtn onPress label? style small?>` | m-btn-primary | accent bg, onAccent ink, radius 11, pad 9×14, 13/700 |
| `<GhostBtn onPress label? style small?>` | m-btn-ghost | bgElev, border, radius 11, pad 8×12, 12.5/600 |
| `<Field ...TextInputProps mono multiline style>` | m-input | inputBg, border, radius 11, pad 9×11, 13px, placeholder textFaint |
| `<Segmented options={[{key,label}]} value onChange>` | 2-column switch (Sessions\|Bots, Commands\|Skills, Yours\|Browse) | bgCard, border, radius 11, pad 3; active = accent bg + onAccent |
| `<Toggle value onChange>` | settings/reasoning switch | 42×24 track, accent when on, 20 knob |
| `<SheetGrabber/>` | sheet grabber | 36×4 radius 999 textFaint 45% |
| `<SheetCard style>` | bottom sheet card (inside your own Modal/overlay) | bgElev, radius 24 top, pad 10×14×26, maxHeight 78% |
| `<SheetBackdrop onPress>` | scrim | rgba(0,0,0,.62) |
| `<HeaderButton name onPress color? size? label?>` | shell-icon-btn | 32×32, radius 10, btnTint, 1px transparent border |
| `<ScreenScroll ...ScrollViewProps contentContainerStyle>` | app-scroll | flex 1, pad 10×14×18 |
| `<Divider/>` | 1px borderSoft separator |
| `<Spinner/>` | ActivityIndicator textDim |
| `<MochiMark size mood="happy"\|"sleepy"/>` | the mascot from `getMochiSVG()` in the mockup (pure-RN shapes). Use wherever the mockup renders Mochi. |

Icons: keep using `Icon` from `components/Icon` (Mouse-tinted Mochi glyphs + Ionicons fallback) and
`Ionicons` for one-offs. Button paddings vary per screen in the mockup — pass `style` to override.

Mockup CSS for all primitives: `design.html` lines **780–1000**.

---

## 3. i18n — full coverage for `en`, `ar`, `zh`, `fr`

- API lives in `app/src/lib/strings.ts` (facade) + `app/src/lib/i18n/` (catalogs).
  - `tr('key', { n: 3 })` — translates; `{placeholders}` interpolate.
  - `useT()` — subscribes to locale changes (use in components that render `tr()` copy at render
    time; simple screens can call `tr()` directly, but subscribing is required if the screen is
    already open when the language changes).
  - `localeAtom`, `setLocale('en'|'ar'|'zh'|'fr')`, `loadLocale()` — persistence already handled.
  - `useDir()` → `{ rtl, row: 'row'|'row-reverse', textAlign, writingDirection, icon: { forward, back } }`.
- **Your catalog file** (one per owner, listed in §5) exports:
  ```ts
  import type { Catalog } from './types'
  export const chat: Catalog = {
    en: { 'chat.send': 'Send', … },
    ar: { 'chat.send': 'إرسال', … },
    zh: { 'chat.send': '发送', … },
    fr: { 'chat.send': 'Envoyer', … },
  }
  ```
  Prefix keys with your domain name. Do not edit other catalog files or `i18n/index.ts`.
- Existing keys live in `lib/i18n/legacy.ts` (migrated from the old EN/AR catalog: `sidebar.*`,
  `fleet.*`, `crew.*`, `bot.*`, `inbox.*`, `bots.*`, `project.*`, `settings.*`, `connectors.*`,
  `automations.*`, `linux.*`, `chat.*`, `status.*`). **Reuse them where they fit** — they are
  already translated into all four languages at the end of this work. If a legacy key's copy does
  not match the mockup wording, do not edit the legacy file: add a new key in your catalog.
- English copy: take the exact strings from the mockup where shown. Other locales: idiomatic,
  concise mobile UI language, consistent glossary (§6). Arabic must be real RTL Arabic (no
  transliteration), Chinese simplified, French with proper accents/typography.
- Formatting: relative times, counts, dates come from existing helpers — if a helper returns English
  labels (e.g. "just now"), localize it with keys in your catalog instead of hardcoding.
- Checklist before reporting done: `grep -nE "['\"][A-Z][a-z]+ [a-z]" <your files>` shows no
  remaining English UI literals; all four locale blocks have identical key sets.

---

## 4. RTL rules (Arabic)

- Root layout is **not** using `I18nManager.forceRTL` (it needs an app restart). Mirror manually:
  - rows: `style={{ flexDirection: dir.row }}`
  - text: `Txt` already applies `writingDirection`; for raw `Text` add
    `{ textAlign: dir.textAlign, writingDirection: dir.writingDirection }`.
  - asymmetric padding/margin → use `dir.rtl ? 'right' : 'left'` for the horizontal component.
  - chevrons/back arrows: `dir.icon.forward` / `dir.icon.back`.
  - horizontally scrolling strips render naturally (RN respects writingDirection); keep LTR for
    URLs, model ids, terminal, code/cron with explicit `writingDirection: 'ltr'` + left alignment.
- Drawer (Sidebar) slides from the right in RTL — the chrome owner handles this.

---

## 5. Screen ownership map (mockup line ranges are in `docs/redesign/design.html`)

| Mockup screen | App files | Catalog file |
|---|---|---|
| 0 Shared chrome, drawer, model sheet | `ScreenShell.tsx` (Lead), `Sidebar.tsx`, `BotsRoster.tsx`, `ProjectList.tsx`, `IdentitySwitch.tsx`, `ModelPickerSheet.tsx`, `SessionToasts.tsx`, `AlertDialog.tsx` (chrome owner) | `i18n/chrome.ts` |
| 1 Chat (★) — lines 1946–2129 | `app/(tabs)/chat.tsx`, `components/Chat.tsx`, `components/media/*`, `components/CommandOutput.tsx`, `components/CommandCatalogSheet.tsx`, `components/CommandOptionsSheet.tsx`, `components/VoiceRecStrip.tsx` | `i18n/chat.ts` |
| 2 Chats/Sessions — 2130–2184, 3 Inbox — 2185–2252, 10 Skills — 2693–2745 | `app/(tabs)/sessions.tsx`, `inbox.tsx`, `skills.tsx` | `i18n/sessions.ts`, `i18n/inbox.ts`, `i18n/skills.ts` |
| 4 Models/Agent — 2253–2344, 5 Terminal — 2345–2401 | `app/(tabs)/agent.tsx`, `terminal.tsx`, `components/ProviderKeyForm.tsx` | `i18n/agent.ts`, `i18n/terminal.ts` |
| 6 Browser — 2402–2472, 11 Connectors — 2746–2823 | `app/(tabs)/browser.tsx`, `connectors.tsx`, `components/AgentBrowserHost.tsx` | `i18n/browser.ts`, `i18n/connectors.ts` |
| 7 Fleet — 2473–2544, 8 Crew — 2545–2627, 13 Bot modal — 2906–2956 | `app/(tabs)/fleet.tsx`, `crew.tsx`, `app/bot.tsx`, `components/BotAvatar.tsx` | `i18n/fleet.ts`, `i18n/crew.ts`, `i18n/bot.ts` |
| 9 Automations — 2628–2692, 12 Settings — 2824–2905 | `app/(tabs)/automations.tsx`, `settings.tsx` | `i18n/automations.ts`, `i18n/settings.ts` |
| 14 Entry — 2957–2989, 15 Setup — 2990–3058, 16–19 Onboarding — 3059–3234 | `app/index.tsx`, `app/setup.tsx`, `app/onboarding/{environment,thinker,providers,about}.tsx`, `components/AnimatedSplash.tsx`, `app/_layout.tsx` (user-visible strings only) | `i18n/setup.ts` |
| legacy EN/AR → zh/fr | `lib/i18n/legacy.ts` ↔ `i18n/legacy-extra.ts` | translator owner |

Also in scope for the owner of the screen that renders them:
`app/(tabs)/_layout.tsx` (no copy changes expected), `src/lib/*` files only when a user-visible
string originates there and is rendered by your screen (translate at the render site).

---

## 6. Glossary (keep identical across screens)

| EN | AR | ZH | FR |
|---|---|---|---|
| Moch (app) / Mochi (mascot) | Moch / Mochi (unchanged) | Moch / Mochi | Moch / Mochi |
| Chat | محادثة | 对话 | Discussion |
| Chats | المحادثات | 对话 | Discussions |
| New chat | محادثة جديدة | 新对话 | Nouvelle discussion |
| Inbox | الوارد | 收件箱 | Boîte de réception |
| Fleet | الأسطول | 机器人集群 | Flotte |
| Crew | الطاقم | 团队 | Équipe |
| Automations | الأتمتة | 自动化 | Automatisations |
| Skills | المهارات | 技能 | Compétences |
| Commands | الأوامر | 命令 | Commandes |
| Connectors | الموصلات | 连接器 | Connecteurs |
| Terminal | الطرفية | 终端 | Terminal |
| Browser | المتصفح | 浏览器 | Navigateur |
| Settings | الإعدادات | 设置 | Paramètres |
| Models | النماذج | 模型 | Modèles |
| Provider | المزوّد | 提供方 | Fournisseur |
| Bot | بوت | 机器人 | Bot |
| Project | مشروع | 项目 | Projet |
| Save | حفظ | 保存 | Enregistrer |
| Cancel | إلغاء | 取消 | Annuler |
| Delete | حذف | 删除 | Supprimer |
| Retry | إعادة المحاولة | 重试 | Réessayer |
| Offline | غير متصل | 离线 | Hors ligne |
| Connected | متصل | 已连接 | Connecté |
| Running | قيد التشغيل | 运行中 | En cours |
| Done | تم | 完成 | Terminé |
| Ready | جاهز | 就绪 | Prêt |
| Working | يعمل | 进行中 | En cours |
| Blocked | متوقف | 阻塞 | Bloqué |
| Frozen | مجمّد | 已冻结 | Gelé |
| Active | نشط | 活跃 | Actif |
| Paused | متوقف مؤقتًا | 已暂停 | En pause |
| Language | اللغة | 语言 | Langue |
| Appearance | المظهر | 外观 | Apparence |
| Notifications | الإشعارات | 通知 | Notifications |
| Reasoning effort | جهد التفكير | 推理强度 | Effort de raisonnement |
| Copy | نسخ | 复制 | Copier |
| Close | إغلاق | 关闭 | Fermer |
| Back | رجوع | 返回 | Retour |
| Skip | تخطّي | 跳过 | Passer |
| Continue | متابعة | 继续 | Continuer |
| Install | تثبيت | 安装 | Installer |
| Test tools | اختبار الأدوات | 测试工具 | Tester les outils |
| Search | بحث | 搜索 | Rechercher |
| Filter | تصفية | 筛选 | Filtrer |
| Add | إضافة | 添加 | Ajouter |
| Edit | تعديل | 编辑 | Modifier |
| Run now | شغّل الآن | 立即运行 | Exécuter |
| Details | التفاصيل | 详情 | Détails |

Numbers keep Latin digits. Do not translate product names, model ids, code, URLs, cron expressions.

## 7. Verification you must run before reporting

```bash
cd app
npx tsc --noEmit -p tsconfig.json
npx tsc -p tsconfig.scripts.json --noEmit
npx eslint <your files>
npx tsx scripts/test-i18n.ts   # Lead adds this; must pass (all 4 locales complete)
```
Report: files touched, catalog keys added, features intentionally kept/moved, typecheck result,
and any shared-file change you need from the Lead.
