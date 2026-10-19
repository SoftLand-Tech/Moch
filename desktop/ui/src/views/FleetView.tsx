import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Check, FileText, Folder, GitBranch, KanbanSquare, ChevronRight, Clock,
  MessageSquare, Pause, Play, Plus, Search, Sparkles, Trash2, TriangleAlert,
  X, Zap,
} from 'lucide-react'
import {
  accentFor, activeBotAtom, createProfile, deleteProfile, fleetProfiles,
  fleetStatusAtom, freezeProfile, listLaunchSkills, loadCreateDefaults,
  mirrorModelKey, refreshFleet, saveCreateDefaults, setActiveBot, seedHasSkips,
  slugifyName, soulDraft, type CreateChecklist, type FleetProfile, type LaunchSkill,
} from '../lib/fleet'
import { newChat } from '../lib/chat'
import { isConnected, rpc } from '../lib/gateway'
import { displayBotName, fmtWhen, type RunEntry } from '../lib/crew'
import { locale, tr } from '../lib/strings'

interface DescribeResult {
  soul?: string
  description?: string
  model?: { provider?: string; default?: string }
}

/** Capability cards for the fresh-fleet empty state. */
const TEMPLATES: { nameKey: string; pitchKey: string; jobKey: string; icon: typeof Folder }[] = [
  {
    nameKey: 'fleet.tpl.watch.name', pitchKey: 'fleet.tpl.watch.pitch', jobKey: 'fleet.tpl.watch.job', icon: Folder,
  },
  {
    nameKey: 'fleet.tpl.deals.name', pitchKey: 'fleet.tpl.deals.pitch', jobKey: 'fleet.tpl.deals.job', icon: Zap,
  },
  {
    nameKey: 'fleet.tpl.journal.name', pitchKey: 'fleet.tpl.journal.pitch', jobKey: 'fleet.tpl.journal.job', icon: FileText,
  },
  {
    nameKey: 'fleet.tpl.research.name', pitchKey: 'fleet.tpl.research.pitch', jobKey: 'fleet.tpl.research.job', icon: Search,
  },
]

/** Starter jobs offered as chips inside the wizard. */
const STARTERS: { labelKey: string; jobKey: string }[] = [
  { labelKey: 'create.starter.research.label', jobKey: 'create.starter.research.job' },
  { labelKey: 'create.starter.deals.label', jobKey: 'create.starter.deals.job' },
  { labelKey: 'create.starter.code.label', jobKey: 'create.starter.code.job' },
  { labelKey: 'create.starter.journal.label', jobKey: 'create.starter.journal.job' },
]

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Rail hand-offs. The rail navigates here through the app's onNav routing;
// these one-shot requests carry the intent that routing alone cannot (open
// the wizard, select a bot). Set before navigating, consumed on mount when
// this view was unmounted, or live via the window events when already shown.
let newBotRequested = false
let focusRequested: string | null = null

export function requestFleetNewBot(): void {
  newBotRequested = true
}

export function requestFleetFocus(name: string): void {
  focusRequested = name
}

