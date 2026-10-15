/**
 * U1 surface: connection status + the session list as proof of a live
 * protocol core. The full chat/shell surfaces land in U2/U3 on this same
 * App root.
 */
import React from 'react'
import { useStore } from '@nanostores/react'
import { connectionState, everConnected } from './core/boot'
import { sessionRows, loadSessions } from '../../../app/src/lib/sessionList'
import { useCallback } from 'react'

const COLORS: Record<string, string> = {
  open: '#4ade80',
  connecting: '#f79236',
  closed: '#f87171',
  error: '#f87171',
  idle: '#86829b',
}

export function App(): React.JSX.Element {
  const state = useStore(connectionState)
  const connected = useStore(everConnected)
  const rows = useStore(sessionRows)

  const refresh = useCallback(() => {
    void loadSessions()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: '1px solid var(--moch-border, rgba(248,239,229,0.11))',
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            background: connected ? COLORS.open : COLORS[state] ?? COLORS.idle,
          }}
        />
        <strong style={{ fontSize: 14 }}>Moch</strong>
        <span style={{ color: '#b4b1c4', fontSize: 13 }}>connection: {state}</span>
        <button
          onClick={refresh}
          disabled={!connected}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            color: '#b4b1c4',
            border: '1px solid var(--moch-border, rgba(248,239,229,0.11))',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: connected ? 'pointer' : 'default',
            fontSize: 13,
          }}
        >
          Refresh chats
        </button>
      </header>
      <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {!connected ? (
          <p style={{ color: '#b4b1c4' }}>
            {state === 'connecting' ? 'Connecting to your computer…' : 'Not connected.'}
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#b4b1c4' }}>No conversations yet. Start one from Chat.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((r) => (
              <li
                key={r.id}
                style={{ padding: '6px 4px', borderBottom: '1px solid rgba(248,239,229,0.06)' }}
              >
                {r.title || 'New chat'}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
