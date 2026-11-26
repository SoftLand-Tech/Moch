import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Pressable, ScrollView, StyleSheet, TextInput, type GestureResponderEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { WebView } from 'react-native-webview'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { showAlert } from '../../src/components/AlertDialog'
import { Icon } from '../../src/components/Icon'
import { Card, GhostBtn, HeaderButton, PrimaryBtn, Spinner, Txt } from '../../src/components/ui'
import { C, useStyles } from '../../src/lib/theme'
import { tr, useT } from '../../src/lib/strings'
import {
  linuxStatus,
  linuxTermProbe,
  linuxTermStartSession,
  linuxTermWriteSession,
  linuxTermDrainSession,
  linuxTermReplaySession,
  linuxTermClearSession,
  linuxTermResizeSession,
  linuxTermKillSession,
} from '../../src/lib/mochiRuntime'
import {
  FIELD_SENTINEL,
  TERM_DRAIN_FAST_MS,
  TERM_KEYS,
  TERM_CTRL_KEYS,
  TerminalController,
  applyFieldChange,
  createSessionTermNative,
  newTermSessionId,
  type FieldState,
  type TermSessionTransport,
  type TermState,
} from '../../src/lib/terminal'
import { activeProjectIdAtom, projectsAtom } from '../../src/lib/workspace'
import { pickProjectCwd } from '../../src/lib/projectScope'
import { openInAppBrowserTab } from '../../src/lib/openInBrowser'

type Gate = 'checking' | 'noprobe' | 'noguest' | 'nopty' | 'ready' | 'failed'

/**
 * BUG-135: grace window a tap gives the WebView's __linkAt hit-test to
 * answer before the legacy IME re-focus fires. Well above the bridge
 * round-trip (~tens of ms), short enough that the refocus still feels
 * instant.
 */
const REFOCUS_DELAY_MS = 140

/** xterm font bounds — 13 is the renderer's default, 9/20 keep it legible. */
const FONT_MIN = 9
const FONT_MAX = 20

/** Native session transport — one bound adapter per tab (no global controller). */
const TERM_TRANSPORT: TermSessionTransport = {
  startSession: linuxTermStartSession,
  writeSession: linuxTermWriteSession,
  drainSession: linuxTermDrainSession,
  replaySession: linuxTermReplaySession,
  clearSession: linuxTermClearSession,
  resizeSession: linuxTermResizeSession,
  killSession: linuxTermKillSession,
}

interface TerminalTab {
  id: string
  cwd: string | null
  label: string
  ctl: TerminalController
}

/**
 * Tab metadata survives a screen unmount (navigating to Chat and back) so
 * the Python PTYs — which live in the runtime process — are reattached by
 * their existing session ids instead of leaking behind fresh shells. The
 * controllers themselves are per-mount; nothing here is a global controller.
 */
interface PersistedTermTab {
  id: string
  cwd: string | null
  label: string
}

const persistedTabs: {
  tabs: PersistedTermTab[]
  activeId: string | null
  seq: number
} = { tabs: [], activeId: null, seq: 0 }

/** Project folder basename for a compact tab label. */
function folderName(cwd: string | null): string | null {
  if (!cwd) return null
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const last = parts[parts.length - 1]
  return last || null
}

export default function Terminal() {
  const s = useStyles(makeS)
  const t = useT()
  // BUG-093: the bottom edge stays STATIC. The keyboard lift is the chat
  // pattern's animated negative paddingBottom (TerminalInner); swapping the
  // edge per keyboard state re-lays-out the whole frame mid-animation for
  // nothing (and sank the lift back by the inset in the KAV attempt).
  return (
    <SafeAreaView style={s.frame} edges={['bottom']}>
      <ScreenShell
        title={t('sidebar.terminal')}
        right={<TerminalMenu onKill={() => killRef.current?.()} onClear={() => clearRef.current?.()} />}
      >
        <TerminalInner />
      </ScreenShell>
    </SafeAreaView>
  )
}

// ScreenShell renders `right` outside the screen subtree — cross the gap with refs.
const killRef = { current: null as null | (() => void) }
const clearRef = { current: null as null | (() => void) }

function TerminalMenu({ onKill, onClear }: { onKill: () => void; onClear: () => void }) {
  const s = useStyles(makeS)
  const t = useT()
  // Mockup: compact 28dp header icons — clear in ink, kill in red.
  return (
    <View style={s.menuRow}>
      <HeaderButton
        onPress={onClear}
        accessibilityLabel={t('terminal.clear')}
        style={s.menuBtn}
      >
        <Icon name="backspace-outline" size={16} color={C.text} />
      </HeaderButton>
      <HeaderButton
        onPress={onKill}
        accessibilityLabel={t('terminal.kill')}
        style={s.menuBtn}
      >
        <Icon name="close" size={16} color={C.red} />
      </HeaderButton>
    </View>
  )
}

