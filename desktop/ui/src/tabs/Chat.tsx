/** Chat — sessions panel + live message stream. Moved verbatim from App.tsx
 *  (round 4 tab-file refactor); behavior identical. */
import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from '../Markdown'
import { ev, relTime, type Block, type RpcRef, type SessionRow } from '../types'

export default function ChatTab({ rpc, client, profile, onProfile }: { rpc: RpcRef; client: any; profile: string; onProfile: (p: string) => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activeSid, setActiveSid] = useState('')
  const [blocks, setBlocks] = useState<Record<string, Block[]>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState(true)
  const [roster, setRoster] = useState<string[]>([])
  const blockId = useRef(1)
  const blocksRef = useRef(blocks); blocksRef.current = blocks
  const activeRef = useRef(activeSid); activeRef.current = activeSid

  const pushBlock = (sid: string, b: Omit<Block, 'id'>) =>
    setBlocks((p) => ({ ...p, [sid]: [...(p[sid] ?? []), { ...b, id: blockId.current++ }] }))
  const patchBlock = (sid: string, pred: (b: Block) => boolean, patch: any) =>
    setBlocks((p) => {
      const list = p[sid] ?? []; const i = list.findIndex(pred); if (i < 0) return p
      const next = list.slice(); next[i] = { ...next[i], ...(typeof patch === 'function' ? patch(next[i]) : patch) }
      return { ...p, [sid]: next }
    })

  const applyEvent = useCallback((e: unknown) => {
    const { type, session_id: sid, payload: p } = ev(e)
    if (!sid) return
    const last = (pred: (b: Block) => boolean) => (blocksRef.current[sid] ?? []).findLast(pred)
    switch (type) {
      case 'message.start': pushBlock(sid, { kind: 'assistant', text: '', live: true }); break
      case 'message.delta': case 'message.interim': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'assistant' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: type === 'message.interim' ? text : b.text + text }))
        else pushBlock(sid, { kind: 'assistant', text, live: true })
        break
      }
      case 'message.complete':
        patchBlock(sid, (b) => b.kind === 'assistant' && b.live, (b: Block) => ({ live: false, text: p?.text != null ? String(p.text) : b.text }))
        setBusy(false); break
      case 'thinking.delta': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'thinking' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: b.text + text }))
        else pushBlock(sid, { kind: 'thinking', text, live: true })
        break
      }
      case 'tool.start': pushBlock(sid, { kind: 'tool', text: String(p?.name ?? p?.tool ?? 'tool'), live: true }); break
      case 'tool.complete': patchBlock(sid, (b) => b.kind === 'tool' && b.live, { live: false, meta: [p?.name, p?.ms != null ? `${p.ms}ms` : null].filter(Boolean).join(' · ') }); break
      case 'status.update': if (p?.status) pushBlock(sid, { kind: 'status', text: String(p.status) }); break
    }
  }, [])

  /** session.list → panel rows (shape per sessionRowMeta.ts: id is the durable
   *  key session.resume takes). Round 3 called this but never defined it —
   *  defined here during the round 4 move so gateway.ready populates the panel. */
  const loadSessions = useCallback(async (prof: string) => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r('session.list', prof && prof !== 'default' ? { limit: 200, profile: prof } : { limit: 200 })
      const rows: SessionRow[] = Array.isArray(res) ? res : res.sessions ?? res.items ?? []
      setSessions(rows.filter((s) => s.id ?? s.stored_session_id ?? s.session_id))
    } catch { /* panel keeps whatever it had */ }
  }, [])
  const loadRoster = useCallback(async () => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r('profiles.list', {})
      const rows = res.profiles ?? res.items ?? []
      setRoster(rows.map((p: { name: string }) => p.name).filter((n: string) => n && n !== 'default'))
    } catch { }
  }, [])

  const profRef = useRef(profile); profRef.current = profile
  useEffect(() => {
    if (!client) return
    void loadSessions(profRef.current)
    void loadRoster()
    const un = client.onAny((e: unknown) => {
      const { type } = ev(e)
      if (type === 'gateway.ready') { void loadSessions(profRef.current); void loadRoster() }
      applyEvent(e)
    })
    return un
  }, [client, applyEvent, loadSessions, loadRoster])

  // Switching profile swaps the board: clear the open chat + reload the list.
  useEffect(() => { setActiveSid(''); void loadSessions(profile) }, [profile])

  const send = async () => {
    const text = draft.trim(); if (!text || busy) return
    const r = rpc.current!; setDraft(''); setBusy(true)
    try {
      let sid = activeRef.current
      if (!sid) {
        const prof = profile && profile !== 'default' ? profile : undefined
        const cr = await r('session.create', { title: prof ? `${prof} · chat` : 'Desktop chat', cols: 120, source: 'mobile', ...(prof ? { profile: prof, follow_profile_config: true } : {}) })
        sid = cr.session_id; setBlocks((p) => ({ ...p, [sid]: [] })); setActiveSid(sid)
        setSessions((p) => [{ session_id: sid, title: prof ? `${prof} · chat` : 'Desktop chat', started_at: Date.now() / 1000, profile: prof }, ...p])
      }
      pushBlock(sid, { kind: 'user', text })
      await r('prompt.submit', { session_id: sid, text })
    } catch { setBusy(false) }
  }

  const list = blocks[activeSid] ?? []
  return (
    <div className="chatwrap">
      {panel && (
        <div className="sessions-panel">
          <button className="new-chat" onClick={() => { setActiveSid(''); setDraft('') }}>+ New chat{profile && profile !== 'default' ? ` · ${profile}` : ''}</button>
          <div className="pchips">
            <button className={`pchip ${!profile || profile === 'default' ? 'on' : ''}`} onClick={() => onProfile('')}>Moch</button>
            {roster.map((n) => (
              <button key={n} className={`pchip ${profile === n ? 'on' : ''}`} onClick={() => onProfile(n)}>{n}</button>
            ))}
          </div>
          <div className="sessions">
            {sessions.map((s) => {
              const key = s.id ?? s.stored_session_id ?? s.session_id ?? ''
              const label = s.title || (s.preview ? s.preview.slice(0, 40) : key.slice(0, 18))
              const meta = [relTime(s.started_at), s.message_count ? `${s.message_count} msgs` : null, s.profile && s.profile !== 'default' ? s.profile : null].filter(Boolean).join(' · ')
              return (
                <button key={key} className={`session ${activeSid === s.session_id ? 'active' : ''}`}
                  onClick={async () => {
                    const r = rpc.current!
                    try {
                      const rr = await r('session.resume', { session_id: key, cols: 120 })
                      const live = rr.session_id
                      const rep = await r('session.events.since', { session_id: live, last_seen: 0 })
                      setBlocks((p) => ({ ...p, [live]: [] })); setActiveSid(live)
                      for (const e of rep.events ?? []) applyEvent(e)
                    } catch { }
                  }}>
                  <span className="s-title">{label}</span>
                  {meta && <span className="s-meta">{meta}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="chat">
        <div className="messages">
          {list.length === 0 && <div className="empty"><div className="mochi">(●ᴗ●)</div><p>{profile && profile !== 'default' ? `Talking to ${profile}.` : 'Your agent, on this machine.'}</p></div>}
          {list.map((b) =>
            b.kind === 'user' ? <div key={b.id} className="msg user">{b.text}</div>
            : b.kind === 'assistant' ? (
              <div key={b.id} className={`msg assistant${b.live ? ' live' : ''}`}>
                {b.live ? (b.text || '▍') : (b.text ? <Markdown text={b.text} /> : null)}
              </div>
            )
            : b.kind === 'thinking' ? (
              <details key={b.id} className="thinking"><summary>Thinking{b.live ? '…' : ''}</summary><pre>{b.text}</pre></details>
            ) : b.kind === 'tool' ? (
              <div key={b.id} className="tool"><span className={`dot${b.live ? '' : ' done'}`}>{b.live ? '◌' : '●'}</span> {b.text}{b.meta ? <span className="meta"> {b.meta}</span> : null}</div>
            ) : <div key={b.id} className="statusline">{b.text}</div>,
          )}
        </div>
        <div className="composer">
          <textarea value={draft} placeholder="Message your agent…" onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="send" onClick={send} disabled={!draft.trim() || busy}>{busy ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}
