/**
 * Global ask-card overlay for server→client requests (approval / clarify /
 * batch clarify / sudo / secret) — answers over the same socket.
 *
 * Why a module-level store: the `client.onRequest` subscription lives in App,
 * the owner of the ONE persistent gateway client, so pending asks must outlive
 * ChatTab's conditional mount — a question arriving while the user browses
 * another tab used to be auto-declined -32601 by the channel. The store is a
 * tiny external store (subscribe / getSnapshot / notify) consumed through
 * useSyncExternalStore; App renders <AsksOverlay /> once and it is visible on
 * EVERY tab, whatever tab the user is on.
 *
 * Respond payloads mirror the phone exactly (app/src/lib/chat.ts):
 *   approval       { choice, all: undefined }          respondApproval  (2200)
 *   clarify        { answer }                          respondClarify   (2211)
 *   batch clarify  { answers: {qid: text} }            respondClarifyBatch (2220)
 *                  — a result without "answers" is a cancel-all (server.py:1331)
 *   sudo / secret  allow → { value }, deny → {}        respondPrivileged (2230)
 * Withdrawn questions arrive as `request.cancel` events with payload
 * {id, method, reason} (server_requests.py:126); App maps them to removeAsk()
 * so a settled id can never be answered late.
 */
import { useState, useSyncExternalStore } from 'react'
import { IconLock } from './Icons'

export type AskKind = 'approval' | 'clarify' | 'batch_clarify' | 'sudo' | 'secret'

/** One pending server→client request with its reply closures (channel ServerRequest half). */
export type Ask = {
  id: string
  kind: AskKind
  session_id: string
  params: Record<string, unknown>
  /** Answer with a JSON-RPC response frame carrying the same `srq-…` id (idempotent). */
  respond: (result: Record<string, unknown>) => void
  /** Answer with a JSON-RPC error — the backend treats the request as unanswered. */
  fail: (code: number, message: string) => void
}

// ── External store (module singleton — survives any tab unmount) ────────────

let asks: Ask[] = []
const listeners = new Set<() => void>()

const notifyAsks = () => { for (const l of [...listeners]) l() }

export const subscribeAsks = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Snapshot array is swapped on change, never mutated — stable for useSyncExternalStore. */
export const getAsks = (): Ask[] => asks

/** File a request (live frame or reconnect replay); a duplicate id is a no-op. */
export const addAsk = (ask: Ask): void => {
  if (asks.some((a) => a.id === ask.id)) return
  asks = [...asks, ask]
  notifyAsks()
}

/** Retire a card — answered, or withdrawn by the backend (request.cancel). */
export const removeAsk = (id: string): void => {
  if (!asks.some((a) => a.id === id)) return
  asks = asks.filter((a) => a.id !== id)
  notifyAsks()
}

const answerAsk = (ask: Ask, result: Record<string, unknown>) => {
  ask.respond(result)
  removeAsk(ask.id)
}

/** Same semantics as the retired ChatTab cancel: fail -32601, drop the card. */
const cancelAsk = (ask: Ask) => {
  ask.fail(-32601, `${ask.kind === 'batch_clarify' ? 'clarify' : ask.kind} cancelled by user`)
  removeAsk(ask.id)
}

// ── Params helpers (phone normalization, chat.ts:2263-2339) ─────────────────

const strParam = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

const choiceList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).slice(0, 12) : [])

type BatchQuestion = { qid: string; question: string; choices: string[] }

/** clarify batch entries, normalized the phone's way (chat.ts:2297-2304). */
const batchQuestions = (p: Record<string, unknown>): BatchQuestion[] =>
  (Array.isArray(p.questions) ? p.questions : [])
    .filter((q) => !!q && typeof q === 'object')
    .map((q) => {
      const e = q as Record<string, unknown>
      return {
        qid: String(e.qid ?? ''),
        question: typeof e.question === 'string' ? e.question.slice(0, 1000) : '',
        choices: choiceList(e.choices),
      }
    })

const bodyStyle = {
  fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.85,
  maxHeight: 140, overflow: 'auto',
} as const

// ── Card (visual language of the retired ChatTab AskCard, on a solid surface) ─

