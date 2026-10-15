/**
 * Bots (fleet) — phone parity, mirroring app/(tabs)/fleet.tsx + app/src/lib/fleet.ts:
 *   roster cards (model/frozen/gate pills), fleet runtime header (armed/off,
 *   queue active/slots, waiting), create-with-checklist (launch USER.md /
 *   MEMORY.md / launch-skills multi-select → moch.profiles.seed, best-effort
 *   after profiles.create), freeze/unfreeze (moch.fleet.freeze), two-click
 *   delete (moch.profiles.delete). Per-step errors, never fatal seeding.
 */
import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CHECKLIST, seedHasSkips,
  type CreateChecklist, type FleetProfile, type FleetStatus, type LaunchSkill, type RpcRef, type SeedResult,
} from '../types'

/** B1 cold-start mount load: the first load races the socket dial. While
 *  rpc is still null, poll every 2s (30s cap); once up, run `load` — a
 *  failed load (error UI already shown) gets exactly one 5s-later retry.
 *  Returns the unmount cleanup that clears every pending timer. */
function mountLoad(rpc: RpcRef, load: () => Promise<boolean>): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let alive = true
  let retries = 1
  const deadline = Date.now() + 30_000
  const later = (fn: () => void, ms: number) => { if (alive) timers.push(setTimeout(fn, ms)) }
  const go = () => {
    if (!alive) return
    if (!rpc.current) {
      if (Date.now() < deadline) later(go, 2000)
      return
    }
    void load().then((ok) => {
      if (alive && !ok && retries > 0) { retries -= 1; later(go, 5000) }
    })
  }
  go()
  return () => { alive = false; for (const t of timers) clearTimeout(t) }
}

/** §2.7 starter templates (phone fleet.tsx): tappable job seeds — zero typing. */
const STARTERS: { label: string; job: string }[] = [
  { label: 'Research', job: 'Research assistant: read my saved sources daily and brief me on what changed.' },
  { label: 'Deals', job: 'Deal watcher: track product pages I name and notify me on price drops.' },
  { label: 'Code (PC)', job: 'Code helper bound to my linked PC: work in my repos on request.' },
  { label: 'Private journal', job: 'Private journal/finance watcher over my own local files only — never sends anything anywhere.' },
]

/** SOUL.md draft — deterministic template (fleet.ts soulDraft), creation instant. */
function soulDraft(job: string, name: string): string {
  return [
    `# ${name}`,
    '',
    job.trim() || 'A helpful Moch fleet bot.',
    '',
    '## Working agreement',
    '- Stay in scope of the job above; ask via a question card when blocked.',
    '- Anything sent to a person is a draft until approved.',
    `- Name for this bot: ${name}.`,
  ].join('\n')
}
/** kebab name from a one-line job (fleet.ts slugifyName). */
function slugifyName(job: string): string {
  const base = job
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join('-')
  return (base || 'bot').slice(0, 32)
}

/** Persisted checklist defaults (phone: AsyncStorage; here: localStorage). */
const CREATE_DEFAULTS_KEY = 'hermes.fleet.createDefaults.v1'
function loadCreateDefaults(): CreateChecklist {
  try {
    const raw = localStorage.getItem(CREATE_DEFAULTS_KEY)
    if (!raw) return { ...DEFAULT_CHECKLIST }
    const p = JSON.parse(raw) as Partial<CreateChecklist>
    return {
      copyUserMemory: p.copyUserMemory ?? DEFAULT_CHECKLIST.copyUserMemory,
      copyMemory: p.copyMemory ?? DEFAULT_CHECKLIST.copyMemory,
      skills: Array.isArray(p.skills) ? p.skills : [],
    }
  } catch { return { ...DEFAULT_CHECKLIST } }
}
function saveCreateDefaults(c: CreateChecklist): void {
  try { localStorage.setItem(CREATE_DEFAULTS_KEY, JSON.stringify(c)) } catch { /* best-effort */ }
}