function TerminalInner() {
  const s = useStyles(makeS)
  const t = useT()
  const router = useRouter()
  const projects = useStore(projectsAtom)
  const activeProjectId = useStore(activeProjectIdAtom)
  // IME visibility truth (RN focus lies on Android — see focusInput).
  // BUG-133: selector form — the object form re-rendered on every per-frame
  // keyboard animation field; only isVisible is consumed here.
  const keyboardVisible = useKeyboardState((k) => k.isVisible)
  const [gate, setGate] = useState<Gate>('checking')
  const [gateMsg, setGateMsg] = useState('')
  const [snap, setSnap] = useState<{ state: TermState; alive: boolean }>({ state: 'idle', alive: false })
  const [hidden, setHidden] = useState('')
  const [fontSize, setFontSize] = useState(13)
  /** Fitted xterm grid — display-only mirror of the `fit` message. */
  const [termGrid, setTermGrid] = useState({ cols: 80, rows: 24 })
  // BUG-093 lift: same driver as the chat screen (chat.tsx BUG-037 fix) —
  // the reanimated keyboard height as a negative bottom pad. The
  // KeyboardAvoidingView computed its pad from parent-relative coords and
  // ran short by status-bar + header height, so the key row and composer
  // stayed behind the IME; no coordinate math survives this host.
  const kb = useReanimatedKeyboardAnimation()
  const kbPad = useAnimatedStyle(() => ({ paddingBottom: -kb.height.value }))
  // Composer state machine (BUG-095): logical text + backspace key events
  // awaiting their change event. The field value is FIELD_SENTINEL + logical.
  const fieldRef = useRef<FieldState>({ logical: '', pendingKeys: 0 })
  const inputRef = useRef<TextInput>(null)
  // BUG-097 renderer: xterm.js lives in a local-asset WebView. Raw PTY
  // bytes flow controller → injectJavaScript → window.__tq → xterm.write;
  // the WebView answers with {ready|fit} JSON on postMessage.
  const wvRef = useRef<WebView>(null)
  const out = useRef({ ready: false, buf: [] as string[], bytes: 0 })
  /** Which tab the mounted WebView belongs to (stale postMessage guard). */
  const webTabRef = useRef('')
  // BUG-135 tap arbitration: the box-only wrapper (BUG-100) owns every tap.
  // A tap is EITHER a link open (WebView answers the __linkAt hit-test with
  // {type:'link'}) OR the legacy IME re-focus — never both. The refocus is
  // deferred one beat; a link reply cancels it.
  const hitRef = useRef<View>(null)
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingRefocus = useCallback(() => {
    if (refocusTimer.current != null) {
      clearTimeout(refocusTimer.current)
      refocusTimer.current = null
    }
  }, [])
  const inject = useCallback((js: string) => {
    wvRef.current?.injectJavaScript(js)
  }, [])
  const pushChunk = useCallback(
    (b64: string) => {
      const o = out.current
      if (!o.ready) {
        // WebView still loading — buffer, dropping the OLDEST bytes past
        // 4MB (a `cat huge` before load isn't worth memory).
        o.buf.push(b64)
        o.bytes += b64.length
        while (o.bytes > 4_000_000 && o.buf.length > 1) {
          const head = o.buf[0] ?? ''
          o.bytes -= head.length
          o.buf.shift()
        }
        return
      }
      inject(`window.__tq(${JSON.stringify(b64)});void 0;`)
    },
    [inject],
  )

  // Active-tab routing: only the tab the UI currently shows may paint.
  const activeIdRef = useRef('')
  const pushChunkFor = useCallback(
    (tabId: string, b64: string) => {
      if (activeIdRef.current === tabId) pushChunk(b64)
    },
    [pushChunk],
  )

  const tabSeqRef = useRef(0)
  /** Live cwd per tab — the controller's adapter reads this at start time. */
  const cwdByIdRef = useRef<Record<string, string | null>>({})
  const createTab = useCallback(
    (cwd: string | null, saved?: PersistedTermTab): TerminalTab => {
      if (saved) {
        cwdByIdRef.current[saved.id] = cwd
        const ctl = new TerminalController(
          createSessionTermNative(TERM_TRANSPORT, saved.id, () => cwdByIdRef.current[saved.id] ?? null),
          { drainMs: TERM_DRAIN_FAST_MS, onChunk: (b64) => pushChunkFor(saved.id, b64) },
        )
        return { id: saved.id, cwd, label: saved.label, ctl }
      }
      tabSeqRef.current += 1
      const n = tabSeqRef.current
      const id = newTermSessionId()
      cwdByIdRef.current[id] = cwd
      const ctl = new TerminalController(
        createSessionTermNative(TERM_TRANSPORT, id, () => cwdByIdRef.current[id] ?? null),
        { drainMs: TERM_DRAIN_FAST_MS, onChunk: (b64) => pushChunkFor(id, b64) },
      )
      return { id, cwd, label: folderName(cwd) ?? tr('terminal.tab.label', { n }), ctl }
    },
    [pushChunkFor],
  )

  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    if (persistedTabs.tabs.length) {
      tabSeqRef.current = persistedTabs.seq
      return persistedTabs.tabs.map((m) => createTab(m.cwd, m))
    }
    const cwd = pickProjectCwd(
      projects.map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
      activeProjectId,
    ) ?? null
    return [createTab(cwd)]
  })
  const [activeId, setActiveId] = useState<string>(() => {
    if (persistedTabs.activeId && tabs.some((x) => x.id === persistedTabs.activeId)) {
      return persistedTabs.activeId
    }
    return tabs[0]?.id ?? ''
  })
  const activeTab = tabs.find((x) => x.id === activeId) ?? tabs[0] ?? null
  const activeTabRef = useRef<TerminalTab | null>(activeTab)
  activeTabRef.current = activeTab
  if (activeId) activeIdRef.current = activeId
  // The WebView is keyed by tab id and remounts on switch. Set its identity
  // during render, not only in onLoadStart: the local asset can answer
  // `ready` before that event is delivered (fast WebView cache), and a
  // dropped ready would leave a blank xterm.
  webTabRef.current = activeTab?.id ?? ''
  const tabsRef = useRef<TerminalTab[]>(tabs)
  tabsRef.current = tabs
  /** Reattach snapshot in flight for a tab switch — ready waits for it. */
  const pendingReattachRef = useRef<Promise<string> | null>(null)
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const dead = snap.state === 'dead'
  // Sticky pad modifiers (BUG-099): Ctrl/Alt arm and compose with the NEXT
  // key — a pad key sends its ctrlSeq; a typed char gets Ctrl→\x03-class
  // or Alt→ESC-prefix treatment. One-shot: consumed or disarmed.
  const [armed, setArmed] = useState<'ctrl' | 'alt' | null>(null)
  const armedRef = useRef<'ctrl' | 'alt' | null>(null)

  // Persist tab metadata for the next mount (PTYs stay in the runtime).
  useEffect(() => {
    persistedTabs.tabs = tabs.map(({ id, cwd, label }) => ({ id, cwd, label }))
    persistedTabs.activeId = activeId || null
    persistedTabs.seq = tabSeqRef.current
  }, [tabs, activeId])

  const send = useCallback((raw: string) => {
    if (!raw) return
    void activeTabRef.current?.ctl.send(raw)
  }, [])

  /** Finish a WebView load for one tab (after its reattach snapshot lands). */
  const paintReady = useCallback(
    (tab: TerminalTab) => {
      if (activeIdRef.current !== tab.id) return
      out.current.ready = true
      // The controller's raw bank is authoritative — it contains the native
      // replay AND every chunk (including ones buffered while loading).
      const bank = tab.ctl.rawBank
      if (bank) inject(`window.__tq(${JSON.stringify(bank)});void 0;`)
      out.current.buf = []
      out.current.bytes = 0
      inject(`window.__tsize(${fontSizeRef.current});void 0;`)
      inject('window.__fit();void 0;')
      tab.ctl.resume()
    },
    [inject],
  )

  const handleWebMsg = useCallback(
    (e: { nativeEvent: { data: string } }) => {
      const tab = activeTabRef.current
      if (!tab || webTabRef.current !== tab.id) return
      let msg: { type?: string; cols?: number; rows?: number; data?: string; url?: string }
      try {
        msg = JSON.parse(e.nativeEvent.data)
      } catch {
        return
      }
      if (msg.type === 'ready') {
        out.current.ready = false
        const pending = pendingReattachRef.current
        const tabId = tab.id
        if (pending) {
          void pending.then(() => {
            if (activeIdRef.current === tabId) paintReady(tab)
          })
          return
        }
        paintReady(tab)
      } else if (msg.type === 'fit' && msg.cols && msg.rows) {
        const cols = msg.cols
        const rows = msg.rows
        // Display-only mirror for the status bar; resize itself unchanged.
        setTermGrid((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }))
        void tab.ctl.resize(cols, rows)
      } else if (msg.type === 'key' && typeof msg.data === 'string' && msg.data) {
        // BUG-100 safety net: if the WebView ever holds focus, the Android
        // IME types into xterm's internal textarea — forward those bytes
        // instead of dropping them. Android has exactly one focused view,
        // so this channel and the hidden sentinel input are mutually
        // exclusive; no double-send is possible.
        send(msg.data)
      } else if (msg.type === 'link' && typeof msg.url === 'string' && msg.url) {
        // BUG-135: the WebView's __linkAt hit-test answered — this tap was
        // on a URL. Cancel the pending IME re-focus and open the built-in
        // Browser instead of raising the keyboard.
        cancelPendingRefocus()
        openInAppBrowserTab(msg.url)
      }
    },
    [cancelPendingRefocus, paintReady, send],
  )

  // Refit on layout changes (keyboard lift, font bump) — trailing throttle
  // so the RNKC animation frames don't storm fit/resize.
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleFit = useCallback(() => {
    clearTimeout(fitTimer.current)
    fitTimer.current = setTimeout(() => inject('window.__fit();void 0;'), 120)
  }, [inject])
  useEffect(() => () => clearTimeout(fitTimer.current), [])

  // Gate check once per screen mount: status → probe → ready. Tabs are
  // already created but never start until the guest is proven.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const st = await linuxStatus()
        if (!alive) return
        if (!st?.bootstrapped) {
          setGate('noguest')
          return
        }
        const p = await linuxTermProbe()
        if (!alive) return
        if (!p) {
          setGate('noprobe')
          setGateMsg(tr('terminal.bridgeMissing'))
          return
        }
        if (!p.pty || !p.shell) {
          setGate('nopty')
          setGateMsg(p.error ?? tr('terminal.ptyRefused'))
          return
        }
        setGate('ready')
      } catch (e) {
        if (alive) {
          setGate('failed')
          setGateMsg(e instanceof Error ? e.message : tr('terminal.startFailed'))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // On tab switch: only the target may poll. Reset the per-WebView buffers,
  // clear the logical composer (text typed for tab A never goes to tab B),
  // and take the target's 64 KiB replay snapshot before its xterm remounts.
  useEffect(() => {
    const tab = tabsRef.current.find((x) => x.id === activeId) ?? null
    activeIdRef.current = tab?.id ?? ''
    out.current = { ready: false, buf: [], bytes: 0 }
    fieldRef.current = { logical: '', pendingKeys: 0 }
    setHidden('')
    armedRef.current = null
    setArmed(null)
    setSnap(tab ? { state: tab.ctl.state, alive: tab.ctl.alive } : { state: 'idle', alive: false })
    cancelPendingRefocus()
    for (const other of tabsRef.current) {
      if (other.id !== tab?.id) other.ctl.pause()
    }
    if (!tab) {
      pendingReattachRef.current = null
      return
    }
    tab.ctl.pause()
    pendingReattachRef.current = tab.ctl.reattach()
  }, [activeId, cancelPendingRefocus])

  // Subscribe to the active controller only; inactive tabs keep their state.
  useEffect(() => {
    if (!activeTab) return
    const off = activeTab.ctl.onChange(setSnap)
    setSnap({ state: activeTab.ctl.state, alive: activeTab.ctl.alive })
    return off
  }, [activeTab])

  // Projects hydrate after the drawer's first refresh. If the Terminal mounts
  // before that, adopt the selected project's folder before the shell starts,
  // so the first tab does not silently stay at the workspace root.
  useEffect(() => {
    if (!activeTab || activeTab.cwd || activeTab.ctl.state !== 'idle') return
    const resolved =
      pickProjectCwd(
        projects.map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
        activeProjectId,
      ) ?? null
    if (!resolved) return
    cwdByIdRef.current[activeTab.id] = resolved
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTab.id ? { ...t, cwd: resolved, label: folderName(resolved) ?? t.label } : t,
      ),
    )
  }, [projects, activeProjectId, activeTab])

  // Start the active tab's shell once the gate is ready. A restored live
  // session was adopted by reattach() (state live) and is skipped.
  useEffect(() => {
    if (gate !== 'ready' || !activeTab) return
    const resolved =
      pickProjectCwd(
        projects.map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
        activeProjectId,
      ) ?? null
    if (!activeTab.cwd && resolved) return // cwd-adoption effect above runs first
    let alive = true
    const run = async () => {
      // Let the switch's replay snapshot land first: a restored live shell
      // is adopted there and must not be "started" a second time.
      try {
        await pendingReattachRef.current
      } catch {
        /* reattach is best-effort */
      }
      if (!alive || activeTab.ctl.state !== 'idle') return
      const ok = await activeTab.ctl.start(80, 24)
      if (!alive || ok) return
      setGateMsg(activeTab.ctl.error ?? tr('terminal.startFailed'))
      setGate('failed')
    }
    void run()
    return () => {
      alive = false
    }
  }, [gate, activeTab, projects, activeProjectId])

  // Session survives unmount (app holds the process) — stop polling only.
  // The tab metadata above lets the next mount reattach to the same PTYs.
  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) tab.ctl.destroy()
    }
  }, [])

  // ── Tab actions ────────────────────────────────────────────────────────
  const switchTab = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return
      activeIdRef.current = id
      cancelPendingRefocus()
      setActiveId(id)
    },
    [cancelPendingRefocus],
  )

  const newTabCwd = useCallback(
    () =>
      pickProjectCwd(
        projects.map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
        activeProjectId,
      ) ?? null,
    [activeProjectId, projects],
  )

  const addTab = useCallback(() => {
    const tab = createTab(newTabCwd())
    activeIdRef.current = tab.id
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }, [createTab, newTabCwd])

  const closeTab = useCallback(
    (id: string) => {
      const current = tabsRef.current
      const idx = current.findIndex((x) => x.id === id)
      if (idx < 0) return
      const closing = current[idx]
      if (closing) {
        delete cwdByIdRef.current[closing.id]
        void closing.ctl.kill()
        closing.ctl.destroy()
      }
      const next = current.filter((x) => x.id !== id)
      if (next.length === 0) {
        const fresh = createTab(newTabCwd())
        activeIdRef.current = fresh.id
        setTabs([fresh])
        setActiveId(fresh.id)
        return
      }
      if (id === activeIdRef.current) {
        const nextActive = next[Math.min(idx, next.length - 1)] ?? next[0]
        if (nextActive) {
          activeIdRef.current = nextActive.id
          setActiveId(nextActive.id)
        }
      }
      setTabs(next)
    },
    [createTab, newTabCwd],
  )

  // ── Modifier / input state ─────────────────────────────────────────────
  const consumeArmed = useCallback(() => {
    const m = armedRef.current
    armedRef.current = null
    setArmed(null)
    return m
  }, [])
  const onPadKey = useCallback(
    (seq: string) => {
      const m = consumeArmed()
      // An armed Alt prefixes; an armed Ctrl over a plain pad key falls
      // back to the unmodified seq (the pad's ctrlSeq handled Ctrl already).
      send(m === 'alt' ? TERM_KEYS.ESC + seq : seq)
    },
    [consumeArmed, send],
  )

  // Direct PTY typing: the PTY has ECHO ON, so the drained output is the
  // display — forward only what the field state machine derives
  // (applyFieldChange) and never render local input (no double echo).
  // The field value is FIELD_SENTINEL + logical, so a backspace always
  // has a char to delete (BUG-095): deleting the sentinel is "DEL past
  // field start"; the key-event channel is paired by counting, so IMEs
  // that emit both events can't double-delete. Armed pad modifiers
  // (BUG-099) compose with the typed char instead of applying the field.
  const onHiddenChange = useCallback(
    (raw: string) => {
      const m = armedRef.current
      if (m && raw.length >= 1) {
        const appended = raw.startsWith(FIELD_SENTINEL) ? raw.slice(1) : raw
        const ch = appended.slice(fieldRef.current.logical.length)
        if (ch.length === 1 && ch >= ' ' && ch !== '\x7f') {
          armedRef.current = null
          setArmed(null)
          send(m === 'ctrl' ? String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64) : TERM_KEYS.ESC + ch)
          // Leave the field untouched: the composed byte never entered it.
          setHidden(fieldRef.current.logical)
          return
        }
      }
      const { bytes, next } = applyFieldChange(fieldRef.current, raw)
      fieldRef.current = next
      if (bytes) send(bytes)
      setHidden(next.logical)
    },
    [send],
  )

  // Re-raising a dismissed IME needs a REAL native focus transition: when
  // the user hides the keyboard, Android silently keeps the input focused,
  // and showSoftInput off an already-focused view is dropped by the IMMS
  // (BUG-091 — plain focus() did nothing; selecting output text was the
  // only thing that blurred the field for real). blur() then refocus a
  // frame later supplies the transition. While the IME is up this is
  // skipped — no point tearing focus on every output tap. Touch-CANCEL is
  // deliberately NOT wired: long-press text selection ends there and must
  // not be torn down.
  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el || keyboardVisible) return
    el.blur()
    requestAnimationFrame(() => el.focus())
  }, [keyboardVisible])

  /**
   * BUG-135 tap arbitration for the box-only wrapper. On touchEnd: ask the
   * WebView WHERE the tap landed (window.__linkAt does the px→cell→URL
   * hit-test — only it knows cells and scrollback), and defer the legacy
   * focusInput by one beat (REFOCUS_DELAY_MS). A {type:'link'} reply
   * cancels the refocus and opens the built-in Browser; no reply within
   * the window means "not a link" and focusInput runs exactly as before.
   * When the WebView isn't ready (still loading / renderer gone) there is
   * no one to answer, so focusInput runs immediately — today's behavior.
   */
  const onTapOutput = useCallback(
    (e: GestureResponderEvent) => {
      if (!out.current.ready) {
        focusInput()
        return
      }
      cancelPendingRefocus()
      hitRef.current?.measureInWindow((wx, wy) => {
        const x = Math.round(e.nativeEvent.pageX - wx)
        const y = Math.round(e.nativeEvent.pageY - wy)
        if (x >= 0 && y >= 0) inject(`window.__linkAt(${x},${y});void 0;`)
      })
      refocusTimer.current = setTimeout(() => {
        refocusTimer.current = null
        focusInput()
      }, REFOCUS_DELAY_MS)
    },
    [cancelPendingRefocus, focusInput, inject],
  )
  useEffect(() => cancelPendingRefocus, [cancelPendingRefocus])

  const submitLine = useCallback(() => {
    send(TERM_KEYS.ENTER)
    fieldRef.current = { logical: '', pendingKeys: 0 }
    setHidden('')
  }, [send])

  // Header clear/kill act on the ACTIVE tab (refs cross the ScreenShell gap).
  killRef.current = useCallback(() => {
    showAlert(tr('terminal.killTitle'), tr('terminal.killBody'), [
      { text: tr('common.cancel'), style: 'cancel' },
      {
        text: tr('terminal.killCta'),
        style: 'destructive',
        onPress: () => {
          void activeTabRef.current?.ctl.kill()
        },
      },
    ])
  }, [])

  clearRef.current = useCallback(() => {
    const ctl = activeTabRef.current?.ctl
    if (!ctl) return
    // Wipe the xterm viewport, this tab's raw bank AND python's replay bank
    // — otherwise switching away and back repaints the cleared scrollback.
    void ctl.clear()
    inject('window.__reset();void 0;')
  }, [inject])

  // Font size lives in xterm now — push it on change (13 on mount is the
  // HTML default; subsequent bumps arrive live).
  useEffect(() => {
    inject(`window.__tsize(${fontSize});void 0;`)
  }, [fontSize, inject])

  const bumpFont = useCallback((delta: number) => {
    setFontSize((f) => Math.max(FONT_MIN, Math.min(FONT_MAX, f + delta)))
  }, [])

  if (gate === 'checking') {
    return (
      <View style={s.center}>
        <Spinner />
        <Txt size={13} color={C.textDim} center>{t('terminal.starting')}</Txt>
      </View>
    )
  }

  if (gate === 'noguest') {
    return (
      <View style={s.emptyWrap}>
        <Card style={s.emptyCard}>
          <Txt size={15} weight="800" center>{t('terminal.noguest.title')}</Txt>
          <Txt size={12} color={C.textDim} center style={s.emptyBody}>
            {t('terminal.noguest.body')}
          </Txt>
          <PrimaryBtn
            label={t('terminal.noguest.cta')}
            onPress={() => router.push('/onboarding/environment')}
            style={s.emptyCta}
          />
        </Card>
      </View>
    )
  }

  if (gate === 'noprobe' || gate === 'nopty' || gate === 'failed') {
    return (
      <View style={s.center}>
        <Txt size={13} color={C.textDim} center>{gateMsg || t('terminal.failed')}</Txt>
        {snap.state === 'dead' || gate === 'failed' ? (
          <GhostBtn
            label={t('common.retry')}
            onPress={() => {
              const tab = activeTabRef.current
              if (!tab) return
              setGate('checking')
              void tab.ctl.start(80, 24).then((ok) => setGate(ok ? 'ready' : 'failed'))
            }}
            style={s.gateRetry}
          />
        ) : null}
      </View>
    )
  }

  return (
    <Animated.View style={[s.root, kbPad]}>
      {/* Tab strip (above the xterm frame): tap to switch, + opens a new
          project-aware shell, × kills and removes one tab. Sessions of
          inactive tabs stay alive; only this tab's controller polls. */}
      {activeTab ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.tabScroll}
          contentContainerStyle={s.tabStrip}
          accessibilityLabel={t('terminal.tabs.a11y')}
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTab.id
            return (
              <View key={tab.id} style={[s.tabChip, selected && s.tabChipActive]}>
                <Pressable
                  onPress={() => switchTab(tab.id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={tab.label}
                  style={s.tabSelect}
                >
                  <Txt
                    size={11}
                    weight="600"
                    color={selected ? C.greenSoft : C.textDim}
                    numberOfLines={1}
                    style={s.tabLabel}
                  >
                    {tab.label}
                  </Txt>
                </Pressable>
                <Pressable
                  onPress={() => closeTab(tab.id)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={t('terminal.tab.close')}
                  style={({ pressed }) => [s.tabClose, pressed && s.pressed]}
                >
                  <Icon name="close" size={12} color={selected ? C.greenSoft : C.textFaint} />
                </Pressable>
              </View>
            )
          })}
          <Pressable
            onPress={addTab}
            accessibilityRole="button"
            accessibilityLabel={t('terminal.tab.new')}
            style={({ pressed }) => [s.tabAdd, pressed && s.pressed]}
          >
            <Icon name="add" size={16} color={C.greenSoft} />
          </Pressable>
        </ScrollView>
      ) : null}

      {/* Persistent typing context: the active shell's folder + focus state.
          xterm's own cursor is easy to miss on a phone, so the screen always
          answers "where am I typing?" without relying on the canvas. */}
      {activeTab ? (
        <View
          style={[s.focusBar, keyboardVisible && s.focusBarActive]}
          accessibilityLabel={`${activeTab.label}, ${keyboardVisible ? t('terminal.typingHint') : t('terminal.tapHint')}`}
        >
          <View style={[s.focusDot, keyboardVisible && s.focusDotActive]} />
          <Txt mono ltr size={10.5} color={keyboardVisible ? C.greenSoft : C.textDim} numberOfLines={1} style={s.focusPath}>
            ~/{folderName(activeTab.cwd) ?? 'workspace'}
          </Txt>
          <Txt size={10} weight="600" color={keyboardVisible ? C.greenSoft : C.textFaint} numberOfLines={1}>
            {keyboardVisible ? t('terminal.typingHint') : t('terminal.tapHint')}
          </Txt>
        </View>
      ) : null}

      {/* xterm.js frame (mockup screen 5): flex 1, 2/10/6 margins, near-black
          green-tinted surface, 14 radius, 10 padding; the font-size bar sits
          inside on a hairline, the sticky key pad just below the frame. */}
      <View style={[s.termFrame, keyboardVisible && s.termFrameFocused]}>
        {/* Tapping the output re-raises the IME when it's down (blur + refocus
            — see focusInput). BUG-100: Android enforces pointerEvents only on
            ReactViewGroup containers — on the WebView itself it's a no-op, so
            the WebView ate every tap and the IME typed into xterm's internal
            textarea, never reaching the PTY. The box-only wrapper intercepts
            touches BEFORE the WebView and is itself the tap target; the dead
            overlay stays a sibling so Retry remains tappable. */}
        <View style={s.outputWrap} onLayout={scheduleFit}>
          <View ref={hitRef} style={s.outputHit} pointerEvents="box-only" onTouchEnd={onTapOutput}>
            <WebView
              key={activeTab?.id ?? 'term'}
              ref={wvRef}
              source={{ uri: 'file:///android_asset/term/index.html' }}
              javaScriptEnabled
              allowFileAccess
              onLoadStart={() => {
                webTabRef.current = activeTab?.id ?? ''
              }}
              onMessage={handleWebMsg}
              style={s.output}
              onRenderProcessGone={() => {
                // Android WebView renderer died — a reload replays from rawBank.
                out.current.ready = false
                inject('window.location.reload();void 0;')
              }}
            />
          </View>
          {dead ? (
            <View style={s.deadWrap} pointerEvents="box-none">
              <Txt mono ltr size={11} color={C.amber} style={s.deadLine}>
                {t('terminal.sessionEnded')}
              </Txt>
              <GhostBtn
                small
                label={t('common.retry')}
                accessibilityLabel={t('terminal.restart')}
                onPress={() => void activeTabRef.current?.ctl.start(80, 24)}
                style={s.deadRetry}
              />
            </View>
          ) : null}
        </View>

        {/* Font-size bar — mono xterm.js grid label + A− / A+ (real state). */}
        <View style={s.fontBar}>
          <Txt mono ltr size={10.5} color={C.green}>
            {t('terminal.xtermSize', { cols: termGrid.cols, rows: termGrid.rows })}
          </Txt>
          <View style={s.fontBtns}>
            <Pressable
              onPress={() => bumpFont(-1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('terminal.fontSmaller')}
              style={({ pressed }) => [s.fontBtn, pressed && s.pressed]}
            >
              <Txt size={11} weight="700" color={C.text}>{t('terminal.font.decrease')}</Txt>
            </Pressable>
            <Pressable
              onPress={() => bumpFont(1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('terminal.fontBigger')}
              style={({ pressed }) => [s.fontBtn, pressed && s.pressed]}
            >
              <Txt size={11} weight="700" color={C.text}>{t('terminal.font.increase')}</Txt>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Invisible direct-typing field: zero-size, never rendered as text
          (the PTY echo in the drained output is the display). */}
      <TextInput
        ref={inputRef}
        value={FIELD_SENTINEL + hidden}
        onChangeText={onHiddenChange}
        /* Backspace key events: Android dispatches onKeyPress BEFORE the
           text change. Only the logically-empty field needs this channel
           (GBoard's delete on the bare sentinel deletes it and fires the
           change too — applyFieldChange pairs the two so exactly one DEL
           goes out; IMEs that emit the key without the change are covered
           because the DEL is sent HERE). With text in the field the change
           event's diff is authoritative — don't double-send. */
        onKeyPress={(e) => {
          if (e.nativeEvent.key !== 'Backspace' || fieldRef.current.logical !== '') return
          fieldRef.current = { ...fieldRef.current, pendingKeys: fieldRef.current.pendingKeys + 1 }
          send('\x7f')
        }}
        onSubmitEditing={submitLine}
        style={s.hiddenInput}
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        multiline={false}
        blurOnSubmit={false}
        editable={!dead}
        accessibilityLabel={t('terminal.inputA11y')}
      />

      <KeyRow onKey={onPadKey} armed={armed} onArm={(m) => { armedRef.current = m; setArmed(m) }} />
    </Animated.View>
  )
}

