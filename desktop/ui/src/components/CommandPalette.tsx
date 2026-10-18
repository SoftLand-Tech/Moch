/**
 * Command palette (Ctrl+K): jump to any view, bot, or action. The spine of
 * the desktop shell — Agent Desktop's Quick Open pattern.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { ArrowRight, Activity, Bot, CalendarClock, Globe, Inbox, MessageSquareText, Plug, Settings, Sparkles, SquareTerminal, UsersRound } from 'lucide-react'
import type { ViewId } from '../app'
import { fleetProfiles, setActiveBot } from '../lib/fleet'
import { newChat } from '../lib/chat'
import { locale, tr } from '../lib/strings'

interface Item {
  id: string
  label: string
  hint?: string
  icon: typeof Globe
  run: () => void
}

export default function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (v: ViewId) => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const bots = useStore(fleetProfiles)
  const inputRef = useRef<HTMLInputElement>(null)
  const loc = useStore(locale) // subscribe so the translated entry re-renders on locale change

  useEffect(() => { inputRef.current?.focus() }, [])

  const items = useMemo<Item[]>(() => {
    const views: Item[] = [
      { id: 'v-chat', label: 'Chats', icon: MessageSquareText, run: () => onNavigate('chat') },
      { id: 'v-fleet', label: 'Fleet — your bots', icon: Bot, run: () => onNavigate('fleet') },
      { id: 'v-crew', label: 'Crew — task board', icon: UsersRound, run: () => onNavigate('crew') },
      { id: 'v-activity', label: tr('activity.palette'), icon: Activity, run: () => onNavigate('history') },
      { id: 'v-inbox', label: 'Inbox — waiting on you', icon: Inbox, run: () => onNavigate('inbox') },
      { id: 'v-browser', label: 'Browser — the agent browser', icon: Globe, run: () => onNavigate('browser') },
      { id: 'v-terminal', label: 'Terminal', icon: SquareTerminal, run: () => onNavigate('terminal') },
      { id: 'v-automations', label: 'Automations', icon: CalendarClock, run: () => onNavigate('automations') },
      { id: 'v-skills', label: 'Skills', icon: Sparkles, run: () => onNavigate('skills') },
      { id: 'v-connectors', label: 'Connectors', icon: Plug, run: () => onNavigate('connectors') },
      { id: 'v-settings', label: 'Settings', icon: Settings, run: () => onNavigate('settings') },
    ]
    const actions: Item[] = [
      { id: 'a-newchat', label: 'New chat', hint: 'fresh session', icon: MessageSquareText, run: () => { onNavigate('chat'); void newChat() } },
      ...bots.filter(b => b.name !== 'default').map((b): Item => ({
        id: `b-${b.name}`,
        label: `Chat with @${b.name}`,
        hint: b.description.slice(0, 60),
        icon: Bot,
        run: () => { void setActiveBot(b.name); onNavigate('chat'); void newChat() },
      })),
    ]
    const all = [...views, ...actions]
    if (!q.trim()) return all
    const needle = q.trim().toLowerCase()
    return all.filter((i) => i.label.toLowerCase().includes(needle) || i.hint?.toLowerCase().includes(needle))
  }, [q, bots, onNavigate, loc])

  useEffect(() => setSel(0), [q])

  const runSel = () => {
    const item = items[sel]
    if (item) { item.run(); onClose() }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ minWidth: 520, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '6px 6px 0' }}>
          <div className="ctx-search" style={{ margin: 0, border: 'none', background: 'transparent', padding: '10px 8px' }}>
            <input
              ref={inputRef}
              placeholder="Jump to anything — views, bots, actions…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, items.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
                if (e.key === 'Enter') { e.preventDefault(); runSel() }
                if (e.key === 'Escape') onClose()
              }}
              style={{ fontSize: 15 }}
            />
          </div>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: '0 8px 10px' }}>
          {items.map((item, i) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`row${i === sel ? ' active' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={runSel}
              >
                <Icon size={15} />
                <span className="row-title">{item.label}</span>
                {item.hint ? <span className="row-sub">{item.hint}</span> : null}
                {i === sel ? <ArrowRight size={12} /> : null}
              </button>
            )
          })}
          {items.length === 0 ? <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: 13 }}>Nothing matches.</div> : null}
        </div>
      </div>
    </div>
  )
}
