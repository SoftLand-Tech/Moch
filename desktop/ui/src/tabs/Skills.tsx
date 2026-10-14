/** Skills — launch-home skills + slash commands. Moved verbatim from App.tsx
 *  (round 4 tab-file refactor); behavior identical. */
import { useEffect, useState } from 'react'
import type { LaunchSkill, RpcRef } from '../types'

export default function SkillsTab({ rpc }: { rpc: RpcRef }) {
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [commands, setCommands] = useState(0)
  const [err, setErr] = useState('')
  useEffect(() => {
    ;(async () => {
      try { setSkills((await rpc.current!('moch.skills.list', {})).skills ?? []) } catch (e) { setErr(String(e)) }
      try { setCommands(Object.keys((await rpc.current!('commands.catalog', {})).commands ?? {}).length) } catch { }
    })()
  }, [])
  return (
    <div className="page">
      <div className="pagehead"><h2>Skills</h2><span className="pill dim">{commands} slash commands</span></div>
      {err && <div className="err">{err}</div>}
      {skills.map((s) => (
        <div key={s.path ?? s.name} className="card"><strong>{s.name}</strong>{s.description && <p className="dim">{s.description}</p>}</div>
      ))}
      {skills.length === 0 && <div className="empty"><p>No launch skills found.</p></div>}
    </div>
  )
}
