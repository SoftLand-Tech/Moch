/** Settings surface — connection, theme, pairing link. */
import React, { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { connConfig, connectionState, everConnected } from '../../core/boot'
import { applyTheme, loadTheme, themeId, type ThemeId } from '../../../../../app/src/lib/theme'
import { parseConnectUrl, pairingSummary } from '../../../../../app/src/lib/pairing'
import { needsPlaintextConfirm } from '../../../../../app/src/lib/transportGate'
import { connect } from '../../../../../app/src/lib/gateway'
import { desktopShell } from '../../../../../app/src/lib/desktopLocal'

export default function Settings(): React.JSX.Element {
  const cfg = useStore(connConfig)
  const state = useStore(connectionState)
  const ever = useStore(everConnected)
  const shell = useStore(desktopShell)
  const [link, setLink] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    void loadTheme()
  }, [])

  const pair = async (): Promise<void> => {
    setMsg(null)
    try {
      const p = parseConnectUrl(link)
      if (needsPlaintextConfirm(p.host, p.tls)) {
        setMsg({ kind: 'err', text: `Refusing plaintext to ${p.host} — use a TLS link.` })
        return
      }
      await connect({ host: p.host, token: p.token, tls: p.tls, ...(p.name ? { name: p.name } : {}) })
      setMsg({ kind: 'ok', text: pairingSummary(p) })
      setLink('')
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Invalid pairing link' })
    }
  }

  return (
    <div className="screen" style={{ padding: 24 }}>
      <h2 className="screen-title">Settings</h2>

      <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)', marginTop: 16 }}>CONNECTION</h3>
      <p className="screen-empty">
        {shell
          ? `Supervised local gateway — ${state}${ever ? ' (connected this run)' : ''}`
          : `${cfg?.host ?? 'no computer'} — ${state}`}
      </p>

      <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)', marginTop: 16 }}>THEME</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['mocheme', 'relay'] as ThemeId[]).map((id) => (
          <button
            key={id}
            className={themeId.get() === id ? 'btn primary' : 'btn'}
            onClick={() => void import('../../../../../app/src/lib/theme').then((m) => m.setTheme(id))}
          >
            {id}
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)', marginTop: 20 }}>
        PAIR ANOTHER COMPUTER
      </h3>
      <div style={{ display: 'flex', gap: 8, maxWidth: 640 }}>
        <input
          className="palette-input"
          style={{ height: 34, fontSize: 13 }}
          placeholder="hermes://connect?host=…&token=…&tls=1"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void pair()}
        />
        <button className="btn" onClick={() => void pair()}>
          Pair
        </button>
      </div>
      {msg ? (
        <p style={{ marginTop: 8, color: msg.kind === 'ok' ? 'var(--moch-text)' : 'var(--moch-red)' }}>
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}
