/** Session open + composer draft hand-off. The draft lands in the chat
 * surface through this tiny module so the shell and palette never import
 * the Chat component directly. */
import { switchToSession } from '../../../../app/src/lib/chat'

let pendingDraft: string | null = null
const draftWaiters: Array<(draft: string | null) => void> = []

export function setComposerDraft(draft: string): void {
  pendingDraft = draft
  for (const w of draftWaiters.splice(0)) w(draft)
}

export function takeComposerDraft(): string | null {
  const d = pendingDraft
  pendingDraft = null
  return d
}

export function onComposerDraft(cb: (draft: string | null) => void): () => void {
  draftWaiters.push(cb)
  return () => {
    const i = draftWaiters.indexOf(cb)
    if (i >= 0) draftWaiters.splice(i, 1)
  }
}

export function openSession(id: string): void {
  void switchToSession(id).catch(() => {})
}
