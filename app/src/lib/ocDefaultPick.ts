/**
 * App-persisted OpenCode default model pick (`All sessions`).
 *
 * OpenCode only has per-chat picks server-side; a global default is a Moch
 * concept, so the pick is stored in AsyncStorage instead of any Hermes/OC
 * gateway state. Keeping the parser free of react-native imports lets the
 * plain-node suite exercise the validation/fallback rules.
 */

export interface OcDefaultPick {
  /** Provider inventory id (`openrouter`, `anthropic`, …). */
  providerID: string
  /** Full model id as `GET /api/model` reports it. */
  modelID: string
  /** Bare `Model.Ref.id` — what `POST /session/:id/model` requires. */
  id: string
}

const MAX_PART = 200

function part(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Accept either the stored JSON string or an already-parsed value. A row is
 * usable only when providerID + modelID are non-empty; `id` falls back to the
 * bare modelID for rows written before the field existed.
 */
export function parseOcDefaultPick(raw: unknown): OcDefaultPick | null {
  let value = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const providerID = part(row.providerID)
  const modelID = part(row.modelID)
  const id = part(row.id) || modelID
  if (!providerID || !modelID || !id) return null
  if (providerID.length > MAX_PART || modelID.length > MAX_PART || id.length > MAX_PART) return null
  return { providerID, modelID, id }
}

/** The `provider/model` spelling `opencode run -m` expects. */
export function ocDefaultPickModelRef(pick: OcDefaultPick | null | undefined): string | null {
  if (!pick?.providerID || !pick.modelID) return null
  return `${pick.providerID}/${pick.modelID}`
}

/**
 * One-shot model resolution: a chat's own pick always wins; the app default is
 * only the fallback when the chat never picked.
 */
export function ocOneShotModelRef(
  chatPick: string | null | undefined,
  defaultPick: OcDefaultPick | null | undefined,
): string | null {
  const own = typeof chatPick === 'string' ? chatPick.trim() : ''
  return own || ocDefaultPickModelRef(defaultPick)
}
