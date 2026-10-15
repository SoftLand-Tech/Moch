/**
 * Transcript rows for the desktop Chat surface. Everything rendered here is
 * read from the shared engine's ChatMessage/ChatSegment/ToolItem shapes —
 * no local protocol state. Rendering mirrors the phone's MessageBubble /
 * ThinkingBlock / ToolRow (app/src/components/Chat.tsx): plain text + cursor
 * while a segment streams, marked+DOMPurify markdown once it completes.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  connConfig,
} from '../../../../../app/src/lib/gateway'
import { httpBase } from '../../../../../app/src/lib/http'
import { formatThinkMeta, type ChatMessage, type ChatSegment, type ToolItem } from '../../../../../app/src/lib/chat'

// Open markdown links in a new browser context — the desktop webview must
// never navigate the whole app away. Default sanitizer keeps href; this hook
// adds the target/rel pair after every sanitize pass.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function sanitizeMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true }) as string
  // Images ride the engine's media segments (authed fetch), never markdown
  // <img> — an auth-gated gateway URL in a plain img tag would just render
  // broken tiles.
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style'] })
}

/** Completed segment text: markdown, sanitized, memoized per text. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => sanitizeMarkdown(text), [text])
  return <div className="moch-md" dangerouslySetInnerHTML={{ __html: html }} />
})

/** Gateway file URL for a received media segment ('' optimistic paths stay
 *  linkless — the desktop media unit owns real upload/render plumbing). */
function mediaHref(seg: ChatSegment): string | undefined {
  if (!seg.path || seg.state === 'missing') return undefined
  const c = connConfig.get()
  if (!c) return undefined
  try {
    return `${httpBase(c)}/api/files/download?path=${encodeURIComponent(seg.path)}`
  } catch {
    return undefined
  }
}

const MEDIA_ICON: Record<NonNullable<ChatSegment['mediaType']>, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
}

function MediaChip({ seg }: { seg: ChatSegment }) {
  const href = mediaHref(seg)
  const label = seg.name || seg.path || MEDIA_ICON[seg.mediaType ?? 'file']
  return href ? (
    <a className="moch-media" href={href} target="_blank" rel="noopener noreferrer">
      <span aria-hidden>⌗</span>
      {label}
    </a>
  ) : (
    <span className="moch-media">
      <span aria-hidden>⌗</span>
      {label}
    </span>
  )
}

/**
 * One reasoning segment — collapsed by default, header only. While `live`
 * (the message's growing tail) a 1 Hz heartbeat keeps the elapsed counter
 * running through silent stretches; formatThinkMeta owns the copy.
 */
export const ThinkingBlock = memo(function ThinkingBlock({ seg, live }: { seg: ChatSegment; live: boolean }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hasText = !!seg.text.trim()
  useEffect(() => {
    if (!live || !hasText) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live, hasText])
  if (!hasText) return null
  const meta = live ? formatThinkMeta(seg.startedAt ?? 0, seg.chars ?? seg.text.length, now) : seg.meta
  const body = seg.text.length > 4000 ? `…truncated — last 4000 chars:\n${seg.text.slice(-4000)}` : seg.text
  return (
    <div className="moch-think moch-seg">
      <button
        type="button"
        className="moch-think__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse thinking' : 'Expand thinking'}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {live ? (
          <span className="moch-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : null}
        <span>
          {live ? 'Thinking' : 'Thought'}
          {meta ? ` · ${meta}` : ''}
        </span>
      </button>
      {open ? <div className="moch-think__body">{body}</div> : null}
    </div>
  )
})

