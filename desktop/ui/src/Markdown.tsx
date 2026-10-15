/**
 * Markdown rendering for assistant messages — mirrors the phone's
 * react-native-markdown-display conventions on Mocheme tokens:
 * inline code sits on accentSoft (theme.ts: "accentSoft doubles as the
 * code_inline background"), code blocks on bgElev cards, links in blush.
 */
import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/**
 * URI policy for href/src. This is DOMPurify's stock regexp (http(s),
 * mailto/tel/… and relative URLs) extended with `data:image/*` so agent
 * markdown images survive sanitization; nothing that was allowed before
 * is now rejected, so existing href handling is unchanged.
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)|data:image\/(?:png|gif|jpeg|jpg|webp|svg\+xml);)/i

/**
 * `src` on <img> is stricter than href: http(s) or data:image/* only.
 */
const IMG_SRC_REGEXP =
  /^(?:https?:|data:image\/(?:png|gif|jpeg|jpg|webp|svg\+xml);)/i

/**
 * The app window is loaded from http://127.0.0.1 and must never navigate
 * away, so external links are neutralized in two layers below (hook +
 * capture-phase click handler). The hook is registered once, at module
 * scope; the flag lives on the DOMPurify instance so it also survives
 * dev-time HMR re-evaluating this module.
 */
const purify = DOMPurify as typeof DOMPurify & { __mdHooksRegistered?: boolean }
if (!purify.__mdHooksRegistered) {
  purify.__mdHooksRegistered = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      if (!IMG_SRC_REGEXP.test(src)) node.remove()
    }
  })
}

/**
 * Capture-phase click handler: an http(s) link click opens in the system
 * browser (via window.open) instead of navigating this window. Runs even
 * if target="_blank" is swallowed by the webview.
 */
function handleContentClick(event: MouseEvent<HTMLDivElement>) {
  const target = event.target
  const anchor = target instanceof Element ? target.closest('a') : null
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  if (!/^https?:/i.test(href)) return
  event.preventDefault()
  window.open(href, '_blank', 'noopener')
}

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span',
        'img',
      ],
      ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
      ALLOWED_URI_REGEXP,
    })
  }, [text])
  return (
    <div
      className="md"
      onClickCapture={handleContentClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
