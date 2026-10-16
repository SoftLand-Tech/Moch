/** History — the full session list (the chat sidebar's bigger sibling). */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { MessageSquareText, Search, Trash2 } from 'lucide-react'
import { deleteSession, sessionOrder, sessionsById, switchToSession } from '../lib/chat'
import type { ViewId } from '../app'

export default function HistoryView({ onOpen }: { onOpen?: (v: ViewId) => void }) {
  void onOpen
  const order = useStore(sessionOrder)
  const byId = useStore(sessionsById)
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return order.filter((r) => !n || r.title.toLowerCase().includes(n))
  }, [order, q])

  return (
    <main className="focus">
      <div className="focus-head">
        <span style={{ fontWeight: 650 }}>History</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{order.length} conversations</span>
        <div style={{ flex: 1 }} />
        <div className="ctx-search" style={{ margin: 0, width: 240 }}>
          <Search size={13} />
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="focus-body" style={{ padding: '10px max(24px, 6%)' }}>
        {rows.map((r) => (
          <div key={r.id} className="row" onClick={() => { void switchToSession(r.id); onOpen?.('chat') }}>
            <MessageSquareText size={14} color="var(--text-faint)" />
            <span className="row-title">{r.title}</span>
            <span className="row-sub">{byId[r.id]?.storedId === r.id ? 'open' : ''}</span>
            <button
              className="msg-action"
              title="Delete chat"
              onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${r.title}"?`)) void deleteSession(r.id) }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {rows.length === 0 ? <div className="empty"><div className="empty-sub">Nothing matches.</div></div> : null}
      </div>
    </main>
  )
}
