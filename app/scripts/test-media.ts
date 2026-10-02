// Unit tests for the media spine's pure logic (no gateway, no RN): directive
// parsing, media extraction, size budgets, and the queue/persistence encoding
// for media-bearing messages.
//
// chat.ts cannot load in plain node (react-native/AsyncStorage at import
// time), so everything tested here lives in src/lib/media.ts, mediaState.ts
// and the sendQueue module — the same constraint that shaped the design.
type MediaMod = typeof import('../src/lib/media')
type MediaSegmentData = import('../src/lib/media').MediaSegmentData
type QueueMod = typeof import('../src/lib/sendQueue')
type StateMod = typeof import('../src/lib/mediaState')

let m: MediaMod
let q: QueueMod
let st: StateMod

// In-memory AsyncStorage stand-in (same pattern as test-queue.ts).
const backing = new Map<string, string>()
const fakeStorage = {
  getItem: async (k: string) => backing.get(k) ?? null,
  setItem: async (k: string, v: string) => void backing.set(k, v),
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const isMedia = (s: { kind: string }): s is MediaSegmentData => s.kind === 'media'

async function main() {
  m = await import('../src/lib/media')
  st = await import('../src/lib/mediaState')
  q = await import('../src/lib/sendQueue')
  q._useStorageForTests(fakeStorage)

  // ── 1. parseMediaDirectives: bare AND quoted values ─────────────────────
  {
    const bare = m.parseMediaDirectives('see @file:/tmp/a.txt now')
    check('bare @file: parses mid-text', bare.length === 1 && bare[0].directive === '@file' && bare[0].value === '/tmp/a.txt')

    const kinds = m.parseMediaDirectives([
      '@image:/x/y.png', // bare
      '@file:`/x/my file.txt`', // backtick (space inside)
      '@file:"/x/br(1).txt"', // double quote (brackets inside)
      "@file:'/x/quote\"d.txt'", // single quote (double quote inside)
    ].join(' and '))
    check(
      'bare + backtick + double + single quoted values parse, quotes stripped',
      kinds.length === 4 &&
        kinds[0].value === '/x/y.png' &&
        kinds[1].value === '/x/my file.txt' &&
        kinds[2].value === '/x/br(1).txt' &&
        kinds[3].value === '/x/quote"d.txt',
      JSON.stringify(kinds.map((k) => k.value)),
    )

    const several = m.parseMediaDirectives('@image:/a.png @file:/b.txt trailing')
    check('multiple directives in one text', several.length === 2 && several[0].value === '/a.png' && several[1].value === '/b.txt')
    check('no directives → empty', m.parseMediaDirectives('just words').length === 0)
  }

  // ── 2. extractMarkdownImages ─────────────────────────────────────────────
  {
    const im = m.extractMarkdownImages('look ![shot](/var/hermes/shot.png) ok')
    check('absolute markdown image extracted with alt as name', im.length === 1 && im[0].path === '/var/hermes/shot.png' && im[0].name === 'shot')

    const im2 = m.extractMarkdownImages('![web](https://x.io/a.png) ![rel](sub/b.png) ![data](data:image/png;base64,xx)')
    check('http(s), relative and data: stay in text (none extracted)', im2.length === 0)

    const im3 = m.extractMarkdownImages('![](~/notes/todo.md)')
    check('relative ~/ path is not a gateway path (left in text)', im3.length === 0)
  }

  // ── 3. mediaKindForPath ──────────────────────────────────────────────────
  {
    check('image exts (cli.py allowlist)', ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.tiff', 'h.tif', 'i.svg', 'j.ico'].every((p) => m.mediaKindForPath(p) === 'image'))
    check('video exts (files.py streamable)', ['a.avi', 'b.mkv', 'c.mov', 'd.mp4', 'e.webm'].every((p) => m.mediaKindForPath(p) === 'video'))
    check('audio exts (files.py streamable)', ['a.flac', 'b.m4a', 'c.mp3', 'd.ogg', 'e.opus', 'f.wav'].every((p) => m.mediaKindForPath(p) === 'audio'))
    check('docs → file, no ext → unknown', m.mediaKindForPath('/x/report.pdf') === 'file' && m.mediaKindForPath('/x/noext') === 'unknown')
  }

  // ── 4. cacheKeyFor determinism + sanitizeBasename ────────────────────────
  {
    check('cacheKeyFor is deterministic and distinct', m.cacheKeyFor('/a/dir/report.pdf') === m.cacheKeyFor('/a/dir/report.pdf') && m.cacheKeyFor('/a/dir/report.pdf') !== m.cacheKeyFor('/other/report.pdf'))
    check('cacheKeyFor keeps a readable name', m.cacheKeyFor('/a/dir/report.pdf').startsWith('report.pdf-'))
    check('sanitizeBasename strips path traversal + separators', m.sanitizeBasename('../../etc/passwd') === 'passwd' && m.sanitizeBasename('a\\b\\c.txt') === 'c.txt')
    check('sanitizeBasename removes control chars, never empty', m.sanitizeBasename('na\x00\x1fme.txt') === 'name.txt' && m.sanitizeBasename('..') === 'attachment' && m.sanitizeBasename('') === 'attachment')
  }

  // ── 5. maxAttachBytesFor — kB = 1000 bytes (blocking-3 unit fix) ─────────
  {
    check('(3 kB/s, 600 s) → 1_800_000 B', m.maxAttachBytesFor(3, 600) === 1_800_000, String(m.maxAttachBytesFor(3, 600)))
    check('(8 kB/s, 600 s) → 4_800_000 B (no ×8, no 1024s)', m.maxAttachBytesFor(8, 600) === 4_800_000, String(m.maxAttachBytesFor(8, 600)))
    check('rate 0 / negative → 0', m.maxAttachBytesFor(0, 600) === 0 && m.maxAttachBytesFor(-3, 600) === 0)
  }

  // ── 6. shouldAutoDownload / formatBytes / estSecondsFor ──────────────────
  {
    check('≤512 kB auto-loads; bigger/unknown does not', m.shouldAutoDownload(512_000) && !m.shouldAutoDownload(512_001) && !m.shouldAutoDownload(undefined))
    check('formatBytes uses kB=1000 units', m.formatBytes(1_800_000) === '1.8 MB' && m.formatBytes(512_000) === '512 kB' && m.formatBytes(230) === '230 B', `${m.formatBytes(1_800_000)}|${m.formatBytes(512_000)}|${m.formatBytes(230)}`)
    const est = (b: number) => m.estSecondsFor(b, 8)
    check('estSecondsFor monotonic, kB/s treated as bytes/s (no ×8)', est(1000) < est(8000) && est(8000) < est(80_000) && Math.abs(est(8000) - 1) < 1e-9 && Math.abs(est(80_000) - 10) < 1e-9)
    check('estSecondsFor at rate 0 is Infinity (never divides by zero)', m.estSecondsFor(1000, 0) === Infinity)
    check('uploadTimeoutMs floors at 2 min and grows ×1.5', m.uploadTimeoutMs(0, 3) === 120_000 && m.uploadTimeoutMs(300_000, 3) === 150_000, String(m.uploadTimeoutMs(300_000, 3)))
  }

  // ── 7. extractMedia + refTextBudget ──────────────────────────────────────
  {
    const out = m.extractMedia([{ kind: 'text', text: 'before @file:`/a b.txt` mid ![p](/p.png) after' }])
    const kinds = out.map((s) => s.kind)
    check('media lands directly after its source text segment', kinds[0] === 'text' && kinds.slice(1).join(',') === 'media,media', kinds.join(','))
    check('directive + markdown extracted in order, quoted value kept', isMedia(out[1]) && out[1].path === '/a b.txt' && isMedia(out[2]) && out[2].path === '/p.png')
    check('source text stripped of both forms', out[0].text === 'before mid after', out[0].text)
    check("media segments carry text: ''", out.slice(1).every((s) => isMedia(s) && s.text === ''))

    const again = m.extractMedia(out)
    check('extractMedia is idempotent', JSON.stringify(again) === JSON.stringify(out))

    const plain = { kind: 'text', text: 'hi' }
    check('marker-free text segment passes through by identity', m.extractMedia([plain])[0] === plain)

    const refs = ['@file:`/a b.txt`', '@file:/x.txt']
    const budget = 8000 - refs.join('').length
    check('refTextBudget respects 8000 − Σ ref lengths', m.refTextBudget('x'.repeat(9000), refs).length === Math.max(0, budget))
    check('appendRefText puts refs last and never truncates them', m.appendRefText('hello', refs) === `hello\n${refs.join('\n')}` && m.appendRefText('', refs) === refs.join('\n'))

    // Simulated media event: message.complete final segments with a directive.
    const evOut = m.extractMedia([{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'done @image:/shots/x.png' }])
    check('interleave order kept (thinking first, media after its text)', evOut[0].kind === 'thinking' && evOut[1].kind === 'text' && isMedia(evOut[2]) && (evOut[2] as MediaSegmentData).path === '/shots/x.png')
    check('joinedTextOf drops markers (m.text contract)', m.joinedTextOf(evOut) === 'done')
    check('stripMediaFromText leaves clean prose', m.stripMediaFromText('a @file:/x.txt b ![p](/p.png) c') === 'a b c')
  }

  // ── 7b. Inline data-URL images (native-vision resume contract) ───────────
  {
    // A realistic gateway inline URL: full base64 run (≥ 64 chars).
    const b64 = 'A'.repeat(80)
    const jpegUrl = `data:image/jpeg;base64,${b64}`
    const pngUrl = `data:image/png;base64,${'B'.repeat(72)}`

    const hits = m.extractInlineImages(`look ${jpegUrl} and ${pngUrl} end`)
    check(
      'bare data:image URLs extracted in order with exact spans',
      hits.length === 2 &&
        hits[0].path === jpegUrl &&
        hits[1].path === pngUrl &&
        hits[0].name === 'embedded-1.jpg' &&
        hits[1].name === 'embedded-2.png' &&
        hits[0].start === 5 &&
        hits[0].end === 5 + jpegUrl.length &&
        hits[1].start === 5 + jpegUrl.length + 5 &&
        hits[1].end === hits[1].start + pngUrl.length,
      JSON.stringify(hits.map((h) => [h.name, h.start, h.end])),
    )
    check('short base64 runs stay in the text (quoted prose, not media)', m.extractInlineImages(`data:image/png;base64,${'A'.repeat(63)}`).length === 0)
    check('non-image data: URLs are not images', m.extractInlineImages(`data:text/plain;base64,${'A'.repeat(80)}`).length === 0)
    check('trailing punctuation terminates the URL run', m.extractInlineImages(`see ${jpegUrl}.`)[0].path === jpegUrl)
    check('plain text has no inline images', m.extractInlineImages('no urls here').length === 0)
    check('isDataUrlPath only matches data: paths', m.isDataUrlPath('data:image/png;base64,AA') && !m.isDataUrlPath('/x/a.png') && !m.isDataUrlPath(undefined))

    // Resume payload shape: refs first (`@image:` per image), raw URLs after
    // — paired from the end so the image renders ONCE, from its durable
    // gateway path, and the base64 never reaches a segment or m.text.
    const persisted = `what is this\n@image:/h/relay-uploads/pic.jpg\n${jpegUrl}`
    const split = m.splitMediaFromText(persisted)
    check(
      'paired directive + URL → one segment (the directive path), URL stripped',
      split.media.length === 1 && split.media[0].path === '/h/relay-uploads/pic.jpg' && split.text === 'what is this',
      JSON.stringify(split),
    )
    check('stripMediaFromText also drops the paired blob', m.stripMediaFromText(persisted) === 'what is this')

    // Two of each pair off (a↔A, b↔B); all URLs dropped, both refs kept.
    const two = m.splitMediaFromText(`caps\n@image:/a.png\n@image:/b.png\n${jpegUrl}\n${pngUrl}`)
    check(
      'N refs + N URLs pairs from the end (refs win, URLs drop)',
      two.media.length === 2 && two.media[0].path === '/a.png' && two.media[1].path === '/b.png' && two.text === 'caps',
      JSON.stringify(two),
    )

    // No directive to pair with (agent-embedded image) → the URL IS media.
    const unpaired = m.splitMediaFromText(`chart below\n${pngUrl}`)
    check(
      'unpaired URL becomes an image segment',
      unpaired.media.length === 1 && unpaired.media[0].path === pngUrl && unpaired.text === 'chart below',
      JSON.stringify(unpaired),
    )

    // @file: directives never participate in the pairing.
    const withFile = m.splitMediaFromText(`a @file:/notes.txt\n${jpegUrl}`)
    check(
      '@file: is not a pairing candidate (URL survives as its own segment)',
      withFile.media.length === 2 && withFile.media[0].path === '/notes.txt' && withFile.media[1].path === jpegUrl,
      JSON.stringify(withFile.media.map((x) => x.path)),
    )

    // extractMedia over a full resume row: idempotent, text capped AFTER
    // extraction (a long caption survives; the blob never does).
    const row = m.extractMedia([{ kind: 'text', text: `${'x'.repeat(9000)}\n@image:/p.png\n${jpegUrl}` }])
    const rowText = row.find((s) => s.kind === 'text') as { text: string }
    check(
      'resume row: caption survives, blob gone, one image segment',
      rowText.text.length === 9000 && row.length === 2 && isMedia(row[1]) && (row[1] as MediaSegmentData).path === '/p.png',
      `textLen=${rowText.text.length} segs=${row.length}`,
    )
    const again2 = m.extractMedia(row)
    check('extractMedia idempotent over inline-extracted rows', JSON.stringify(again2) === JSON.stringify(row))
  }

  // ── 8. Restart encoding: sendQueue stays {id,text,ts} ────────────────────
  {
    q.sendQueue.set({})
    const withText = q.enqueueSend('chat', 'with text')
    const mediaOnly = q.enqueueSend('chat', '', { allowEmpty: true }) // attachment-only
    check('attachment-only send queues via allowEmpty', withText != null && mediaOnly != null && mediaOnly.text === '')
    check('plain empty text still returns null', q.enqueueSend('chat', '   ') === null)
    await q.flushSendQueue()

    const rawParsed = JSON.parse((await fakeStorage.getItem('hermes.sendQueue.v1')) ?? '{}') as Record<string, Array<Record<string, unknown>>>
    const blobOk = (rawParsed.chat ?? []).every((x) => Object.keys(x).every((k) => ['id', 'text', 'ts'].includes(k)))
    check('storage shape stays exactly {id,text,ts}', blobOk, JSON.stringify(rawParsed.chat))

    q.sendQueue.set({})
    await q.loadSendQueue()
    check('restart: text item survives, attachment-only item is dropped', q.queueFor('chat').length === 1 && q.queueFor('chat')[0].text === 'with text')

    // Legacy blobs (pre-media) load unchanged.
    await fakeStorage.setItem('hermes.sendQueue.v1', JSON.stringify({ legacy: [{ id: 'q1', text: 'old', ts: 123 }] }))
    q.sendQueue.set({})
    await q.loadSendQueue()
    check('legacy queue blobs load unchanged', q.queueFor('legacy').length === 1 && q.queueFor('legacy')[0].text === 'old' && q.queueFor('legacy')[0].ts === 123)
    await tick()
  }

  // ── 9. Media-segment JSON round trip + legacy transcript blob ────────────
  {
    const seg = m.mediaSegment({ mediaType: 'image', path: '/h/img/x.jpg', name: 'x.jpg', size: 1234, mime: 'image/jpeg' })
    const blob = { v: 1, title: 't', messages: [{ id: 'm1', role: 'user', text: '', ts: 1, segments: [seg, { kind: 'text', text: 'look' }] }], tools: [] }
    const round = JSON.parse(JSON.stringify(blob)) as typeof blob
    const seg2 = round.messages[0].segments[0] as MediaSegmentData
    check('media segment round-trips through the transcript blob', JSON.stringify(seg2) === JSON.stringify(seg) && seg2.text === '' && seg2.kind === 'media' && seg2.path === '/h/img/x.jpg')
    check('unset optional fields stay absent (no undefined→null pollution)', !('state' in seg2) && !('localUri' in seg2))

    // A pre-media v1 blob (bare message array) parses with no reshaping.
    const legacy = JSON.parse('[{"id":"a","role":"assistant","text":"old","ts":5}]') as Array<Record<string, unknown>>
    check('old v1 transcript blob parses unchanged', legacy[0].text === 'old' && !('segments' in legacy[0]))

    // mediaState: per-key stores are independent and idle by default.
    st.setMediaState('k', { status: 'ready', uri: 'file:///x' })
    check('mediaState per key: idle default, stable store identity', st.mediaStateForKey('_idle_').get().status === 'idle' && st.mediaStateForKey('k').get().status === 'ready' && st.mediaStateForKey('k') === st.mediaStateForKey('k'))
    st.clearMediaState('k')
    check('clearMediaState resets to idle', st.mediaStateForKey('k').get().status === 'idle')
  }

  // ── 10. UI classification/geometry helpers (pure, component-consumed) ─────
  {
    // formatDuration: m:ss, zero-guarded, h:mm:ss past an hour.
    check('formatDuration m:ss baseline', m.formatDuration(0) === '0:00' && m.formatDuration(59) === '0:59' && m.formatDuration(60) === '1:00' && m.formatDuration(75) === '1:15')
    check('formatDuration hours + invalid inputs', m.formatDuration(3600) === '1:00:00' && m.formatDuration(3725) === '1:02:05' && m.formatDuration(-3) === '0:00' && m.formatDuration(NaN) === '0:00' && m.formatDuration(Infinity) === '0:00')

    // fitWithin: aspect-fit ≤ maxEdge, never upscales, null on unknown dims.
    check('fitWithin caps the longest edge preserving ratio', JSON.stringify(m.fitWithin(220, 4400, 2200)) === JSON.stringify({ width: 220, height: 110 }) && JSON.stringify(m.fitWithin(220, 1080, 2400)) === JSON.stringify({ width: 99, height: 220 }), JSON.stringify(m.fitWithin(220, 1080, 2400)))
    check('fitWithin never upscales a small image', JSON.stringify(m.fitWithin(220, 100, 50)) === JSON.stringify({ width: 100, height: 50 }))
    check('fitWithin null on missing/invalid dims', m.fitWithin(220) === null && m.fitWithin(220, 0, 100) === null && m.fitWithin(220, -10, 100) === null && m.fitWithin(220, NaN, NaN) === null)

    // fileIconForPath: ext-driven classification, generic fallback for unknown.
    check('fileIconForPath groups docs/sheets/code/terminal/archives', m.fileIconForPath('/x/a.pdf') === 'document-text-outline' && m.fileIconForPath('notes.md') === 'document-text-outline' && m.fileIconForPath('/x/data.csv') === 'grid-outline' && m.fileIconForPath('/x/b.ts') === 'code-slash-outline' && m.fileIconForPath('/x/run.sh') === 'terminal-outline' && m.fileIconForPath('/x/pkg.zip') === 'file-tray-full-outline')
    check('fileIconForPath unknown ext → generic icon (case-insensitive ext)', m.fileIconForPath('/x/report.weird') === 'document-attach-outline' && m.fileIconForPath('/x/NO.EXT') === 'document-attach-outline' && m.fileIconForPath('/x/noext') === 'document-attach-outline')
  }

  // ── 11. Bare gateway path extraction (agent pasted a path, not a file) ───
  {
    const UP = '/home/mamoun/relay-uploads/1790655229030_g7a7-4d28e406-ec44-4a02-b3c4-1b25fa240d60.jpg'
    const screenshot = `Here it is:\n${UP}`
    const sp = m.splitMediaFromText(screenshot)
    check('screenshot case: bare relay-uploads path becomes an image segment', sp.media.length === 1 && sp.media[0]!.mediaType === 'image' && sp.media[0]!.path === UP && sp.text === 'Here it is:', JSON.stringify(sp))

    const dot = m.splitMediaFromText('Saved at /tmp/chart.png.')
    check('trailing sentence punctuation is not part of the path', dot.media.length === 1 && dot.media[0]!.path === '/tmp/chart.png')

    check('https URLs stay text', m.splitMediaFromText('see https://x.com/a.jpg').media.length === 0)
    check('relative paths stay text', m.splitMediaFromText('check foo/bar.jpg').media.length === 0)
    check('root-only paths stay text', m.splitMediaFromText('weird /a.jpg case').media.length === 0)
    const unk = m.splitMediaFromText('output at /tmp/file.weird here')
    check('unknown extensions stay text', unk.media.length === 0 && unk.text.includes('/tmp/file.weird'))

    const pdf = m.splitMediaFromText('the report: /tmp/report.pdf')
    check('doc extensions become file segments', pdf.media.length === 1 && pdf.media[0]!.mediaType === 'file' && pdf.media[0]!.name === 'report.pdf')

    const md = m.splitMediaFromText('![chart](/tmp/a.jpg)')
    check('no duplicate when the path is already a markdown image', md.media.length === 1 && md.media[0]!.path === '/tmp/a.jpg')
    const dir = m.splitMediaFromText('@image:/tmp/a.jpg')
    check('no duplicate when the path is already a directive', dir.media.length === 1 && dir.media[0]!.path === '/tmp/a.jpg')

    const par = m.splitMediaFromText('(see /tmp/a.jpg)')
    check('path inside parentheses extracts (parens are token boundaries)', par.media.length === 1 && par.media[0]!.path === '/tmp/a.jpg')

    // Round trip through the segment builder, the way applyHistory consumes it.
    const segs = m.extractMedia([{ kind: 'text', text: screenshot } as never])
    check('extractMedia round trip: [text][media]', segs.length === 2 && (segs[0] as { text: string }).text === 'Here it is:' && (segs[1] as { kind: string }).kind === 'media')

    // Notifications/copy see the caption, never the path that became media.
    check('stripMediaFromText drops the extracted path', m.stripMediaFromText(screenshot) === 'Here it is:')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-media crashed:', err)
  process.exit(1)
})
