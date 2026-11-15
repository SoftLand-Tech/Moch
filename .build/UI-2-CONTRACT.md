# UI-2 — Projects that actually scope chats

Slice A landed the drawer surface; the projects do not yet *do* anything.
This follow-up makes a project own new chats and lists them under that
project. It is deliberately small: one lib module, two call sites, one test.

## The gap (verified)

- `SessionCreateParams` (vendored `tui_gateway/contracts/sessions.py:118`) has
  `cwd: str | None` — the ONLY project-related create field. There is no
  `project_id` on create, and no project param on `session.list`.
- `StoredSessionRow` carries `cwd` and `git_branch`; `SessionLiveInfo`
  carries `cwd`, `branch`, and `project` (`ProjectRef: id, slug, name,
  primary_path`).
- `projects.tree` returns each node's `path`, `sessionCount`, and
  `sessionIds`; `projects.for_cwd { cwd }` resolves a cwd → project, and
  `projects.set_active { id|null }` sets the server's active project.
- Therefore: **a chat belongs to a project by its `cwd`.** The server's
  active project is not a session field; the client must pass the project's
  folder as `cwd` on create and group rows by `cwd` (or by the server's
  `project` on resume).

## Contract

`app/src/lib/projectScope.ts` (NEW)
```ts
/** Project that should own the next new chat, from the gateway tree. */
export async function projectForNewChat(id: string | null): Promise<ProjectRow | null>
/** cwd to pass to session.create; undefined = the runtime default. */
export async function cwdForNewChat(): Promise<string | undefined>
/** Project for a stored row: row.cwd via projects.for_cwd (cached). */
export async function projectForRow(row: { cwd?: string; project_id?: string }): Promise<ProjectRow | undefined>
/** Synchronous best-effort used by the drawer (no RPC on the hot path). */
export function projectForRowSync(row: { cwd?: string }): ProjectRow | undefined
```
- `projectForNewChat(null)` returns the `isNoProject` row if the tree has one,
  else null; `cwdForNewChat()` then returns `undefined` (the runtime default,
  which is exactly the Personal workspace).
- For a non-null id: resolve the node, use its `path` (or its first repo
  `path`). If the project has no folder, return `undefined` and surface a
  short error atom (`projectScopeErrorAtom`) — do not create in the wrong
  place.
- Cache the `projects.for_cwd` answer per cwd for the session (Map), and
  clear it on `refreshProjects()`; expose `_clearProjectScopeCacheForTests`.

## Slice A — chat create path (owner: A)
Files: `app/src/lib/projectScope.ts` (new), `app/src/lib/chat.ts`
(`createSession` / `runNewChat` only), `app/src/lib/fleet.ts` (NO — do not
touch), `app/src/lib/sessionRowMeta.ts` (add `cwd?: string`,
`project_id?: string`), `app/src/lib/sessionList.ts` (carry `cwd` through the
fan-out; do not filter here).
- In `createSession`, replace the `embeddedSessionCwd()` spread with:
  `cwd: (await cwdForNewChat()) ?? (await embeddedSessionCwd()).cwd` — the
  selected project wins; Personal falls back to the runtime workspace.
- In `runNewChat` (the background create), nothing else changes.
- `sessionRowMeta.SessionRow` gains `cwd?: string`; `sessionList` passes it
  through from `session.list` (the row already sends it) and from
  `session.resume` (`info.cwd`) when a row is created live.
- Do not add a `project` RPC; `cwd` is the contract.

## Slice B — drawer grouping (owner: B)
Files: `app/src/components/Sidebar.tsx`, `app/src/components/ScreenShell.tsx`,
`app/src/lib/workspace.ts` (only `projectForRow*` re-export if needed).
- When `activeProjectId` is null (All), group `recent` by
  `projectForRowSync(row)` → section headers `Personal`, `<project name>`;
  rows whose `cwd` matches no project fall into Personal. Keep the current
  time buckets inside each project group only if the list is small — simplest
  correct shape: **project headers, then rows by recency**; the existing
  `Pinned/Today/...` grouping stays for the `All` view only when there are no
  projects (single-bucket installs).
- When a project is selected, filter to rows whose `projectForRowSync` id
  matches, and use the existing time buckets.
- Do NOT call `projects.for_cwd` from render; use the sync cache. Refresh the
  cache on drawer open (`refreshProjects` already runs then).

## Slice C — test (owner: C)
`app/scripts/test-project-scope.ts` + `package.json` `test:projectscope`:
- fake tree: Personal + "Moch" (`path: /work/moch`) + "Client"
  (`path: /work/client`); fake rows cwds → assert grouping, prefix match
  (`/work/moch/app` → Moch, `/work/mochawk` → none), selected-project
  filtering, and `cwdForNewChat()` returns the selected path / undefined for
  Personal.
- plain node, no RN imports (import only `projectScope.ts`; it must be pure
  with an injectable `rpc` like `sessionList`).

## Verification (AWS)
- `cd app && npx tsc --noEmit && npx tsx scripts/test-project-scope.ts`
- eslint touched files.
- No Gradle/APK here (the AWS build job runs after merge).

## Merge rule
A owns `chat.ts`; B owns Sidebar/ScreenShell; C owns only the test. B must
consume `projectForRowSync` from A's module and not reimplement matching.