export default function FleetView({ onOpenChat }: { onOpenChat?: () => void }) {
  const profiles = useStore(fleetProfiles)
  const status = useStore(fleetStatusAtom)
  const activeBot = useStore(activeBotAtom)
  const connected = useStore(isConnected)
  useStore(locale)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardSeed, setWizardSeed] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => { void refreshFleet() }, [])

  // Consume rail hand-offs: once on mount (the rail set the request before
  // navigating here), then on the live events while this view stays open.
  useEffect(() => {
    const consume = () => {
      if (newBotRequested) {
        newBotRequested = false
        setWizardSeed('')
        setWizardOpen(true)
      }
      if (focusRequested !== null) {
        setSelected(focusRequested)
        setNotice('')
        focusRequested = null
      }
    }
    consume()
    window.addEventListener('moch-fleet-new-bot', consume)
    window.addEventListener('moch-fleet-focus', consume)
    return () => {
      window.removeEventListener('moch-fleet-new-bot', consume)
      window.removeEventListener('moch-fleet-focus', consume)
    }
    // One-shot wiring on mount; the setters it uses are stable.
  }, [])

  // Drop a selection that no longer exists (deleted on the server, etc).
  useEffect(() => {
    if (selected && profiles.length && !profiles.some((p) => p.name === selected)) setSelected(null)
  }, [profiles, selected])

  const selectedProfile = selected ? profiles.find((p) => p.name === selected) ?? null : null
  const onlyDefault = profiles.length === 0 || (profiles.length === 1 && profiles[0].name === 'default')

  const statusOf = (name: string) => status?.profiles.find((p) => p.name === name)

  const openChat = async (name: string) => {
    setErr('')
    try {
      await setActiveBot(name === 'default' ? null : name)
      await newChat()
      onOpenChat?.()
      window.dispatchEvent(new CustomEvent('moch-navigate', { detail: 'chat' }))
    } catch (e) {
      setErr(errText(e))
    }
  }

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">{tr('fleet.title')}</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title={tr('fleet.create')} onClick={() => { setWizardSeed(''); setWizardOpen(true) }}>
              <Plus size={15} /> {tr('fleet.create')}
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {profiles.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
              {connected ? tr('fleet.roster.loading') : tr('fleet.roster.waiting')}
            </div>
          ) : (
            <>
              <div className="row-section">{tr('fleet.roster.bots', { n: profiles.length })}</div>
              {profiles.map((p) => {
                const frozen = !!statusOf(p.name)?.frozen
                return (
                  <div
                    key={p.name}
                    className={`row${selected === p.name ? ' active' : ''}`}
                    style={{ alignItems: 'center', padding: '7px 10px' }}
                    onMouseEnter={() => setHovered(p.name)}
                    onMouseLeave={() => setHovered((h) => (h === p.name ? null : h))}
                    onClick={() => { setSelected(p.name); setNotice('') }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(p.name)}
                  >
                    <span className="avatar" style={{ width: 26, height: 26, fontSize: 10.5, background: accentFor(p.name) }}>
                      {displayBotName(p.name).slice(0, 2)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span
                        className="row-title"
                        style={{ color: selected === p.name ? undefined : activeBot === p.name ? accentFor(p.name) : undefined, fontWeight: activeBot === p.name ? 650 : undefined }}
                      >
                        {displayBotName(p.name)}
                      </span>
                      <span className="row-sub" style={{ maxWidth: 'none' }}>{p.description || tr('rail.nodesc')}</span>
                    </span>
                    {hovered === p.name ? (
                      <button
                        className="chip"
                        style={{ padding: '2px 8px', gap: 4 }}
                        title={tr('fleet.chat.named.title', { name: displayBotName(p.name) })}
                        onClick={(e) => { e.stopPropagation(); void openChat(p.name) }}
                      >
                        <MessageSquare size={11} /> {tr('fleet.chat.button')}
                      </button>
                    ) : frozen ? (
                      <span title={tr('fleet.frozen.title')} style={{ display: 'inline-flex', flexShrink: 0 }}>
                        <Pause size={12} color="var(--amber)" />
                      </span>
                    ) : activeBot === p.name ? (
                      <span title={tr('fleet.active.title')} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green-soft)', boxShadow: '0 0 6px rgba(74,222,128,0.6)', flexShrink: 0 }} />
                    ) : null}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </aside>

      <main className="focus">
        <div className="focus-head">
          {selectedProfile ? (
            <>
              <span className="avatar" style={{ width: 28, height: 28, fontSize: 11.5, background: accentFor(selectedProfile.name) }}>
                {displayBotName(selectedProfile.name).slice(0, 2)}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap' }}>{displayBotName(selectedProfile.name)}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  @{selectedProfile.name}
                </span>
              </div>
              {statusOf(selectedProfile.name)?.gateHeld ? (
                <span className="chip active" style={{ cursor: 'default', padding: '2px 8px' }}>{tr('fleet.gateheld')}</span>
              ) : null}
              <div style={{ flex: 1 }} />
              <button
                className="btn ghost sm"
                disabled={!connected}
                title={statusOf(selectedProfile.name)?.frozen ? tr('fleet.resume.title') : tr('fleet.freeze.title')}
                onClick={() => void freezeToggle(selectedProfile.name, !statusOf(selectedProfile.name)?.frozen, setErr)}
              >
                {statusOf(selectedProfile.name)?.frozen ? <Play size={13} /> : <Pause size={13} />}
                {statusOf(selectedProfile.name)?.frozen ? tr('fleet.resume') : tr('fleet.freeze.btn')}
              </button>
              <button className="btn primary sm" onClick={() => void openChat(selectedProfile.name)}>
                <MessageSquare size={13} /> {tr('fleet.chat.button')}
              </button>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 650, fontSize: 15 }}>{tr('fleet.title')}</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {tr(profiles.length === 1 ? 'fleet.head.count.one' : 'fleet.head.count.many', { n: profiles.length })}
              </span>
            </>
          )}
        </div>
        {err ? <div style={{ padding: '6px 18px 8px', fontSize: 12, color: 'var(--red)' }}>{err}</div> : null}

        {selectedProfile ? (
          <BotDetail key={selectedProfile.name} profile={selectedProfile} notice={notice} onErr={setErr} />
        ) : onlyDefault ? (
          <div className="focus-body">
            <div className="empty" style={{ padding: '36px 20px', gap: 12 }}>
              <span className="avatar" style={{ width: 54, height: 54, fontSize: 22, borderRadius: 16, background: 'var(--accent)' }}>M</span>
              <div className="empty-title">{tr('fleet.empty.title')}</div>
              <div className="empty-sub" style={{ maxWidth: 460 }}>
                {tr('fleet.empty.sub')}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(190px, 250px))', gap: 10, marginTop: 14 }}>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.nameKey}
                    onClick={() => { setWizardSeed(tr(t.jobKey)); setWizardOpen(true) }}
                    style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', border: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 5, cursor: 'pointer' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
                      <t.icon size={14} color="var(--accent)" /> {tr(t.nameKey)}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.45 }}>{tr(t.pitchKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="focus-body">
            <div className="empty">
              <Bot size={28} color="var(--text-faint)" />
              <div className="empty-title">{tr('fleet.pick.title')}</div>
              <div className="empty-sub">{tr('fleet.pick.sub')}</div>
            </div>
          </div>
        )}
      </main>

      {wizardOpen ? (
        <NewBotWizard
          seed={wizardSeed}
          onClose={() => setWizardOpen(false)}
          onCreated={(name, createdNotice) => {
            setWizardOpen(false)
            setSelected(name)
            setNotice(createdNotice)
          }}
        />
      ) : null}
    </>
  )
}

