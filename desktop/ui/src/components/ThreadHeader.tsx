/**
 * ThreadHeader — the center pane's minimal header: the active bot's
 * avatar, name, and one status. Deliberately quiet; the thread below is
 * the surface.
 */
import { useStore } from '@nanostores/react'
import { accentFor, activeBotAtom } from '../lib/fleet'
import { agentBusy } from '../lib/chat'
import { locale, tr } from '../lib/strings'

export default function ThreadHeader() {
  const active = useStore(activeBotAtom)
  const busy = useStore(agentBusy)
  useStore(locale) // subscribe so the status word re-renders when the language changes
  const name = active ?? tr('rail.mochi')

  return (
    <header className="rk-threadhead">
      <span
        className="rk-avatar lg"
        style={{ background: active ? accentFor(active) : 'var(--text-faint)' }}
      >
        {name.slice(0, 2)}
      </span>
      <b className="rk-threadname">{name}</b>
      <span className={`rk-dot ${busy ? 'run' : 'idle'}`} />
      <span className="rk-threadstate">{busy ? tr('shell.thread.working') : tr('shell.thread.idle')}</span>
    </header>
  )
}
