/**
 * Markdown rendering: marked + DOMPurify (the phone renders on completion;
 * streaming shows plain text — same contract here).
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'hr', 'del', 's', 'sup', 'sub', 'span',
    ],
    ALLOWED_ATTR: ['href', 'title'],
  })
}
