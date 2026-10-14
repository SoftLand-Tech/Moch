/** Skills — launch-home skills + the full slash-command catalog, searchable
 *  (commands.catalog; presentation mirrors the RN skills screen compactly). */
import { useEffect, useState } from 'react'
import type { LaunchSkill, RpcRef } from '../types'

type CmdEntry = { name: string; description?: string }

export default function SkillsTab({ rpc }: { rpc: RpcRef }) {
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [commands, setCommands] = useState<CmdEntry[]>([])
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    ;(async () => {
      try { setSkills((await rpc.current!('moch.skills.list', {})).skills ?? []) } catch (e) { setErr(String(e)) }
      try {
        const r = await rpc.current!('commands.catalog', {})
        const cmds = r.commands ?? {}
        setCommands(Object.entries(cmds).map(([name, def]) => ({
          name,
          description: (def as { description?: string; summary?: string })?.description ?? (def as { summary?: string })?.summary ?? '',
        })))
      } catch { }
    })()
  }, [])

  const needle = q.trim().toLowerCase()
  const match = (s: string) => !needle || s.toLowerCase().includes(needle)
  const fSkills = skills.filter((s) => match(s.name) || match(s.description ?? ''))
  const fCommands = commands.filter((c) => match(c.name) || match(c.description ?? ''))

  return (
    <div className="page">
      <div className="pagehead">
        <h2>Skills</h2>
        <span className="pill dim">{skills.length} skills · {commands.length} commands</span>
        <span className="spacer" />
        <input className="search" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <div className="err">{err}</div>}
      {skills.length > 0 && <>
        <h3 className="sec">Launch skills</h3>
        {fSkills.map((s) => (
          <div key={s.path ?? s.name} className="card"><strong>{s.name}</strong>{s.description && <p className="dim">{s.description}</p>}</div>
        ))}
      </>}
      <h3 className="sec">Commands</h3>
      {fCommands.map((c) => (
        <div key={c.name} className="card cmdrow">
          <code>{c.name}</code>
          {c.description && <p className="dim">{c.description}</p>}
        </div>
      ))}
      {fSkills.length === 0 && fCommands.length === 0 && <div className="empty"><p>Nothing matches “{q}”.</p></div>}
    </div>
  )
}
