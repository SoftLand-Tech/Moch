/** Browser — a live, drivable view of the agent's Chromium over CDP. The
 * left pane lists /cdp/json targets (3s refresh); the main pane is a
 * Page.startScreencast canvas driven through Input.*: canvas-relative
 * pointer coordinates are scaled frame → device surface (metadata carries
 * DPR) → CSS pixels, which is what Input dispatches. Desktop-only — the
 * phone's WebView pool cannot reach the agent browser. */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CdpSession, fetchCdpWsPort, fetchTargets, type CdpTarget } from './cdp'

declare const beacon: (msg: string) => void

const POLL_MS = 3000

// Chromium renamed the screencast ack: current builds take
// Page.screencastFrameAck, older ones Page.screencastFrameAcknowledge.
// Until an ack lands Chromium caps in-flight frames (~2), so the screen
// freezes at the first frames when the wrong name is used. Remember
// which name this browser accepts.
let ackFrameMethod: 'Page.screencastFrameAck' | 'Page.screencastFrameAcknowledge' =
  'Page.screencastFrameAck'

function ackScreencastFrame(session: CdpSession, frameSessionId: number): void {
  const method = ackFrameMethod
  session.send(method, { sessionId: frameSessionId }).catch((e: unknown) => {
    if (!(e instanceof Error) || !e.message.includes("wasn't found")) return
    if (method === 'Page.screencastFrameAck') {
      ackFrameMethod = 'Page.screencastFrameAcknowledge'
      void session.send(ackFrameMethod, { sessionId: frameSessionId }).catch(() => {})
    }
  })
}

/** windowsVirtualKeyCode for keys pages branch on; printable text rides
 * key/code and Input.insertText instead. */
const VK_BY_KEY: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ' ': 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
}

