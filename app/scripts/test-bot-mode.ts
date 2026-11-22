/**
 * Unit tests for the NATIVE Bot Mode layer (audit: BOT-MODE.md) — no gateway,
 * no RN. Covers the two client-side pieces that keep Moch a Bot Mode client
 * instead of a parallel bot system:
 *
 *  A. `lib/botMode.ts` — the native marker (`profile.yaml` →
 *     `ui_meta['hermes-bots']`, written through `profiles.configure` with
 *     per-key CAS), the identity fallbacks, and the roster row mapping.
 *  B. `lib/botRosterMeta.ts` — a roster row is a PROFILE (one canonical Bot
 *     Chat); the canonical chat's preview is the row's face, never a newer
 *     task/side session on the same profile.
 *
 *   npx tsx scripts/test-bot-mode.ts
 */

export {}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

type Call = { method: string; params: Record<string, unknown> }

function fakeRpc(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  // Mirror the real gateway's generic `rpc<T>` so BotModeRpc accepts it.
  const rpc = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params })
    return (await handler(method, params)) as T
  }
  return { rpc, calls }
}

async function main() {
  const botMode = await import('../src/lib/botMode')
  const roster = await import('../src/lib/botRosterMeta')

  const {
    BOT_META_KEY,
    readBotModeMeta,
    isBotModeManaged,
    uiMetaRevision,
    botDisplayTitle,
    botModeMarkerPatch,
    markBotModeManaged,
  } = botMode
  const { rosterRows, botPreview, DEFAULT_PROFILE, DEFAULT_BOT_LABEL } = roster

  // ── A. Native marker shape ───────────────────────────────────────────────
  check('BOT_META_KEY is the native ui_meta key', BOT_META_KEY === 'hermes-bots')
  check('missing ui_meta is unmanaged', !isBotModeManaged(undefined) && !isBotModeManaged(null))
  check('non-object ui_meta is unmanaged', !isBotModeManaged('hermes-bots'))
  check(
    'a hermes-bots block marks the profile managed (native _is_bot_managed)',
    isBotModeManaged({ 'hermes-bots': { title: 'Dr. Foo' } }),
  )
  check(
    'the title is trimmed like the native bot_title reader',
    readBotModeMeta({ 'hermes-bots': { title: '  Dr. Foo  ' } })?.title === 'Dr. Foo',
    JSON.stringify(readBotModeMeta({ 'hermes-bots': { title: '  Dr. Foo  ' } })),
  )
  check(
    'CAS revisions clamp to the native int semantics',
    uiMetaRevision({ 'hermes-bots': 4 }) === 4 &&
      uiMetaRevision({ 'hermes-bots': '4' }) === 0 &&
      uiMetaRevision({ 'hermes-bots': -1 }) === 0 &&
      uiMetaRevision(undefined) === 0,
  )

  // ── B. Identity precedence ───────────────────────────────────────────────
  check(
    'marker title wins over display_name and folder id',
    botDisplayTitle('researcher', { 'hermes-bots': { title: 'Dr. Foo' } }, { displayName: 'Foo' }) === 'Dr. Foo',
  )
  check(
    'display_name is the fallback when the marker has no title',
    botDisplayTitle('researcher', { 'hermes-bots': {} }, { displayName: 'Foo' }) === 'Foo',
  )
  check('the folder id is the last fallback', botDisplayTitle('researcher', undefined) === 'researcher')
  check('the launch profile reads Moch', botDisplayTitle('default', undefined, { isDefault: true }) === 'Moch')

  // ── C. Marker write shape (native profiles.configure door) ───────────────
  {
    const patch = botModeMarkerPatch('researcher', { revisions: { 'hermes-bots': 7 } })
    check('marker patch targets the native ui_meta block', !!patch.ui_meta[BOT_META_KEY])
    check(
      'marker title defaults to the profile name',
      (patch.ui_meta[BOT_META_KEY] as { title?: string }).title === 'researcher',
    )
    check(
      'marker patch carries the per-key CAS revision',
      patch.ui_meta_expected_revisions[BOT_META_KEY] === 7,
      JSON.stringify(patch.ui_meta_expected_revisions),
    )

    // Unknown keys another client wrote must survive the merge.
    const keep = botModeMarkerPatch('researcher', {
      existing: { 'hermes-bots': { title: 'Old', emoji: '🧪', accent: '#f0f' } },
      title: 'New',
    })
    const block = keep.ui_meta[BOT_META_KEY] as Record<string, unknown>
    check('marker merge keeps unknown native keys', block.emoji === '🧪' && block.accent === '#f0f')
    check('marker merge updates the title', block.title === 'New')
    check('marker patch without revisions writes CAS 0', keep.ui_meta_expected_revisions[BOT_META_KEY] === 0)
  }

  // ── D. markBotModeManaged (best-effort, idempotent) ──────────────────────
  {
    const { rpc: fake, calls } = fakeRpc(() => ({ ok: true }))
    const wrote = await markBotModeManaged('researcher', fake)
    check('mark writes through the native configure door', wrote === true && calls.length === 1)
    check('mark calls profiles.configure', calls[0]?.method === 'profiles.configure')
    check(
      'mark params: name + ui_meta hermes-bots + CAS',
      calls[0]?.params?.name === 'researcher' &&
        JSON.stringify(calls[0]?.params?.ui_meta) === JSON.stringify({ 'hermes-bots': { title: 'researcher' } }) &&
        JSON.stringify(calls[0]?.params?.ui_meta_expected_revisions) === JSON.stringify({ 'hermes-bots': 0 }),
      JSON.stringify(calls[0]?.params),
    )

    const managed = fakeRpc(() => ({ ok: true }))
    const noop = await markBotModeManaged('researcher', managed.rpc, { existing: { 'hermes-bots': { title: 'X' } } })
    check('already-managed profiles are not re-written', noop === false && managed.calls.length === 0)

    const broken = fakeRpc(() => { throw new Error('socket closed') })
    const failed = await markBotModeManaged('researcher', broken.rpc)
    check('a failed mark is best-effort false (roster keeps painting)', failed === false && broken.calls.length === 1)
    check('blank profile never calls the gateway', (await markBotModeManaged('   ', broken.rpc)) === false)
  }

  // ── E. Roster rows are PROFILES; canonical chat is the face ──────────────
  {
    const wire = [
      {
        name: 'default',
        is_default: true,
        description: 'the assistant',
      },
      {
        name: 'researcher',
        description: 'reads everything',
        // Native raw row: identity lives in ui_meta.
        ui_meta: { 'hermes-bots': { title: 'Dr. Foo' } },
        canonical_session: {
          id: 'bot-chat-root',
          resolved_id: 'bot-chat-tip',
          preview: 'Canonical synthesis is ready.',
          last_active: 1_700_000_300,
        },
        // A NEWER task/worker session on the same profile: must NOT stand in.
        last_session: {
          id: 'task-session',
          preview: 'kanban worker log line',
          last_active: 1_700_000_500,
        },
        worker_session: { id: 'worker-1', last_active: 1_700_000_500 },
      },
    ]
    const rows = rosterRows(wire)
    const byKey = new Map(rows.map((r) => [r.key, r]))

    check('roster: one row per profile', rows.length === 2, String(rows.length))
    check('roster: default row opens the chat surface (key "")', !!byKey.get(''))
    check('roster: default row reads Moch', byKey.get('')?.name === DEFAULT_BOT_LABEL)
    const bot = byKey.get('researcher')
    check('roster: row key is the profile name', !!bot && bot.profile === 'researcher')
    check('roster: name comes from the NATIVE marker title', bot?.name === 'Dr. Foo', String(bot?.name))
    check('roster: description rides along', bot?.description === 'reads everything')
    check('roster: canonical id + compression tip are exposed', bot?.canonicalId === 'bot-chat-root' && bot?.canonicalResolvedId === 'bot-chat-tip')
    check(
      'roster: preview is the canonical Bot Chat, never the newer task session',
      bot?.preview === 'Canonical synthesis is ready.',
      String(bot?.preview),
    )
    check('roster: task session stays out of the row text', !rows.some((r) => r.preview.includes('kanban')))

    // fleet.ts maps the same identity into a typed row (camelCase session
    // shapes); rosterRows accepts it and keeps the canonical preview.
    const mapped = rosterRows([
      {
        name: 'writer',
        title: 'Scribe',
        description: 'writes',
        ui_meta: { 'hermes-bots': { title: 'Scribe' } },
        canonicalSession: {
          id: 'root-2',
          resolvedId: 'tip-2',
          preview: 'Typed canonical preview',
          lastActive: 1_700_000_400,
        },
        lastSession: { id: 'side-2', preview: 'newer task text', lastActive: 1_700_000_900 },
      },
    ])
    check('roster: mapped FleetProfile title is used', mapped[0]?.name === 'Scribe', String(mapped[0]?.name))
    check('roster: mapped canonical id + tip are kept', mapped[0]?.canonicalId === 'root-2' && mapped[0]?.canonicalResolvedId === 'tip-2')
    check(
      'roster: mapped canonical preview wins over a newer task session',
      mapped[0]?.preview === 'Typed canonical preview',
      String(mapped[0]?.preview),
    )

    // No canonical chat yet = NO preview (a task session must not impersonate it).
    const noCanonical = rosterRows([
      { name: 'newbot', last_session: { id: 'side', preview: 'side chat text', last_active: 1 } },
    ])
    check('roster: no canonical chat means no preview', noCanonical[0]?.preview === '', JSON.stringify(noCanonical[0]?.preview))

    // Existing helper stays honest.
    check(
      'botPreview strips the Bot Mode DM envelope',
      botPreview('Message from 🤖 dex (@dex): hello there') === 'hello there',
    )
  }

  // The default profile must never be treated as a fleet bot row entry.
  check('DEFAULT_PROFILE is the launch id', DEFAULT_PROFILE === 'default')

  check('the launch profile is not marked by roster mapping', rosterRows([{ name: 'default' }])[0]?.isDefault === true)

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
