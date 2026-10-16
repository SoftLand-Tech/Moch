/** Sessions surface — full-width conversation table over the shared
 * session list stores. Styling rides the shell's shared `mos-*` kit. */
import React, { useCallback } from 'react'
import { useStore } from '@nanostores/react'
import {
  sessionListError,
  sessionListLoading,
  sessionRows,
  loadSessions,
} from '../../../../../app/src/lib/sessionList'
import { openSession } from '../../core/openSession'
import { setShellLayout } from '../shell/state'
import { IconMoch } from '../shell/icons'
import { newChat } from '../../../../../app/src/lib/chat'
import { messageCountText } from '../../../../../app/src/lib/sessionRowMeta'

/** Relative "last touched" from the row's unix-seconds start stamp. */
function when(sec?: number): string {
  if (!sec) return '—'
  const age = Date.now() / 1000 - sec
  if (age < 60) return 'just now'
  if (age < 3_600) return `${Math.floor(age / 60)}m ago`
  if (age < 86_400) return `${Math.floor(age / 3_600)}h ago`
  return `${Math.floor(age / 86_400)}d ago`
}

export default function Sessions(): React.JSX.Element {
  const rows = useStore(sessionRows)
  const loading = useStore(sessionListLoading)
  const error = useStore(sessionListError)
  const refresh = useCallback(() => void loadSessions(), [])
  return (
    <div className="mos-root">
      <header className="mos-head">
        <h2>Chats</h2>
        <span className="mos-sub">Every conversation stored on your computer.</span>
        <button className="mos-btn mos-spring" onClick={refresh} aria-label="Refresh chats">
          Refresh
        </button>
        <button className="mos-btn mos-accent" onClick={() => void newChat()}>
          New chat
        </button>
      </header>
      {error ? (
        <div className="mos-errrow" role="alert">
          <span>Couldn't load chats — {error}</span>
          <button className="mos-btn" onClick={refresh}>Retry</button>
        </div>
      ) : null}
      {!loading && rows.length === 0 && !error ? (
        <div className="mos-empty">
          <IconMoch size={56} />
          <p className="mos-emptyTitle">No conversations yet</p>
          <p className="mos-emptyBody">Start one from Chat — press Ctrl+1.</p>
          <button className="mos-btn mos-accent" onClick={() => void newChat()}>
            New chat
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="mos-spin" aria-label="Loading chats" />
      ) : (
        <div className="mos-scroller">
          <table className="mos-table">
            <thead>
              <tr>
                <th className="mos-th">Title</th>
                <th className="mos-th" style={{ width: 96 }}>
                  Messages
                </th>
                <th className="mos-th" style={{ width: 110 }}>
                  Started
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="mos-row"
                  onClick={() => {
                    openSession(r.id)
                    setShellLayout({ screen: 'chat' })
                  }}
                >
                  <td className="mos-td">{r.title || 'New chat'}</td>
                  <td className="mos-td">{messageCountText(r.message_count)}</td>
                  <td className="mos-td">{when(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
