/**
 * Chat/session state — the desktop port of the phone's src/lib/chat.ts
 * (same v7 event vocabulary, same session lifecycle), written clean against
 * nanostores for the web. RN-only machinery (outbox persistence via
 * AsyncStorage, keyboard, replay-on-mount scrollers) is replaced by its
 * desktop equivalent: localStorage marks, virtual-free rendering (browsers
 * handle long lists), and the same live↔stored session id bridging.
 */

import { atom, computed } from 'nanostores'
import { rpc, onEvent, onServerRequest, workspaceDir } from './gateway'
import { activeBotAtom, homeThreadFor, setActiveBot, setHomeThread } from './fleet'
import type { ServerRequest } from '../protocol/json-rpc-gateway'

// ── model ───────────────────────────────────────────────────────────────────

export interface ChatSegment {
  kind: 'text' | 'reasoning' | 'thinking'
  text: string
  startedAt?: number
  chars?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  segments: ChatSegment[]
  streaming?: boolean
  done?: boolean
  createdAt: number
  /** Slash/command meta (local echo). */
  command?: { name: string; text?: string }
}

export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'complete' | 'error'
  args?: string
  output?: string
  startedAt?: number
  endedAt?: number
  /** Full raw args (uncapped) — the diff capture needs path + content. */
  argsRaw?: unknown
  /** Edit tracking (Diff workbench + inline diff block). */
  editPath?: string
  add?: number
  del?: number
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/** One interactive server request (approval / clarify / sudo / secret). */
export interface PendingCard {
  id: string
  kind: 'approval' | 'clarify' | 'sudo' | 'secret' | 'vault'
  sessionId?: string
  title: string
  body?: string
  command?: string
  options?: { label: string; value: string }[]
  /** Batch clarify: one entry per question. */
  questions?: { qid: string; question?: string; choices?: string[] }[]
  allowPermanent?: boolean
  allowSession?: boolean
  danger?: boolean
  /** Set when the backend withdrew the question (request.cancel). */
  cancelled?: boolean
  raw: ServerRequest
}

export interface SessionState {
  liveId: string
  storedId?: string
  title: string
  messages: ChatMessage[]
  tools: ToolItem[]
  todos: TodoItem[]
  usage: UsageInfo
  busy: boolean
  profile?: string
  createdAt: number
}

export const sessionsById = atom<Record<string, SessionState>>({})
export const activeSession = atom<string | null>(null)
export const activeSessionAtom = activeSession
export const pendingBySession = atom<Record<string, PendingCard>>({})
/** Ordered stored ids from session.list (the sidebar list). */
export const sessionOrder = atom<{ id: string; title: string; lastActive: number; profile?: string }[]>([])

/** Files the agents edited this session (for the Diff workbench tab). */
export interface ChangedFile { path: string; add: number; del: number; patch?: string }
export const changedFiles = atom<Map<string, ChangedFile>>(new Map())
export const changedOrder = atom<string[]>([])

function recordEdit(path: string, add: number, del: number, patch?: string): void {
  console.info('[moch-diff] recordEdit', path, add, del, patch?.length ?? 0)
  const map = new Map(changedFiles.get())
  const prev = map.get(path)
  map.set(path, {
    path,
    add: (prev?.add ?? 0) + add,
    del: (prev?.del ?? 0) + del,
    patch: patch ?? prev?.patch,
  })
  changedFiles.set(map)
  const order = changedOrder.get()
  if (!order.includes(path)) changedOrder.set([...order, path])
}

/** Extract a unified-ish diff from patch-tool args/output and count changes. */
function parsePatch(pathHint: string, rawText: string): { path: string; add: number; del: number; patch: string } | null {
  if (!rawText || (!rawText.includes('\n---') && !rawText.includes('\n+++') && !/^--- /m.test(rawText))) {
    const add = (rawText.match(/^\+[^+]/gm) || []).length
    const del = (rawText.match(/^-[^-]/gm) || []).length
    if (!add && !del) return null
    return { path: pathHint, add, del, patch: rawText }
  }
  let path = pathHint
  for (const m of rawText.matchAll(/^\+\+\+\s+\S*\/?([^\n/]+)$/gm)) path = m[1] || path
  const add = (rawText.match(/^\+[^+]/gm) || []).length
  const del = (rawText.match(/^-[^-]/gm) || []).length
  return { path, add, del, patch: rawText }
}

