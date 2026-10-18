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

interface DescribeResult {
  soul?: string
  description?: string
  model?: { provider?: string; default?: string }
}

/** Capability cards for the fresh-fleet empty state. */
const TEMPLATES: { name: string; pitch: string; job: string; icon: typeof Folder }[] = [
  {
    name: 'Watch a folder', pitch: 'Notices new files land and does the next right thing with them.', icon: Folder,
    job: 'Watch my Drop folder. When a new file lands, read it and do the next right thing — summarize long docs, sort and rename files, or ask me what to do.',
  },
  {
    name: 'Hunt deals daily', pitch: 'Scans listings every morning and surfaces only the wins.', icon: Zap,
    job: 'Hunt deals daily. Scan the listings and marketplaces I care about each morning and surface only the genuinely good deals, with a short note on why each one is worth it.',
  },
  {
    name: 'Keep my journal', pitch: 'A nightly brain-dump companion that writes it all down.', icon: FileText,
    job: 'Keep my journal. Check in with me every evening, ask how the day went, and write a short dated entry I will actually want to reread.',
  },
  {
    name: 'Research anything', pitch: 'Deep-dives a topic and returns a tight, sourced brief.', icon: Search,
    job: 'Research anything. When I give you a topic, do a deep dive across the web and come back with a tight, sourced brief with the key findings up top.',
  },
]

/** Starter jobs offered as chips inside the wizard. */
const STARTERS: { label: string; job: string }[] = [
  { label: 'Research assistant', job: 'Help me research topics: gather sources, verify claims, and return tight briefs with the key findings up top.' },
  { label: 'Deal hunter', job: 'Hunt deals on things I am looking for. Check regularly and flag only the genuinely good ones, with a note on why.' },
  { label: 'Code helper', job: 'Help me write and review code in this workspace. Keep changes small, tested, and explained.' },
  { label: 'Daily journal', job: 'Check in each evening and keep a short journal of my day — one entry per day, easy to reread.' },
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
          <span className="ctx-title">Fleet</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title="New bot" onClick={() => { setWizardSeed(''); setWizardOpen(true) }}>
              <Plus size={15} /> New bot
            </button>
          </div>
        </div>
        <div className="ctx-body">
          {profiles.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
              {connected ? 'Loading the roster…' : 'Waiting for the gateway…'}
            </div>
          ) : (
            <>
              <div className="row-section">Bots · {profiles.length}</div>
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
                      <span className="row-sub" style={{ maxWidth: 'none' }}>{p.description || 'No description yet'}</span>
                    </span>
                    {hovered === p.name ? (
                      <button
                        className="chip"
                        style={{ padding: '2px 8px', gap: 4 }}
                        title={`Start a chat with ${displayBotName(p.name)} (new chats go to this bot)`}
                        onClick={(e) => { e.stopPropagation(); void openChat(p.name) }}
                      >
                        <MessageSquare size={11} /> Chat
                      </button>
                    ) : frozen ? (
                      <span title="Frozen — this bot is paused" style={{ display: 'inline-flex', flexShrink: 0 }}>
                        <Pause size={12} color="var(--amber)" />
                      </span>
                    ) : activeBot === p.name ? (
                      <span title="New chats go to this bot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green-soft)', boxShadow: '0 0 6px rgba(74,222,128,0.6)', flexShrink: 0 }} />
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
                <span className="chip active" style={{ cursor: 'default', padding: '2px 8px' }}>gate held</span>
              ) : null}
              <div style={{ flex: 1 }} />
              <button
                className="btn ghost sm"
                disabled={!connected}
                title={statusOf(selectedProfile.name)?.frozen ? 'Resume this bot' : 'Freeze this bot (it stops picking up work)'}
                onClick={() => void freezeToggle(selectedProfile.name, !statusOf(selectedProfile.name)?.frozen, setErr)}
              >
                {statusOf(selectedProfile.name)?.frozen ? <Play size={13} /> : <Pause size={13} />}
                {statusOf(selectedProfile.name)?.frozen ? 'Resume' : 'Freeze'}
              </button>
              <button className="btn primary sm" onClick={() => void openChat(selectedProfile.name)}>
                <MessageSquare size={13} /> Chat
              </button>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 650, fontSize: 15 }}>Fleet</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {profiles.length} bot{profiles.length === 1 ? '' : 's'} on this machine
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
              <div className="empty-title">Your fleet starts here</div>
              <div className="empty-sub" style={{ maxWidth: 460 }}>
                Bots are little agents with their own job, memory and skills. Give one a job
                and it works on this machine while you do other things — Mochi (your main
                agent) is already here to help.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(190px, 250px))', gap: 10, marginTop: 14 }}>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => { setWizardSeed(t.job); setWizardOpen(true) }}
                    style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', border: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 5, cursor: 'pointer' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
                      <t.icon size={14} color="var(--accent)" /> {t.name}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.45 }}>{t.pitch}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="focus-body">
            <div className="empty">
              <Bot size={28} color="var(--text-faint)" />
              <div className="empty-title">Pick a bot</div>
              <div className="empty-sub">Select a bot on the left to open its editor — job, SOUL.md, provider and all.</div>
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
        onErr(`Could not load the full bot file: ${errText(e)}`)
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
          ? `Mirrored ${n} key${n === 1 ? '' : 's'} (${r.mirrored.join(', ')}) — this bot now uses your provider.`
          : 'Nothing needed mirroring — the keys were already in place.',
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
        <div style={label}>What is this bot for?</div>
        <textarea
          className="input"
          rows={2}
          disabled={loading}
          placeholder="One or two sentences — this is the bot's job description."
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...label, display: 'flex', alignItems: 'center', gap: 8 }}>
          SOUL.md
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>the bot's personality and working agreement</span>
        </div>
        <textarea
          className="input mono"
          style={{ minHeight: 200, fontSize: 12.5, lineHeight: 1.55 }}
          disabled={loading}
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          placeholder={loading ? 'Loading…' : '# The bot soul — who it is, how it works.'}
        />
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn primary" disabled={loading || saving || !dirty} onClick={() => void save()}>
          {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null} Save
        </button>
        {savedAt ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--green-soft)' }}>
            <Check size={13} /> Saved
          </span>
        ) : dirty ? (
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Unsaved changes</span>
        ) : null}
      </div>

      <section>
        {provider === null && loading ? null : provider === '' && !mirrorResult ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--radius)', background: 'var(--amber-soft)', border: '1px solid var(--amber)', flexWrap: 'wrap' }}>
            <TriangleAlert size={15} color="var(--amber)" />
            <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--amber)', fontWeight: 650 }}>No provider.</span>{' '}
              This bot has no model credentials of its own — mirror your keys so it can actually run.
            </div>
            <button className="btn sm" disabled={mirroring} onClick={() => void mirror()}>
              {mirroring ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null} Use my provider
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-dim)' }}>
            <Check size={13} color="var(--green-soft)" />
            {mirrorResult || (provider ? <>Provider: <span className="mono" style={{ color: 'var(--text)' }}>{provider}</span></> : 'Provider ready.')}
          </div>
        )}
      </section>

      <BotRuns profile={profile.name} />

      <section style={{ marginTop: 'auto', paddingTop: 18, borderTop: '1px solid var(--border-soft)' }}>
        <div style={{ ...label, color: 'var(--red)' }}>Danger zone</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 'var(--radius)', background: 'var(--red-soft)', border: '1px solid rgba(255,90,90,0.3)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--text-dim)' }}>
            Deletes the bot's files, memory and skills. Chats stay, but the bot is gone for good.
          </div>
          <button
            className="btn danger"
            disabled={profile.name === 'default' || deleting}
            title={profile.name === 'default' ? 'Mochi, the main agent, cannot be deleted' : undefined}
            onClick={() => void onDelete()}
          >
            <Trash2 size={13} />
            {deleting ? 'Deleting…' : armDelete ? 'Tap again to confirm' : 'Delete this bot'}
          </button>
        </div>
      </section>
    </div>
  )
}