function AskCard({ ask }: { ask: Ask }) {
  const [text, setText] = useState('')
  const [batch, setBatch] = useState<Record<string, string>>({})
  const p = ask.params ?? {}
  const sidLabel = ask.session_id ? `session ${ask.session_id.slice(0, 12)}` : ''

  const title =
    ask.kind === 'approval'
      ? strParam(p.tool_name, 200) || 'Approval needed'
      : ask.kind === 'sudo'
        ? 'Sudo requested'
        : ask.kind === 'secret'
          ? 'Secret requested'
          : 'Mochi needs you'

  const approvalChoices = ask.kind === 'approval' ? choiceList(p.choices) : []
  const questions = ask.kind === 'batch_clarify' ? batchQuestions(p) : []
  const allAnswered = questions.length > 0 && questions.every((q) => (batch[q.qid] ?? '').trim() !== '')

  return (
    <div
      style={{
        borderRadius: 14, padding: '10px 12px',
        border: '1px solid rgba(255,176,32,.45)', background: 'var(--bg-card, #151220)',
        boxShadow: '0 10px 32px rgba(0,0,0,.5)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconLock width={12} height={12} />
        <span>{title}</span>
        {sidLabel && (
          <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 10, opacity: 0.55 }}>{sidLabel}</span>
        )}
      </div>

      {ask.kind === 'approval' && (
        <>
          <div style={bodyStyle}>
            {strParam(p.command, 800) || strParam(p.description, 800) || 'The agent wants to run a command.'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="tool-chip-btn"
              style={{ background: 'rgba(48,164,108,.9)', color: '#fff', border: 'none' }}
              onClick={() => answerAsk(ask, { choice: 'once', all: undefined })}
            >
              Approve
            </button>
            {approvalChoices.includes('session') && (
              <button className="tool-chip-btn" onClick={() => answerAsk(ask, { choice: 'session', all: undefined })}>
                This session
              </button>
            )}
            {approvalChoices.includes('always') && (
              <button className="tool-chip-btn" onClick={() => answerAsk(ask, { choice: 'always', all: undefined })}>
                Always allow
              </button>
            )}
            <button
              className="tool-chip-btn"
              style={{ color: '#e5484d' }}
              onClick={() => answerAsk(ask, { choice: 'deny', all: undefined })}
            >
              Deny
            </button>
          </div>
        </>
      )}

      {ask.kind === 'clarify' && (
        <>
          <div style={bodyStyle}>{strParam(p.question, 1000) || 'Clarification needed'}</div>
          {choiceList(p.choices).map((o) => (
            <button
              key={o}
              className="tool-chip-btn"
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => answerAsk(ask, { answer: o })}
            >
              {o}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              className="composer-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Or type your answer…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const t = text.trim().slice(0, 4000)
                  if (t) { setText(''); answerAsk(ask, { answer: t }) }
                }
              }}
            />
            <button
              className="tool-chip-btn"
              disabled={!text.trim()}
              style={{ opacity: text.trim() ? 1 : 0.5 }}
              onClick={() => {
                const t = text.trim().slice(0, 4000)
                if (!t) return
                setText('')
                answerAsk(ask, { answer: t })
              }}
            >
              Send
            </button>
            <button className="tool-chip-btn" onClick={() => cancelAsk(ask)}>Cancel</button>
          </div>
        </>
      )}

      {ask.kind === 'batch_clarify' && (
        <>
          {questions.map((q, i) => (
            <div key={`${q.qid}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={bodyStyle}>{q.question || 'Clarification needed'}</div>
              {q.choices.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {q.choices.map((o) => (
                    <button
                      key={o}
                      className="tool-chip-btn"
                      style={batch[q.qid] === o ? { borderColor: 'rgba(255,176,32,.7)' } : undefined}
                      onClick={() => setBatch((b) => ({ ...b, [q.qid]: o }))}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <input
                type="text"
                className="composer-input"
                style={{ width: '100%' }}
                placeholder="Or type your answer…"
                value={batch[q.qid] ?? ''}
                onChange={(e) => setBatch((b) => ({ ...b, [q.qid]: e.target.value }))}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="tool-chip-btn"
              disabled={!allAnswered}
              style={{ opacity: allAnswered ? 1 : 0.5 }}
              onClick={() => {
                if (!allAnswered) return
                // EXACT batch shape: { answers: {qid: answerText} } — anything
                // else is a cancel-all (server.py:1331-1335).
                answerAsk(ask, {
                  answers: Object.fromEntries(
                    questions.map((q) => [q.qid, (batch[q.qid] ?? '').trim().slice(0, 4000)]),
                  ),
                })
              }}
            >
              Send answers
            </button>
            <button className="tool-chip-btn" onClick={() => cancelAsk(ask)}>Cancel</button>
          </div>
        </>
      )}

      {ask.kind === 'sudo' && (
        <>
          <div style={bodyStyle}>{strParam(p.command, 800) || 'Elevated access requested'}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="password"
              className="composer-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Sudo password…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text) {
                  e.preventDefault()
                  answerAsk(ask, { value: text })
                }
              }}
            />
            <button
              className="tool-chip-btn"
              disabled={!text}
              style={{ opacity: text ? 1 : 0.5, background: 'rgba(48,164,108,.9)', color: '#fff', border: 'none' }}
              onClick={() => { if (text) answerAsk(ask, { value: text }) }}
            >
              Allow once
            </button>
            <button
              className="tool-chip-btn"
              style={{ color: '#e5484d' }}
              onClick={() => answerAsk(ask, {})}
            >
              Deny
            </button>
          </div>
        </>
      )}

      {ask.kind === 'secret' && (
        <>
          <div style={bodyStyle}>{strParam(p.prompt, 500) || `Enter ${String(p.env_var ?? 'secret')}`}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="password"
              className="composer-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Value…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text) {
                  e.preventDefault()
                  answerAsk(ask, { value: text })
                }
              }}
            />
            <button
              className="tool-chip-btn"
              disabled={!text}
              style={{ opacity: text ? 1 : 0.5 }}
              onClick={() => { if (text) answerAsk(ask, { value: text }) }}
            >
              Provide
            </button>
            <button
              className="tool-chip-btn"
              style={{ color: '#e5484d' }}
              onClick={() => answerAsk(ask, {})}
            >
              Deny
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Fixed overlay — rendered by App once, visible on EVERY tab. */
export default function AsksOverlay() {
  const asks = useSyncExternalStore(subscribeAsks, getAsks)
  if (asks.length === 0) return null
  return (
    <div
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 200,
        display: 'flex', flexDirection: 'column', gap: 10,
        width: 'min(400px, calc(100vw - 32px))',
        maxHeight: 'calc(100vh - 96px)', overflowY: 'auto',
      }}
    >
      {asks.map((a) => <AskCard key={a.id} ask={a} />)}
    </div>
  )
}