export const view = computed([sessionsById, activeSession], (map, id) =>
  id && map[id] ? map[id] : null,
)
export const messages = computed(view, (s) => s?.messages ?? [])
export const tools = computed(view, (s) => s?.tools ?? [])
export const todos = computed(view, (s) => s?.todos ?? [])
export const usage = computed(view, (s) => s?.usage ?? {})
export const agentBusy = computed(view, (s) => s?.busy ?? false)
export const activeTitle = computed(view, (s) => s?.title ?? '')
export const pendingRequest = computed(
  [pendingBySession, activeSession],
  (map, id): PendingCard | null => (id ? map[id] ?? null : null),
)
export const anyBusy = computed(sessionsById, (map) => Object.values(map).some((s) => s.busy))
export const pendingCount = computed(pendingBySession, (map) => Object.values(map).filter((p) => !p.cancelled).length)

export function patchSession(id: string, patch: Partial<SessionState>): void {
  const map = sessionsById.get()
  const cur = map[id]
  if (!cur) return
  sessionsById.set({ ...map, [id]: { ...cur, ...patch } })
}

function ensureSession(liveId: string): SessionState {
  const map = sessionsById.get()
  if (map[liveId]) return map[liveId]
  const fresh: SessionState = {
    liveId,
    title: 'New chat',
    messages: [],
    tools: [],
    todos: [],
    usage: {},
    busy: false,
    createdAt: Date.now(),
  }
  sessionsById.set({ ...map, [liveId]: fresh })
  return fresh
}

// ── live ↔ stored id bridging ──────────────────────────────────────────────

const liveByStored = new Map<string, string>()
export function storedIdFor(liveId: string): string | undefined {
  const s = sessionsById.get()[liveId]
  return s?.storedId
}
export function liveIdForStored(storedId: string): string | undefined {
  return liveByStored.get(storedId)
}
function bindIds(liveId: string, storedId: string | undefined): void {
  if (!storedId) return
  const s = sessionsById.get()[liveId]
  if (s) patchSession(liveId, { storedId })
  liveByStored.set(storedId, liveId)
}

// ── event intake ────────────────────────────────────────────────────────────

function upsertMessage(sid: string, role: 'user' | 'assistant' | 'system', seg: ChatSegment, opts: { streaming?: boolean; id?: string } = {}): string {
  const s = ensureSession(sid)
  const id = opts.id ?? `m${Date.now()}${Math.random().toString(36).slice(2, 7)}`
  const messages = s.messages.slice()
  messages.push({ id, role, segments: [seg], streaming: opts.streaming, createdAt: Date.now() })
  patchSession(sid, { messages })
  return id
}

function appendToLast(sid: string, kind: ChatSegment['kind'], chunk: string): void {
  const s = sessionsById.get()[sid]
  if (!s) return
  const messages = s.messages.slice()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.streaming) continue
    const segs = m.segments.slice()
    const last = segs[segs.length - 1]
    // Reasoning interleaves: it only extends a TRAILING reasoning segment.
    // If text came after it, the model reasoned AGAIN — open a fresh block
    // in flow order instead of feeding the old one at the top.
    if (last && last.kind === kind && (kind === 'text' || segs[segs.length - 1] === last)) {
      segs[segs.length - 1] = { ...last, text: last.text + chunk, chars: (last.chars ?? last.text.length) + chunk.length }
    } else {
      segs.push({ kind, text: chunk, startedAt: Date.now(), chars: chunk.length })
    }
    messages[i] = { ...m, segments: segs }
    patchSession(sid, { messages })
    return
  }
  // no streaming message yet — open one
  upsertMessage(sid, 'assistant', { kind, text: chunk, startedAt: Date.now(), chars: chunk.length }, { streaming: true })
}

