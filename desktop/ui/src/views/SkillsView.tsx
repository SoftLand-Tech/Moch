import { useCallback, useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import { CircleAlert, FolderOpen, RefreshCw, Sparkles } from 'lucide-react'
import { listSkills, resolveSkillDir, type Skill } from '../lib/skills'
import { hermesHome, isConnected, workspaceDir } from '../lib/gateway'
import { revealPath } from '../lib/shell-ops'
import { locale, tr } from '../lib/strings'

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 650,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  marginBottom: 6,
}

export default function SkillsView() {
  useStore(locale)
  const connected = useStore(isConnected)
  const ws = useStore(workspaceDir)
  const home = useStore(hermesHome)
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listSkills()
      setSkills(list)
      setError('')
      setSelected((prev) => (prev && list.some((s) => s.name === prev) ? prev : list[0]?.name ?? null))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  const skill = skills.find((s) => s.name === selected) ?? null
  const skillDir = skill ? resolveSkillDir(skill, home, ws) : null
  const skillsRoot = (ws ?? home) ? `${(ws ?? home) as string}/skills` : tr('skills.root.fallback')

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">{tr('nav.skills')}</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title={tr('skills.rescan')} onClick={() => void refresh()} disabled={!connected}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {loading ? (
            <div style={{ padding: '14px 12px', display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-faint)' }}>
              <span className="spinner" style={{ width: 12, height: 12 }} /> {tr('skills.loading')}
            </div>
          ) : error ? (
            <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--red)', display: 'flex', gap: 6 }}>
              <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
            </div>
          ) : (
            <>
              <div className="row-section">{tr('skills.installed', { n: skills.length })}</div>
              {skills.length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.5 }}>
                  {tr('skills.none')}
                </div>
              ) : (
                skills.map((s) => (
                  <div
                    key={s.name}
                    className={`row${selected === s.name ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(s.name)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(s.name)}
                  >
                    <Sparkles size={13} color="var(--accent)" style={{ flexShrink: 0 }} />
                    <span className="row-title" title={s.name}>{s.name}</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </aside>

      <main className="focus">
        {skill ? (
          <>
            <div className="focus-head">
              <Sparkles size={16} color="var(--accent)" />
              <span style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {skill.name}
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn sm" disabled={!skillDir} title={skillDir ?? tr('skills.path.unknown')} onClick={() => skillDir && void revealPath(skillDir)}>
                <FolderOpen size={13} /> {tr('skills.open')}
              </button>
            </div>
            <div className="focus-body">
              <Field label={tr('skills.field.desc')}>
                {skill.description ? (
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 1.6, userSelect: 'text' }}>
                    {skill.description}
                  </div>
                ) : (
                  <span className="text-faint" style={{ fontSize: 'var(--text-sm)' }}>{tr('skills.nodesc')}</span>
                )}
              </Field>
              <Field label={tr('skills.field.loc')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <code
                    className="mono"
                    style={{
                      flex: 1, minWidth: 0, fontSize: 'var(--text-xs)', color: 'var(--text-dim)',
                      background: 'var(--bg-card)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius)',
                      padding: '8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'text',
                    }}
                    title={skillDir ?? skill.path ?? undefined}
                  >
                    {skillDir ?? skill.path ?? 'unknown'}
                  </code>
                  <button className="btn sm" disabled={!skillDir} onClick={() => skillDir && void revealPath(skillDir)}>
                    <FolderOpen size={13} /> {tr('settings.reveal')}
                  </button>
                </div>
              </Field>
              <Field label={tr('skills.field.how')}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)', lineHeight: 1.6 }}>
                  {tr('skills.how')}
                </span>
              </Field>
            </div>
          </>
        ) : (
          <div className="empty">
            <Sparkles size={34} color="var(--text-faint)" />
            <div className="empty-title">{tr('skills.empty.title')}</div>
            <div className="empty-sub" style={{ userSelect: 'text' }}>
              {tr('skills.empty.pre')} <span className="mono" style={{ color: 'var(--accent)' }}>{skillsRoot}</span> {tr('skills.empty.post')}
            </div>
            <button className="btn" onClick={() => ws && void revealPath(ws)} disabled={!ws}>
              <FolderOpen size={14} /> {tr('skills.show.ws')}
            </button>
          </div>
        )}
      </main>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border-soft)' }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}
