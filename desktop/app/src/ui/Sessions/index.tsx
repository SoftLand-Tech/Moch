/** Sessions surface — full-width conversation table (D6 table arrives with
 * the sessions unit; this build ships the open/list core). */
import React from 'react'
import { useStore } from '@nanostores/react'
import { sessionRows, loadSessions } from '../../../../../app/src/lib/sessionList'
import { openSession } from '../../core/openSession'
import { useCallback } from 'react'
import { setShellLayout } from '../shell/state'
import { newChat } from '../../../../../app/src/lib/chat'

export default function Sessions(): React.JSX.Element {
  const rows = useStore(sessionRows)
  const refresh = useCallback(() => void loadSessions(), [])
  return (
    <div className="screen" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 className="screen-title" style={{ marginBottom: 0 }}>
          Chats
        </h2>
        <button className="btn" onClick={refresh}>
          Refresh
        </button>
        <button className="btn primary" onClick={() => void newChat()}>
          New chat
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="screen-empty" style={{ marginTop: 16 }}>
          No conversations yet. Start one from Chat.
        </p>
      ) : (
        <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => {
                  openSession(r.id)
                  setShellLayout({ screen: 'chat' })
                }}
                style={{ cursor: 'pointer', borderBottom: '1px solid var(--moch-border)' }}
              >
                <td style={{ padding: '8px 6px' }}>{r.title || 'New chat'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
