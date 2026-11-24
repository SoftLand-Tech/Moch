/**
 * Pure OpenCode Form / Question helpers — NO React Native / AsyncStorage imports,
 * so `scripts/test-oc-question.ts` can verify them directly under tsx.
 *
 * OpenCode 2.3.0's `question` tool prompts the user through `Form.Service`
 * (`form.created` / `form.replied` / `form.cancelled` over `/api/event`, plus
 * `GET|POST|DELETE /api/session/:sessionID/form`).
 */

export interface OcFormOption {
  value: string
  label: string
  description?: string
}

export interface OcFormField {
  key: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external' | string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  options?: OcFormOption[]
  custom?: boolean
  placeholder?: string
  default?: unknown
  url?: string
}

export interface OcFormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: OcFormField[]
}

export type OcFormValue = string | number | boolean | string[]
export type OcFormAnswer = Record<string, OcFormValue>

/**
 * Extract the owning sessionID from an OpenCode `/api/event` data object.
 * Most events carry top-level `data.sessionID`, while `form.created` nests
 * the info inside `data.form.sessionID`.
 */
export function extractOcEventSessionId(data: Record<string, unknown>): string {
  if (typeof data.sessionID === 'string' && data.sessionID) return data.sessionID
  const form = data.form
  if (form && typeof form === 'object' && typeof (form as Record<string, unknown>).sessionID === 'string') {
    return (form as Record<string, unknown>).sessionID as string
  }
  const permission = data.permission
  if (permission && typeof permission === 'object' && typeof (permission as Record<string, unknown>).sessionID === 'string') {
    return (permission as Record<string, unknown>).sessionID as string
  }
  return ''
}

function normalizeOption(raw: unknown): OcFormOption | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const label = typeof r.label === 'string' ? r.label : typeof r.value === 'string' ? r.value : ''
  const value = typeof r.value === 'string' ? r.value : label
  if (!label && !value) return null
  const description = typeof r.description === 'string' && r.description ? r.description : undefined
  return { value, label: label || value, ...(description ? { description } : {}) }
}

function normalizeField(raw: unknown): OcFormField | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const key = typeof r.key === 'string' ? r.key.trim() : ''
  if (!key) return null
  const type = typeof r.type === 'string' && r.type ? r.type : 'string'
  const options = Array.isArray(r.options)
    ? r.options.map(normalizeOption).filter((o): o is OcFormOption => o !== null)
    : undefined
  return {
    key,
    type,
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(typeof r.required === 'boolean' ? { required: r.required } : {}),
    ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
    ...(options ? { options } : {}),
    ...(typeof r.custom === 'boolean' ? { custom: r.custom } : {}),
    ...(typeof r.placeholder === 'string' ? { placeholder: r.placeholder } : {}),
    ...(r.default !== undefined ? { default: r.default } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
  }
}

/** Parse and validate an incoming `Form.Info` payload from SSE or REST. */
export function parseOcForm(raw: unknown): OcFormInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const sessionID = typeof r.sessionID === 'string' ? r.sessionID.trim() : ''
  if (!id || !sessionID || !Array.isArray(r.fields)) return null
  const fields = r.fields.map(normalizeField).filter((f): f is OcFormField => f !== null)
  if (!fields.some((f) => !f.hidden)) return null
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Questions'
  const metadata = r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : undefined
  return { id, sessionID, title, ...(metadata ? { metadata } : {}), fields }
}

export interface OcFormDraftState {
  /** Selected option values keyed by field.key. */
  selected: Record<string, string[]>
  /** Free-form text keyed by field.key. */
  customText: Record<string, string>
  /** Whether free-form custom entry is enabled/focused for field.key. */
  customOn: Record<string, boolean>
}

export function initOcFormDraft(form: OcFormInfo): OcFormDraftState {
  const selected: Record<string, string[]> = {}
  const customText: Record<string, string> = {}
  const customOn: Record<string, boolean> = {}
  for (const f of form.fields) {
    if (f.hidden) continue
    if (Array.isArray(f.default)) {
      selected[f.key] = f.default.map(String)
    } else if (typeof f.default === 'string' || typeof f.default === 'number' || typeof f.default === 'boolean') {
      const val = String(f.default)
      if (f.options?.some((o) => o.value === val)) {
        selected[f.key] = [val]
      } else {
        customText[f.key] = val
        customOn[f.key] = true
      }
    }
  }
  return { selected, customText, customOn }
}

/** Build the `Form.Answer` payload expected by `POST /api/session/:id/form/:formID/reply`. */
export function buildOcFormAnswer(fields: OcFormField[], draft: OcFormDraftState): OcFormAnswer {
  const out: OcFormAnswer = {}
  for (const f of fields) {
    if (f.hidden || f.type === 'external') continue
    const picks = (draft.selected[f.key] ?? []).filter((v) => v.length > 0)
    const custom = (draft.customText[f.key] ?? '').trim()
    const hasOptions = !!f.options?.length
    const useCustom = draft.customOn[f.key] === true || !hasOptions

    if (f.type === 'multiselect') {
      const combined = [...picks]
      if (custom && (draft.customOn[f.key] === true || !hasOptions) && !combined.includes(custom)) {
        combined.push(custom)
      }
      if (combined.length > 0) out[f.key] = combined
      continue
    }

    const rawVal = useCustom ? (custom || picks[0] || '') : (picks[0] || custom || '')
    if (!rawVal) continue

    if (f.type === 'number' || f.type === 'integer') {
      const num = Number(rawVal)
      if (Number.isFinite(num)) out[f.key] = f.type === 'integer' ? Math.trunc(num) : num
      continue
    }
    if (f.type === 'boolean') {
      const low = rawVal.toLowerCase()
      if (low === 'true' || low === 'yes' || low === '1') out[f.key] = true
      else if (low === 'false' || low === 'no' || low === '0') out[f.key] = false
      continue
    }
    out[f.key] = rawVal
  }
  return out
}

/** Count visible questions that still lack a valid answer in the draft. */
export function countOcFormUnanswered(fields: OcFormField[], draft: OcFormDraftState): number {
  const built = buildOcFormAnswer(fields, draft)
  let missing = 0
  for (const f of fields) {
    if (f.hidden || f.type === 'external') continue
    const val = built[f.key]
    if (val === undefined) {
      missing++
    } else if (Array.isArray(val) && val.length === 0) {
      missing++
    } else if (typeof val === 'string' && !val.trim()) {
      missing++
    }
  }
  return missing
}