function finishStreaming(sid: string): void {
  const s = sessionsById.get()[sid]
  if (!s) return
  const messages = s.messages.map((m) => (m.streaming ? { ...m, streaming: false, done: true } : m))
  patchSession(sid, { messages, busy: false })
}

function handleToolEvent(sid: string, payload: Record<string, unknown>, phase: 'start' | 'complete'): void {
  const s = ensureSession(sid)
  const name = String(payload.name ?? 'tool')
  const id = String(payload.id ?? payload.call_id ?? '')
  const tools = s.tools.slice()
  const idx = tools.findIndex((t) => t.id === id)
  // start/complete carry different synthetic ids — match the running item by
  // name (last match), falling back to id.
  let cur = idx
  if (cur < 0) {
    for (let i = tools.length - 1; i >= 0; i--) {
      if (tools[i].name === name && tools[i].status === 'running') { cur = i; break }
    }
  }

  if (phase === 'start') {
    const rawArgs = payload.args ?? payload.input
    if (cur >= 0) {
      tools[cur] = { ...tools[cur], status: 'running', argsRaw: rawArgs ?? tools[cur].argsRaw, startedAt: tools[cur].startedAt ?? Date.now() }
    } else {
      tools.push({
        id: id || `${name}-${Date.now()}`,
        name,
        status: 'running',
        args: summarizeArgs(rawArgs),
        argsRaw: rawArgs,
        startedAt: Date.now(),
      })
    }
    patchSession(sid, { tools })
    return
  }

  // complete
  if (cur >= 0) {
    tools[cur] = {
      ...tools[cur],
      status: payload.error ? 'error' : 'complete',
      argsRaw: (tools[cur].argsRaw ?? payload.args) as unknown,
      output: summarizeOutput(payload.output ?? payload.result ?? payload.error),
      endedAt: Date.now(),
    }
  }
  patchSession(sid, { tools })

  // Track edited files for the Diff workbench (patch/Edit/write_file family).
  if (!payload.error && cur >= 0) {
    const item = tools[cur]
    if (/patch|edit|write_file|apply/.test(item.name.toLowerCase())) {
      let pathHint = item.editPath ?? (id || item.name)
      let patchText: string | undefined
      try {
        const raw: unknown = item.argsRaw
        const parsedArgs = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
        pathHint = String(parsedArgs.path ?? parsedArgs.file ?? pathHint)
        if (typeof parsedArgs.patch === 'string') patchText = parsedArgs.patch
        if (typeof parsedArgs.content === 'string' && !patchText) {
          patchText = parsedArgs.content.split('\n').map((l) => `+${l}`).join('\n')
        }
      } catch { /* args not JSON */ }
      const outRaw = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      const parsed = parsePatch(pathHint, patchText ?? outRaw)
      if (parsed) {
        recordEdit(parsed.path, parsed.add, parsed.del, parsed.patch)
        const now = sessionsById.get()[sid]
        if (now) {
          patchSession(sid, { tools: now.tools.map((x) => (x.id === item.id ? { ...x, editPath: parsed.path, add: parsed.add, del: parsed.del } : x)) })
        }
      }
    }
  }
}

function summarizeArgs(args: unknown): string | undefined {
  if (args == null) return undefined
  if (typeof args === 'string') return args.slice(0, 500)
  try { return JSON.stringify(args).slice(0, 500) } catch { return String(args).slice(0, 500) }
}
function summarizeOutput(out: unknown): string | undefined {
  if (out == null) return undefined
  if (typeof out === 'string') return out.slice(0, 4000)
  try { return JSON.stringify(out, null, 2).slice(0, 4000) } catch { return String(out).slice(0, 4000) }
}

