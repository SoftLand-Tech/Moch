/**
 * Terminal view — real host shells in the agent workspace. The context
 * column lists live sessions (each row: shell N + close X); the focus head
 * carries the workspace breadcrumb and new/restart controls. Every session
 * stays mounted in a stacked pane set (display:none for inactive tabs) so
 * switching tabs never kills a shell; closing a tab unmounts its pane,
 * whose cleanup kills the PTY.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useRef, useState } from 'react'
import { ChevronRight, House, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import TerminalPane from '../components/TerminalPane'
import { workspaceDir } from '../lib/gateway'
import { locale, tr } from '../lib/strings'

/** The view's shells greet: MOCH marks our spawn, TERM enables 256-color. */
const TERM_ENV: Record<string, string> = { MOCH: '1', TERM: 'xterm-256color' }

interface TermSession {
  key: number
  label: string
}

export default function TerminalView() {
  const workspace = useStore(workspaceDir)
  useStore(locale)
  const [sessions, setSessions] = useState<TermSession[]>(() => [{ key: 1, label: tr('term.session.label', { n: 1 }) }])
  const [activeKey, setActiveKey] = useState(1)
  const [restartNonces, setRestartNonces] = useState<Record<number, number>>({})
  const nextKey = useRef(2)

  const newSession = useCallback(() => {
    const key = nextKey.current++
    setSessions((prev) => [...prev, { key, label: tr('term.session.label', { n: key }) }])
    setActiveKey(key)
  }, [])

  const closeSession = useCallback((key: number) => {
    const idx = sessions.findIndex((s) => s.key === key)
    if (idx === -1) return
    const remaining = sessions.filter((s) => s.key !== key)
    setSessions(remaining)
    setActiveKey((cur) => {
      if (cur !== key) return cur
      const neighbor = remaining[Math.min(idx, remaining.length - 1)]
      return neighbor ? neighbor.key : 0
    })
    setRestartNonces((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [sessions])

  const restartActive = useCallback(() => {
    if (!activeKey) return
    setRestartNonces((prev) => ({ ...prev, [activeKey]: (prev[activeKey] ?? 0) + 1 }))
  }, [activeKey])

  const activeLabel = sessions.find((s) => s.key === activeKey)?.label
  const crumbs = (workspace ?? '').split('/').filter(Boolean)

  return (
    <>
      <aside className="ctx" aria-label={tr('term.sessions.aria')}>
        <div className="ctx-head">
          <span className="ctx-title">{tr('term.sessions')}</span>
          <span className="ctx-actions row-meta">{tr('term.sessions.live', { n: sessions.length })}</span>
        </div>
        <div className="ctx-body">
          {sessions.map((s) => (
            <button
              key={s.key}
              className={`row${s.key === activeKey ? ' active' : ''}`}
              onClick={() => setActiveKey(s.key)}
              title={tr('term.show')}
            >
              <SquareTerminal size={14} />
              <span className="row-title">{s.label}</span>
              <span
                className="term-tab-close"
                role="button"
                aria-label={tr('term.closeNamed', { label: s.label })}
                title={tr('term.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  closeSession(s.key)
                }}
              >
                <X size={12} />
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="text-faint" style={{ fontSize: 12, padding: '10px 12px', lineHeight: 1.5 }}>
              {tr('term.none')}
            </div>
          )}
          <button className="ctx-new" onClick={newSession}>
            <Plus size={14} /> {tr('term.new')}
          </button>
        </div>
      </aside>

      <main className="focus">
        <div className="focus-head">
          <span className="mono" style={{ fontSize: 13, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            <SquareTerminal size={15} color="var(--accent)" />
            {activeLabel ?? tr('nav.terminal')}
          </span>
          <span className="chip" title={workspace ?? tr('files.waiting')}>
            <House size={11} />
            <span style={{
              maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'inline-flex', alignItems: 'center',
            }}>
              {crumbs.length === 0
                ? '…'
                : crumbs.map((c, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <span style={{ color: i === crumbs.length - 1 ? 'var(--text)' : 'var(--text-faint)' }}>{c}</span>
                      {i < crumbs.length - 1 && <ChevronRight size={10} style={{ margin: '0 2px', color: 'var(--text-faint)', flexShrink: 0 }} />}
                    </span>
                  ))}
            </span>
          </span>
          <span className="chip" title={tr('term.defaultShell.title')}>
            {tr('term.defaultShell')}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={newSession}>
            <Plus size={13} /> {tr('term.new')}
          </button>
          <button className="btn sm" onClick={restartActive} disabled={!activeKey}>
            <RotateCcw size={13} /> {tr('term.restart')}
          </button>
        </div>
        <div className="term-stack">
          {sessions.map((s) => (
            <div key={s.key} className={`term-pane${s.key === activeKey ? '' : ' hidden'}`}>
              <TerminalPane env={TERM_ENV} active={s.key === activeKey} restartNonce={restartNonces[s.key] ?? 0} />
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="empty">
              <div className="empty-title">{tr('term.empty.title')}</div>
              <div className="empty-sub">{tr('term.empty.sub')}</div>
              <button className="btn primary" onClick={newSession}>
                <Plus size={14} /> {tr('term.new')}
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
