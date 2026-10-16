/**
 * Desktop Fleet — the bots surface as a dense table over the same engine
 * calls as the phone screen (app/app/(tabs)/fleet.tsx): profiles.list +
 * fleet runtime via refreshFleet/fleetProfiles/fleetStatusAtom, freeze via
 * freezeProfile, create via createProfile (with the persisted checklist and
 * launch-skill picker), and the chat hand-off via setActiveBot + newChat —
 * the same botProfile param path the phone chat consumes.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  CreateChecklist,
  DEFAULT_CHECKLIST,
  FleetProfile,
  LaunchSkill,
  createProfile,
  fleetError,
  fleetProfiles,
  fleetStatusAtom,
  freezeProfile,
  listLaunchSkills,
  loadCreateDefaults,
  refreshFleet,
  saveCreateDefaults,
  seedHasSkips,
  setActiveBot,
  slugifyName,
  soulDraft,
} from '../../../../../app/src/lib/fleet'
import { newChat } from '../../../../../app/src/lib/chat'
import { isConnected } from '../../../../../app/src/lib/gateway'
import { setShellLayout } from '../shell/state'

/** §2.7 starter templates: tappable job seeds — zero typing path. */
const STARTERS: { label: string; job: string }[] = [
  { label: 'Research', job: 'Research assistant: read my saved sources daily and brief me on what changed.' },
  { label: 'Deals', job: 'Deal watcher: track product pages I name and notify me on price drops.' },
  { label: 'Code (PC)', job: 'Code helper bound to my linked PC: work in my repos on request.' },
  { label: 'Private journal', job: 'Private journal/finance watcher over my own local files only — never sends anything anywhere.' },
]

