/**
 * Chat actions the shell (palette, session rows) calls. Thin wrappers over
 * the shared engine — switching chats is engine logic (resume, re-point,
 * optimistic windows), this module only names it for the shell's import.
 */
import { switchToSession } from '../../../../../app/src/lib/chat'

/** Open a session-list row (stored id) in the chat surface. */
export async function openSessionById(storedId: string): Promise<string> {
  return switchToSession(storedId)
}
