/**
 * CreateBotOverlay — the hiring flow. A plain-language job line, a live name,
 * the soul draft it produces, a color and avatar pick, the seed checklist,
 * and on create: identity persisted through ui_meta, the bot's home thread
 * opened, and one hidden intro turn where it states its understanding and
 * asks for what it needs.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { newChat } from '../lib/chat'
import {
  AVATAR_ASSETS, CREATE_COLORS, accentFor, createBot, listLaunchSkills,
  loadCreateDefaults, saveCreateDefaults, setActiveBot, slugifyName,
  soulDraft, submitIntroTurn, type CreateChecklist, type LaunchSkill,
} from '../lib/fleet'
import { locale, tr } from '../lib/strings'

/** One-tap job seeds, carried over from the recycled fleet create flow. */
const STARTERS = [
  { label: 'create.starter.research.label', job: 'create.starter.research.job' },
  { label: 'create.starter.deals.label', job: 'create.starter.deals.job' },
  { label: 'create.starter.code.label', job: 'create.starter.code.job' },
  { label: 'create.starter.journal.label', job: 'create.starter.journal.job' },
] as const

/** Avatar label keys parallel to AVATAR_ASSETS order. */
const AVATAR_LABELS = [
  'create.look.avatar.greeting',
  'create.look.avatar.listening',
  'create.look.avatar.deep-thinking',
  'create.look.avatar.confused',
  'create.look.avatar.connecting',
  'create.look.avatar.approval',
  'create.look.avatar.celebration',
] as const

