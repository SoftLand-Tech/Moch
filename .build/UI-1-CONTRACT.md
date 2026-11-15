# UI-1 — Sidebar identity + projects

Three parallel slices, one shared contract. Land on `ui/bots-projects` → PR.

## Contract

### `src/lib/workspace.ts` (NEW, owner: slice A)
```ts
export type Identity = 'sessions' | 'bots'
export const identityAtom = atom<Identity>('sessions')       // persisted
export const setIdentity = async (i: Identity) => void

export interface ProjectRow {
  id: string
  name: string
  color?: string | null
  icon?: string | null
  isNoProject?: boolean
  sessionCount: number
  primaryPath?: string | null
}
export const projectsAtom = atom<ProjectRow[]>([])
export const activeProjectIdAtom = atom<string | null>(null)
export const refreshProjects = async (): Promise<void> => void
export const setActiveProject = async (id: string | null): Promise<void> => void
/** The effective project for a new chat: selected, else null (= Personal). */
export const newChatProjectId = (): string | null => activeProjectIdAtom.get()
export const projectForCwd = (cwd: string): ProjectRow | undefined => ...
```

Wire shapes (gateway, verified):
- `projects.tree` → `{ projects: ProjectTreeNode[], active_id: string|null }`
  - node: `id, label, path, color, icon, isAuto, isNoProject, sessionCount, lastActive, previewSessions[]`
- `projects.set_active { id: string|null }`
- `projects.create { name, folders?: string[], use?: boolean }`
- `projects.update { id, name?, color?, icon? }`
- `projects.archive { id, restore?: bool }`
- `projects.delete { id }`

Default project = the node with `isNoProject: true` ("Personal"). It is
undeletable and is what `active_id == null` means. Never invent a project id
for it.

### `src/lib/botChat.ts` (NEW, owner: slice B)
```ts
export const BOT_CHAT_TITLE = 'Bot Chat'
export interface BotChatRef { storedId: string; resolvedId?: string }
/** Exact-title lookup on the bot's profile. Never mints. */
export async function findBotChat(profile: string): Promise<BotChatRef | null>
/** Lookup; if absent, create + title; returns the opened stored id. */
export async function openBotChat(profile: string): Promise<string>
```
Rules:
- `session.list { profile, title: 'Bot Chat', limit: 50, include_hidden: true }`
  is the identity lookup. Match a row whose trimmed title is exactly `Bot Chat`.
- On a thrown RPC or an empty list **after** the profile's roster says
  `canonical_session` exists, fail closed (`throw`) — never mint a duplicate.
- Create: `session.create { profile, title: 'Bot Chat', hidden: true, follow_profile_config: true }`
  then `session.title { session_id: <runtime>, title: 'Bot Chat' }` so the row
  exists immediately. If the title is rejected "already in use", re-run the
  lookup and adopt the winner.
- Open with the existing `resumeShared(storedId)` from `lib/chat`.
- Single-flight per profile (double-tap must not mint two).

### `src/lib/inbox.ts` (NEW, owner: slice C)
```ts
export type InboxKind = 'ask' | 'done' | 'error'
export interface InboxItem {
  kind: InboxKind
  storedId: string
  title: string
  at: number
  detail?: string
}
export const inboxItems = computed(...): InboxItem[]
export const inboxCount = computed(...): number
```
Sources (all already exist):
- `pendingBySession` (export it or add a selector) → `ask`
- `attentionById` (`done`/`error`) → `done`/`error`
- `sessionRows` for titles.

## Slice A — Sidebar shell (owner: A)
Files: `src/lib/workspace.ts` (new), `src/components/Sidebar.tsx`,
`src/components/ScreenShell.tsx`, `src/lib/strings.ts` (append keys only,
namespaced `sidebar.*` / `project.*`), new
`src/components/IdentitySwitch.tsx`, new `src/components/ProjectList.tsx`.
- `IdentitySwitch`: segmented `Sessions | Bots`, uses `identityAtom`.
- `ProjectList`: "All projects" + rows + `+ New project`; uses
  `projectsAtom`/`activeProjectIdAtom`; long-press sheet: Rename, Set default,
  Archive, Delete. Rename/create dialogs reuse the Sidebar dialog style
  (`dialogCard` etc.) — do not invent a second dialog.
- Sidebar props gain `identity`, `projects`, `activeProjectId`,
  `onIdentity`, `onProject`, `onNewProject`, `onProjectMenu`. In Sessions mode
  render `ProjectList` above the search; in Bots mode render nothing there
  (Bots slice D owns the roster body — leave a `null` branch).
- ScreenShell: add `identityAtom` + `projectsAtom` subscriptions, pass through,
  hide `fleet`/`crew` from `topNav`, move `connectors` under a new `library`
  key (route: `/(tabs)/connectors` for now), add `inbox` nav row with
  `inboxCount` badge. Do not touch chat.ts / bot.tsx.
- Project filter: ScreenShell already builds `recent`; when
  `activeProjectId` is set, filter rows by `r.project_id` if present, else
  by `projectForCwd(r.cwd)`. Add `cwd`/`project_id` to `SessionRow`
  (sessionRowMeta) if not typed.
- i18n: add EN + AR keys only; no literals in JSX.

## Slice B — Canonical Bot Chat (owner: B)
Files: `src/lib/botChat.ts` (new), `src/lib/fleet.ts` (add
`canonicalSession` to `FleetProfile` + map `profiles.list` rows; do not remove
existing exports), `app/bot.tsx` (replace the "Chat with" hand-off with
`openBotChat(name)`), `app/(tabs)/chat.tsx` **only** the
`activeBot` chip "Switch back" action (call `setActiveBot(null)` remains).
- `profiles.list` already returns `canonical_session`; use it for the
  fail-closed probe.
- `openBotChat` must call `setActiveBot(profile)` first so `createSession`
  keeps scoping new sessions, then `resumeShared`.
- No homeThreads on mobile (there are none); do not add one.
- Tests: add `scripts/test-bot-chat.ts` (plain node, fake RPC via
  `_useSessionRpcForTests` pattern from sessionList) covering: existing row
  opens; missing row creates + titles; title conflict adopts; RPC failure
  throws. Add script to package.json `test:botchat`.

## Slice C — Inbox screen (owner: C)
Files: `src/lib/inbox.ts` (new), `app/(tabs)/inbox.tsx` (new), `app/(tabs)/_layout.tsx`
(add `<Tabs.Screen name="inbox" />`), `src/lib/strings.ts` (append keys only,
`inbox.*`), `src/components/ScreenShell.tsx` **only** the nav item + badge
(coordinate: A also edits this file — see merge rule).
- Screen: grouped `Needs you` (ask), `Finished` (done), `Failed` (error);
  row shows bot/project? (best-effort from `profile`/`cwd`), title, age;
  tap → `switchToSession(storedId)` + `router.navigate('/(tabs)/chat')`.
- Empty state: "Nothing needs you" + Mochi.
- No new RPC. No writes.

## Merge rule for ScreenShell.tsx
A owns the whole file; C's only change is the nav item + badge. C must NOT
edit ScreenShell; instead put the nav row in `workspace.ts` as
`inboxNavItem` and tell A in the report. A applies it.

## Verification (on AWS only)
- `cd app && npx tsc --noEmit`
- `npx eslint src app --ext .ts,.tsx`
- `npx tsx scripts/test-bot-chat.ts` (new) + existing offline suites listed
  in `package.json` (test, test:chatlist, test:attention, test:queue, test:slash,
  test:interactive, test:imports). No `test:live` (needs a gateway).
- Do not run Gradle or build the APK.
