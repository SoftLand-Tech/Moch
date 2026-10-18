import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef } from 'react'
import { Inbox } from 'lucide-react'
import {
  cardTitleKey, pendingBySession, pendingCount, sessionsById, sessionOrder,
  type PendingCard,
} from '../lib/chat'
import { tr } from '../lib/strings'
import { accentFor } from '../lib/fleet'
import { displayBotName } from '../lib/crew'
import InteractiveCard from '../components/InteractiveCard'

const KIND_LABEL: Record<PendingCard['kind'], string> = {
  approval: 'Approval',
  clarify: 'Question',
  sudo: 'Sudo',
  secret: 'Secret',
  vault: 'Vault',
}

/** Which bot + session a pending card belongs to. */
function cardMeta(
  card: PendingCard,
  byId: Record<string, { title?: string; storedId?: string; profile?: string }>,
  order: { id: string; title: string; profile?: string }[],
): { bot: string; sessionTitle: string } {
  const sid = card.sessionId ?? ''
  const live = byId[sid]
  const storedId = live?.storedId
  const stored = storedId ? order.find((r) => r.id === storedId) : order.find((r) => r.id === sid)
  const profile = live?.profile ?? stored?.profile ?? 'default'
  const sessionTitle = live?.title ?? stored?.title ?? 'Session'
  return { bot: profile, sessionTitle }
}

export default function InboxView() {
  const pending = useStore(pendingBySession)
  const count = useStore(pendingCount)
  const byId = useStore(sessionsById)
  const order = useStore(sessionOrder)

  const cards = useMemo(
    () => Object.values(pending).filter((c) => !c.cancelled),
    [pending],
  )

  // A card arriving while nothing was pending earns a desktop notification
  // (only if the OS already granted Moch permission).
  const prevCount = useRef(count)
  useEffect(() => {
    const before = prevCount.current
    prevCount.current = count
    if (before !== 0 || count === 0) return
    void (async () => {
      try {
        const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
        if (!(await isPermissionGranted())) return
        const first = Object.values(pendingBySession.get()).find((c) => !c.cancelled)
        sendNotification({
          title: 'A bot is waiting on you',
          body: first ? tr(cardTitleKey(first.kind)) : 'Open Moch to respond.',
        })
      } catch {
        /* notifications unavailable in this shell — the badge still shows */
      }
    })()
  }, [count])

  return (
    <main className="focus">
      <div className="focus-head">
        <span style={{ fontWeight: 650, fontSize: 15 }}>Waiting on you</span>
        {count > 0 ? (
          <span className="chip active" style={{ cursor: 'default', padding: '2px 10px' }}>
            {count} open
          </span>
        ) : null}
      </div>
      <div className="focus-body">
        <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', padding: '20px 24px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {cards.length === 0 ? (
            <div className="empty" style={{ padding: '90px 20px' }}>
              <Inbox size={30} color="var(--text-faint)" />
              <div className="empty-title">Nothing needs you</div>
              <div className="empty-sub" style={{ maxWidth: 420 }}>
                Approvals, questions and sudo requests from any bot land here
                the moment they ask. Mochi keeps working until one shows up.
              </div>
            </div>
          ) : (
            cards.map((card) => {
              const { bot, sessionTitle } = cardMeta(card, byId, order)
              return <InboxCard key={card.id} card={card} bot={bot} sessionTitle={sessionTitle} />
            })
          )}
        </div>
      </div>
    </main>
  )
}

/** Same card visual as the chat transcript, plus who is asking. */
function InboxCard({ card, bot, sessionTitle }: { card: PendingCard; bot: string; sessionTitle: string }) {
  return (
    <div className={`card${card.danger ? ' danger' : ''}`} style={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 0' }}>
        <span className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: accentFor(bot) }}>
          {displayBotName(bot).slice(0, 2)}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: accentFor(bot), whiteSpace: 'nowrap' }}>
          {displayBotName(bot)}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
          {sessionTitle}
        </span>
        <span className="chip" style={{ cursor: 'default', padding: '2px 9px', flexShrink: 0 }}>{KIND_LABEL[card.kind]}</span>
      </div>
      <InteractiveCard card={card} />
    </div>
  )
}
