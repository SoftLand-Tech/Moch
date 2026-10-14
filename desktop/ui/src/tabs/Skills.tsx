/** Skills — launch-home skills + the gateway's slash-command catalog.
 *  Round 5: mirrors the RN skills screen (app/app/(tabs)/skills.tsx) — one
 *  search field filtering both lists, counts on the section heads, one-line
 *  descriptions. Descriptions come from the SAME commands.catalog response's
 *  category pairs (the `commands` map itself ships none on the wire — probe
 *  note in app/src/lib/slash.ts). Display-only: the RN screen "runs" a row
 *  by handing the chat composer a `/name ` draft, not via slash.exec, and
 *  this tab has no composer plumbing — so no Run affordance here. */
import { useEffect, useMemo, useState } from 'react'

/** RpcRef shape App passes every tab (inlined — types.ts is owned elsewhere). */
type RpcRef = { current: ((m: string, p?: any) => Promise<any>) | null }
/** moch.skills.list row — a skill shipped from the launch home. */
type LaunchSkill = { name: string; description?: string; path?: string }
/** commands.catalog `commands` row subset (app/src/lib/slash.ts CatalogCommand). */
type CatalogCommand = { description?: string }
type Catalog = {
  commands?: Record<string, CatalogCommand>
  skills?: Record<string, unknown>
  skill_count?: number
  categories?: Array<{ name?: string; pairs: Array<[string, string]> }>
}

export default function SkillsTab({ rpc }: { rpc: RpcRef }) {
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  /** ["/name", one-line description ('' when the gateway has none)] */
  const [commands, setCommands] = useState<Array<[string, string]>>([])
  const [skillCmds, setSkillCmds] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        setSkills((await rpc.current!('moch.skills.list', {})).skills ?? [])
      } catch (e) {
        setErr(String(e))
      }
      try {
        const c: Catalog = await rpc.current!('commands.catalog', {})
        // Category pairs carry the one-liners (RN loadCatalog builds the very
        // same bare-name → desc map from this field).
        const descs: Record<string, string> = {}
        for (const cat of c.categories ?? []) {
          for (const [key, desc] of cat.pairs ?? []) {
            const bare = key.replace(/^\//, '').toLowerCase()
            if (desc && !descs[bare]) descs[bare] = desc
          }
        }
        setCommands(
          Object.entries(c.commands ?? {})
            .map(([name, def]) => {
              const bare = name.replace(/^\//, '')
              return [`/${bare}`, def?.description || descs[bare.toLowerCase()] || ''] as [string, string]
            })
            .sort((a, b) => a[0].localeCompare(b[0])),
        )
        setSkillCmds(c.skill_count ?? Object.keys(c.skills ?? {}).length)
      } catch {
        /* catalog is best-effort — the section owns its own empty state */
      }
      setLoading(false)
    })()
  }, [])

  const needle = q.trim().toLowerCase()
  const hit = (...xs: Array<string | undefined>) =>
    !needle || xs.some((x) => (x ?? '').toLowerCase().includes(needle))
  const fSkills = useMemo(
    () => skills.filter((s) => hit(s.name, s.description, s.path)),
    [skills, needle],
  )
  const fCommands = useMemo(
    () => commands.filter(([n, d]) => hit(n.replace(/^\//, ''), d)),
    [commands, needle],
  )

  if (loading) {
    return <div className="page"><div className="empty"><p>loading skills…</p></div></div>
  }

  return (
    <div className="page">
      <div className="pagehead">
        <h2>Skills</h2>
        <span className="pill dim">{commands.length} commands · {skillCmds} skills</span>
      </div>

      <div className="card form">
        <input
          placeholder="Filter skills & commands…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {err && <div className="err">{err}</div>}

      <div className="row">
        <strong>Launch skills</strong>
        <span className="pill dim">{fSkills.length}{needle ? ` of ${skills.length}` : ''}</span>
      </div>
      {fSkills.map((s) => (
        <div key={s.path ?? s.name} className="card">
          <div className="row"><strong>{s.name}</strong></div>
          {s.description && <p className="dim">{s.description}</p>}
          {s.path && <p className="dim"><code>{s.path}</code></p>}
        </div>
      ))}
      {skills.length > 0 && fSkills.length === 0 && (
        <div className="empty"><p>No skills match “{q}”.</p></div>
      )}
      {skills.length === 0 && !err && <div className="empty"><p>No launch skills found.</p></div>}

      <div className="row">
        <strong>Commands catalog</strong>
        <span className="pill dim">{fCommands.length}{needle ? ` of ${commands.length}` : ''}</span>
      </div>
      {fCommands.length > 0 ? (
        <div className="card">
          <div className="skillsbox">
            {fCommands.map(([name, desc]) => (
              <div key={name} className="row">
                <code>{name}</code>
                {desc && <span className="dim small">— {desc}</span>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty">
          <p>{commands.length === 0 ? 'No commands loaded.' : `No commands match “${q}”.`}</p>
        </div>
      )}
    </div>
  )
}