export function hookChatEvents(): () => void {
  const stop = onEvent((e) => {
    const sid = e.session_id
    const p = (e.payload ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'session.info': {
        // session metadata refresh (title, model, busy)
        const title = typeof p.title === 'string' ? p.title : undefined
        const busy = typeof p.busy === 'boolean' ? p.busy : undefined
        if (sid) {
          const s = ensureSession(sid)
          patchSession(sid, { ...(title && title !== s.title ? { title } : {}), ...(busy !== undefined ? { busy: busy as boolean } : {}) })
        }
        break
      }
      case 'session.title':
        if (sid && typeof p.title === 'string') patchSession(sid, { title: p.title })
        refreshSessionOrderSoon()
        break
      case 'session.usage':
        if (sid) {
          ensureSession(sid)
          patchSession(sid, {
            usage: {
              inputTokens: numOrUndef(p.input_tokens) ?? numOrUndef(p.tokens_in),
              outputTokens: numOrUndef(p.output_tokens) ?? numOrUndef(p.tokens_out),
              costUsd: numOrUndef(p.cost_usd) ?? numOrUndef(p.cost),
            },
          })
        }
        break
      case 'session.reclaimed':
        if (sid) patchSession(sid, { busy: false })
        break
      case 'message.start':
      case 'message.interim': {
        if (!sid) break
        const role = (typeof p.role === 'string' ? p.role : 'assistant') as 'user' | 'assistant'
        const text = typeof p.text === 'string' ? p.text : ''
        if (role === 'user') {
          if (!p.echo) break // user messages are added locally on submit
          upsertMessage(sid, 'user', { kind: 'text', text })
        } else {
          const s = ensureSession(sid)
          const hasOpen = s.messages.some((m) => m.streaming)
          if (!hasOpen && text) upsertMessage(sid, 'assistant', { kind: 'text', text, startedAt: Date.now() }, { streaming: true, id: typeof p.id === 'string' ? p.id : undefined })
        }
        break
      }
      case 'message.delta':
        if (sid && typeof p.text === 'string') appendToLast(sid, 'text', p.text)
        break
      case 'reasoning.delta':
        // thinking.delta is deliberately ignored: it carries fluffy status
        // lines ("ruminating...") — the real content is reasoning.delta.
        if (sid) {
          const text = typeof p.text === 'string' ? p.text : typeof p.delta === 'string' ? p.delta : ''
          if (text) appendToLast(sid, 'reasoning', text)
        }
        break
      case 'message.complete': {
        if (!sid) break
        const s = sessionsById.get()[sid]
        if (!s) break
        const messages = s.messages.slice()
        const id = typeof p.id === 'string' ? p.id : undefined
        const byId = id ? messages.findIndex((m) => m.id === id) : -1
        const target = byId >= 0 ? byId : findLastIdx(messages, (m) => !!m.streaming)
        if (target >= 0) {
          const segs = messages[target].segments.slice()
          // Final text: replace the last text segment (the canonical full text
          // supersedes the streamed fragments), or append if none streamed.
          if (typeof p.text === 'string' && p.text) {
            const lastText = findLastIdx(segs, (sg) => sg.kind === 'text')
            if (lastText >= 0) segs[lastText] = { ...segs[lastText], text: p.text }
            else segs.push({ kind: 'text', text: p.text })
          }
          // Interleaved reasoning segments are kept exactly as streamed.
          messages[target] = { ...messages[target], segments: segs, streaming: false, done: true, ...(id ? { id } : {}) }
        }
        patchSession(sid, { messages })
        finishStreaming(sid)
        refreshSessionOrderSoon()
        break
      }
      case 'tool.start':
        if (sid) handleToolEvent(sid, p, 'start')
        break
      case 'tool.complete':
        if (sid) handleToolEvent(sid, p, 'complete')
        break
      case 'todo.updated': {
        if (!sid) break
        const items = Array.isArray(p.todos) ? (p.todos as TodoItem[]) : []
        patchSession(sid, { todos: items })
        break
      }
      case 'notice': {
        if (!sid) break
        const text = typeof p.text === 'string' ? p.text : JSON.stringify(p)
        upsertMessage(sid, 'system', { kind: 'text', text })
        break
      }
      case 'error': {
        if (!sid) break
        const text = typeof p.message === 'string' ? p.message : typeof p.error === 'string' ? p.error : JSON.stringify(p)
        upsertMessage(sid, 'system', { kind: 'text', text: `⚠ ${text}` })
        patchSession(sid, { busy: false })
        break
      }
      case 'status.update':
        if (sid && typeof p.text === 'string') patchSession(sid, { busy: true })
        break
      case 'request.cancel': {
        // The backend withdrew an interactive request (e.g. approval timeout).
        const reqId = typeof p.request_id === 'string' ? p.request_id : undefined
        if (reqId) cancelPending(reqId)
        break
      }
      default:
        break
    }
  })

  const stopReq = onServerRequest((req) => {
    if (!['approval', 'clarify', 'sudo', 'secret', 'vault', 'vault_unlock', 'approval.request', 'clarify.request'].includes(req.method)) return false
    intakeServerRequest(req)
    return true
  })

  return () => { stop(); stopReq() }
}