/**
 * Pad keys: seq sent as-is; ctrlSeq = Ctrl+key form; hintKey = a11y label.
 * Row 1 is the mockup's sticky row (Ctrl, Alt, Tab, Esc + arrows); row 2
 * keeps every legacy key (^C, ^D, Home, End, PgUp, PgDn) reachable.
 */
const PAD_ROWS: { label: string; seq?: string; ctrlSeq?: string; modifier?: 'ctrl' | 'alt'; hintKey: string }[][] = [
  [
    { label: 'Ctrl', modifier: 'ctrl', hintKey: 'terminal.key.ctrl' },
    { label: 'Alt', modifier: 'alt', hintKey: 'terminal.key.alt' },
    { label: 'Tab', seq: TERM_KEYS.TAB, hintKey: 'terminal.key.tab' },
    { label: 'Esc', seq: TERM_KEYS.ESC, hintKey: 'terminal.key.escape' },
    { label: '↑', seq: TERM_KEYS.UP, ctrlSeq: TERM_CTRL_KEYS.UP, hintKey: 'terminal.key.up' },
    { label: '↓', seq: TERM_KEYS.DOWN, ctrlSeq: TERM_CTRL_KEYS.DOWN, hintKey: 'terminal.key.down' },
    { label: '←', seq: TERM_KEYS.LEFT, ctrlSeq: TERM_CTRL_KEYS.LEFT, hintKey: 'terminal.key.left' },
    { label: '→', seq: TERM_KEYS.RIGHT, ctrlSeq: TERM_CTRL_KEYS.RIGHT, hintKey: 'terminal.key.right' },
  ],
  [
    { label: '^C', seq: TERM_KEYS.CTRL_C, hintKey: 'terminal.key.interrupt' },
    { label: '^D', seq: TERM_KEYS.CTRL_D, hintKey: 'terminal.key.eof' },
    { label: 'Home', seq: TERM_KEYS.HOME, ctrlSeq: TERM_CTRL_KEYS.HOME, hintKey: 'terminal.key.home' },
    { label: 'End', seq: TERM_KEYS.END, ctrlSeq: TERM_CTRL_KEYS.END, hintKey: 'terminal.key.end' },
    { label: 'PgUp', seq: TERM_KEYS.PGUP, hintKey: 'terminal.key.pageUp' },
    { label: 'PgDn', seq: TERM_KEYS.PGDN, hintKey: 'terminal.key.pageDown' },
  ],
]