function FailedStrip({ m, onRetry }: { m: ChatMessage; onRetry?: (id: string) => void }) {
  if (m.status !== 'failed' && m.status !== 'unconfirmed') return null
  const unconfirmed = m.status === 'unconfirmed'
  return (
    <div className={`moch-failed${unconfirmed ? ' moch-failed--warn' : ''}`}>
      <span aria-hidden>{unconfirmed ? '?' : '!'}</span>
      <span>
        {m.error ??
          (unconfirmed ? 'Sent — no confirmation; it may still have gone through' : 'Not sent')}
      </span>
      {onRetry ? (
        <button type="button" className="moch-failed__retry" onClick={() => onRetry(m.id)}>
          <span aria-hidden>↻</span> Retry
        </button>
      ) : null}
    </div>
  )
}

/** A message's renderable content: explicit segments, else its plain text. */
function segmentsOf(m: ChatMessage): ChatSegment[] {
  if (m.segments?.length) return m.segments
  return m.text ? [{ kind: 'text', text: m.text }] : []
}

function CommandCard({ m }: { m: ChatMessage }) {
  return (
    <div className="moch-cmdcard moch-seg">
      {m.cmd?.name ? <div className="moch-cmdcard__title">{m.cmd.name}</div> : null}
      <div className="moch-cmdcard__body">{m.text}</div>
    </div>
  )
}

export const MessageRow = memo(function MessageRow({ m, onRetry }: { m: ChatMessage; onRetry: (id: string) => void }) {
  if (m.role === 'assistant') {
    if (m.cmd) {
      return (
        <div className="moch-row-bot">
          <CommandCard m={m} />
        </div>
      )
    }
    const segs = segmentsOf(m)
    const lastIdx = segs.length - 1
    // Hidden thinking doesn't count as visible content, or the working dots
    // would never show while the model reasons quietly (phone parity).
    const hasVisibleText = segs.some((seg) => seg.kind === 'text' && seg.text.trim())
    return (
      <div className="moch-row-bot">
        {segs.map((seg, i) =>
          seg.kind === 'media' ? (
            <div key={i} className="moch-seg">
              <MediaChip seg={seg} />
            </div>
          ) : seg.kind === 'thinking' ? (
            <ThinkingBlock key={i} seg={seg} live={!!m.streaming && i === lastIdx} />
          ) : m.streaming && i === lastIdx ? (
            // Plain text while streaming: re-parsing markdown per flush churns
            // the whole subtree; the full render happens once, on completion.
            <div key={i} className="moch-stream moch-seg">
              {seg.text}
              <span className="moch-cursor" aria-hidden>
                ▍
              </span>
            </div>
          ) : (
            <Markdown key={i} text={seg.text} />
          ),
        )}
        {m.streaming && !hasVisibleText ? (
          <div className="moch-seg">
            <span className="moch-dots" aria-label="Working">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null}
        <FailedStrip m={m} onRetry={onRetry} />
      </div>
    )
  }

  const userSegs = segmentsOf(m)
  // Media rows are not retryable: a text-only retry would silently drop the
  // attachments (engine enforces the same rule in retryMessage).
  const hasMedia = userSegs.some((seg) => seg.kind === 'media')
  return (
    <div className="moch-row-user">
      <div className="moch-bubble-user">
        {userSegs.map((seg, i) =>
          seg.kind === 'media' ? (
            <MediaChip key={i} seg={seg} />
          ) : seg.text ? (
            <span key={i}>{seg.text}</span>
          ) : null,
        )}
      </div>
      <FailedStrip m={m} onRetry={hasMedia ? undefined : onRetry} />
    </div>
  )
})

export function ToolRow({ t }: { t: ToolItem }) {
  return (
    <div className="moch-tool" aria-label={`${t.name} ${t.status}`}>
      <span className={`moch-tool__status moch-tool__status--${t.status}`} aria-hidden>
        {t.status === 'running' ? '◌' : t.status === 'failed' ? '✕' : '✓'}
      </span>
      <span className="moch-tool__name">{t.name}</span>
      {t.preview ? <span className="moch-tool__preview">{t.preview}</span> : null}
      {t.durationS != null ? <span className="moch-tool__dur">{t.durationS.toFixed(1)}s</span> : null}
    </div>
  )
}