function findLastIdx<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i
  return -1
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ── interactive requests (cards) ───────────────────────────────────────────

function intakeServerRequest(req: ServerRequest): void {
  const p = req.params as Record<string, unknown>
  const kind: PendingCard['kind'] =
    req.method === 'approval' ? 'approval'
      : req.method === 'clarify' ? 'clarify'
        : req.method === 'sudo' ? 'sudo'
          : req.method === 'secret' ? 'secret'
            : req.method.startsWith('vault') ? 'vault'
              : 'secret'
  // v7 shapes (mirrors the phone's intake exactly):
  //   approval: {command, description, choices, allow_permanent, allow_session, tool_name}
  //   clarify:  {question, choices} OR {questions: [{qid, question, choices, multi_select}]}
  //   sudo/secret: {prompt/title-ish fields}
  const plainChoices = Array.isArray(p.choices) ? p.choices.map(String).slice(0, 12) : undefined
  const questions = Array.isArray(p.questions)
    ? (p.questions as Array<Record<string, unknown>>).map((q) => ({
      qid: String(q.qid ?? ''),
      question: typeof q.question === 'string' ? q.question.slice(0, 1000) : undefined,
      choices: Array.isArray(q.choices) ? q.choices.map(String).slice(0, 12) : undefined,
    }))
    : undefined
  const card: PendingCard = {
    id: req.id,
    kind,
    sessionId: req.sessionId,
    title: kind === 'approval'
      ? 'Needs your approval'
      : kind === 'clarify' ? 'Agent asks'
        : kind === 'sudo' ? 'Sudo password needed'
          : kind === 'secret' ? 'A secret is needed' : 'Vault',
    body: typeof p.question === 'string' ? p.question
      : typeof p.command === 'string' ? p.command
        : typeof p.description === 'string' ? p.description
          : typeof p.body === 'string' ? p.body : undefined,
    command: typeof p.command === 'string' ? p.command.slice(0, 800) : undefined,
    options: plainChoices?.map((c) => ({ label: c, value: c })),
    questions,
    allowPermanent: p.allow_permanent === true,
    allowSession: p.allow_session === true,
    danger: kind === 'sudo' || p.danger === true,
    raw: req,
  }
  const sid = card.sessionId ?? activeSession.get()
  const map = { ...pendingBySession.get() }
  // One card per session at a time (the protocol re-delivers on reconnect).
  if (sid) {
    map[sid] = card
    pendingBySession.set(map)
  }
}

