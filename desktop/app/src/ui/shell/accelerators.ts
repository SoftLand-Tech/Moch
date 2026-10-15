/** Desktop accelerator table (spec 4.1 web layer). One document keydown
 * listener. A focused text input keeps its own keys: plain characters and
 * Enter/arrows never trigger actions while the target is editable; only
 * modified combos and Escape are global. */
import { closePalette, openPalette, paletteOpen, setShellLayout, shellLayout } from './state'
import { SCREENS } from './registry'
import type { ScreenId } from './state'

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

export function installTauriMenuBridge(handlers: {
  newChat: () => void
  stopRun: () => void
  focusScreen: (id: ScreenId) => void
}): () => void {
  const w = window as unknown as {
    __mochMenu?: (id: string) => void
  }
  w.__mochMenu = (id: string) => {
    if (id === 'new-chat') return handlers.newChat()
    if (id === 'shortcuts') return openPalette()
    if (id.startsWith('go-')) return handlers.focusScreen(id.slice(3) as ScreenId)
    if (id === 'toggle-list') return setShellLayout({ listCollapsed: !shellLayout.get().listCollapsed })
    if (id === 'toggle-inspector') return setShellLayout({ inspectorCollapsed: !shellLayout.get().inspectorCollapsed })
    if (id === 'toggle-rail') return setShellLayout({ railExpanded: !shellLayout.get().railExpanded })
  }
  return () => {
    delete w.__mochMenu
  }
}

export function installAccelerators(handlers: {
  newChat: () => void
  stopRun: () => void
  focusScreen: (id: ScreenId) => void
}): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape') {
      if (paletteOpen.get()) {
        e.preventDefault()
        closePalette()
      }
      return
    }
    if (!mod) {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        handlers.focusScreen('chat')
      }
      return
    }
    const k = e.key.toLowerCase()
    if (k === 'k') {
      e.preventDefault()
      if (paletteOpen.get() && !e.shiftKey) closePalette()
      else openPalette(e.shiftKey)
      return
    }
    if (k === 'b') {
      e.preventDefault()
      setShellLayout({ listCollapsed: !shellLayout.get().listCollapsed })
      return
    }
    if (k === 'j') {
      e.preventDefault()
      setShellLayout({ inspectorCollapsed: !shellLayout.get().inspectorCollapsed })
      return
    }
    if (k === '\\') {
      e.preventDefault()
      setShellLayout({ railExpanded: !shellLayout.get().railExpanded })
      return
    }
    if (k === ',') {
      e.preventDefault()
      handlers.focusScreen('settings')
      return
    }
    if (k === 't') {
      e.preventDefault()
      handlers.newChat()
      return
    }
    if (k === '.') {
      e.preventDefault()
      handlers.stopRun()
      return
    }
    if (/^[0-9]$/.test(k)) {
      const screen = SCREENS.find((s) => s.digit === k)
      if (screen) {
        e.preventDefault()
        handlers.focusScreen(screen.id)
      }
    }
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}