async function freezeToggle(name: string, frozen: boolean, onErr: (m: string) => void): Promise<void> {
  try {
    await freezeProfile(name, frozen)
  } catch (e) {
    onErr(errText(e))
  }
}

// ── bot detail (the whole editor — one profiles.configure save) ─────────────

function BotDetail({ profile, notice, onErr }: { profile: FleetProfile; notice: string; onErr: (m: string) => void }) {
  useStore(locale)
  const [desc, setDesc] = useState('')
  const [soul, setSoul] = useState('')
  const [base, setBase] = useState<{ desc: string; soul: string } | null>(null)
  const [provider, setProvider] = useState<string | null>(null) // null = loading, '' = none
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [mirroring, setMirroring] = useState(false)
  const [mirrorResult, setMirrorResult] = useState('')
  const [armDelete, setArmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setBase(null); setProvider(null); setMirrorResult(''); setSavedAt(0); setArmDelete(false)
    rpc<{ result?: DescribeResult } & DescribeResult>('profiles.describe', { name: profile.name }, 10000)
      .then((res) => {
        if (!alive) return
        const d = res.result ?? res
        const dd = typeof d.description === 'string' ? d.description : ''
        const ss = typeof d.soul === 'string' ? d.soul : ''
        setDesc(dd); setSoul(ss); setBase({ desc: dd, soul: ss })
        setProvider(d.model?.provider ?? '')
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        // Older gateways: fall back to whatever profiles.list gave us.
        setDesc(profile.description ?? ''); setSoul(''); setBase({ desc: profile.description ?? '', soul: '' })
        setProvider(profile.model?.provider ?? '')
        setLoading(false)
        onErr(tr('fleet.detail.loaderr', { why: errText(e) }))
      })
    return () => { alive = false }
    // Re-run only when switching bots (the parent remounts us per name anyway) —
    // a fleet refresh must never clobber unsaved edits.
  }, [profile.name])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
  }, [])

  const dirty = !!base && (desc !== base.desc || soul !== base.soul)

  const save = async () => {
    setSaving(true); onErr('')
    try {
      await rpc('profiles.configure', { name: profile.name, description: desc, soul }, 15000)
      setBase({ desc, soul })
      setSavedAt(Date.now())
      void refreshFleet()
    } catch (e) {
      onErr(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const mirror = async () => {
    setMirroring(true); onErr('')
    try {
      const r = await mirrorModelKey(profile.name)
      const n = r.mirrored?.length ?? 0
      setMirrorResult(
        n > 0
          ? tr(n === 1 ? 'fleet.mirror.done.one' : 'fleet.mirror.done.many', { n, list: r.mirrored.join(', ') })
          : tr('fleet.mirror.none'),
      )
    } catch (e) {
      onErr(errText(e))
    } finally {
      setMirroring(false)
    }
  }

  const onDelete = async () => {
    if (profile.name === 'default') return
    if (!armDelete) {
      setArmDelete(true)
      if (disarmTimer.current) clearTimeout(disarmTimer.current)
      disarmTimer.current = setTimeout(() => setArmDelete(false), 3000)
      return
    }
    setDeleting(true); onErr('')
    try {
      await deleteProfile(profile.name)
    } catch (e) {
      onErr(errText(e))
      setDeleting(false)
    }
  }

  const label: React.CSSProperties = { fontSize: 11.5, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 6 }

  return (
    <div className="focus-body" style={{ padding: '16px max(24px, 7%) 32px', gap: 20 }}>
      {notice ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 'var(--radius)', background: 'var(--amber-soft)', border: '1px solid var(--amber)', fontSize: 12.5, color: 'var(--amber)' }}>
          <TriangleAlert size={14} /> {notice}
        </div>
      ) : null}

      <section>
        <div style={label}>{tr('fleet.detail.desc.label')}</div>
        <textarea
          className="input"
          rows={2}
          disabled={loading}
          placeholder={tr('fleet.detail.desc.ph')}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...label, display: 'flex', alignItems: 'center', gap: 8 }}>
          SOUL.md
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{tr('fleet.detail.soul.sub')}</span>
        </div>
        <textarea
          className="input mono"
          style={{ minHeight: 200, fontSize: 12.5, lineHeight: 1.55 }}
          disabled={loading}
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          placeholder={loading ? tr('rail.chats.loading') : tr('fleet.detail.soul.ph')}
        />
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn primary" disabled={loading || saving || !dirty} onClick={() => void save()}>
          {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null} {tr('fleet.detail.save')}
        </button>
        {savedAt ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--green-soft)' }}>
            <Check size={13} /> {tr('fleet.detail.saved')}
          </span>
        ) : dirty ? (
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{tr('fleet.detail.unsaved')}</span>
        ) : null}
      </div>

      <section>
        {provider === null && loading ? null : provider === '' && !mirrorResult ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--radius)', background: 'var(--amber-soft)', border: '1px solid var(--amber)', flexWrap: 'wrap' }}>
            <TriangleAlert size={15} color="var(--amber)" />
            <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--amber)', fontWeight: 650 }}>{tr('fleet.noprovider.title')}</span>{' '}
              {tr('fleet.noprovider.body')}
            </div>
            <button className="btn sm" disabled={mirroring} onClick={() => void mirror()}>
              {mirroring ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null} {tr('fleet.noprovider.mirror')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-dim)' }}>
            <Check size={13} color="var(--green-soft)" />
            {mirrorResult || (provider ? <>{tr('fleet.provider.label')} <span className="mono" style={{ color: 'var(--text)' }}>{provider}</span></> : tr('fleet.provider.ready'))}
          </div>
        )}
      </section>

      <BotRuns profile={profile.name} />

      <section style={{ marginTop: 'auto', paddingTop: 18, borderTop: '1px solid var(--border-soft)' }}>
        <div style={{ ...label, color: 'var(--red)' }}>{tr('fleet.danger.title')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--radius)', background: 'var(--red-soft)', border: '1px solid rgba(255,90,90,0.3)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--text-dim)' }}>
            {tr('fleet.danger.body')}
          </div>
          <button
            className="btn danger"
            disabled={profile.name === 'default' || deleting}
            title={profile.name === 'default' ? tr('fleet.danger.mochi') : undefined}
            onClick={() => void onDelete()}
          >
            <Trash2 size={13} />
            {deleting ? tr('fleet.danger.deleting') : armDelete ? tr('fleet.danger.confirm') : tr('fleet.danger.delete')}
          </button>
        </div>
      </section>
    </div>
  )
}


