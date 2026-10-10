# Agentic Browser Frameworks: Under-the-Hood Spec for a Mobile (Android WebView + CDP) Re-implementation

Research synthesis, 2026-10. Sources numbered at the end; all facts verified against fetched docs/source.

## (a) The canonical agent loop

Every production system converges on the same skeleton: **system prompt + step history + structured page state → one JSON decision per step → execute actions → re-observe → repeat until `done` or max_steps.**

**browser-use** (system_prompt.md, [1]) is the most explicit. Input per step: `<user_request>`, `<agent_history>` (each step: *evaluation of previous step / memory / next goal / action results*), `<agent_state>`, `<browser_state>` (URL, open tabs with ids, interactive elements, visible content), optional `<browser_vision>` (screenshot with bounding boxes). Output is strict JSON: `thinking`, `evaluation_previous_goal`, `memory` (1–3 sentences), `next_goal`, optional `plan_update`/`current_plan_item`, and an `action` list — **up to `max_actions_per_step=5`** actions executed sequentially, with *page-changing actions placed last* because remaining actions are auto-skipped when the page changes [1][7]. Defaults from source: `max_failures=5`, `planning_replan_on_stall=3`, one final recovery call after max failures [7]. Stop: `done(text, success, files_to_display)` on completion, at `max_steps`, or when impossible; a 75%-budget checkpoint forces consolidation; `success=false` is mandated for any unmet requirement (pre-done verification checklist) [1]. Built-in action registry: `search, navigate, go_back, wait, click(index), input, upload_file, scroll, find_text, send_keys, evaluate, switch/close (tabs), extract (LLM page extraction), screenshot, dropdown_options, select_dropdown, write_file/read_file/replace_file, done` [3].

**Claude's browser toolset** (`browser_toolset_20260801`) runs the same loop via native tool-calls: Claude returns **batched member calls** per turn; the executor runs them in order; a failure applies a halt rule — later calls return "Not executed: an earlier action in this turn failed" [4]. Stale refs get "ref_3 is stale or not found… Re-read the page to get fresh references" [4].

**Playwright MCP / Chrome DevTools MCP** externalize the loop to the MCP client but keep the primitives: snapshot-then-act with ref echo-back (`browser_click(element, target=ref)`) [5]; DevTools MCP returns `includeSnapshot` on actions to save a round trip, and `fill_form` batches form fills ("ALWAYS prefer this over multiple fill/click calls") [6].

**Benchmarks** confirm the shape: WebVoyager = 15 max iters, keep last 3 screenshots, GPT-4V auto-eval [10]; WebArena established accessibility-tree observations and a small compositional action space [9]; BrowseComp tests persistence (multi-session search) with short verifiable answers [11].

## (b) Element grounding

- **Ref generation**: browser-use indexes interactive elements `[N]` in a serialized tree; text as child nodes; `*[N]` marks elements *new since last step*; `|SCROLL|` prefixes scrollable containers with position; `|SHADOW(open/closed)|` marks shadow roots; only viewport-visible elements listed by default [1]. Playwright MCP uses YAML aria snapshots (`- role "name" [ref=sXeY]`, `/url`, `textbox: value`) with `browser_find` returning matching nodes + path instead of full snapshots [2][5]. Claude: `read_page(filter=interactive|all, depth≤15, ref scoping)` returns `role "name" [ref_N]` lines, hard-capped at 50,000 chars, plus `find(query)` → ≤20 tagged matches [4]. DevTools MCP: a11y-tree snapshot with `uid`s, "always use the latest snapshot; prefer snapshot over screenshot" [6].
- **Extraction internals**: browser-use historically injected custom JS (`buildDomTree.js`, "extractDOMSnapshot"); current main has **replaced it with native CDP** — `dom/enhanced_snapshot.py` merges `DOMSnapshot.captureSnapshot` with `Accessibility.getFullAXTree` via backendNodeId lookups, uses CDP's `isClickable` rare-boolean data, computed styles, bounds/clientRects, a viewport-ratio computation, cross-origin-iframe size eligibility, and y-position/viewport-height thresholding to cull hidden subtrees [8]. This is the strongest signal for a mobile CDP implementation: prefer native DOMSnapshot+AX over hand-rolled JS.
- **Token efficiency**: viewport-only filtering, depth caps, `find`/search tools, Playwright MCP `--mobile` ("mobile pages are usually lighter, which saves tokens"), Stagehand's "hybrid accessibility-tree trimming" [5][12].

## (c) Vision vs DOM

Playwright MCP: snapshots are primary, "no vision models needed… deterministic tool application"; screenshots explicitly can't ground actions (`--caps=vision` adds `browser_mouse_click_xy` coordinate tools) [5]. browser-use and Claude are **hybrid**: refs for grounding, screenshot+Set-of-Mark as *ground truth for verification* — browser-use draws bounding boxes around indexed elements and asks the model to verify actions against the image [1]; WebVoyager showed the same SoM overlay (GPT-4V-ACT JS) beats text-only [10]. Claude unifies both in one `target` union: `{"type":"ref"}` or `{"type":"coordinate","x","y"}` [4]. Recommended mobile stance: DOM-first grounding (cheap, deterministic), screenshot-on-demand + `zoom(region)` for verification and canvas-heavy pages.

