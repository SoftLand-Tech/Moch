/**
 * BotsRail — the Rakazo-shaped left pane: brand, search, the live roster
 * from the fleet store, and the new-bot entry. The roster IS the desktop
 * home: picking a bot makes the center pane its one home thread.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, MessageSquare, MessagesSquare, MoreHorizontal, Plus, Search, Settings } from 'lucide-react'
import type { ViewId } from '../app'
import CreateBotOverlay from './CreateBotOverlay'
import {
  accentFor, activeBotAtom, botAvatar, botColor, fleetProfiles, fleetStatusAtom, homeThreadFor,
  type FleetQueueEntry,
} from '../lib/fleet'
import { listBotSessions, openHomeThread, startSideChat, switchToSession, type BotSessionRow } from '../lib/chat'
import { isConnected } from '../lib/gateway'
import { locale, tr } from '../lib/strings'
import { requestFleetFocus } from '../views/FleetView'
import './BotsRail.css'

/** One roster row's status: the dot kind plus the queued-turn count. */
type DotKind = 'run' | 'wait' | 'idle' | 'frozen'

/** key '' is the default agent (Mochi); named bots key by profile name. */
interface RailBot {
  key: string
  name: string | null
  description: string
  accent: string
  dot: DotKind
  waiting: number
  color?: string
  avatar?: string
}

/**
 * Queue tickets carry the profile home path. Named profiles live under
 * .../profiles/<name>; the launch home (no /profiles/ segment) is Mochi's.
 */
function waitingByBot(waiting: FleetQueueEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const w of waiting) {
    const i = w.home.lastIndexOf('/profiles/')
    const bot = i === -1 ? '' : w.home.slice(i + '/profiles/'.length).split('/')[0]
    counts.set(bot, (counts.get(bot) ?? 0) + 1)
  }
  return counts
}

function dotLabel(kind: DotKind, waiting: number): string {
  if (kind === 'frozen') return tr('shell.thread.frozen')
  if (kind === 'run') return tr('shell.thread.working')
  if (kind === 'wait') return waiting > 1 ? tr('rail.waiting.n', { n: waiting }) : tr('shell.thread.waiting')
  return tr('shell.thread.idle')
}