function KeyRow({
  onKey,
  armed,
  onArm,
}: {
  onKey: (seq: string) => void
  armed: 'ctrl' | 'alt' | null
  onArm: (m: 'ctrl' | 'alt' | null) => void
}) {
  const s = useStyles(makeS)
  const t = useT()
  return (
    <View style={s.padWrap}>
      {PAD_ROWS.map((row, i) => (
        <View key={i} style={s.keyRow}>
          {row.map((k) => {
            const isModifier = k.modifier != null
            const isArmed = k.modifier != null && armed === k.modifier
            return (
              <Pressable
                key={k.label}
                style={({ pressed }) => [s.key, isArmed && s.keyArmed, pressed && s.pressed]}
                onPress={() => {
                  if (isModifier) {
                    // Sticky modifier: arms, disarms on re-tap; consumed by
                    // the next pad key (ctrlSeq) or the next typed char.
                    onArm(armed === k.modifier ? null : (k.modifier ?? null))
                    return
                  }
                  onKey(k.ctrlSeq && armed === 'ctrl' ? k.ctrlSeq : (k.seq ?? ''))
                  if (armed) onArm(null)
                }}
                hitSlop={2}
                accessibilityLabel={t(k.hintKey)}
                accessibilityState={isModifier ? { selected: isArmed } : undefined}
              >
                <Txt mono ltr size={11} weight="700" color={isArmed ? C.bg : C.text}>
                  {k.label}
                </Txt>
              </Pressable>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  frame: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },

  // ── No-guest empty state (mockup screen 5) ────────────────────────────────
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyCard: { padding: 20, width: '100%' },
  emptyBody: { marginTop: 6, marginBottom: 14, lineHeight: 17 },
  emptyCta: { alignSelf: 'center' },
  gateRetry: { marginTop: 12 },

  // ── Tab strip ─────────────────────────────────────────────────────────────
  tabScroll: { flexGrow: 0, marginTop: 2 },
  tabStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  tabChip: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 30,
    maxWidth: 190,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 9,
    overflow: 'hidden',
  },
  tabChipActive: { backgroundColor: C.greenTint, borderColor: C.green },
  tabSelect: { height: 30, justifyContent: 'center', paddingLeft: 10, paddingRight: 4, maxWidth: 150 },
  tabLabel: { letterSpacing: 0.1 },
  tabClose: { width: 26, height: 30, alignItems: 'center', justifyContent: 'center' },
  tabAdd: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgElev,
    borderWidth: 1,
    borderColor: C.border,
  },

  // ── Typing context bar ───────────────────────────────────────────────────
  focusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 10,
    marginBottom: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 9,
    backgroundColor: C.bgCard,
  },
  focusBarActive: {
    borderColor: 'rgba(127,199,154,0.42)',
    backgroundColor: C.greenTint,
  },
  focusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.textFaint, flexShrink: 0 },
  focusDotActive: { backgroundColor: C.greenSoft },
  focusPath: { flex: 1, minWidth: 0 },

  // ── xterm frame + font bar ────────────────────────────────────────────────
  termFrame: {
    flex: 1,
    marginTop: 2,
    marginHorizontal: 10,
    marginBottom: 6,
    backgroundColor: '#050807',
    borderWidth: 1,
    borderColor: 'rgba(127,199,154,0.22)',
    borderRadius: 14,
    padding: 10,
  },
  termFrameFocused: { borderColor: 'rgba(127,199,154,0.55)' },
  outputWrap: { flex: 1 },
  outputHit: { flex: 1 },
  output: { flex: 1, backgroundColor: '#050807' },
  deadWrap: { position: 'absolute', top: 14, left: 0, right: 0, alignItems: 'center' },
  deadLine: { marginTop: 8 },
  deadRetry: { marginTop: 8 },
  fontBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(127,199,154,0.14)',
  },
  fontBtns: { flexDirection: 'row', gap: 5 },
  fontBtn: {
    backgroundColor: C.greenTint,
    borderWidth: 1,
    borderColor: 'rgba(127,199,154,0.24)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 1,
    minWidth: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Sticky key pad ────────────────────────────────────────────────────────
  padWrap: { paddingTop: 2 },
  keyRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingTop: 4 },
  key: {
    flex: 1,
    minWidth: 36,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    backgroundColor: C.bgCard,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  keyArmed: { backgroundColor: C.green, borderColor: C.greenSoft },
  hint: { paddingTop: 4, paddingBottom: 8, paddingHorizontal: 10 },

  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  pressed: { opacity: 0.55 },

  menuRow: { flexDirection: 'row', gap: 6 },
  menuBtn: { width: 28, height: 28, borderRadius: 10 },
})
