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
    <div className="mof-root">
      <style>{css}</style>
      <header className="mof-head">
        <h2>Fleet</h2>
        {status ? (
          <span className="mof-sub">
            {status.fleetEnabled ? `Runtime active — ${status.queue.active}/${status.queue.slots}` : 'Runtime idle'}
            {waiting.length > 0 ? ` · ${waiting.length} waiting (${waiting.map((w) => w.priority).join(', ')})` : ''}
          </span>
        ) : null}
        <button className="mof-btn" onClick={() => void refresh()} disabled={!online} aria-label="Refresh fleet">Refresh</button>
        <button className="mof-btn mof-accent" onClick={() => setCreating(true)} disabled={!online}>＋ Create bot</button>
      </header>

      {refreshError ? <div className="mof-banner" role="alert">Offline: {refreshError}</div> : null}
      {note ? <div className="mof-toast" role="status">{note}</div> : null}

      {!online && loaded ? (
        <div className="mof-empty" role="status">
          <p className="mof-emptyTitle">Not connected</p>
          <p className="mof-emptyBody">Bots live on your computer. Connect, then refresh.</p>
          <button className="mof-btn" onClick={() => void refresh()}>Refresh</button>
        </div>
      ) : !loaded ? (
        <div className="mof-spin" aria-label="Loading bots" />
      ) : profiles.length === 0 ? (
        <div className="mof-empty">
          <p className="mof-emptyTitle">No bots yet</p>
          <p className="mof-emptyBody">Give the agent a name and a job — it becomes a profile you can chat with, freeze, and equip.</p>
          <button className="mof-btn mof-accent" onClick={() => setCreating(true)} disabled={!online}>Create bot</button>
        </div>
      ) : (
        <div className="mof-scroller">
          <table className="mof-table">
            <thead>
              <tr>
                <th className="mof-th">Name</th>
                <th className="mof-th">Description</th>
                <th className="mof-th">Runtime</th>
                <th className="mof-th mof-w-frozen">Frozen</th>
                <th className="mof-th mof-w-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {profiles.map((pf) => {
                const frozen = frozenSet.has(pf.name)
                const rowBusy = busy === pf.name
                return (
                  <tr
                    key={pf.name}
                    className={`mof-row${selected === pf.name ? ' mof-sel' : ''}`}
                    onClick={() => setSelected(pf.name)}
                  >
                    <td className="mof-td mof-name" title={pf.description || pf.name}>{pf.name}</td>
                    <td className="mof-td mof-desc" title={pf.description}>{pf.description || '—'}</td>
                    <td className="mof-td">{runtimeLine(pf)}</td>
                    <td className="mof-td mof-w-frozen">
                      <button
                        className={`mof-toggle${frozen ? '' : ' mof-toggleOff'}`}
                        disabled={rowBusy || !!busy}
                        title={frozen ? 'Unfreeze' : 'Freeze'}
                        aria-label={frozen ? `Unfreeze ${pf.name}` : `Freeze ${pf.name}`}
                        onClick={(e) => { e.stopPropagation(); void toggleFreeze(pf) }}
                      >
                        <span className="mof-knob" />
                      </button>
                    </td>
                    <td className="mof-td mof-w-actions">
                      {rowBusy ? (
                        <span className="mof-spinSm" aria-label="Working" />
                      ) : (
                        <>
                          <button className="mof-btn" onClick={(e) => { e.stopPropagation(); void chatWith(pf) }}>Chat</button>
                          <button
                            className="mof-btn"
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
    <div className="mof-scrim" onClick={close}>
      <div className="mof-card" role="dialog" aria-modal aria-label="Create bot" onClick={(e) => e.stopPropagation()}>
        <div className="mof-cardHead">
          <strong>Create bot</strong>
          <button className="mof-x" aria-label="Close" onClick={close}>✕</button>
        </div>

        <div className="mof-chips">
          {STARTERS.map((st) => (
            <button key={st.label} className={`mof-chip${job === st.job ? ' mof-chipOn' : ''}`} onClick={() => setJob(st.job)}>
              {st.label}
            </button>
          ))}
        </div>

        <textarea
          className="mof-input"
          rows={3}
          placeholder="Describe the bot's job…"
          value={job}
          autoFocus
          onChange={(e) => setJob(e.target.value)}
        />
        <p className="mof-hint">Name: {slugifyName(job) || '…'}</p>

        {/* Context/skills enter as FILES (USER.md, skills/), never prompt-stuffing
            — files persist, are visible/editable in bot detail, and ride the
            gateway's memory machinery. Existing files are never overwritten. */}
        <label className="mof-check">
          <input
            type="checkbox"
            checked={checklist.copyUserMemory}
            onChange={(e) => setChecklist((c) => ({ ...c, copyUserMemory: e.target.checked }))}
          />
          <span>
            Copy my USER.md <em>— the bot starts with what it already knows about me</em>
          </span>
        </label>
        <label className="mof-check">
          <input
            type="checkbox"
            checked={checklist.copyMemory}
            onChange={(e) => setChecklist((c) => ({ ...c, copyMemory: e.target.checked }))}
          />
          <span>
            Copy MEMORY.md too <em>— accumulated history; usually noisy for a fresh bot</em>
          </span>
        </label>

        <button className="mof-skillsToggle" aria-expanded={skillsOpen} onClick={() => setSkillsOpen((v) => !v)}>
          Skills{checklist.skills.length > 0 ? ` (${checklist.skills.length})` : ''} {skillsOpen ? '▾' : '▸'}
        </button>
        {skillsOpen ? (
          skillsLoaded && skillsList.length === 0 ? (
            <p className="mof-hint">No skills installed in the launch home yet.</p>
          ) : (
            <div className="mof-chips">
              {skillsList.map((sk) => (
                <button
                  key={sk.path}
                  className={`mof-chip${checklist.skills.includes(sk.name) ? ' mof-chipOn' : ''}`}
                  onClick={() => toggleSkill(sk.name)}
                >
                  {sk.name}
                </button>
              ))}
            </div>
          )
        ) : null}

        {createErr ? <p className="mof-err" role="alert">{createErr}</p> : null}

        <div className="mof-dialogBtns">
          <button className="mof-btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="mof-btn mof-accent" onClick={() => void create()} disabled={!job.trim() || busy || !online}>
            {busy ? 'Creating…' : 'Create bot'}
          </button>
        </div>
      </div>
    </div>
  )
}

const css = `
.mof-root { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--moch-text); font-family: var(--moch-font); }
.mof-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--moch-border); }
.mof-head h2 { margin: 0; font-size: 15px; }
.mof-sub { color: var(--moch-text-dim); font-size: 12px; }
.mof-head .mof-btn:first-of-type { margin-left: auto; }
.mof-scroller { flex: 1; overflow: auto; min-height: 0; }
.mof-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mof-th { position: sticky; top: 0; z-index: 1; background: var(--moch-bg-card); color: var(--moch-text-faint); text-align: left; font-weight: 500; padding: 0 10px; height: 30px; border-bottom: 1px solid var(--moch-border); white-space: nowrap; }
.mof-row { height: var(--moch-row-h, 32px); cursor: default; }
.mof-row:hover { background: var(--moch-bg-hover); }
.mof-row.mof-sel { background: var(--moch-accent-soft); }
.mof-td { padding: 0 10px; border-bottom: 1px solid var(--moch-border-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mof-name { font-weight: 500; font-family: var(--moch-mono); font-size: 12px; }
.mof-desc { color: var(--moch-text-dim); max-width: 480px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mof-w-frozen { width: 72px; }
.mof-w-actions { width: 1%; white-space: nowrap; }
.mof-toggle { width: 28px; height: 16px; border-radius: 8px; border: none; background: var(--moch-accent); position: relative; cursor: pointer; padding: 0; }
.mof-toggleOff { background: var(--moch-text-faint); }
.mof-knob { position: absolute; top: 2px; left: 14px; width: 12px; height: 12px; border-radius: 6px; background: var(--moch-bg); transition: left 120ms ease; }
.mof-toggleOff .mof-knob { left: 2px; }
.mof-btn { background: transparent; color: var(--moch-text-dim); border: 1px solid var(--moch-border); border-radius: 5px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
.mof-btn:hover:not(:disabled) { color: var(--moch-text); border-color: var(--moch-text-faint); }
.mof-btn:disabled { opacity: 0.5; cursor: default; }
.mof-btn.mof-accent { background: var(--moch-accent); color: var(--moch-bg); border-color: transparent; }
.mof-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; color: var(--moch-text-dim); }
.mof-emptyTitle { margin: 0; color: var(--moch-text); font-size: 16px; font-weight: 600; }
.mof-emptyBody { margin: 0 0 8px; font-size: 12.5px; text-align: center; max-width: 420px; }
.mof-banner { padding: 6px 16px; color: var(--moch-red); font-size: 12.5px; border-bottom: 1px solid var(--moch-border-soft); }
.mof-spin { width: 22px; height: 22px; margin: 48px auto; border: 2px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: mof-rot 800ms linear infinite; }
.mof-spinSm { display: inline-block; width: 13px; height: 13px; border: 1.5px solid var(--moch-border); border-top-color: var(--moch-accent); border-radius: 50%; animation: mof-rot 800ms linear infinite; }
@keyframes mof-rot { to { transform: rotate(360deg); } }
.mof-toast { position: fixed; left: 16px; bottom: 16px; z-index: 40; background: var(--moch-bg-elev); border: 1px solid var(--moch-border); color: var(--moch-text); font-size: 12.5px; padding: 7px 12px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
.mof-scrim { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.45); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px; }
.mof-card { background: var(--moch-bg-card); border: 1px solid var(--moch-border); border-radius: 10px; width: 520px; max-width: 100%; max-height: 84vh; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); }
.mof-cardHead { display: flex; align-items: center; }
.mof-cardHead strong { font-size: 14px; flex: 1; }
.mof-x { background: none; border: none; color: var(--moch-text-faint); cursor: pointer; font-size: 12px; padding: 2px 6px; }
.mof-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mof-chip { background: transparent; border: 1px solid var(--moch-border); color: var(--moch-text-dim); border-radius: 999px; font-size: 11.5px; padding: 3px 10px; cursor: pointer; font-family: inherit; }
.mof-chip.mof-chipOn { background: var(--moch-accent-soft); border-color: var(--moch-accent); color: var(--moch-text); }
.mof-input { background: var(--moch-bg); color: var(--moch-text); border: 1px solid var(--moch-border); border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.mof-hint { margin: 0; color: var(--moch-text-faint); font-size: 11.5px; }
.mof-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--moch-text); cursor: pointer; }
.mof-check input { margin-top: 2px; accent-color: var(--moch-accent); }
.mof-check em { color: var(--moch-text-faint); font-style: normal; }
.mof-skillsToggle { background: none; border: none; color: var(--moch-text-dim); font-size: 12.5px; cursor: pointer; padding: 0; text-align: left; font-family: inherit; }
.mof-err { margin: 0; color: var(--moch-red); font-size: 12.5px; }
.mof-dialogBtns { display: flex; justify-content: flex-end; gap: 8px; }
.mof-root :focus-visible { outline: 2px solid var(--moch-accent); outline-offset: 1px; }
`