## (d) Session & persistence

Patterns across all frameworks: (1) **persistent profile dir** — Playwright MCP `--user-data-dir` (per-workspace hashed profiles), `--isolated` for in-memory ephemeral sessions; browser-use `Browser.from_system_chrome()` reuses the real Chrome profile (logins, cookies, extensions) [5][1]. (2) **storage state files** — Playwright `--storage-state` / `browser_storage_state` save/restore cookies+localStorage; browser-use `save_cookies` example and `storage_state='./auth.json'` [5][3]. (3) **Login-once patterns** — Stagehand's canonical flow: `observe()` the email/password inputs → fill via real selectors so *credentials never reach the model* → cookies persist in `./browser-data` so next run starts signed in [12]. (4) 2FA flows via custom callback tools (browser-use 2fa/1Password examples) [1].

## (e) Licensing (all verified via GitHub API / LICENSE files)

| Project | License | Reimplement pattern? |
|---|---|---|
| browser-use [1] | **MIT** (© 2024 Gregor Zunic) | Yes |
| Playwright / playwright-mcp [2][5] | **Apache-2.0** | Yes |
| chrome-devtools-mcp (ChromeDevTools org) [6] | **Apache-2.0** | Yes |
| Stagehand [12] | **MIT** (code; "Stagehand" is a Browserbase trademark) | Yes, avoid the name |
| WebArena / WebVoyager [9][10] | Apache-2.0 | Yes |

Clean-room re-implementing the *pattern* (refs, snapshot format, action schema) is fine under MIT/Apache-2.0; don't copy prompts/code verbatim, and note patent grant (Apache) and trademark (Stagehand, Chrome brand) nuances.

## (f) Safety patterns

- **Anthropic's explicit guidance** [13]: run in a dedicated minimal-privilege VM/container; allowlist domains; **human confirmation for consequential actions** — financial transactions, accepting cookies, agreeing to ToS; prompt-injection classifiers scan tool results/screenshots and steer the model to verify provenance.
- **URL policy**: Playwright MCP `--allowed-origins`/`--blocked-origins` (blocklist evaluated first; "does not serve as a security boundary"); browser-use `Browser(allowed_domains=[...])`, plus `restricted_urls`/`blocked_domains` examples [5][1][3].
- **Secrets**: browser-use `sensitive_data` dict — LLM sees only placeholders (`x_user`), real values injected into form fields at execute time; recommend `use_vision=False` during credential entry; Playwright MCP `--secrets` dotenv file [3][5]. Stagehand: selectors returned by `observe` keep credentials out of model context entirely [12].
- **Watch mode**: browser-use Cloud human-in-the-loop (live preview, take over, resume session); Claude SDK approval callbacks on every browser/computer action [1][4].

## Recommended v1 for Android (visible WebView driven over CDP)

**Transport**: `WebView.setWebContentsDebuggingEnabled(true)` → attach via CDP (same protocol Playwright MCP's `--cdp-endpoint` and DevTools MCP use on desktop [5][6]).

**Observation (per step)**: header {url, title, viewport WxH, scroll %}, tabs inventory (one active), then a pruned tree of *viewport-visible interactive* elements — one line each: `[eN] role/tag "accessible name" [key attrs] [box=x,y,w,h optional]`, `*` for new-since-last-step, `|SCROLL|`/`|SHADOW|` markers; merge iframes + open shadow DOM; cap ~50k chars; build it from **CDP DOMSnapshot + AX tree** (browser-use's current approach [8]). Optional screenshot with SoM boxes for verification.

**Action space v1** (subset of Claude's 31 [4] + browser-use [3]): `navigate(url|back|forward|reload)`, `click(ref|xy)`, `input(ref, text)`, `form_input(refs+values batch)`, `select_option(ref, value)`, `scroll(direction, amount)`, `scroll_to(ref)`, `key(text)`, `wait(s)`, `screenshot()`, `zoom(region)`, `find(query)`, `tabs {list|new|switch|close}`, `done(text, success)`. Errors as descriptive text ("stale ref — re-snapshot"), batch with fail-fast halt, max ~5 actions/step, max_steps 30–100, 5 consecutive-failure abort.

**Safety v1**: domain allow/deny list enforced pre-navigation; secret placeholder injection at execute-time; user confirmation sheet before purchases/PII submits; the WebView itself is the watch-mode UI.

## Sources

1. https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/agent/system_prompts/system_prompt.md (+ README, LICENSE)
2. https://playwright.dev/docs/aria-snapshots
3. https://docs.browser-use.com/open-source/customize/tools/available.md (+ sensitive-data.md, llms.txt)
4. https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
5. https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md
6. https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md (+ README)
7. https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/agent/views.py
8. https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/enhanced_snapshot.py (+ dom/service.py)
9. https://arxiv.org/abs/2307.13854 (WebArena)
10. https://github.com/MinorJerry/WebVoyager (README) / https://arxiv.org/abs/2401.13919
11. https://arxiv.org/abs/2504.12516 (BrowseComp)
12. https://raw.githubusercontent.com/browserbase/stagehand/main/README.md (+ docs.stagehand.dev v4 act/observe/extract/caching)
13. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (+ OpenAI https://developers.openai.com/api/docs/guides/tools-computer-use)