export default function BotsRail({ onNav }: { onNav: (v: ViewId) => void }) {
  const [q, setQ] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [chatsFor, setChatsFor] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const bots = useStore(fleetProfiles)
  const fleet = useStore(fleetStatusAtom)
  const active = useStore(activeBotAtom)
  const connected = useStore(isConnected)
  useStore(locale) // subscribe so roster labels re-render when the language changes

  const rows = useMemo<RailBot[]>(() => {
    const waiting = waitingByBot(fleet?.queue.waiting ?? [])
    const all: RailBot[] = [
      {
        key: '',
        name: null,
        description: tr('rail.mochi.job'),
        accent: 'var(--text-faint)',
        dot: (waiting.get('') ?? 0) > 0 ? 'wait' : 'idle',
        waiting: waiting.get('') ?? 0,
      },
      ...bots
        .filter((b) => b.name !== 'default')
        .map((b): RailBot => {
          const st = fleet?.profiles.find((p) => p.name === b.name)
          const w = waiting.get(b.name) ?? 0
          const frozen = !!st?.frozen || !!b.frozen
          return {
            key: b.name,
            name: b.name,
            description: b.description || tr('rail.nodesc'),
            accent: b.avatarAccent ?? accentFor(b.name),
            dot: frozen ? 'frozen' : st?.gateHeld ? 'run' : w > 0 ? 'wait' : 'idle',
            waiting: w,
            color: botColor(b),
            avatar: botAvatar(b),
          }
        }),
    ]
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter((r) =>
      `${r.name ?? tr('rail.mochi')}\n${r.description}`.toLowerCase().includes(needle))
  }, [bots, fleet, q])

  // Focus the bot's home thread: the bound session, or a fresh one when the
  // bot has none yet. openHomeThread owns the resolution and the binding.
  const pick = async (name: string | null) => {
    closeMenu()
    try {
      await openHomeThread(name)
    } catch {
      // Still route to the thread pane; the next send re-anchors to the bot.
    }
    onNav('chat')
  }

  const openSettings = (key: string) => {
    closeMenu()
    requestFleetFocus(key || 'default')
    window.dispatchEvent(new CustomEvent('moch-fleet-focus'))
    onNav('fleet')
  }

  const closeMenu = () => {
    setMenuFor(null)
    setChatsFor(null)
  }

  const openCreate = () => setCreateOpen(true)

  const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>, key: string) => {
    e.stopPropagation()
    if (menuFor === key) {
      closeMenu()
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    setMenuAt({ left: Math.min(r.left, window.innerWidth - 180), top: r.bottom + 4 })
    setChatsFor(null)
    setMenuFor(key)
  }

  useEffect(() => {
    if (!menuFor) return
    const onDown = (e: MouseEvent) => {
      const t = e.target
      if (menuRef.current?.contains(t as Node)) return
      if (t instanceof Element && t.closest('.rk-more')) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  return (
    <aside className="rk-rail" aria-label={tr('nav.fleet')}>
      <div className="rk-brand">
        <img src="/mochi/mochi-greeting.svg" alt="" width={28} height={28} />
        <b>Moch</b>
        <button
          className="rk-iconbtn"
          onClick={() => onNav('settings')}
          title={tr('nav.settings')}
          aria-label={tr('nav.settings')}
        >
          <Settings size={15} />
        </button>
      </div>

      <div className="rk-search">
        <Search size={13} />
        <input
          placeholder={tr('rail.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={tr('rail.search')}
        />
      </div>

      <div className="rk-roster" role="list">
        {rows.map((b) => {
          const name = b.name ?? tr('rail.mochi')
          const on = active === b.name
          return (
            <div className="rk-rowwrap" role="listitem" key={b.key}>
              <button
                className={`rk-bot${on ? ' on' : ''}`}
                onClick={() => void pick(b.name)}
                title={name}
                aria-current={on ? 'true' : undefined}
              >
                <span className="rk-avatar" style={{ background: b.color ?? b.accent }}>
                  {b.avatar ? <img src={b.avatar} alt="" width={20} height={20} /> : name.slice(0, 2)}
                </span>
                <span className="rk-bottext">
                  <span className="rk-botname">{name}</span>
                  <span className="rk-botdesc" title={b.description}>{b.description}</span>
                </span>
                {b.waiting > 0 ? (
                  <span className="rk-badge" title={tr('rail.waiting.n', { n: b.waiting })}>
                    {b.waiting}
                  </span>
                ) : null}
                <span className={`rk-dot ${b.dot}`} title={dotLabel(b.dot, b.waiting)} />
              </button>
              <button
                className="rk-more"
                aria-label={tr('rail.menu')}
                aria-haspopup="menu"
                aria-expanded={menuFor === b.key}
                onClick={(e) => toggleMenu(e, b.key)}
              >
                <MoreHorizontal size={14} />
              </button>
              {menuFor === b.key && menuAt ? (
                <div
                  className="rk-menu"
                  role="menu"
                  ref={menuRef}
                  style={chatsFor === b.key ? { ...menuAt, width: 230 } : menuAt}
                >
                  {chatsFor === b.key ? (
                    <ChatsMenu bot={b.name} onBack={() => setChatsFor(null)} onDone={closeMenu} onNav={onNav} />
                  ) : (
                    <>
                      <button role="menuitem" onClick={() => void pick(b.name)}>
                        <MessageSquare size={13} /> {tr('rail.menu.open')}
                      </button>
                      <button role="menuitem" onClick={() => setChatsFor(b.key)}>
                        <MessagesSquare size={13} /> {tr('nav.chats')}
                      </button>
                      <button role="menuitem" onClick={() => openSettings(b.key)}>
                        <Settings size={13} /> {tr('rail.menu.settings')}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
        {rows.length === 0 ? <div className="rk-norows">{tr('rail.nomatch')}</div> : null}
        {!connected ? <div className="rk-norows">{tr('fleet.offline')}</div> : null}
      </div>

      <button className="rk-newbot" onClick={openCreate} disabled={!connected}>
        <Plus size={14} /> {tr('fleet.create')}
      </button>

      {createOpen ? (
        <CreateBotOverlay
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => { setCreateOpen(false); void pick(name) }}
        />
      ) : null}
    </aside>
  )
}

/**
 * The per-bot Chats control: that bot's sessions beside its home thread.
 * Opening one only switches the center pane; the home binding is never
 * touched here, so the rail row keeps meaning "go home".
 */
function ChatsMenu({ bot, onBack, onDone, onNav }: {
  bot: string | null
  onBack: () => void
  onDone: () => void
  onNav: (v: ViewId) => void
}) {
  const [rows, setRows] = useState<BotSessionRow[] | null>(null)
  useStore(locale) // subscribe so the control's labels re-render when the language changes

  useEffect(() => {
    let alive = true
    setRows(null)
    listBotSessions(bot)
      .then((r) => { if (alive) setRows(r) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [bot])

  const home = homeThreadFor(bot)
  const others = (rows ?? []).filter((r) => r.id !== home)

  const open = async (id: string) => {
    try {
      await switchToSession(id, { profile: bot })
    } catch (err) {
      // Route to the thread pane anyway; the failed open is visible in the console.
      console.warn('[rail] could not open the side chat', err)
    }
    onDone()
    onNav('chat')
  }

  const startNew = async () => {
    try {
      await startSideChat(bot)
    } catch (err) {
      // Route to the thread pane anyway; the failed create is visible in the console.
      console.warn('[rail] could not start a side chat', err)
    }
    onDone()
    onNav('chat')
  }

  const titleStyle: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  return (
    <>
      <button role="menuitem" onClick={onBack}>
        <ChevronLeft size={13} /> {tr('nav.chats')}
      </button>
      <div style={{ maxHeight: 236, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {rows === null ? (
          <span style={{ padding: '7px 10px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {tr('rail.chats.loading')}
          </span>
        ) : others.length === 0 ? (
          <span style={{ padding: '7px 10px', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {tr('rail.chats.empty')}
          </span>
        ) : others.map((r) => (
          <button role="menuitem" key={r.id} onClick={() => void open(r.id)} title={r.title || tr('rail.chats.untitled')}>
            <MessageSquare size={13} />
            <span style={titleStyle}>{r.title || tr('rail.chats.untitled')}</span>
          </button>
        ))}
      </div>
      <button role="menuitem" onClick={() => void startNew()}>
        <Plus size={13} /> {tr('rail.chats.new')}
      </button>
    </>
  )
}
