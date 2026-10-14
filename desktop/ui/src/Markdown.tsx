/**
 * Markdown rendering for assistant messages — mirrors the phone's
 * react-native-markdown-display conventions on Mocheme tokens:
 * inline code sits on accentSoft (theme.ts: "accentSoft doubles as the
 * code_inline background"), code blocks on bgElev cards, links in blush.
 */
import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span',
      ],
      ALLOWED_ATTR: ['href', 'title'],
    })
  }, [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
