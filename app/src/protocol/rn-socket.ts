/**
 * Adapts React Native's callback-style WebSocket to the addEventListener
 * surface the vendored Hermes protocol client expects.
 */

type Listener = (ev: any) => void

export class RnWebSocketAdapter {
  get CONNECTING() { return 0 }
  get OPEN() { return 1 }
  get CLOSING() { return 2 }
  get CLOSED() { return 3 }

  readyState = 0 // CONNECTING
  binaryType = 'arraybuffer'
  private ws: WebSocket
  private listeners = new Map<string, Set<{ fn: Listener; once: boolean }>>()

  constructor(url: string, protocols?: string | string[]) {
    this.ws = new WebSocket(url, protocols as any)
    this.ws.onopen = () => { this.readyState = 1; this.emit('open', {}) }
    this.ws.onmessage = (m: any) => this.emit('message', m)
    this.ws.onerror = (e: any) => this.emit('error', e)
    this.ws.onclose = (e: any) => { this.readyState = 3; this.emit('close', e) }
  }

  addEventListener(type: string, fn: Listener, options?: { once?: boolean } | boolean) {
    const once = typeof options === 'boolean' ? options : !!options?.once
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add({ fn, once })
  }

  removeEventListener(type: string, fn: Listener) {
    const set = this.listeners.get(type)
    if (!set) return
    for (const entry of set) {
      if (entry.fn === fn) { set.delete(entry); break }
    }
  }

  private emit(type: string, ev: any) {
    const set = this.listeners.get(type)
    if (!set || set.size === 0) return
    const entries = [...set]
    for (const entry of entries) {
      if (entry.once) set.delete(entry)
      try { entry.fn(ev) } catch {}
    }
  }

  send(data: string) { this.ws.send(data) }

  close(code?: number, reason?: string) {
    try { (this.ws as any).close(code, reason) } catch {}
    this.readyState = 3
  }
}
