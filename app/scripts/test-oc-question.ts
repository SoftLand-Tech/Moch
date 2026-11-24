// Unit tests for OpenCode Form.Service (`question` tool) helpers.
// Run: cd app && npx tsx scripts/test-oc-question.ts

import {
  buildOcFormAnswer,
  countOcFormUnanswered,
  extractOcEventSessionId,
  initOcFormDraft,
  parseOcForm,
} from '../src/lib/ocForm'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function main() {
  // ── 1. Session ID extraction across flat + nested OpenCode events ──────
  check(
    'extractOcEventSessionId reads top-level sessionID',
    extractOcEventSessionId({ sessionID: 'ses_top', id: 'frm_1' }) === 'ses_top',
  )
  check(
    'extractOcEventSessionId reads nested form.sessionID (form.created)',
    extractOcEventSessionId({
      form: { id: 'frm_1', sessionID: 'ses_nested', title: 'Questions', fields: [] },
    }) === 'ses_nested',
  )
  check(
    'extractOcEventSessionId returns empty string when absent',
    extractOcEventSessionId({ id: 'frm_1' }) === '',
  )

  // ── 2. Form parsing ────────────────────────────────────────────────────
  const rawForm = {
    id: 'frm_123',
    sessionID: 'ses_abc',
    title: 'Questions',
    metadata: { kind: 'question' },
    fields: [
      {
        key: 'q0',
        type: 'string',
        title: 'Database',
        description: 'Which DB should we use?',
        options: [
          { value: 'Postgres', label: 'Postgres', description: 'Primary SQL DB' },
          { value: 'SQLite', label: 'SQLite', description: 'Embedded local DB' },
        ],
        custom: true,
      },
      {
        key: 'q1',
        type: 'multiselect',
        title: 'Extras',
        description: 'Select features',
        options: [
          { value: 'Auth', label: 'Auth' },
          { value: 'Cache', label: 'Cache' },
        ],
        custom: true,
      },
    ],
  }
  const parsed = parseOcForm(rawForm)
  check('parseOcForm validates QuestionTool form', !!parsed && parsed.fields.length === 2)
  check('parseOcForm rejects missing id/sessionID', parseOcForm({ sessionID: 'ses_1', fields: [{ key: 'q0', type: 'string' }] }) === null)
  check('parseOcForm rejects all-hidden forms', parseOcForm({ id: 'frm_1', sessionID: 'ses_1', fields: [{ key: 'q0', type: 'string', hidden: true }] }) === null)

  // ── 3. Draft answering, custom answer, and unanswered count ────────────
  if (parsed) {
    const emptyDraft = initOcFormDraft(parsed)
    check(
      'unanswered starts at 2',
      countOcFormUnanswered(parsed.fields, emptyDraft) === 2,
    )

    const partialDraft = {
      ...emptyDraft,
      selected: { q0: ['Postgres'], q1: ['Auth', 'Cache'] },
      customText: { q1: 'Search' },
      customOn: { q1: true },
    }
    check(
      'all answered gives 0 remaining',
      countOcFormUnanswered(parsed.fields, partialDraft) === 0,
    )
    const built = buildOcFormAnswer(parsed.fields, partialDraft)
    check(
      'single-select builds string and multiselect merges picks + custom',
      built.q0 === 'Postgres' &&
        Array.isArray(built.q1) &&
        built.q1.length === 3 &&
        built.q1.join(',') === 'Auth,Cache,Search',
      JSON.stringify(built),
    )

    const customSingle = {
      selected: { q0: ['Postgres'], q1: ['Auth'] },
      customText: { q0: 'DuckDB' },
      customOn: { q0: true },
    }
    const builtCustom = buildOcFormAnswer(parsed.fields, customSingle)
    check('customOn overrides option pick on single-select', builtCustom.q0 === 'DuckDB', JSON.stringify(builtCustom))
  }

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
