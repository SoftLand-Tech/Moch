/**
 * BrowserPane — the agent browser surface: a live CDP screencast of the
 * app-managed headless Chromium, with mouse/keyboard forwarded over the
 * Input domain. The same pane is used full-size in the Browser view and
 * compact in the Stage dock. You and the agents drive the SAME browser —
 * whatever hermes does in it appears here in real time.
 */
import { useStore } from '@nanostores/react'
import {
  useCallback, useEffect, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Lock, RotateCw } from 'lucide-react'
import {
  activeTargetId, browserStatus, browserTabs, cdpConnection, ensureBrowserWatch, getCdp, launchBrowser,
  type CdpConnectionState,
} from '../lib/cdp'
import { openExternal } from '../lib/shell-ops'
import { locale, tr } from '../lib/strings'
import '../styles/browser.css'

interface SurfaceState {
  url: string | null
  loading: boolean
  canBack: boolean
  canForward: boolean
}

interface ScreencastApi {
  navigate(url: string): void
  back(): void
  forward(): void
  reload(): void
}

export default function BrowserPane({ compact = false }: { compact?: boolean }) {
  const status = useStore(browserStatus)
  const tabs = useStore(browserTabs)
  const conn = useStore(cdpConnection)
  const targetId = useStore(activeTargetId)
  useStore(locale)

  const [urlInput, setUrlInput] = useState('')
  const [surface, setSurface] = useState<SurfaceState>({ url: null, loading: false, canBack: false, canForward: false })
  const apiRef = useRef<ScreencastApi | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const urlEditing = useRef(false)

  // Start the app-wide browser watcher (status polling + agent arming) on
  // the first pane mount; it lives for the app, not for this component.
  useEffect(() => { ensureBrowserWatch() }, [])

  const onState = useCallback((patch: Partial<SurfaceState>) => {
    setSurface((s) => ({ ...s, ...patch }))
  }, [])

  // Keep the URL bar in sync with the page unless the user is editing it.
  useEffect(() => {
    if (!urlEditing.current && surface.url != null) setUrlInput(surface.url)
  }, [surface.url])

  const secure = (surface.url ?? '').startsWith('https://')

  const submitUrl = (e: FormEvent) => {
    e.preventDefault()
    const raw = urlInput.trim()
    if (!raw) return
    const url = normalizeUrl(raw)
    setUrlInput(url)
    urlRef.current?.blur()
    apiRef.current?.navigate(url)
  }

  if (!status.running) {
    return (
      <div className="browser-pane bp-idle">
        <Globe size={22} />
        <div>{tr('ctx.browser.idle')}</div>
        <button
          className="btn primary sm"
          onClick={() => void launchBrowser().catch((err) => console.warn('[browser] launch failed', err))}
        >
          {tr('ctx.browser.launch')}
        </button>
      </div>
    )
  }

  return (
    <div className={`browser-pane${compact ? ' compact' : ''}`}>
      <div className="bp-chrome">
        <div className="bp-nav">
          <button className="bp-icon-btn" title={tr('ctx.browser.back')} aria-label={tr('ctx.browser.back')} disabled={!surface.canBack} onClick={() => apiRef.current?.back()}>
            <ArrowLeft size={14} />
          </button>
          <button className="bp-icon-btn" title={tr('ctx.browser.forward')} aria-label={tr('ctx.browser.forward')} disabled={!surface.canForward} onClick={() => apiRef.current?.forward()}>
            <ArrowRight size={14} />
          </button>
          <button className="bp-icon-btn" title={tr('ctx.browser.reload')} aria-label={tr('ctx.browser.reload')} onClick={() => apiRef.current?.reload()}>
            <RotateCw size={13} />
          </button>
        </div>
        <form className="bp-url" onSubmit={submitUrl}>
          <span className="bp-url-scheme" title={secure ? tr('ctx.browser.secure') : tr('ctx.browser.insecure')}>
            {surface.loading
              ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} />
              : secure ? <Lock size={11} /> : <Globe size={11} />}
          </span>
          <input
            ref={urlRef}
            value={urlInput}
            spellCheck={false}
            autoComplete="off"
            placeholder={tr('ctx.browser.address.ph')}
            aria-label={tr('ctx.browser.address.aria')}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => { urlEditing.current = true }}
            onBlur={() => {
              urlEditing.current = false
              if (surface.url != null) setUrlInput(surface.url)
            }}
          />
        </form>
        <div className="bp-actions">
          {!compact && tabs.length > 0 ? (
            <span className="bp-tabcount" title={tr(tabs.length === 1 ? 'ctx.browser.tabs.one' : 'ctx.browser.tabs.many', { n: tabs.length })}>
              <Globe size={10} />{tabs.length}
            </span>
          ) : null}
          <button
            className="bp-icon-btn"
            title={tr('ctx.browser.openExternal')}
            aria-label={tr('ctx.browser.openExternal')}
            disabled={!surface.url}
            onClick={() => surface.url && void openExternal(surface.url)}
          >
            <ExternalLink size={13} />
          </button>
        </div>
      </div>

      <div className="bp-viewport">
        <ScreencastSurface targetId={targetId} conn={conn} apiRef={apiRef} onState={onState} />
      </div>

      <div className="bp-foot">
        <span className={`bp-live${conn === 'connected' && targetId ? ' on' : ''}`}>
          <span className="bp-live-dot" /> {tr('ctx.browser.live')}
        </span>
        <span className="bp-caption" title={tr('ctx.browser.captionTitle')}>{tr('ctx.browser.caption')}</span>
      </div>
    </div>
  )
}

