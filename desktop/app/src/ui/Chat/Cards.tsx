/**
 * Question cards for the desktop Chat surface: approval / clarify / sudo /
 * secret requests the agent blocks on. Answers go through the engine's
 * respond* helpers (each sends the JSON-RPC response frame keyed by the
 * srq-… id — there is no *.respond RPC). Includes the BUG-086 aggregate card
 * for questions from sessions this app isn't tracking (automation/CLI on the
 * host): same answer machinery, one expander.
 */
import { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import type { Dispatch, SetStateAction } from 'react'
import {
  pendingRequest,
  pendingUntracked,
  respondApproval,
  respondClarify,
  respondClarifyBatch,
  respondPrivileged,
  type PendingRequest,
} from '../../../../../app/src/lib/chat'
import { countUnanswered } from '../../../../../app/src/lib/clarifyGate'

type AnswerChoice = 'once' | 'session' | 'always' | 'deny'

const CHOICE_LABEL: Record<AnswerChoice, string> = {
  once: 'Allow',
  session: 'Always this chat',
  always: 'Always',
  deny: 'Deny',
}

/** The server's offered choice set, minus scopes it explicitly disabled. */
function approvalChoicesFor(r: PendingRequest): string[] {
  if (r.method !== 'approval') return []
  const offered = r.choices?.length ? r.choices : ['once', 'session', 'always', 'deny']
  return offered.filter((c) => {
    if (c === 'always' && r.allowPermanent === false) return false
    if (c === 'session' && r.allowSession === false) return false
    return true
  })
}

/** Shared composer-adjacent answer state; reset when the question set changes. */
interface CardState {
  answerText: string
  secretValue: string
  batchAnswers: Record<string, string>
  setAnswerText: Dispatch<SetStateAction<string>>
  setSecretValue: Dispatch<SetStateAction<string>>
  setBatchAnswers: Dispatch<SetStateAction<Record<string, string>>>
}

function QuestionCard({ r, cs }: { r: PendingRequest; cs: CardState }) {
  if (r.method === 'approval') {
    return (
      <div className="moch-card">
        <div className="moch-card__head moch-card__head--amber">
          Approval needed{r.replayed ? ' (restored)' : ''}
        </div>
        <div className="moch-card__scroll">
          {r.toolName ? <div className="moch-card__kicker">{r.toolName}</div> : null}
          <div className="moch-card__body">
            {r.command ?? r.description ?? 'The agent wants to run a command.'}
          </div>
          {r.description && r.description !== r.command ? (
            <div className="moch-card__desc">{r.description}</div>
          ) : null}
        </div>
        <div className="moch-card__row">
          {approvalChoicesFor(r).map((c) => (
            <button
              key={c}
              type="button"
              className={`moch-btn${c === 'deny' ? ' moch-btn--deny' : ''}`}
              onClick={() => void respondApproval(c as AnswerChoice, false, r)}
            >
              {CHOICE_LABEL[c as AnswerChoice] ?? c}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (r.method === 'clarify') {
    const batch = !!r.questions?.length
    const batchMissing = batch ? countUnanswered(r.questions ?? [], cs.batchAnswers) : 0
    return (
      <div className="moch-card">
        <div className="moch-card__head moch-card__head--accent">Mochi needs you</div>
        {batch ? (
          <>
            <div className="moch-card__scroll">
              {r.questions?.map((q) => (
                <div key={q.qid} className="moch-card__q">
                  <div className="moch-card__qtext">{q.question ?? q.qid}</div>
                  {q.choices?.length ? (
                    <div className="moch-card__options">
                      {q.choices.map((o) => (
                        <button
                          key={o}
                          type="button"
                          className={`moch-btn moch-btn--ghost${cs.batchAnswers[q.qid] === o ? ' moch-btn--on' : ''}`}
                          onClick={() => cs.setBatchAnswers((a) => ({ ...a, [q.qid]: o }))}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      className="moch-card__input"
                      value={cs.batchAnswers[q.qid] ?? ''}
                      onChange={(e) => cs.setBatchAnswers((a) => ({ ...a, [q.qid]: e.target.value }))}
                      placeholder="Your answer…"
                      aria-label={`Answer: ${q.question ?? 'the question'}`}
                    />
                  )}
                </div>
              ))}
            </div>
            {batchMissing > 0 ? (
              <div className="moch-card__hint">
                {batchMissing === 1
                  ? '1 question still needs an answer'
                  : `${batchMissing} questions still need answers`}
              </div>
            ) : null}
            <div className="moch-card__row">
              <button
                type="button"
                className={`moch-btn${batchMissing > 0 ? ' moch-btn--off' : ''}`}
                disabled={batchMissing > 0}
                onClick={() => {
                  if (batchMissing > 0) return
                  void respondClarifyBatch(cs.batchAnswers, r)
                }}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="moch-card__scroll">
              <div className="moch-card__body">{r.question ?? 'Clarification needed'}</div>
              {r.options?.length ? (
                <div className="moch-card__options">
                  {r.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="moch-btn moch-btn--ghost"
                      onClick={() => void respondClarify(o, r)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="moch-card__clarifyrow">
              <input
                className="moch-card__input"
                value={cs.answerText}
                onChange={(e) => cs.setAnswerText(e.target.value)}
                placeholder="Or type your answer…"
                aria-label="Clarification answer"
              />
              <button
                type="button"
                className="moch-btn moch-btn--mini"
                aria-label="Send clarification"
                onClick={() => {
                  const t = cs.answerText.trim()
                  if (!t) return
                  cs.setAnswerText('')
                  void respondClarify(t, r)
                }}
              >
                ↑
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  if (r.method === 'sudo' || r.method === 'secret') {
    return (
      <div className="moch-card">
        <div className="moch-card__head moch-card__head--red">
          {r.method === 'sudo' ? 'Sudo requested' : 'Secret requested'}
        </div>
        <div className="moch-card__scroll">
          <div className="moch-card__body">{r.prompt}</div>
        </div>
        <input
          className="moch-card__input"
          type="password"
          value={cs.secretValue}
          onChange={(e) => cs.setSecretValue(e.target.value)}
          placeholder={r.method === 'sudo' ? 'sudo password…' : `Value for ${r.envVar ?? 'secret'}…`}
          aria-label="Secret value"
        />
        <div className="moch-card__row">
          <button
            type="button"
            className="moch-btn"
            onClick={() => {
              const v = cs.secretValue
              cs.setSecretValue('')
              void respondPrivileged(true, v || undefined, r)
            }}
          >
            Send
          </button>
          <button
            type="button"
            className="moch-btn moch-btn--deny"
            onClick={() => {
              cs.setSecretValue('')
              void respondPrivileged(false, undefined, r)
            }}
          >
            Deny
          </button>
        </div>
      </div>
    )
  }

  return null
}

/** The question block docked above the composer: the active chat's question
 *  first, then the foreign aggregate card. */
export function QuestionCards() {
  const req = useStore(pendingRequest)
  const foreign = useStore(pendingUntracked)
  const [answerText, setAnswerText] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({})
  const [foreignOpen, setForeignOpen] = useState(false)

  // Reset the answer fields whenever the set of questions on screen changes.
  const questionKey = `${req?.id ?? ''}|${foreign.map((f) => f.id).join(',')}`
  useEffect(() => {
    setAnswerText('')
    setSecretValue('')
    setBatchAnswers({})
  }, [questionKey])

  const cs: CardState = {
    answerText,
    secretValue,
    batchAnswers,
    setAnswerText,
    setSecretValue,
    setBatchAnswers,
  }

  return (
    <>
      {req ? <QuestionCard r={req} cs={cs} /> : null}
      {foreign.length > 0 ? (
        <div className="moch-card">
          <button
            type="button"
            className="moch-card__foreignhead"
            onClick={() => setForeignOpen(!foreignOpen)}
            aria-expanded={foreignOpen}
          >
            <span>
              Questions from other sessions ({foreign.length})
            </span>
            <span className="moch-card__foreignchev" aria-hidden>
              {foreignOpen ? '▾' : '▸'}
            </span>
          </button>
          {foreignOpen ? (
            foreign.map((f) => <QuestionCard key={f.id} r={f} cs={cs} />)
          ) : (
            <div className="moch-card__foreignhint">
              The agent is blocked on a chat this window isn't showing. Expand to answer.
            </div>
          )}
        </div>
      ) : null}
    </>
  )
}