export default function BotsTab({ rpc, onChat }: { rpc: RpcRef; onChat: (name: string) => void }) {
  const [profiles, setProfiles] = useState<FleetProfile[]>([])
  const [status, setStatus] = useState<FleetStatus | null>(null)
  const [err, setErr] = useState('')

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [desc, setDesc] = useState('')
  const [soul, setSoul] = useState('')
  const [checklist, setChecklist] = useState<CreateChecklist>(DEFAULT_CHECKLIST)
  const [skillsList, setSkillsList] = useState<LaunchSkill[]>([])
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [createErr, setCreateErr] = useState('')
  const [partial, setPartial] = useState(false)
  /** 'create' | profile name while a freeze/delete is in flight. */
  const [busy, setBusy] = useState<string | null>(null)
  /** Profile name armed for a second-click delete confirm. */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = async (): Promise<boolean> => {
    const r = rpc.current; if (!r) return false
    setErr('')
    try {
      const lst: any = await r('profiles.list', {})
      const rows = lst.profiles ?? lst.items ?? (Array.isArray(lst) ? lst : [])
      setProfiles(rows)
      const st: FleetStatus | null = await r<FleetStatus | null>('moch.fleet.status', {}).catch(() => null)
      setStatus(st)
      return true
    } catch (e) { setErr(String(e)); return false }
  }
  useEffect(() => mountLoad(rpc, load), [])

  // B2: a disarmed (unmounted) tab must not fire its stale confirm reset —
  // track the arm timers and clear them all on unmount.
  const armTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => { for (const t of armTimers.current) clearTimeout(t) }, [])

  // Open create → restore last checklist + fetch launch skills (never blocks:
  // older gateways answer nothing and the picker renders its empty state).
  useEffect(() => {
    if (!creating) return
    setChecklist(loadCreateDefaults())
    if (!skillsLoaded) {
      rpc.current!('moch.skills.list', {})
        .then((res: { skills?: LaunchSkill[] }) => setSkillsList(res.skills ?? []))
        .catch(() => setSkillsList([]))
        .finally(() => setSkillsLoaded(true))
    }
  }, [creating])

  const suggested = nameTouched ? name : slugifyName(desc)
  const toggleSkill = (sk: string, on: boolean) =>
    setChecklist((c) => ({ ...c, skills: on ? c.skills.filter((n) => n !== sk) : [...c.skills, sk] }))

  const create = async () => {
    const botName = suggested.trim() || 'bot'
    if (!desc.trim() || busy) return
    setBusy('create'); setCreateErr(''); setPartial(false)
    // Step 1 — the bot itself (§2.8: mirror the launch MODEL key only).
    try {
      const res: any = await rpc.current!('profiles.create', {
        name: botName,
        description: desc.trim(),
        soul: soul.trim() || soulDraft(desc, botName),
        no_alias: true,
        mirror_credentials: true,
      })
      if (res && res.ok === false) {
        setCreateErr(`create failed: ${res.error ?? 'profiles.create refused'}`)
        return
      }
      // Step 2 — checklist seeding, BEST-EFFORT (bot exists either way;
      // files persist, existing files are never overwritten).
      if (checklist.copyUserMemory || checklist.copyMemory || checklist.skills.length > 0) {
        try {
          const seed: SeedResult = await rpc.current!('moch.profiles.seed', {
            profile: botName,
            copy_user_memory: checklist.copyUserMemory,
            copy_memory: checklist.copyMemory,
            skills: checklist.skills,
          })
          if (seedHasSkips(seed)) setPartial(true)
        } catch (e) { setCreateErr(`seed failed: ${String(e)}`) }
      }
      saveCreateDefaults(checklist)
      setName(''); setNameTouched(false); setDesc(''); setSoul('')
      setCreating(false)
      await load()
    } catch (e) {
      setCreateErr(`create failed: ${String(e)}`)
    } finally { setBusy(null) }
  }

  const toggleFreeze = async (p: FleetProfile, frozen: boolean) => {
    if (busy) return
    setBusy(p.name); setConfirmDel(null); setErr('')
    try {
      await rpc.current!('moch.fleet.freeze', { profile: p.name, frozen })
      await load()
    } catch (e) {
      // #106 parity: a freeze failure must be visible, never silently undone.
      setErr(`freeze failed for ${p.name}: ${String(e)}`)
    } finally { setBusy(null) }
  }

  const del = async (p: FleetProfile) => {
    if (busy) return
    setBusy(p.name); setConfirmDel(null); setErr('')
    try {
      // Second click of the inline confirm sends the server's confirm token
      // (bot.tsx: { profile, confirm: true } — gateway guards with 4090).
      await rpc.current!('moch.profiles.delete', { profile: p.name, confirm: true })
      await load()
    } catch (e) {
      setErr(`delete failed for ${p.name}: ${String(e)}`)
    } finally { setBusy(null) }
  }

  const armDelete = (name: string) => {
    setConfirmDel(name)
    armTimers.current.push(setTimeout(() => setConfirmDel((c) => (c === name ? null : c)), 4000))
  }

  const waiting = status?.queue?.waiting ?? []

  return (
    <div className="page">
      <div className="pagehead">
        <h2>Bots</h2>
        {status && <span className={`pill ${status.fleetEnabled ? 'ok' : ''}`}>fleet {status.fleetEnabled ? 'armed' : 'off'}</span>}
        {status?.queue && <span className="pill">queue {status.queue.active}/{status.queue.slots}</span>}
        {waiting.length > 0 && (
          <span className="pill warn" title={waiting.map((w) => w.home).join(', ')}>
            {waiting.length} waiting · {waiting.map((w) => w.priority).join(', ')}
          </span>
        )}
        <button className="ghost" onClick={load}>refresh</button>
        <button className="primary" onClick={() => { setCreateErr(''); setPartial(false); setCreating(!creating) }}>+ New bot</button>
      </div>

      {err && <div className="err">{err}</div>}
      {partial && (
        <div className="notice">
          Bot created, but some checklist items weren't copied (missing, or already existed). Everything else is in place.
        </div>
      )}

      {creating && (
        <div className="card form">
          <div className="row">
            {STARTERS.map((st) => (
              <button key={st.label} type="button" className={`chip${desc === st.job ? ' on' : ''}`}
                onClick={() => { setDesc(st.job); setNameTouched(false); setName(slugifyName(st.job)); setSoul(soulDraft(st.job, slugifyName(st.job))) }}>
                {st.label}
              </button>
            ))}
          </div>
          <input placeholder="name" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
          <input placeholder="description (what is this bot for?)" value={desc}
            onChange={(e) => { setDesc(e.target.value); if (!nameTouched) setName(slugifyName(e.target.value)) }} />
          <textarea placeholder="soul (personality / instructions — prefilled with a working agreement if empty)" value={soul} onChange={(e) => setSoul(e.target.value)} />

          {/* Checklist: context/skills enter as FILES (USER.md, skills/), never
              prompt-stuffing — files persist and are visible/editable. */}
          <label className="checkrow">
            <input type="checkbox" checked={checklist.copyUserMemory} onChange={(e) => setChecklist((c) => ({ ...c, copyUserMemory: e.target.checked }))} />
            <span className="checktext">
              <span className="checklabel">Copy “ideas about me” (launch USER.md)</span>
              <span className="checkhint">Your preferences and facts, so the bot already knows you.</span>
            </span>
          </label>
          <label className="checkrow">
            <input type="checkbox" checked={checklist.copyMemory} onChange={(e) => setChecklist((c) => ({ ...c, copyMemory: e.target.checked }))} />
            <span className="checktext">
              <span className="checklabel">Copy launch memory too (MEMORY.md)</span>
              <span className="checkhint">Accumulated history — noisy; usually leave off.</span>
            </span>
          </label>
          <div className="checkhead">
            <span className="checklabel">Launch skills</span>
            {checklist.skills.length > 0 && <span className="pill">{checklist.skills.length}</span>}
          </div>
          {skillsLoaded && skillsList.length === 0 ? (
            <span className="checkhint">No launch skills found on this runtime.</span>
          ) : (
            <div className="skillsbox">
              {skillsList.map((sk) => (
                <label key={sk.path} className="checkrow">
                  <input type="checkbox" checked={checklist.skills.includes(sk.name)} onChange={(e) => toggleSkill(sk.name, e.target.checked)} />
                  <span className="checktext">
                    <span className="checklabel">{sk.name}</span>
                    {sk.description && <span className="checkhint">{sk.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}

          {createErr && <div className="err">{createErr}</div>}
          <div className="row">
            <button className="primary" onClick={create} disabled={!desc.trim() || busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create bot'}
            </button>
            <button className="ghost" onClick={() => setCreating(false)}>cancel</button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !creating && (
        <div className="empty">
          <div className="mochi">(●ᴗ●)</div>
          <p>No bots yet — one Moch is plenty until you need a specialist.</p>
        </div>
      )}
      {profiles.map((p) => {
        const st = status?.profiles?.find((s) => s.name === p.name)
        const frozen = st?.frozen ?? p.frozen
        const gateHeld = st?.gateHeld ?? p.gateHeld
        const isBusy = busy === p.name
        const armed = confirmDel === p.name
        return (
          <div key={p.name} className="card bot">
            <div className="row">
              <strong>{p.name}</strong>
              {frozen && <span className="pill warn">frozen</span>}
              {gateHeld && <span className="pill warn">gate held</span>}
              {p.model?.default && <span className="pill dim">{p.model.default}</span>}
              <span className="spacer" />
              <button className="ghost" disabled={!!busy || frozen}
                onClick={() => onChat(p.name)}>
                chat
              </button>
              <button className="ghost" disabled={isBusy || !!busy}
                onClick={() => toggleFreeze(p, !frozen)}>
                {isBusy ? '…' : frozen ? 'unfreeze' : 'freeze'}
              </button>
              <button className={`ghost danger${armed ? ' confirm' : ''}`} disabled={!!busy}
                onClick={() => (armed ? del(p) : armDelete(p.name))}>
                {isBusy ? '…' : armed ? 'sure? delete' : 'delete'}
              </button>
            </div>
            {p.description && <p className="dim">{p.description}</p>}
          </div>
        )
      })}
    </div>
  )
}