export function cancelPending(reqId: string): void {
  const map = pendingBySession.get()
  for (const [sid, card] of Object.entries(map)) {
    if (card.id === reqId) {
      const next = { ...map }
      delete next[sid]
      pendingBySession.set(next)
      return
    }
  }
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/**
 * Answer an interactive card with the v7 wire shapes (the phone's contract):
 *   approval → { choice, all? }            choice ∈ once|session|always|deny
 *   clarify  → { answer }  (single) or { answers: {qid: text} }  (batch)
 *   sudo/secret → { value } to allow, {} to deny
 */
export async function answerCard(
  card: PendingCard,
  answer: { choice?: ApprovalChoice; value?: string; batch?: Record<string, string>; editedText?: string },
): Promise<void> {
  let payload: Record<string, unknown> = {}
  if (card.kind === 'approval') {
    payload = { choice: answer.choice ?? 'deny', ...(answer.choice === 'always' ? { all: true } : {}) }
  } else if (card.kind === 'clarify') {
    if (answer.batch && Object.keys(answer.batch).length) payload = { answers: answer.batch }
    else payload = { answer: (answer.value ?? '').slice(0, 4000) }
  } else if (card.kind === 'sudo' || card.kind === 'secret' || card.kind === 'vault') {
    payload = answer.value !== undefined && answer.value !== '' ? { value: answer.value } : {}
  }
  if (answer.editedText !== undefined) payload.edited = answer.editedText
  card.raw.respond(payload)
  const map = { ...pendingBySession.get() }
  delete map[card.sessionId ?? '']
  pendingBySession.set(map)
}

// ── session lifecycle ───────────────────────────────────────────────────────

/** THE active-bot atom (owned by fleet.ts; chat reads it for scoping). */
export const activeBot = activeBotAtom

export async function newChat(title?: string): Promise<string> {
  const bot = activeBot.get()
  const params: Record<string, unknown> = {
    cols: 120,
    source: 'desktop',
  }
  // Anchor the session to the workspace (the phone does the same): hermes
  // treats an explicit existing dir as the persistent session workspace, so
  // terminal/files tools operate in ~/Moch, not wherever the gateway runs.
  const ws = workspaceDir.get()
  if (ws) params.cwd = ws
  if (title) params.title = title
  if (bot) {
    params.profile = bot
    if (!title) params.title = `Bot · ${bot}`
  }
  const res = await rpc<{ session_id?: string; id?: string; stored_session_id?: string; stored_id?: string }>('session.create', params)
  const liveId = String(res.session_id ?? res.id ?? '')
  if (!liveId) throw new Error('gateway returned no session id')
  ensureSession(liveId)
  if (bot) patchSession(liveId, { profile: bot })
  const stored = res.stored_session_id ?? res.stored_id
  if (stored) bindIds(liveId, String(stored))
  activeSession.set(liveId)
  refreshSessionOrderSoon()
  return liveId
}

export async function send(text: string, opts: { steer?: boolean } = {}): Promise<void> {
  let sid = activeSession.get()
  // No open thread: the message lands in the active bot's home thread, the
  // same place a rail pick would go (unsent new chats are local-only).
  if (!sid && !opts.steer) {
    try {
      sid = await openHomeThread(activeBot.get())
    } catch (err) {
      console.warn('[chat] could not open the home thread for send', err)
      return
    }
  }
  if (!sid) return
  // Local echo (the gateway does not echo the user's own message back).
  const s = sessionsById.get()[sid]
  if (s && !opts.steer) {
    const messages = s.messages.slice()
    messages.push({ id: `u${Date.now()}`, role: 'user', segments: [{ kind: 'text', text }], createdAt: Date.now() })
    patchSession(sid, { messages })
  }
  patchSession(sid, { busy: true })
  await rpc('prompt.submit', {
    session_id: sid,
    text,
    // queued: a message sent while the bot's intro, routine, or live turn is
    // running waits and is answered after it — the gateway's default mid-turn
    // path redirects the text into the live turn instead.
    ...(opts.steer ? { steer: true } : { queued: true }),
  })
}

export async function interrupt(): Promise<void> {
  const sid = activeSession.get()
  if (!sid) return
  await rpc('session.interrupt', { session_id: sid })
  patchSession(sid, { busy: false })
}

export async function steer(text: string): Promise<void> {
  const sid = activeSession.get()
  if (!sid) return
  await rpc('session.steer', { session_id: sid, text })
}

/**
 * Open (and resume) a stored session id. `profile` scopes the resume to the
 * bot's own store — a bot's stored ids only resolve under its profile — and
 * keeps the session tagged; without it the launch store is used (the default
 * agent). Wherever a session becomes active, the active bot follows it, so
 * the rail and the thread header always name the thread that is open.
 */
export async function switchToSession(storedId: string, opts: { profile?: string | null } = {}): Promise<string> {
  const live = liveIdForStored(storedId)
  if (live && sessionsById.get()[live]) {
    activeSession.set(live)
    const want = sessionsById.get()[live].profile ?? null
    if (activeBotAtom.get() !== want) await setActiveBot(want)
    return live
  }
  const res = await rpc<{ session_id?: string; messages?: unknown[]; history?: unknown[]; info?: Record<string, unknown> }>('session.resume', {
    session_id: storedId,
    ...(opts.profile ? { profile: opts.profile } : {}),
  })
  const liveId = String(res.session_id ?? storedId)
  ensureSession(liveId)
  bindIds(liveId, storedId)
  applyHistory(liveId, res.messages ?? res.history)
  const info = res.info ?? {}
  const wireName = typeof info.profile_name === 'string' ? info.profile_name : ''
  const profile = opts.profile !== undefined
    ? opts.profile
    : wireName && wireName !== 'default' ? wireName : null
  if (profile) patchSession(liveId, { profile })
  activeSession.set(liveId)
  const want = profile ?? null
  if (activeBotAtom.get() !== want) await setActiveBot(want)
  return liveId
}

/** One of a bot's stored sessions, newest first (session.list is profile-scoped). */
export interface BotSessionRow {
  id: string
  title: string
  startedAt: number
  messageCount: number
}

export async function listBotSessions(profile: string | null): Promise<BotSessionRow[]> {
  const res = await rpc<{ sessions?: Record<string, unknown>[] }>('session.list', {
    limit: 30,
    ...(profile ? { profile } : {}),
  })
  const rows = (res.sessions ?? [])
    .map((r) => ({
      id: String(r.id ?? r.session_id ?? ''),
      title: typeof r.title === 'string' ? r.title : '',
      startedAt: numOrUndef(r.started_at) ?? 0,
      messageCount: numOrUndef(r.message_count) ?? 0,
    }))
    .filter((r) => r.id)
  rows.sort((a, b) => b.startedAt - a.startedAt)
  return rows
}

/**
 * Open the bot's one home thread: the bound stored id when it resumes, the
 * profile's most recent stored session when no binding exists yet (bots from
 * before the binding), or a fresh session on first selection. Keyed per
 * profile, so it can never land in another bot's session. Single-flight per
 * profile: a double boot (React StrictMode) or a double click must not mint
 * two home sessions for one bot.
 */
const openingHome = new Map<string, Promise<string | null>>()

export function openHomeThread(profile: string | null): Promise<string | null> {
  const key = profile ?? ''
  const inflight = openingHome.get(key)
  if (inflight) return inflight
  const run = resolveHomeThread(profile).finally(() => openingHome.delete(key))
  openingHome.set(key, run)
  return run
}

async function resolveHomeThread(profile: string | null): Promise<string | null> {
  if (activeBotAtom.get() !== profile) await setActiveBot(profile)
  const bound = homeThreadFor(profile)
  if (bound) {
    const live = liveIdForStored(bound)
    if (live && sessionsById.get()[live]) {
      activeSession.set(live)
      return live
    }
    try {
      await switchToSession(bound, { profile })
      return activeSession.get()
    } catch {
      // the bound id no longer resumes (deleted, or a draft that never
      // persisted): fall through and rebind
    }
  }
  const others = await listBotSessions(profile).catch(() => [])
  const latest = others.find((r) => r.id !== bound)
  if (latest) {
    try {
      await switchToSession(latest.id, { profile })
      setHomeThread(profile, latest.id)
      return activeSession.get()
    } catch { /* fall through to a fresh home */ }
  }
  const liveId = await newChat()
  const stored = storedIdFor(liveId)
  if (stored) setHomeThread(profile, stored)
  return liveId
}

/** A new session beside the bot's home thread. The home binding is untouched. */
export async function startSideChat(profile: string | null): Promise<string> {
  if (activeBotAtom.get() !== profile) await setActiveBot(profile)
  return newChat()
}

function applyHistory(liveId: string, history: unknown | undefined): void {
  if (!Array.isArray(history)) return
  const messages: ChatMessage[] = []
  for (const row of history as Record<string, unknown>[]) {
    const role = row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : 'system'
    if (role === 'system' && typeof row.text !== 'string') continue
    const segs: ChatSegment[] = []
    if (typeof row.reasoning === 'string' && row.reasoning) segs.push({ kind: 'reasoning', text: row.reasoning })
    if (typeof row.thinking === 'string' && row.thinking) segs.push({ kind: 'thinking', text: row.thinking })
    if (typeof row.text === 'string' && row.text) segs.push({ kind: 'text', text: row.text })
    else if (typeof row.content === 'string' && row.content) segs.push({ kind: 'text', text: row.content })
    if (!segs.length) continue
    messages.push({
      id: String(row.id ?? `h${messages.length}`),
      role,
      segments: segs,
      done: true,
      createdAt: numOrUndef(row.ts) ?? numOrUndef(row.timestamp) ?? Date.now(),
    })
  }
  patchSession(liveId, { messages })
}

// ── sidebar list ────────────────────────────────────────────────────────────

let orderTimer: ReturnType<typeof setTimeout> | null = null
function refreshSessionOrderSoon(): void {
  if (orderTimer) return
  orderTimer = setTimeout(() => {
    orderTimer = null
    void refreshSessionOrder().catch(() => {})
  }, 800)
}

export async function refreshSessionOrder(): Promise<void> {
  try {
    const res = await rpc<{ sessions?: Record<string, unknown>[] }>('session.list', { limit: 200 })
    const rows = (res.sessions ?? []).map((r) => ({
      id: String(r.id ?? r.session_id ?? ''),
      title: String(r.title ?? 'Untitled'),
      lastActive: numOrUndef(r.last_active ?? r.updated_at ?? r.started_at ?? r.ts) ?? 0,
      profile: typeof r.profile === 'string' ? r.profile : undefined,
    }))
    rows.sort((a, b) => b.lastActive - a.lastActive)
    sessionOrder.set(rows)
  } catch {
    /* offline — keep the last list */
  }
}

export async function deleteSession(storedId: string): Promise<void> {
  await rpc('session.delete', { session_id: storedId })
  liveByStored.delete(storedId)
  sessionOrder.set(sessionOrder.get().filter((r) => r.id !== storedId))
}

export async function renameSession(storedId: string, title: string): Promise<void> {
  await rpc('session.title', { session_id: storedId, title })
  sessionOrder.set(sessionOrder.get().map((r) => (r.id === storedId ? { ...r, title } : r)))
}

// Local marks (pin/archive) — same idea as the phone, desktop-local.
export interface LocalMarks { pinned: string[]; archived: string[] }
const MARKS_KEY = 'moch.desktop.sessionMarks.v1'
export const sessionMarks = atom<LocalMarks>({ pinned: [], archived: [] })

export function loadMarks(): void {
  try {
    const raw = localStorage.getItem(MARKS_KEY)
    if (raw) sessionMarks.set(JSON.parse(raw) as LocalMarks)
  } catch { /* fresh */ }
}
export function toggleMark(kind: 'pinned' | 'archived', id: string): void {
  const marks = { ...sessionMarks.get() }
  const list = marks[kind]
  marks[kind] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
  sessionMarks.set(marks)
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(marks)) } catch { /* ok */ }
}

