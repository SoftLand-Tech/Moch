/**
 * Desktop Skills — commands + skills from the gateway's own registry
 * (`commands.catalog`, exactly the stores the phone screen reads in
 * app/app/(tabs)/skills.tsx), a filter field, and Run → a composer draft
 * via the shared drafts store — the same hand-off the phone does with its
 * chat `draft` route param.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  commandCatalog,
  commandDescriptions,
  loadCatalog,
  loadSkillDescriptions,
  skillCommands,
  skillDescriptions,
} from '../../../../../app/src/lib/slash'
import { activeStoredId } from '../../../../../app/src/lib/chat'
import { setDraft } from '../../../../../app/src/lib/drafts'
import { isConnected } from '../../../../../app/src/lib/gateway'
import { setShellLayout } from '../shell/state'

export default function Skills(): React.JSX.Element {
  const online = useStore(isConnected)
  const skills = useStore(skillCommands)
  const commands = useStore(commandCatalog)
  const cmdDescs = useStore(commandDescriptions)
  const skillDescs = useStore(skillDescriptions)
  const [query, setQuery] = useState('')
  // Spinner only until the FIRST catalog lands — when the chat path already
  // loaded the registry the lists render on the very first paint.
  const [loaded, setLoaded] = useState(() => Object.keys(commandCatalog.get()).length > 0)
  const [tab, setTab] = useState<'commands' | 'skills'>('commands')
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!online) {
      setLoaded(true)
      return
    }
    // Serve the in-memory catalog instantly; only hit the wire when empty
    // (loadCatalog({}) is a no-op once loaded — same lifetime the chat path
    // and the shell already assume).
    const cached = Object.keys(commandCatalog.get()).length > 0
    loadCatalog(cached ? {} : { force: true })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [online])

  // Skill descriptions arrive via one complete.slash query per skill (the
  // catalog carries none) — progressive: rows render immediately and the
  // descriptions fill in as batches land.
  useEffect(() => {
    if (tab === 'skills' && online) void loadSkillDescriptions().catch(() => {})
  }, [tab, online])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  const skillList = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\//, '')
    return Object.entries(skills)
      .map(([name, meta]) => ({ name, desc: skillDescs[name.replace(/^\//, '').toLowerCase()], usage: meta.usage }))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.desc?.toLowerCase().includes(q))
      .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))
  }, [skills, skillDescs, query])

  const commandList = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.entries(commands)
      .map(([name, def]) => ({ name, desc: cmdDescs[name.replace(/^\//, '').toLowerCase()] ?? def.description }))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.desc?.toLowerCase().includes(q))
  }, [commands, cmdDescs, query])

  // Run → the composer draft the phone navigates with (`draft: '/cmd '`):
  // write the shared drafts store under the active chat's STORED id and let
  // the shell bring Chat to front. No auto-send — the user reviews and sends.
  const run = (name: string) => {
    // Skill keys already carry a leading slash — normalise so the composer
    // never ends up with "//airtable".
    const bare = name.replace(/^\/+/, '')
    const key = activeStoredId.get()
    setDraft(key, `/${bare} `)
    setShellLayout({ screen: 'chat' })
    if (!key) setNote(`No chat is open — “/${bare}” will land once you open one.`)
  }

  const reload = () => {
    setLoaded(false)
    loadCatalog({ force: true })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }

  const rows = tab === 'commands' ? commandList : skillList
  const emptyText = !online
    ? 'Offline — the registry lives on your computer.'
    : query.trim()
      ? 'No matches'
      : tab === 'commands'
        ? 'No commands loaded'
        : 'No skills installed'

  return (
    <div className="mos-root">
      <style>{css}</style>
      <header className="mos-head">
        <h2>Skills</h2>
        <span className="mos-sub">Commands and skills served by your computer's registry.</span>
        <input
          className="mos-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'commands' ? 'Filter commands…' : 'Filter skills…'}
          aria-label="Filter"
          spellCheck={false}
        />
      </header>

      <div className="mos-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'commands'} className={`mos-tab${tab === 'commands' ? ' mos-tabOn' : ''}`} onClick={() => setTab('commands')}>
          Commands ({Object.keys(commands).length})
        </button>
        <button role="tab" aria-selected={tab === 'skills'} className={`mos-tab${tab === 'skills' ? ' mos-tabOn' : ''}`} onClick={() => setTab('skills')}>
          Skills ({Object.keys(skills).length})
        </button>
      </div>

      {note ? <div className="mos-toast" role="status">{note}</div> : null}

      {!loaded ? (
        <div className="mos-spin" aria-label="Loading registry" />
      ) : rows.length === 0 ? (
        <div className="mos-empty">
          <p className="mos-emptyTitle">{emptyText}</p>
          {online && !query.trim() ? <button className="mos-btn mos-accent" onClick={reload}>Reload registry</button> : null}
        </div>
      ) : (
        <div className="mos-scroller">
          <table className="mos-table">
            <thead>
              <tr>
                <th className="mos-th mos-w-name">{tab === 'commands' ? 'Command' : 'Skill'}</th>
                <th className="mos-th">Description</th>
                <th className="mos-th mos-w-actions" aria-label="Run" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.name}
                  className={`mos-row${selected === r.name ? ' mos-sel' : ''}`}
                  onClick={() => setSelected(r.name)}
                  onDoubleClick={() => run(r.name)}
                >
                  <td className="mos-td mos-name">/{r.name.replace(/^\/+/, '')}</td>
                  <td className="mos-td mos-desc" title={r.desc}>{r.desc || '—'}</td>
                  <td className="mos-td mos-w-actions">
                    <button className="mos-btn" onClick={(e) => { e.stopPropagation(); run(r.name) }} aria-label={`Run /${r.name.replace(/^\/+/, '')}`}>
                      Run
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const css = `
.mos-root { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--moch-text); font-family: var(--moch-font); }
.mos-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--moch-border); }
.mos-head h2 { margin: 0; font-size: 15px; }
.mos-sub { color: var(--moch-text-dim); font-size: 12px; }
.mos-search { margin-left: auto; background: var(--moch-bg); color: var(--moch-text); border: 1px solid var(--moch-border); border-radius: 6px; padding: 4px 9px; font-size: 12.5px; font-family: inherit; width: 220px; }
.mos-tabs { display: flex; gap: 2px; padding: 6px 16px 0; border-bottom: 1px solid var(--moch-border); }
.mos-tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--moch-text-dim); font-size: 12.5px; padding: 5px 10px; cursor: pointer; font-family: inherit; }
.mos-tab:hover { color: var(--moch-text); }
.mos-tab.mos-tabOn { color: var(--moch-text); border-bottom-color: var(--moch-accent); }
.mos-scroller { flex: 1; overflow: auto; min-height: 0; }
.mos-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mos-th { position: sticky; top: 0; z-index: 1; background: var(--moch-bg-card); color: var(--moch-text-faint); text-align: left; font-weight: 500; padding: 0 10px; height: 30px; border-bottom: 1px solid var(--moch-border); white-space: nowrap; }
.mos-row { height: var(--moch-row-h, 32px); cursor: default; }
.mos-row:hover { background: var(--moch-bg-hover); }
.mos-row.mos-sel { background: var(--moch-accent-soft); }
.mos-td { padding: 0 10px; border-bottom: 1px solid var(--moch-border-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mos-name { font-family: var(--moch-mono); font-size: 12px; font-weight: 500; color: var(--moch-accent); }
.mos-desc { color: var(--moch-text-dim); max-width: 560px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.mos-w-name { width: 200px; }
.mos-w-actions { width: 1%; white-space: nowrap; }
.mos-btn { background: transparent; color: var(--moch-text-dim); border: 1px solid var(--moch-border); border-radius: 5px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
.mos-btn:hover { color: var(--moch-text); border-color: var(--moch-text-faint); }
.mos-btn.mos-accent { background: var(--moch-accent); color: var(--moch-bg); border-color: transparent; }
.mos-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; color: var(--moch-text-dim); }
.mos-emptyTitle { margin: 0 0 8px; color: var(--moch-text); font-size: 14px; }
.mos-spin { width: 22px; height: 22px; margin: 48px auto; border: 2px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: mos-rot 800ms linear infinite; }
@keyframes mos-rot { to { transform: rotate(360deg); } }
.mos-toast { position: fixed; left: 16px; bottom: 16px; z-index: 40; background: var(--moch-bg-elev); border: 1px solid var(--moch-border); color: var(--moch-text); font-size: 12.5px; padding: 7px 12px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
.mos-root :focus-visible { outline: 2px solid var(--moch-accent); outline-offset: 1px; }
`
