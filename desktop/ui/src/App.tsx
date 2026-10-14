/**
 * Moch Desktop — local-only chat UI for the PC.
 *
 * Talks to a LOCAL hermes serve (spawned by the Rust shell, or attached
 * on 9119) using the app's own protocol stack, imported verbatim:
 *   ../../../app/src/protocol/json-rpc-gateway.ts  (with Mamoun's changes)
 *
 * RPCs used (same shapes as app/scripts/test-live.ts + chat.ts):
 *   session.create {title, cols, source:'mobile'}
 *   session.list {limit} / session.active_list {}
 *   session.resume {session_id, cols}
 *   session.events.since {session_id, last_seen}   (history replay)
 *   prompt.submit {session_id, text}
 *   gateway.ping {}
 * Events: message.start/delta/interim/complete, thinking.delta,
 *   tool.start/complete, session.title, status.update.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
// The app's protocol stack — the single source of truth, fork changes included.
import { JsonRpcGatewayClient } from '../../../app/src/protocol/json-rpc-gateway'

type Cfg = { wsUrl: string; token: string; mode: string }

type Block = {
  id: number
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'status'
  text: string
  live?: boolean
  meta?: string
}

type SessionRow = {
  session_id?: string
  stored_session_id?: string
  title?: string
  updated_at?: number
  created_at?: string
}

function dbg(what: string, extra: Record<string, unknown> = {}) {
  fetch('/dbg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: Date.now(), what, ...extra }),
  }).catch(() => {})
}

const ev = (e: unknown): { type: string; session_id?: string; payload: any } =>
  e as { type: string; session_id?: string; payload: any }

export default function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activeSid, setActiveSid] = useState('')
  const [blocks, setBlocks] = useState<Record<string, Block[]>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const clientRef = useRef<JsonRpcGatewayClient | null>(null)
  const blocksRef = useRef(blocks)
  const activeRef = useRef(activeSid)
  const blockId = useRef(1)
  blocksRef.current = blocks
  activeRef.current = activeSid

  const pushBlock = useCallback((sid: string, b: Omit<Block, 'id'>) => {
    setBlocks((prev) => {
      const nextBlockId = blockId.current++
      return { ...prev, [sid]: [...(prev[sid] ?? []), { ...b, id: nextBlockId }] }
    })
  }, [])

  const patchBlock = useCallback((sid: string, pred: (b: Block) => boolean, patch: Partial<Block> | ((b: Block) => Partial<Block>)) => {
    setBlocks((prev) => {
      const list = prev[sid] ?? []
      const idx = list.findIndex(pred)
      if (idx < 0) return prev
      const p = typeof patch === 'function' ? patch(list[idx]) : patch
      const next = list.slice()
      next[idx] = { ...next[idx], ...p }
      return { ...prev, [sid]: next }
    })
  }, [])

  /** Apply one protocol event to the block model. Used live AND for replay. */
  const applyEvent = useCallback(
    (e: unknown) => {
      const { type, session_id: sid, payload: p } = ev(e)
      if (!sid) return
      const last = (pred: (b: Block) => boolean) => (blocksRef.current[sid] ?? []).findLast(pred)
      switch (type) {
        case 'message.start':
          pushBlock(sid, { kind: 'assistant', text: '', live: true })
          break
        case 'message.delta':
        case 'message.interim': {
          const text = String(p?.text ?? p?.delta ?? '')
          if (!text) break
          const target = last((b) => b.kind === 'assistant' && b.live)
          if (target) {
            patchBlock(sid, (b) => b.id === target.id, (b) => ({
              text: type === 'message.interim' ? text : b.text + text,
            }))
          } else {
            pushBlock(sid, { kind: 'assistant', text, live: true })
          }
          break
        }
        case 'message.complete': {
          const full = p?.text != null ? String(p.text) : null
          patchBlock(sid, (b) => b.kind === 'assistant' && b.live, (b) => ({
            live: false,
            text: full ?? b.text,
          }))
          setBusy(false)
          break
        }
        case 'thinking.delta': {
          const text = String(p?.text ?? p?.delta ?? '')
          if (!text) break
          const target = last((b) => b.kind === 'thinking' && b.live)
          if (target) {
            patchBlock(sid, (b) => b.id === target.id, (b) => ({ text: b.text + text }))
          } else {
            pushBlock(sid, { kind: 'thinking', text, live: true })
          }
          break
        }
        case 'tool.start':
          pushBlock(sid, { kind: 'tool', text: String(p?.name ?? p?.tool ?? 'tool'), live: true, meta: p?.args ? JSON.stringify(p.args).slice(0, 120) : '' })
          break
        case 'tool.complete':
          patchBlock(sid, (b) => b.kind === 'tool' && b.live && b.text === String(p?.name ?? p?.tool ?? b.text), {
            live: false,
            meta: [p?.name, p?.ms != null ? `${p.ms}ms` : p?.summary].filter(Boolean).join(' · '),
          })
          break
        case 'status.update': {
          const s = String(p?.status ?? p?.state ?? '')
          if (s) pushBlock(sid, { kind: 'status', text: s })
          break
        }
        case 'session.title':
          setSessions((prev) =>
            prev.map((s) =>
              (s.stored_session_id ?? s.session_id) === sid || s.session_id === sid
                ? { ...s, title: String(p?.title ?? s.title ?? '') }
                : s,
            ),
          )
          break
        default:
          break
      }
    },
    [pushBlock, patchBlock],
  )

  /** Boot: fetch config, connect the protocol client, load sessions. */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let cfg: Cfg
      try {
        cfg = await (await fetch('/moch-config.json')).json()
      } catch {
        setConn('error')
        return
      }
      if (cancelled) return
      setCfg(cfg)
      dbg('cfg', { mode: cfg.mode, ws: cfg.wsUrl })
      if (cfg.mode === 'error') {
        setConn('error')
        return
      }

      const client = new JsonRpcGatewayClient({
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 120_000,
        socketFactory: (url: string) => new WebSocket(url) as unknown as WebSocket,
      })
      clientRef.current = client
      client.onAny((e) => {
        const { type } = ev(e)
        if (type === 'gateway.ready') {
          setConn('open')
          dbg('ws-open', {})
          client
            .request<{ sessions?: SessionRow[] }>('session.list', { limit: 200 })
            .then((r) => {
              const rows = (r.sessions ?? []).slice().sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
              setSessions(rows)
              dbg('sessions-loaded', { n: rows.length })
            })
            .catch((err) => dbg('sessions-error', { err: String(err) }))
        }
        applyEvent(e)
      })

      const url = `${cfg.wsUrl}?token=${encodeURIComponent(cfg.token)}`
      client.connect(url).catch((err) => {
        dbg('ws-error', { err: String(err) })
        setConn('error')
      })
    })()
    return () => {
      cancelled = true
      clientRef.current?.close()
    }
  }, [applyEvent])

  /** Open a stored session: resume to a live id, replay its history. */
  const openSession = useCallback(async (row: SessionRow) => {
    const client = clientRef.current
    if (!client) return
    try {
      const stored = row.stored_session_id ?? row.session_id ?? ''
      const r = await client.request<{ session_id: string }>('session.resume', {
        session_id: stored,
        cols: 120,
      })
      const live = r.session_id
      setBlocks((prev) => ({ ...prev, [live]: prev[live] ?? [] }))
      setActiveSid(live)
      const rep = await client.request<{ events?: unknown[] }>('session.events.since', {
        session_id: live,
        last_seen: 0,
      })
      setBlocks((prev) => ({ ...prev, [live]: [] }))
      for (const e of rep.events ?? []) applyEvent(e)
      dbg('session-opened', { stored, live, replayed: (rep.events ?? []).length })
    } catch (err) {
      dbg('open-error', { err: String(err) })
    }
  }, [applyEvent])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy) return
    const client = clientRef.current
    if (!client) return
    setDraft('')
    setBusy(true)
    try {
      let sid = activeRef.current
      if (!sid) {
        const r = await client.request<{ session_id: string }>('session.create', {
          title: 'Desktop chat',
          cols: 120,
          source: 'mobile',
        })
        sid = r.session_id
        setBlocks((prev) => ({ ...prev, [sid]: [] }))
        setActiveSid(sid)
        setSessions((prev) => [{ session_id: sid, title: 'Desktop chat' }, ...prev])
        dbg('session-created', { sid })
      }
      pushBlock(sid, { kind: 'user', text })
      await client.request('prompt.submit', { session_id: sid, text })
      dbg('submitted', { sid, len: text.length })
    } catch (err) {
      setBusy(false)
      dbg('submit-error', { err: String(err) })
    }
  }, [draft, busy, pushBlock])

  /** Self-test mode (?selftest=1): full round trip, reported to /dbg. */
  useEffect(() => {
    if (conn !== 'open' || !location.search.includes('selftest=1')) return
    ;(async () => {
      const client = clientRef.current!
      try {
        const pong = await client.request<{ ok?: boolean }>('gateway.ping', {}, 8000)
        dbg('selftest:ping', { ok: pong?.ok === true })
        const r = await client.request<{ session_id: string }>('session.create', {
          title: 'selftest',
          cols: 120,
          source: 'mobile',
        })
        const sid = r.session_id
        dbg('selftest:created', { sid })
        await client.request('prompt.submit', { session_id: sid, text: 'Reply with the single word READY and nothing else.' })
        dbg('selftest:submitted', {})
        const started = Date.now()
        const check = setInterval(async () => {
          const list = (blocksRef.current[sid] ?? []).filter((b) => b.kind === 'assistant' && !b.live)
          if (list.length) {
            clearInterval(check)
            dbg('selftest:reply', { text: list[0].text.slice(0, 200), ms: Date.now() - started })
            await client.request('session.delete', { session_id: sid }).catch(() => {})
          } else if (Date.now() - started > 120_000) {
            clearInterval(check)
            dbg('selftest:timeout', {})
          }
        }, 1000)
      } catch (err) {
        dbg('selftest:error', { err: String(err) })
      }
    })()
  }, [conn])

  const list = blocks[activeSid] ?? []

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◍</span> Moch
          <span className={`badge ${cfg?.mode ?? ''}`}>{cfg?.mode === 'fork' ? 'fork' : cfg?.mode ?? '…'}</span>
        </div>
        <button
          className="new-chat"
          onClick={() => {
            setActiveSid('')
            setDraft('')
          }}
        >
          + New chat
        </button>
        <div className="sessions">
          {sessions.map((s) => {
            const key = s.stored_session_id ?? s.session_id ?? ''
            return (
              <button
                key={key}
                className={`session ${activeSid === s.session_id ? 'active' : ''}`}
                onClick={() => openSession(s)}
              >
                <span className="s-title">{s.title || key.slice(0, 18)}</span>
              </button>
            )
          })}
        </div>
        <div className={`conn ${conn}`}>{conn === 'open' ? '● local hermes' : conn === 'connecting' ? '◌ connecting…' : '✕ no local hermes'}</div>
      </aside>

      <main className="chat">
        {conn === 'error' && (
          <div className="fatal">
            <p>No local hermes found.</p>
            <p className="hint">
              The shell tried to spawn <code>app/hermes-src</code> (the fork) and to attach a serve on
              127.0.0.1:9119. Check <code>desktop/.hermes-serve.log</code>.
            </p>
          </div>
        )}
        <div className="messages">
          {list.length === 0 && conn === 'open' && (
            <div className="empty">
              <div className="mochi">(●ᴗ●)</div>
              <p>Your agent, on this machine.</p>
            </div>
          )}
          {list.map((b) =>
            b.kind === 'user' ? (
              <div key={b.id} className="msg user">{b.text}</div>
            ) : b.kind === 'assistant' ? (
              <div key={b.id} className={`msg assistant${b.live ? ' live' : ''}`}>
                {b.text || (b.live ? '▍' : '')}
              </div>
            ) : b.kind === 'thinking' ? (
              <details key={b.id} className="thinking">
                <summary>Thinking{b.live ? '…' : ''}</summary>
                <pre>{b.text}</pre>
              </details>
            ) : b.kind === 'tool' ? (
              <div key={b.id} className="tool">
                <span className={`dot${b.live ? ' spin' : ''}`}>{b.live ? '◌' : '●'}</span> {b.text}
                {b.meta ? <span className="meta"> {b.meta}</span> : null}
              </div>
            ) : (
              <div key={b.id} className="statusline">{b.text}</div>
            ),
          )}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            placeholder={conn === 'open' ? 'Message your agent…' : 'waiting for gateway…'}
            disabled={conn !== 'open'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="send" onClick={send} disabled={!draft.trim() || busy || conn !== 'open'}>
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </main>
    </div>
  )
}