// ── per-bot run history (the fleet observability slice) ────────────────────

function BotRuns({ profile }: { profile: string }) {
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
        <div style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Recent runs</div>
        <ChevronRight size={13} color="var(--text-faint)" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
      </button>
      {open ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 0' }}>No runs recorded for this bot yet.</div>
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
      if (!res.ok) throw new Error(res.error || 'The gateway refused the create')
      saveCreateDefaults(checklist)
      let createdNotice = ''
      if (res.seed && seedHasSkips(res.seed)) {
        createdNotice = 'Bot created — but some seed steps were skipped (memory or skills copied only partially).'
      } else if (res.seedError) {
        createdNotice = `Bot created — seeding failed: ${res.seedError}`
      }
      onCreated(finalName, createdNotice)
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 580 }} role="dialog" aria-label="New bot">
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={15} color="var(--accent)" /> New bot
          </span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 6 }}>What is this bot for?</div>
            <textarea
              className="input"
              rows={3}
              autoFocus
              placeholder="Describe the job in a sentence or two — the bot's whole life is built around this."
              value={job}
              onChange={(e) => setJob(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {STARTERS.map((s) => (
                <button key={s.label} className={`chip${job.trim() === s.job ? ' active' : ''}`} onClick={() => { setJob(s.job); setNameEdited(false) }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="avatar" style={{ width: 26, height: 26, fontSize: 10.5, background: accentFor(finalName) }}>{finalName.slice(0, 2)}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>moch name</span>
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
            <div style={{ fontSize: 12.5, fontWeight: 650 }}>Start the bot with</div>
            <CheckRow
              on={checklist.copyUserMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyUserMemory: !c.copyUserMemory }))}
              title="Ideas about me"
              sub="Copy Mochi's ideas about you — tone, preferences, context."
            />
            <CheckRow
              on={checklist.copyMemory}
              onToggle={() => setChecklist((c) => ({ ...c, copyMemory: !c.copyMemory }))}
              title="Moch's work memory"
              sub="Also copy Mochi's work memory — projects, decisions, in-flight threads."
            />
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '4px 0 6px' }}>Launch skills</div>
              {skills.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>No launch skills installed.</div>
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
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !job.trim()} onClick={() => void create()}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Sparkles size={13} />} Create bot
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