/** Progressive phase label for the current turn (drives "Mochi ● Editing"). */
export function phaseForTools(tools: ToolItem[]): string {
  const last = tools.length ? tools[tools.length - 1] : null
  if (!last) return 'Thinking'
  const n = last.name.toLowerCase()
  if (/patch|edit|write_file|apply/.test(n)) return 'Editing'
  if (/terminal|bash|exec/.test(n)) return 'Running commands'
  if (/browser/.test(n)) return 'Browsing'
  if (/read|search|glob/.test(n)) return 'Researching'
  if (/skill/.test(n)) return 'Loading skills'
  if (last.status === 'error') return 'Recovering'
  return 'Working'
}

/** Debug handle: `__mochChat()` in the console shows session internals. */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __mochChat?: () => unknown }).__mochChat = () => ({
    sessions: Object.fromEntries(Object.entries(sessionsById.get()).map(([k, v]) => [k, {
      tools: v.tools.map((t) => ({ name: t.name, id: t.id, editPath: t.editPath, add: t.add, del: t.del, hasArgsRaw: t.argsRaw !== undefined })),
      msgCount: v.messages.length,
      userCount: v.messages.filter((m) => m.role === 'user').length,
    }])),
    changed: [...changedFiles.get().entries()],
    order: changedOrder.get(),
  })
}