// ── the screencast surface ───────────────────────────────────────────

interface ScreencastMetadata {
  offsetTop?: number
  pageScaleFactor?: number
  deviceWidth?: number
  deviceHeight?: number
}

interface ScreencastFrameEvent {
  data: string
  metadata?: ScreencastMetadata
  sessionId?: string
}

interface FrameNavigatedEvent {
  frame?: { id?: string; parentId?: string; url?: string }
}

interface NavigationHistory {
  currentIndex: number
  entries: { id: number; url: string; title?: string }[]
}

interface DecodedFrame {
  src: CanvasImageSource
  width: number
  height: number
}

function ScreencastSurface({
  targetId, conn, apiRef, onState,
}: {
  targetId: string | null
  conn: CdpConnectionState
  apiRef: RefObject<ScreencastApi | null>
  onState: (patch: Partial<SurfaceState>) => void
}) {
  useStore(locale)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<string | null>(null)
  const metaRef = useRef({ offsetTop: 0, pageScaleFactor: 1 })
  const clickStateRef = useRef({ t: 0, x: -100, y: -100, count: 0 })
  const lastMoveRef = useRef(0)
  const [frameSeen, setFrameSeen] = useState(false)

  // Attach to the target and run the screencast while target + connection
  // hold. Re-runs (fresh attach) when either changes or the ws reconnects.
  useEffect(() => {
    setFrameSeen(false)
    const canvas = canvasRef.current
    if (!canvas || !targetId || conn !== 'connected') {
      sessionRef.current = null
      apiRef.current = null
      return
    }
    const cdp = getCdp()
    let disposed = false
    let sessionId = ''
    let pendingFrames = 0
    sessionRef.current = null

    const syncNav = async (sid: string) => {
      try {
        const hist = await cdp.send<NavigationHistory>('Page.getNavigationHistory', {}, sid)
        const entry = hist.entries[hist.currentIndex]
        onState({
          url: entry?.url ?? 'about:blank',
          canBack: hist.currentIndex > 0,
          canForward: hist.currentIndex < hist.entries.length - 1,
        })
      } catch { /* target went away */ }
    }

    const attach = async (attempt: number): Promise<void> => {
      try {
        sessionId = await cdp.attachToPage(targetId)
        if (disposed) {
          void cdp.send('Target.detachFromTarget', { sessionId }).catch(() => { /* noop */ })
          return
        }
        sessionRef.current = sessionId
        await cdp.send('Page.enable', {}, sessionId)
        if (disposed) return
        apiRef.current = {
          navigate: (url: string) => {
            onState({ loading: true })
            void cdp.send('Page.navigate', { url }, sessionId).catch(() => { /* surfaced by events */ })
          },
          reload: () => {
            onState({ loading: true })
            void cdp.send('Page.reload', {}, sessionId).catch(() => { /* noop */ })
          },
          back: () => {
            void (async () => {
              try {
                const h = await cdp.send<NavigationHistory>('Page.getNavigationHistory', {}, sessionId)
                const entry = h.entries[h.currentIndex - 1]
                if (entry) {
                  onState({ loading: true })
                  await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId)
                }
              } catch { /* noop */ }
            })()
          },
          forward: () => {
            void (async () => {
              try {
                const h = await cdp.send<NavigationHistory>('Page.getNavigationHistory', {}, sessionId)
                const entry = h.entries[h.currentIndex + 1]
                if (entry) {
                  onState({ loading: true })
                  await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId)
                }
              } catch { /* noop */ }
            })()
          },
        }
        await syncNav(sessionId)
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200 }, sessionId)
      } catch (err) {
        const staleSid = sessionId
        sessionId = ''
        sessionRef.current = null
        apiRef.current = null
        if (staleSid) void cdp.send('Target.detachFromTarget', { sessionId: staleSid }).catch(() => { /* noop */ })
        if (disposed) return
        if (attempt < 3) {
          // most failures are ws races right after connect — retry shortly
          setTimeout(() => { if (!disposed) void attach(attempt + 1) }, 1_200)
        } else {
          console.warn('[browser] attach failed:', err)
        }
      }
    }
    void attach(0)

    // Event handlers are registered before the attach resolves; each one
    // no-ops until `sessionId` matches (flatted session id on the envelope).
    const unsubs: Array<() => void> = [
      cdp.on('Page.screencastFrame', (p: ScreencastFrameEvent | undefined, sid?: string) => {
        if (disposed || !sid || sid !== sessionId || !p?.data) return
        const md = p.metadata ?? {}
        // Backpressure: at most 2 frames may await decode/draw; anything
        // beyond is dropped but STILL acked, or Chromium stops streaming.
        if (pendingFrames >= 2) {
          void cdp.send('Page.screencastFrameAck', {}, sid).catch(() => { /* noop */ })
          return
        }
        pendingFrames++
        decodeJpeg(p.data)
          .then((frame) => {
            if (disposed || !frame) return
            const c = canvasRef.current
            const ctx = c?.getContext('2d')
            if (!c || !ctx) return
            // Size the bitmap to the frame itself (the device viewport under
            // the maxWidth/maxHeight caps) — display scaling is pure CSS.
            if (c.width !== frame.width || c.height !== frame.height) {
              c.width = frame.width
              c.height = frame.height
            }
            ctx.drawImage(frame.src, 0, 0)
            closeBitmap(frame.src)
            metaRef.current = { offsetTop: md.offsetTop ?? 0, pageScaleFactor: md.pageScaleFactor ?? 1 }
            setFrameSeen(true)
          })
          .catch(() => { /* corrupt frame — skip */ })
          .finally(() => {
            pendingFrames--
            void cdp.send('Page.screencastFrameAck', {}, sid).catch(() => { /* noop */ })
          })
      }),
      cdp.on('Page.frameNavigated', (p: FrameNavigatedEvent | undefined, sid?: string) => {
        if (disposed || !sid || sid !== sessionId || !p?.frame) return
        if (p.frame.parentId !== undefined) return // main frame only
        onState({ url: p.frame.url ?? '', loading: true })
        void syncNav(sessionId)
      }),
      cdp.on('Page.navigatedWithinDocument', (p: { url?: string } | undefined, sid?: string) => {
        if (disposed || !sid || sid !== sessionId || !p) return
        onState({ url: p.url ?? '' })
      }),
      cdp.on('Page.loadEventFired', (_p: unknown, sid?: string) => {
        if (disposed || !sid || sid !== sessionId) return
        onState({ loading: false })
        void syncNav(sessionId)
      }),
    ]

    return () => {
      disposed = true
      apiRef.current = null
      sessionRef.current = null
      for (const u of unsubs) u()
      if (sessionId) {
        void cdp.send('Page.stopScreencast', {}, sessionId).catch(() => { /* noop */ })
        void cdp.send('Target.detachFromTarget', { sessionId }).catch(() => { /* noop */ })
      }
      const c = canvasRef.current
      const ctx = c?.getContext('2d')
      if (c && ctx && c.width > 0) ctx.clearRect(0, 0, c.width, c.height)
      setFrameSeen(false)
    }
  }, [targetId, conn, apiRef, onState])

  // ── input forwarding (CDP Input domain) ──────────────────────────

  const buttonName = (b: number): 'left' | 'middle' | 'right' | 'none' =>
    b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'none'

  /** Event point → canvas-local px (React's synthetic events don't carry
      offsetX/offsetY, so derive them from the bounding rect). */
  const canvasOffset = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const c = canvasRef.current
    if (!c) return null
    const rect = c.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Canvas-local px → page CSS px: undo the canvas' display scale, then the
      page zoom (÷ pageScaleFactor); offsetTop carries the frame's scroll
      offset (the standard screencast coordinate formula). */
  const toPagePoint = (offsetX: number, offsetY: number): { x: number; y: number } | null => {
    const c = canvasRef.current
    if (!c || !c.clientWidth || !c.width) return null
    const display = c.width / c.clientWidth
    const { offsetTop, pageScaleFactor } = metaRef.current
    const scale = display / (pageScaleFactor || 1)
    return { x: offsetX * scale, y: offsetY * scale + offsetTop }
  }

  const sendMouse = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
    offset: { x: number; y: number } | null,
    button: 'left' | 'middle' | 'right' | 'none',
    clickCount: number,
  ) => {
    const sid = sessionRef.current
    const pos = offset && toPagePoint(offset.x, offset.y)
    if (!sid || !pos) return
    void getCdp().send('Input.dispatchMouseEvent', {
      type,
      x: pos.x,
      y: pos.y,
      button,
      clickCount,
      modifiers: modifiers(e),
    }, sid).catch(() => { /* noop */ })
  }

  const sendKey = (type: 'keyDown' | 'keyUp', e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const sid = sessionRef.current
    if (!sid) return
    // let app-level shortcuts (⌘K palette, ⌘1..9 views) reach the shell
    const k = e.key.toLowerCase()
    if (e.metaKey || (e.ctrlKey && (k === 'k' || k === 'j' || /^[0-9]$/.test(k)))) return
    e.preventDefault()
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
    const text = type === 'keyDown'
      ? e.key === 'Enter' ? '\r' : e.key === 'Tab' ? '\t' : printable ? e.key : undefined
      : undefined
    void getCdp().send('Input.dispatchKeyEvent', {
      type,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      text,
      unmodifiedText: text,
      autoRepeat: e.repeat || undefined,
      location: e.location,
      modifiers: modifiers(e),
    }, sid).catch(() => { /* noop */ })
  }

  // Wheel must be a native listener: React's onWheel is passive at the root,
  // so preventDefault() (which we need to keep the pane from scrolling the
  // app) would be ignored.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      const sid = sessionRef.current
      const off = canvasOffset(e)
      const pos = off && toPagePoint(off.x, off.y)
      if (!sid || !pos) return
      e.preventDefault()
      void getCdp().send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: pos.x,
        y: pos.y,
        button: 'none',
        clickCount: 0,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers: modifiers(e),
      }, sid).catch(() => { /* noop */ })
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    e.currentTarget.focus()
    const off = canvasOffset(e)
    const now = Date.now()
    const s = clickStateRef.current
    const isDouble = off && now - s.t < 500 && Math.abs(off.x - s.x) < 6 && Math.abs(off.y - s.y) < 6 && e.button === 0
    s.t = now
    s.x = off?.x ?? -100
    s.y = off?.y ?? -100
    s.count = isDouble ? 2 : 1
    sendMouse('mousePressed', e, off, buttonName(e.button), s.count)
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className="bp-canvas"
        tabIndex={0}
        aria-label={tr('ctx.browser.viewport.aria')}
        onMouseDown={onMouseDown}
        onMouseUp={(e) => sendMouse('mouseReleased', e, canvasOffset(e), buttonName(e.button), Math.max(clickStateRef.current.count, 1))}
        onMouseMove={(e) => {
          const now = performance.now()
          if (now - lastMoveRef.current < 16) return // ~60/s cap
          lastMoveRef.current = now
          sendMouse('mouseMoved', e, canvasOffset(e), 'none', 0)
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => sendKey('keyDown', e)}
        onKeyUp={(e) => sendKey('keyUp', e)}
      />
      {conn !== 'connected' ? (
        <div className="bp-overlay">
          <div className="spinner" style={{ width: 16, height: 16 }} />
          <div>{tr('ctx.browser.connecting')}</div>
        </div>
      ) : !targetId ? (
        <div className="bp-overlay">
          <Globe size={18} />
          <div>{tr('ctx.browser.notab')}</div>
        </div>
      ) : !frameSeen ? (
        <div className="bp-overlay">
          <div className="spinner" style={{ width: 16, height: 16 }} />
          <div>{tr('ctx.browser.starting')}</div>
        </div>
      ) : null}
    </>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** Scheme it if it has one, https it if it looks like a host, else search. */
function normalizeUrl(input: string): string {
  const t = input.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t
  if (/^localhost([:/?#].*)?$/i.test(t)) return `http://${t}`
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(t)) return `https://${t}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`
}

async function decodeJpeg(b64: string): Promise<DecodedFrame | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      return { src: bitmap, width: bitmap.width, height: bitmap.height }
    }
    const img = new Image()
    img.src = `data:image/jpeg;base64,${b64}`
    await img.decode()
    return { src: img, width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return null
  }
}

function closeBitmap(src: CanvasImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close()
}