function withScheme(raw: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`
}

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--moch-text-dim)',
  border: '1px solid var(--moch-border)',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 13,
}

const urlInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--moch-bg-card)',
  border: '1px solid var(--moch-border)',
  borderRadius: 6,
  color: 'var(--moch-text)',
  padding: '6px 10px',
  fontSize: 13,
}

function Notice(props: { text: string }): React.JSX.Element {
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <p className="screen-empty" style={{ maxWidth: 540, textAlign: 'center' }}>
        {props.text}
      </p>
    </main>
  )
}

/** The screencast canvas + toolbar for one connected target. Keyed by
 * target id so switching tabs resets every ref and draft. */
function CdpStage(props: { session: CdpSession; target: CdpTarget }): React.JSX.Element {
  const { session, target } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Screencast frame metadata: the full device surface the frame was
  // downscaled from, devicePixelRatio included.
  const surfaceRef = useRef<{ deviceWidth: number; deviceHeight: number } | null>(null)
  const dprRef = useRef(1)
  const [urlDraft, setUrlDraft] = useState(target.url)
  const [drawing, setDrawing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    setUrlDraft(target.url)
  }, [target.id, target.url])

  useEffect(() => {
    const offNav = session.on('Page.frameNavigated', (p) => {
      const frame: unknown = p.frame
      if (
        frame && typeof frame === 'object' &&
        !('parentId' in frame) && 'url' in frame && typeof frame.url === 'string'
      ) {
        setUrlDraft(frame.url)
      }
    })
    return offNav
  }, [session])

  useEffect(() => {
    void session
      .send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'window.devicePixelRatio',
        returnByValue: true,
      })
      .then((r) => {
        const v = r.result?.value
        if (typeof v === 'number' && v > 0) dprRef.current = v
      })
      .catch(() => {})
  }, [session])

  useEffect(() => {
    let firstFrame = true
    const off = session.on('Page.screencastFrame', (p) => {
      const data = typeof p.data === 'string' ? p.data : ''
      if (!data || typeof p.sessionId !== 'number') return
      const meta: unknown = p.metadata
      let format = 'jpeg'
      if (meta && typeof meta === 'object' && 'format' in meta && meta.format === 'png') {
        format = 'png'
      }
      const img = new Image()
      img.onload = () => {
        const canvas = canvasRef.current
        if (!canvas) return
        if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth
        if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight
        canvas.getContext('2d')?.drawImage(img, 0, 0)
        if (
          meta && typeof meta === 'object' &&
          'deviceWidth' in meta && 'deviceHeight' in meta &&
          typeof meta.deviceWidth === 'number' && typeof meta.deviceHeight === 'number'
        ) {
          surfaceRef.current = { deviceWidth: meta.deviceWidth, deviceHeight: meta.deviceHeight }
        }
      }
      img.src = `data:image/${format};base64,${data}`
      ackScreencastFrame(session, p.sessionId)
      if (firstFrame) {
        firstFrame = false
        setDrawing(true)
      }
    })
    return off
  }, [session])

  /** Stage-relative pointer position → page CSS pixels. */
  const pageXY = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const surface = surfaceRef.current
    const frameX = ((e.clientX - rect.left) * canvas.width) / rect.width
    const frameY = ((e.clientY - rect.top) * canvas.height) / rect.height
    return {
      x: (frameX * (surface ? surface.deviceWidth / canvas.width : 1)) / (dprRef.current || 1),
      y: (frameY * (surface ? surface.deviceHeight / canvas.height : 1)) / (dprRef.current || 1),
    }
  }

  const goBack = () => {
    void session
      .send<{ currentIndex?: number; entries?: { entryId: number }[] }>('Page.getNavigationHistory', {})
      .then((h) => {
        const prev =
          h.entries && h.currentIndex !== undefined ? h.entries[h.currentIndex - 1] : undefined
        if (prev) {
          return session.send('Page.navigateToHistoryEntry', { entryId: prev.entryId })
        }
        return undefined
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : 'back failed'))
  }

  const navigate = () => {
    const url = withScheme(urlDraft.trim())
    if (!url) return
    setUrlDraft(url)
    void session
      .send('Page.navigate', { url })
      .then(() => setNote(null))
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : 'navigation failed'))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // preventDefault keeps the webview itself from acting on the key
    // (Backspace history navigation, focus cycling) — the key is routed
    // to the remote page instead.
    e.preventDefault()
    const vk = VK_BY_KEY[e.key] ?? 0
    const modifiers =
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    void session
      .send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      })
      .catch(() => {})
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      void session.send('Input.insertText', { text: e.key }).catch(() => {})
    }
  }

  const onKeyUp = (e: React.KeyboardEvent) => {
    e.preventDefault()
    const vk = VK_BY_KEY[e.key] ?? 0
    const modifiers =
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    void session
      .send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      })
      .catch(() => {})
  }

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--moch-border)',
          alignItems: 'center',
        }}
      >
        <button type="button" onClick={goBack} style={btnStyle}>
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            void session.send('Page.reload', { ignoreCache: false }).catch(() => {})
          }}
          style={btnStyle}
        >
          Reload
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            navigate()
          }}
          style={{ flex: 1, display: 'flex' }}
        >
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            spellCheck={false}
            placeholder="Navigate the agent's browser…"
            style={urlInputStyle}
          />
        </form>
      </div>
      <div
        tabIndex={0}
        autoFocus
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerMove={(e) => {
            const xy = pageXY(e)
            if (xy) {
              void session
                .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy.x, y: xy.y, buttons: e.buttons })
                .catch(() => {})
            }
          }}
          onPointerDown={(e) => {
            const xy = pageXY(e)
            if (xy) {
              void session
                .send('Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  x: xy.x,
                  y: xy.y,
                  button: e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left',
                  buttons: e.buttons || 1,
                  clickCount: 1,
                })
                .catch(() => {})
            }
          }}
          onPointerUp={(e) => {
            const xy = pageXY(e)
            if (xy) {
              void session
                .send('Input.dispatchMouseEvent', {
                  type: 'mouseReleased',
                  x: xy.x,
                  y: xy.y,
                  button: e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left',
                  buttons: e.buttons,
                  clickCount: 1,
                })
                .catch(() => {})
            }
          }}
          onWheel={(e) => {
            const xy = pageXY(e)
            if (xy) {
              void session
                .send('Input.dispatchMouseEvent', {
                  type: 'mouseWheel',
                  x: xy.x,
                  y: xy.y,
                  deltaX: e.deltaX,
                  deltaY: e.deltaY,
                })
                .catch(() => {})
            }
          }}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            background: 'var(--moch-bg-card)',
            touchAction: 'none',
          }}
        />
        {!drawing && (
          <div
            className="screen-empty"
            style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}
          >
            waiting for the first frame…
          </div>
        )}
      </div>
      {note && (
        <div style={{ padding: '6px 12px', color: 'var(--moch-text-dim)', borderTop: '1px solid var(--moch-border)', fontSize: 12 }}>
          {note}
        </div>
      )}
    </main>
  )
}

export function Browser(): React.JSX.Element {
  const [targets, setTargets] = useState<CdpTarget[]>([])
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // undefined = not fetched yet, null = bridge offline, number = live port.
  const [wsPort, setWsPort] = useState<number | null | undefined>(undefined)
  const [session, setSession] = useState<CdpSession | null>(null)
  const [sessionNote, setSessionNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetchTargets()
    if (res.ok) {
      setTargets(res.targets)
      setTargetsError(null)
    } else {
      setTargets([])
      setTargetsError(res.error)
    }
  }, [])

  useEffect(() => {
    void fetchCdpWsPort().then(setWsPort)
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Follow the live list: first page target wins until the user (or a
  // closed target) picks otherwise.
  useEffect(() => {
    if (targets.length === 0) return
    if (selectedId && targets.some((t) => t.id === selectedId)) return
    const firstPage = targets.find((t) => t.type === 'page')
    setSelectedId((firstPage ?? targets[0]).id)
  }, [targets, selectedId])

  // One CDP session per selected target; cleanup covers target switches,
  // unmount, and StrictMode's double mount.
  useEffect(() => {
    if (!selectedId || !wsPort) return
    let disposed = false
    let s: CdpSession | null = null
    const cleanups: Array<() => void> = []
    void (async () => {
      s = new CdpSession(
        `ws://127.0.0.1:${wsPort}/cdp/ws?target=${encodeURIComponent(selectedId)}&kind=${encodeURIComponent(
          targets.find((t) => t.id === selectedId)?.type ?? 'page',
        )}`,
      )
      try {
        await s.connect()
      } catch (e) {
        if (!disposed) setSessionNote(e instanceof Error ? e.message : 'cdp session failed')
        return
      }
      if (disposed) {
        s.close()
        return
      }
      try {
        await s.send('Page.enable')
        await s.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 60,
          maxWidth: 1600,
          maxHeight: 1200,
          everyNthFrame: 1,
        })
      } catch (e) {
        if (!disposed) setSessionNote(e instanceof Error ? e.message : 'screencast failed to start')
        s.close()
        return
      }
      if (disposed) {
        s.close()
        return
      }
      cleanups.push(
        s.on('_closed', () => {
          if (!disposed) setSessionNote('the CDP session closed (target or browser went away)')
        }),
      )
      setSession(s)
      beacon(`browser: session live target=${selectedId.slice(0, 8)}`)
    })()
    return () => {
      disposed = true
      for (const off of cleanups) off()
      s?.close()
      setSession(null)
      setSessionNote(null)
    }
  }, [selectedId, wsPort])

  const selected = targets.find((t) => t.id === selectedId) ?? null

  let body: React.JSX.Element
  if (wsPort === null) {
    body = (
      <Notice text="The shell's CDP bridge is offline — no ws proxy port was published. Restart Moch Desktop; the runtime spawns the agent browser at gateway boot." />
    )
  } else if (targetsError) {
    body = <Notice text={`Agent browser unavailable: ${targetsError}`} />
  } else if (sessionNote) {
    body = <Notice text={sessionNote} />
  } else if (selected && session) {
    body = <CdpStage key={selected.id} session={session} target={selected} />
  } else {
    body = <Notice text="Connecting to the agent browser…" />
  }

  return (
    <div className="screen" style={{ display: 'flex', flex: 1, minHeight: 0, padding: 0 }}>
      <aside
        style={{
          width: 264,
          flexShrink: 0,
          borderRight: '1px solid var(--moch-border)',
          overflowY: 'auto',
          padding: 8,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ padding: '4px 6px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Agent browser</strong>
          <span style={{ color: 'var(--moch-text-faint)', fontSize: 11 }}>live · 3s</span>
        </div>
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setSelectedId(t.id)
              setSessionNote(null)
            }}
            aria-current={t.id === selectedId}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              background: t.id === selectedId ? 'var(--moch-accent-soft)' : 'transparent',
              color: t.id === selectedId ? 'var(--moch-text)' : 'var(--moch-text-dim)',
              border: '1px solid var(--moch-border)',
              borderRadius: 6,
              padding: '6px 8px',
            }}
          >
            <span
              style={{
                display: 'block',
                fontSize: 13,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t.title || t.url || '(untitled)'}
            </span>
            <span
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                marginTop: 2,
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  flexShrink: 0,
                  color: 'var(--moch-text-faint)',
                  border: '1px solid var(--moch-border)',
                  borderRadius: 4,
                  padding: '0 4px',
                }}
              >
                {t.type}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--moch-text-faint)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t.url}
              </span>
            </span>
          </button>
        ))}
      </aside>
      {body}
    </div>
  )
}