export default function Fleet(): React.JSX.Element {
  const online = useStore(isConnected)
  const profiles = useStore(fleetProfiles)
  const status = useStore(fleetStatusAtom)
  const refreshError = useStore(fleetError)
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!online) {
      setLoaded(true)
      return
    }
    return refreshFleet()
  }, [online])

  useEffect(() => {
    setLoaded(false)
    void (refresh() ?? Promise.resolve()).finally(() => setLoaded(true))
  }, [refresh])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  const frozenSet = new Set((status?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name))
  const waiting = status?.queue.waiting ?? []

  const toggleFreeze = async (pf: FleetProfile) => {
    if (busy) return
    setBusy(pf.name)
    try {
      await freezeProfile(pf.name, !frozenSet.has(pf.name))
      setNote(frozenSet.has(pf.name) ? `Unfroze “${pf.name}”` : `Froze “${pf.name}”`)
    } catch (e) {
      setNote(`Freeze failed for ${pf.name} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  // The Fleet screen hands over a bot identity: set active + fresh bot chat,
  // then let the shell bring Chat to front.
  const chatWith = async (pf: FleetProfile) => {
    if (busy) return
    setBusy(pf.name)
    try {
      await setActiveBot(pf.name)
      await newChat()
      setShellLayout({ screen: 'chat' })
    } catch (e) {
      setNote(`Could not open a chat with ${pf.name} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const runtimeLine = (pf: FleetProfile) => {
    if (frozenSet.has(pf.name)) return 'frozen'
    if (!status) return '—'
    return status.fleetEnabled ? `active ${status.queue.active}/${status.queue.slots}` : 'idle'
  }

  return (
    <div className="mos-root">
      <style>{css}</style>
      <header className="mos-head">
        <h2>Fleet</h2>
        {status ? (
          <span className="mos-sub">
            {status.fleetEnabled ? `Runtime active — ${status.queue.active}/${status.queue.slots}` : 'Runtime idle'}
            {waiting.length > 0 ? ` · ${waiting.length} waiting (${waiting.map((w) => w.priority).join(', ')})` : ''}
          </span>
        ) : null}
        <button className="mos-btn mos-spring" onClick={() => void refresh()} disabled={!online} aria-label="Refresh fleet">Refresh</button>
        <button className="mos-btn mos-accent" onClick={() => setCreating(true)} disabled={!online}>＋ Create bot</button>
      </header>

      {refreshError ? <div className="mos-banner" role="alert">Offline: {refreshError}</div> : null}
      {note ? <div className="mos-toast" role="status">{note}</div> : null}

      {!online && loaded ? (
        <div className="mos-empty" role="status">
          <p className="mos-emptyTitle">Not connected</p>
          <p className="mos-emptyBody">Bots live on your computer. Connect, then refresh.</p>
          <button className="mos-btn" onClick={() => void refresh()}>Refresh</button>
        </div>
      ) : !loaded ? (
        <div className="mos-spin" aria-label="Loading bots" />
      ) : profiles.length === 0 ? (
        <div className="mos-empty">
          <p className="mos-emptyTitle">No bots yet</p>
          <p className="mos-emptyBody">Give the agent a name and a job — it becomes a profile you can chat with, freeze, and equip.</p>
          <button className="mos-btn mos-accent" onClick={() => setCreating(true)} disabled={!online}>Create bot</button>
        </div>
      ) : (
        <div className="mos-scroller">
          <table className="mos-table">
            <thead>
              <tr>
                <th className="mos-th">Name</th>
                <th className="mos-th">Description</th>
                <th className="mos-th">Runtime</th>
                <th className="mos-th mos-w-frozen">Frozen</th>
                <th className="mos-th mos-w-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {profiles.map((pf) => {
                const frozen = frozenSet.has(pf.name)
                const rowBusy = busy === pf.name
                return (
                  <tr
                    key={pf.name}
                    className={`mos-row${selected === pf.name ? ' mos-sel' : ''}`}
                    onClick={() => setSelected(pf.name)}
                  >
                    <td className="mos-td mos-name" title={pf.description || pf.name}>{pf.name}</td>
                    <td className="mos-td mos-desc" title={pf.description}>{pf.description || '—'}</td>
                    <td className="mos-td">{runtimeLine(pf)}</td>
                    <td className="mos-td mos-w-frozen">
                      <button
                        className={`mos-toggle${frozen ? '' : ' mos-toggleOff'}`}
                        disabled={rowBusy || !!busy}
                        title={frozen ? 'Unfreeze' : 'Freeze'}
                        aria-label={frozen ? `Unfreeze ${pf.name}` : `Freeze ${pf.name}`}
                        onClick={(e) => { e.stopPropagation(); void toggleFreeze(pf) }}
                      >
                        <span className="mos-knob" />
                      </button>
                    </td>
                    <td className="mos-td mos-w-actions">
                      {rowBusy ? (
                        <span className="mos-spinSm" aria-label="Working" />
                      ) : (
                        <>
                          <button className="mos-btn" onClick={(e) => { e.stopPropagation(); void chatWith(pf) }}>Chat</button>
                          <button
                            className="mos-btn"
                            title="Deferred: bot detail (soul, memory files, skills) has no desktop surface yet"
                            onClick={(e) => { e.stopPropagation(); setNote(`Bot detail for “${pf.name}” is deferred — the phone's bot screen has no desktop pane yet. Context and skills were seeded at creation.`) }}
                          >
                            Details
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateBox
          onClose={() => setCreating(false)}
          onNote={(m) => setNote(m)}
          onCreated={(msg) => { setCreating(false); setNote(msg) }}
        />
      ) : null}
    </div>
  )
}

/** Creation dialog — the phone's create box: starters, checklist, skill picker. */
function CreateBox(props: { onClose: () => void; onNote: (msg: string) => void; onCreated: (msg: string) => void }): React.JSX.Element {
  const online = useStore(isConnected)
  const [job, setJob] = useState('')
  const [busy, setBusy] = useState(false)
  // Persisted defaults + launch-skill picker (moch.skills.list; older
  // gateways answer nothing and the picker renders its empty state — the
  // checklist never blocks creation).
  const [checklist, setChecklist] = useState<CreateChecklist>(DEFAULT_CHECKLIST)
  const [skillsList, setSkillsList] = useState<LaunchSkill[]>([])
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [createErr, setCreateErr] = useState('')

  useEffect(() => {
    void loadCreateDefaults().then(setChecklist)
    if (!skillsLoaded) {
      void listLaunchSkills().then((l) => {
        setSkillsList(l)
        setSkillsLoaded(true)
      })
    }
  }, [])

  const create = async () => {
    if (!job.trim() || busy) return
    setBusy(true)
    setCreateErr('')
    try {
      const name = slugifyName(job)
      const r = await createProfile({
        name,
        description: job.trim(),
        soul: soulDraft(job, name),
        checklist,
      })
      if (!r.ok) {
        setCreateErr(`Could not create the bot — ${r.error ?? 'profiles.create refused'}`)
        return
      }
      void saveCreateDefaults(checklist)
      // Bot exists — seeding outcome is best-effort and reported, never fatal.
      if (r.seedError) {
        props.onCreated(`Created “${name}” — but seeding failed: ${r.seedError}`)
        return
      }
      if (r.seed && seedHasSkips(r.seed)) {
        props.onCreated(`Created “${name}” — some checklist items were skipped`)
        return
      }
      props.onCreated(`Created “${name}”`)
    } catch (e) {
      setCreateErr(`Could not create the bot — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const toggleSkill = (name: string) => {
    setChecklist((c) => ({
      ...c,
      skills: c.skills.includes(name) ? c.skills.filter((n) => n !== name) : [...c.skills, name],
    }))
  }

  const close = () => { if (!busy) props.onClose() }

  return (
    <div className="mos-scrim" onClick={close}>
      <div className="mos-card" role="dialog" aria-modal aria-label="Create bot" onClick={(e) => e.stopPropagation()}>
        <div className="mos-cardHead">
          <strong>Create bot</strong>
          <button className="mos-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="mos-chips">
          {STARTERS.map((st) => (
            <button key={st.label} className={`mos-chip${job === st.job ? ' mos-chipOn' : ''}`} onClick={() => setJob(st.job)}>
              {st.label}
            </button>
          ))}
        </div>

        <textarea
          className="mos-input"
          rows={3}
          placeholder="Describe the bot's job…"
          value={job}
          autoFocus
          onChange={(e) => setJob(e.target.value)}
        />
        <p className="mos-hint">Name: {slugifyName(job) || '…'}</p>

        {/* Context/skills enter as FILES (USER.md, skills/), never prompt-stuffing
            — files persist, are visible/editable in bot detail, and ride the
            gateway's memory machinery. Existing files are never overwritten. */}
        <label className="mos-check">
          <input
            type="checkbox"
            checked={checklist.copyUserMemory}
            onChange={(e) => setChecklist((c) => ({ ...c, copyUserMemory: e.target.checked }))}
          />
          <span>
            Copy my USER.md <em>— the bot starts with what it already knows about me</em>
          </span>
        </label>
        <label className="mos-check">
          <input
            type="checkbox"
            checked={checklist.copyMemory}
            onChange={(e) => setChecklist((c) => ({ ...c, copyMemory: e.target.checked }))}
          />
          <span>
            Copy MEMORY.md too <em>— accumulated history; usually noisy for a fresh bot</em>
          </span>
        </label>

        <button className="mos-skillsToggle" aria-expanded={skillsOpen} onClick={() => setSkillsOpen((v) => !v)}>
          Skills{checklist.skills.length > 0 ? ` (${checklist.skills.length})` : ''} {skillsOpen ? '▾' : '▸'}
        </button>
        {skillsOpen ? (
          skillsLoaded && skillsList.length === 0 ? (
            <p className="mos-hint">No skills installed in the launch home yet.</p>
          ) : (
            <div className="mos-chips">
              {skillsList.map((sk) => (
                <button
                  key={sk.path}
                  className={`mos-chip${checklist.skills.includes(sk.name) ? ' mos-chipOn' : ''}`}
                  onClick={() => toggleSkill(sk.name)}
                >
                  {sk.name}
                </button>
              ))}
            </div>
          )
        ) : null}

        {createErr ? <p className="mos-err" role="alert">{createErr}</p> : null}

        <div className="mos-dialogBtns">
          <button className="mos-btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="mos-btn mos-accent" onClick={() => void create()} disabled={!job.trim() || busy || !online}>
            {busy ? 'Creating…' : 'Create bot'}
          </button>
        </div>
      </div>
    </div>
  )
}

const css = `
/* Local to Fleet: the shared table kit (desktop.css) covers the rest. */
.mos-w-frozen { width: 72px; }
.mos-banner { padding: 6px 16px; color: var(--moch-red); font-size: 12.5px; border-bottom: 1px solid var(--moch-border-soft); flex: none; }
.mos-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--moch-text); cursor: pointer; }
.mos-check input { margin-top: 2px; accent-color: var(--moch-accent); }
.mos-check em { color: var(--moch-text-faint); font-style: normal; }
.mos-skillsToggle { background: none; border: none; color: var(--moch-text-dim); font-size: 12.5px; cursor: pointer; padding: 0; text-align: left; font-family: inherit; }
.mos-skillsToggle:hover { color: var(--moch-text); }
`
