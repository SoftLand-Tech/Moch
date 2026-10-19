/**
 * InteractiveCard — the ONE renderer for gateway questions (approval /
 * clarify / sudo / secret), used inline in chat and in the Inbox.
 * Wire shapes mirror the phone's v7 contract exactly:
 *   approval → {choice: once|session|always|deny, all?}
 *   clarify  → {answer} | {answers: {qid, text}}
 *   sudo/secret → {value} | {} (deny)
 */
import { useState } from 'react'
import { useStore } from '@nanostores/react'
import { GitBranch, LockKeyhole } from 'lucide-react'
import { answerCard, cardTitleKey, type PendingCard } from '../lib/chat'
import { locale, tr } from '../lib/strings'

export default function InteractiveCard({ card }: { card: PendingCard }) {
  const [value, setValue] = useState('')
  const [batch, setBatch] = useState<Record<string, string>>({})
  useStore(locale) // subscribe so every card string re-renders when the language changes
  const isPrivileged = card.kind === 'sudo' || card.kind === 'secret' || card.kind === 'vault'
  const singleQuestion = card.questions?.length === 1 ? card.questions[0] : null
  const choices = card.options ?? (singleQuestion?.choices?.map((c) => ({ label: c, value: c })) ?? undefined)
  const body = card.body ?? singleQuestion?.question

  const answerChoice = (text: string) => {
    if (card.kind === 'approval') {
      // The agent offered phrased choices — map by keyword, default 'once'.
      const t = text.toLowerCase()
      const choice = /always|every time/.test(t) ? 'always' : /session|for this chat/.test(t) ? 'session' : /no|deny|cancel|don't/.test(t) ? 'deny' : 'once'
      void answerCard(card, { choice })
      return
    }
    if (card.kind === 'clarify') {
      if (singleQuestion && singleQuestion.qid) {
        void answerCard(card, { batch: { [singleQuestion.qid]: text } })
      } else {
        void answerCard(card, { value: text })
      }
      return
    }
    void answerCard(card, { value: text })
  }

  const submitText = () => {
    if (!value.trim()) return
    if (card.kind === 'clarify' && singleQuestion?.qid) {
      void answerCard(card, { batch: { [singleQuestion.qid]: value.trim() } })
    } else {
      void answerCard(card, { value: value.trim() })
    }
  }

  return (
    <div className={`card${card.danger || isPrivileged ? ' danger' : ''}`}>
      <div className="card-title">
        {isPrivileged ? <LockKeyhole size={15} /> : <GitBranch size={15} />}
        {tr(cardTitleKey(card.kind))}
      </div>
      {body ? <div className="card-body mono">{body}</div> : null}
      {card.command && card.command !== body ? (
        <div className="card-body mono" style={{ color: 'var(--text)' }}>$ {card.command}</div>
      ) : null}

      {/* Batch clarify: every question gets its own row of choices. */}
      {card.questions && card.questions.length > 1 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
          {card.questions.map((q) => (
            <div key={q.qid}>
              {q.question ? <div className="card-body mono" style={{ marginBottom: 4 }}>{q.question}</div> : null}
              <div className="card-actions">
                {q.choices?.map((c) => (
                  <button
                    key={c}
                    className={`btn${batch[q.qid] === c ? ' primary' : ''}`}
                    onClick={() => setBatch((b) => ({ ...b, [q.qid]: c }))}
                  >{c}</button>
                ))}
                {!q.choices?.length ? (
                  <input
                    className="input card-input"
                    style={{ marginBottom: 0 }}
                    placeholder={tr('card.answer.placeholder')}
                    value={batch[q.qid] ?? ''}
                    onChange={(e) => setBatch((b) => ({ ...b, [q.qid]: e.target.value }))}
                  />
                ) : null}
              </div>
            </div>
          ))}
          <button
            className="btn primary"
            disabled={card.questions.some((q) => !batch[q.qid])}
            onClick={() => void answerCard(card, { batch })}
          >{tr('card.answer.all')}</button>
        </div>
      ) : null}

      {/* Single question / approval / privileged. */}
      {!(card.questions && card.questions.length > 1) ? (
        <>
          {isPrivileged ? (
            <input
              className="input card-input"
              type={card.kind === 'sudo' ? 'password' : 'text'}
              placeholder={card.kind === 'sudo' ? tr('card.sudo.placeholder') : tr('card.secret.placeholder')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : !choices?.length ? (
            <input
              className="input card-input"
              placeholder={tr('card.answer.placeholder')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitText()}
            />
          ) : null}
          <div className="card-actions">
            {choices?.length ? choices.map((o) => (
              <button key={o.value} className="btn" onClick={() => answerChoice(o.value)}>{o.label}</button>
            )) : null}
            {isPrivileged ? (
              <>
                <button className="btn primary" disabled={!value} onClick={() => void answerCard(card, { value })}>{tr('card.allow')}</button>
                <button className="btn danger" onClick={() => void answerCard(card, {})}>{tr('card.deny')}</button>
              </>
            ) : !choices?.length ? (
              <button className="btn primary" disabled={!value.trim()} onClick={submitText}>{tr('card.answer')}</button>
            ) : null}
            {/* Approval without offered choices: the canonical verbs. */}
            {card.kind === 'approval' && !choices?.length ? (
              <>
                <button className="btn primary" onClick={() => void answerCard(card, { choice: 'once' })}>{tr('card.approve')}</button>
                {card.allowSession ? <button className="btn" onClick={() => void answerCard(card, { choice: 'session' })}>{tr('card.approve.session')}</button> : null}
                {card.allowPermanent ? <button className="btn" onClick={() => void answerCard(card, { choice: 'always' })}>{tr('card.approve.always')}</button> : null}
                <button className="btn danger" onClick={() => void answerCard(card, { choice: 'deny' })}>{tr('card.deny')}</button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