// ── per-bot run history (the fleet observability slice) ────────────────────

function BotRuns({ profile }: { profile: string }) {
  useStore(locale)
  const [runs, setRuns] = useState<RunEntry[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = () => {
      rpc<{ runs?: RunEntry[] }>('moch.runs.timeline', { limit: 60 }, 15000)
        .then((res) => { if (!cancelled) setRuns((res.runs ?? []).filter((r) => (profile === 'default' ? r.profile === 'default' || !r.profile : r.profile === profile))) })
        .catch(() => { if (!cancelled) setRuns([]) })
    }
    load()
    const t = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [open, profile])

  const icon = (src: RunEntry['source']) =>
    src === 'cron' ? <Clock size={12} /> : src === 'delegate' ? <GitBranch size={12} /> : <KanbanSquare size={12} />
  const failed = (r: RunEntry) => /fail|error|blocked|cancel/i.test(r.status)

  return (
    <section style={{ paddingTop: 18 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <div style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{tr('fleet.runs.title')}</div>
        <ChevronRight size={13} color="var(--text-faint)" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
      </button>
      {open ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 0' }}>{tr('fleet.runs.empty')}</div>
          ) : runs.slice(0, 12).map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: failed(r) ? 'var(--red)' : 'var(--text-dim)', padding: '4px 0' }}>
              {icon(r.source)}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title || r.id}</span>
              <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{r.status}</span>
              {r.ts ? <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{fmtWhen(r.ts)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

// ── new bot wizard ──────────────────────────────────────────────────────────

function NewBotWizard({ seed, onClose, onCreated }: { seed: string; onClose: () => void; onCreated: (name: string, notice: string) => void }) {
  useStore(locale)
  const [job, setJob] = useState(seed)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [checklist, setChecklist] = useState<CreateChecklist>(() => loadCreateDefaults())
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const suggested = useMemo(() => slugifyName(job), [job])
  useEffect(() => { if (!nameEdited) setName(suggested) }, [suggested, nameEdited])

  useEffect(() => { void listLaunchSkills().then(setSkills) }, [])

  const finalName = (nameEdited ? name : suggested).trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bot'

  const create = async () => {
    if (!job.trim()) return
    setBusy(true); setErr('')
    try {
      const res = await createProfile({
        name: finalName,
        description: job.trim(),
        soul: soulDraft(job, finalName),
        checklist,
      })
      if (!res.ok) throw new Error(res.error || tr('fleet.wizard.refused'))
      saveCreateDefaults(checklist)
      let createdNotice = ''
      if (res.seed && seedHasSkips(res.seed)) {
        createdNotice = tr('fleet.wizard.partialSeed')
      } else if (res.seedError) {
        createdNotice = tr('fleet.wizard.seedFail', { why: res.seedError })
      }
      onCreated(finalName, createdNotice)
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 580 }} role="dialog" aria-label={tr('fleet.create')}>
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={15} color="var(--accent)" /> {tr('fleet.create')}
          </span>
          <button className="btn ghost sm" onClick={onClose} aria-label={tr('settings.close')}><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 6 }}>{tr('fleet.detail.desc.label')}</div>
            <textarea
              className="input"
              rows={3}
              autoFocus
              placeholder={tr('fleet.wizard.job.ph')}
              value={job}
              onChange={(e) => setJob(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {STARTERS.map((s) => (
                <button key={s.labelKey} className={`chip${job.trim() === tr(s.jobKey) ? ' active' : ''}`} onClick={() => { setJob(tr(s.jobKey)); setNameEdited(false) }}>
                  {tr(s.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="avatar" style={{ width: 26, height: 26, fontSize: 10.5, background: accentFor(finalName) }}>{finalName.slice(0, 2)}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{tr('fleet.wizard.name')}</span>
            <input
              className="input mono"
              style={{ flex: 1, fontSize: 12.5 }}
              value={nameEdited ? name : suggested}
              onChange={(e) => { setNameEdited(true); setName(e.target.value) }}
              placeholder={suggested}
              spellCheck={false}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650 }}>{tr('fleet.wizard.start')}</div>
            <CheckRow
              on={checklist.copyUserMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyUserMemory: !c.copyUserMemory }))}
              title={tr('fleet.create.ideas')}
              sub={tr('fleet.wizard.ideas.sub')}
            />
            <CheckRow
              on={checklist.copyMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyMemory: !c.copyMemory }))}
              title={tr('fleet.create.memory')}
              sub={tr('fleet.wizard.memory.sub')}
            />
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '4px 0 6px' }}>{tr('fleet.wizard.skills')}</div>
              {skills.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{tr('fleet.wizard.skills.empty')}</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {skills.map((s) => (
                    <button
                      key={s.path}
                      className={`chip${checklist.skills.includes(s.name) ? ' active' : ''}`}
                      title={s.description}
                      onClick={() => setChecklist((c) => ({ ...c, skills: c.skills.includes(s.name) ? c.skills.filter((x) => x !== s.name) : [...c.skills, s.name] }))}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {err ? <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div> : null}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>{tr('fleet.cancel')}</button>
          <button className="btn primary" disabled={busy || !job.trim()} onClick={() => void create()}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Sparkles size={13} />} {tr('fleet.create.cta')}
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
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--bg-card)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`, textAlign: 'left', width: '100%' }}
    >
      <span style={{ width: 16, height: 16, marginTop: 1, borderRadius: 5, display: 'grid', placeItems: 'center', background: on ? 'var(--accent)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: 'var(--on-accent)', flexShrink: 0 }}>
        {on ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      <span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>{sub}</span>
      </span>
    </button>
  )
}