function avatarLabel(path: string): string {
  const i = AVATAR_ASSETS.indexOf(path)
  return i >= 0 && AVATAR_LABELS[i] ? tr(AVATAR_LABELS[i]) : tr('create.look.avatar')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function CreateBotOverlay({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const [job, setJob] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [soul, setSoul] = useState('')
  const [soulEdited, setSoulEdited] = useState(false)
  const [color, setColor] = useState<string | null>(null)
  const [avatar, setAvatar] = useState<string | null>(null)
  const [checklist, setChecklist] = useState<CreateChecklist>(() => loadCreateDefaults())
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [createdName, setCreatedName] = useState<string | null>(null)
  useStore(locale) // re-render every label when the language flips

  const suggested = useMemo(() => slugifyName(job), [job])
  const finalName = useMemo(
    () => (nameEdited ? name : suggested).trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bot',
    [name, nameEdited, suggested],
  )
  const draftSoul = useMemo(() => soulDraft(job, finalName), [job, finalName])
  const effectiveColor = color ?? accentFor(finalName)

  useEffect(() => { if (!nameEdited) setName(suggested) }, [suggested, nameEdited])
  useEffect(() => { if (!soulEdited) setSoul(draftSoul) }, [draftSoul, soulEdited])
  useEffect(() => { void listLaunchSkills().then(setSkills) }, [])

  const create = async () => {
    if (!job.trim() || busy) return
    setBusy(true); setErr(''); setCreatedName(null)
    try {
      const res = await createBot({
        name: finalName,
        description: job.trim(),
        soul: soulEdited ? soul : draftSoul,
        checklist,
        color: effectiveColor,
        avatar,
      })
      if (!res.ok) throw new Error(res.error || 'The gateway refused the create')
      saveCreateDefaults(checklist)
      setCreatedName(finalName)
      await setActiveBot(finalName)
      const sid = await newChat()
      await submitIntroTurn(sid, tr('create.intro.prompt', { name: finalName, job: job.trim() }))
      onCreated(finalName)
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  const label: React.CSSProperties = {
    fontSize: 11.5, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: 'var(--text-faint)', marginBottom: 6,
  }

  return (
    <div
      className="scrim"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="modal" style={{ width: 580 }} role="dialog" aria-modal="true" aria-label={tr('create.title')}>
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={15} color="var(--acc)" /> {tr('create.title')}
          </span>
          <button className="btn ghost sm" onClick={onClose} disabled={busy} aria-label={tr('create.cancel')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section>
            <div style={label}>{tr('create.job.label')}</div>
            <textarea
              className="input"
              rows={3}
              autoFocus
              placeholder={tr('create.job.placeholder')}
              value={job}
              onChange={(e) => setJob(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  className={`chip${job.trim() === tr(s.job) ? ' active' : ''}`}
                  onClick={() => { setJob(tr(s.job)); setNameEdited(false) }}
                >
                  {tr(s.label)}
                </button>
              ))}
            </div>
          </section>

          <section style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="rk-avatar" style={{ background: effectiveColor }}>
              {avatar
                ? <img src={avatar} alt="" width={20} height={20} />
                : finalName.slice(0, 2)}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{tr('create.name.label')}</span>
            <input
              className="input mono"
              style={{ flex: 1, fontSize: 12.5 }}
              value={nameEdited ? name : suggested}
              onChange={(e) => { setNameEdited(true); setName(e.target.value) }}
              placeholder={suggested}
              spellCheck={false}
              aria-label={tr('create.name.label')}
            />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...label, display: 'flex', alignItems: 'baseline', gap: 8 }}>
              {tr('create.soul.label')}
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 11.5 }}>
                {tr('create.soul.hint')}
              </span>
            </div>
            <textarea
              className="input mono"
              style={{ minHeight: 120, fontSize: 12.5, lineHeight: 1.55 }}
              value={soulEdited ? soul : draftSoul}
              onChange={(e) => { setSoulEdited(true); setSoul(e.target.value) }}
              spellCheck={false}
            />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...label, marginBottom: 0 }}>{tr('create.look.label')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-faint)', width: 44 }}>{tr('create.look.color')}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {CREATE_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    aria-label={c}
                    title={c}
                    style={{
                      width: 22, height: 22, borderRadius: 7, background: c, cursor: 'pointer',
                      outline: effectiveColor === c ? '2px solid var(--text)' : 'none',
                      outlineOffset: 2, border: 'none', padding: 0,
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-faint)', width: 44 }}>{tr('create.look.avatar')}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className={`chip${avatar === null ? ' active' : ''}`}
                  onClick={() => setAvatar(null)}
                  title={tr('create.look.avatar.none')}
                >
                  {tr('create.look.avatar.none')}
                </button>
                {AVATAR_ASSETS.map((a) => (
                  <button
                    key={a}
                    onClick={() => setAvatar(a)}
                    aria-label={avatarLabel(a)}
                    title={avatarLabel(a)}
                    style={{
                      width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
                      background: avatar === a ? 'var(--bg-hover)' : 'transparent',
                      border: `1px solid ${avatar === a ? 'var(--acc)' : 'var(--border-soft)'}`,
                      cursor: 'pointer', padding: 0,
                    }}
                  >
                    <img src={a} alt="" width={22} height={22} />
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...label, marginBottom: 0 }}>{tr('create.start.label')}</div>
            <CheckRow
              on={checklist.copyUserMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyUserMemory: !c.copyUserMemory }))}
              title={tr('fleet.create.ideas')}
              sub={tr('fleet.create.ideas.hint')}
            />
            <CheckRow
              on={checklist.copyMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyMemory: !c.copyMemory }))}
              title={tr('fleet.create.memory')}
              sub={tr('fleet.create.memory.hint')}
            />
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '4px 0 6px' }}>{tr('fleet.create.skills')}</div>
              {skills.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{tr('fleet.create.skills.empty')}</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {skills.map((s) => (
                    <button
                      key={s.path}
                      className={`chip${checklist.skills.includes(s.name) ? ' active' : ''}`}
                      title={s.description}
                      onClick={() => setChecklist((c) => ({
                        ...c,
                        skills: c.skills.includes(s.name) ? c.skills.filter((x) => x !== s.name) : [...c.skills, s.name],
                      }))}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {err ? (
            <div style={{ fontSize: 12, color: 'var(--red)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>{createdName ? tr('create.err.late', { name: createdName, why: err }) : tr('create.err', { why: err })}</span>
              {createdName ? (
                <button className="btn sm" onClick={() => onCreated(createdName)}>
                  {tr('create.openanyway', { name: createdName })}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>{tr('create.cancel')}</button>
          <button className="btn primary" disabled={busy || !job.trim()} onClick={() => void create()}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Sparkles size={13} />}
            {busy ? tr('create.cta.busy', { name: finalName }) : tr('create.cta')}
          </button>
        </div>
      </div>
    </div>
  )
}

function CheckRow({ on, onToggle, title, sub }: { on: boolean; onToggle: () => void; title: string; sub: string }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px',
        borderRadius: 'var(--radius)', background: 'var(--bg-card)', textAlign: 'start', width: '100%',
        border: `1px solid ${on ? 'var(--acc)' : 'var(--border-soft)'}`,
      }}
    >
      <span style={{
        width: 16, height: 16, marginTop: 1, borderRadius: 5, display: 'grid', placeItems: 'center',
        background: on ? 'var(--acc)' : 'transparent', color: 'var(--on-acc)', flexShrink: 0,
        border: `1px solid ${on ? 'var(--acc)' : 'var(--border)'}`,
      }}>
        {on ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      <span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>{sub}</span>
      </span>
    </button>
  )
}
