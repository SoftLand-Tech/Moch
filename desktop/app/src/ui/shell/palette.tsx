/** Ctrl+K palette (spec 4.3): one input, sources = screens + slash
 * commands + sessions, ranked by paletteRank. Slash items fill the chat
 * composer through the engine's draft store. */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { commandCatalog, commandDescriptions, loadCatalog, type CatalogCommand } from '../../../../../app/src/lib/slash'
import { sessionRows } from '../../../../../app/src/lib/sessionList'
import { setShellLayout, shellLayout, closePalette, openPalette, paletteOpen, paletteQuery } from './state'
import { SCREENS } from './registry'
import { rankItems, type RankableItem } from './paletteRank'

interface Item extends RankableItem {
  id: string
  kind: 'screen' | 'slash' | 'session'
  run: () => void
}

export function Palette(props: { onOpenChatDraft: (draft: string) => void }): React.JSX.Element | null {
  const open = useStore(paletteOpen)
  const catalog = useStore(commandCatalog)
  const descriptions = useStore(commandDescriptions)
  const rows = useStore(sessionRows)
  const query = useStore(paletteQuery)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const items = useMemo(() => buildItems(query, catalog, descriptions, rows, props), [open, query, catalog, descriptions, rows, props])

  useEffect(() => {
    return paletteOpen.subscribe((o) => {
      if (o) {
        restoreRef.current = document.activeElement as HTMLElement | null
        void loadCatalog().catch(() => {})
        setTimeout(() => inputRef.current?.focus(), 20)
      } else {
        restoreRef.current?.focus?.()
        setCursor(0)
      }
    })
  }, [])

  useEffect(() => {
    setCursor(0)
  }, [query])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (items.length ? (c + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[cursor]?.run()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const item = items[cursor]
      if (item && item.kind === 'slash') {
        paletteQuery.set(item.title + ' ')
        inputRef.current!.value = item.title + ' '
      }
    }
  }

  return (
    <div className="palette-scrim" role="presentation" onMouseDown={closePalette}>
      <div
        className="palette-card"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => paletteQuery.set(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search chats, screens, commands…  ( / commands, > screens )"
          aria-label="Command palette input"
          autoFocus
        />
        {items.length === 0 ? (
          <div className="palette-empty">No matches. Esc closes.</div>
        ) : (
          <div className="palette-list" role="listbox">
            {items.map((item, i) => (
              <div
                key={item.id}
                role="option"
                aria-selected={i === cursor}
                className={i === cursor ? 'palette-row active' : 'palette-row'}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => item.run()}
              >
                <span className="palette-title">{item.title}</span>
                {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                <span className="palette-kind">{item.kind}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function buildItems(
  query: string,
  catalog: Record<string, CatalogCommand>,
  descriptions: Record<string, string>,
  rows: Array<{ id: string; title: string; last_activity_at?: number }>,
  props: { onOpenChatDraft: (draft: string) => void },
): Item[] {
  if (!query) return []
  const slashMode = query.startsWith('/')
  const screensMode = query.startsWith('>')
  const q = slashMode || screensMode ? query.slice(1) : query
  const out: Item[] = []
  if (!screensMode) {
    for (const [name, cmd] of Object.entries(catalog)) {
      const full = `/${name}`
      out.push({
        id: `slash:${name}`,
        kind: 'slash',
        title: full,
        hint: descriptions[name] ?? cmd.description ?? '',
        run: () => {
          closePalette()
          props.onOpenChatDraft(`${full} `)
        },
      })
    }
  }
  if (!slashMode) {
    for (const s of SCREENS) {
      out.push({
        id: `screen:${s.id}`,
        kind: 'screen',
        title: s.label,
        hint: 'screen',
        run: () => {
          closePalette()
          setShellLayout({ screen: s.id })
        },
      })
    }
    for (const r of rows.slice(0, 40)) {
      out.push({
        id: `session:${r.id}`,
        kind: 'session',
        title: r.title || 'New chat',
        recency: r.last_activity_at ?? 0,
        run: () => {
          closePalette()
          setShellLayout({ screen: 'chat' })
          void import('../Chat/api').then((m) => m.openSessionById(r.id)).catch(() => {})
        },
      })
    }
  }
  const ranked = rankItems(q, out as RankableItem[]) as Item[]
  if (slashMode) return ranked.filter((i) => i.kind === 'slash').slice(0, 12)
  if (screensMode) return ranked.filter((i) => i.kind === 'screen').slice(0, 12)
  return [
    ...ranked.filter((i) => i.kind === 'session').slice(0, 8),
    ...ranked.filter((i) => i.kind !== 'session').slice(0, 14),
  ]
}

export { shellLayout, openPalette }
