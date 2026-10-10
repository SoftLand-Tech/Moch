# AI Agentic Browsers & In-App Agent Browsing — Landscape & UX Report (Oct 2026)
*For the design of Moch's built-in real agentic browser (Android). Compiled from primary product pages, hands-on reviews, and vendor blogs.*

## (a) Landscape table

| Product | Platform(s) | Agent model | Mobile? | Status (late 2026) |
|---|---|---|---|---|
| **Perplexity Comet** | macOS/Win (Jul 2025), **Android (Nov 20 2025)**, iOS/iPadOS (Mar 18 2026) | Comet Assistant, multi-model picker; **Android/desktop: in-page on-device agent** (pulsing blue highlight, user takeover); iOS: cloud virtual browser, temp cookie transfer, screenshot updates | **Yes — the only full agentic browser on both mobile platforms** | Active, category leader; free + Pro $20/Max $200; Sept 2026 backlash for metering browser control via "Computer credits" |
| **OpenAI ChatGPT Atlas** | macOS only (Oct 2025) | ChatGPT sidebar + agent mode vs authenticated sessions; OWL architecture decoupling Chromium | No (mobile users get ChatGPT Agent in-app, cloud VM) | **Discontinued Aug 9 2026**, folded into new ChatGPT desktop "superapp" (ChatGPT + Codex + browser) |
| **Google Project Mariner / Gemini in Chrome** | Chrome desktop | Up to 10 parallel browser tasks, teach-and-repeat; AI Ultra tier | No | **Shut down May 4 2026**; tech folded into Gemini Agent, AI Mode in Search, Chrome "auto browse" (Gemini 3, AI Pro/Ultra, en-US) |
| **Opera (Aria / Browser Operator / Neon)** | Desktop (Opera One/GX; Neon standalone) | Browser Operator (Mar 2025): **native client-side agent, no screenshots/cloud VM**; Aria chat; **Neon (Sept 30 2025, paid, public Dec 11 2025)**: "chat, do, make" — Neon Do acts locally in your authenticated session, Tasks workspaces, Cards recipes, cloud Research Agents; MCP Connector (Mar 2026) makes the *browser an MCP server* for external agents (free) | No (agentic plans for Opera Mini publicized) | Active; Neon subscription-gated |
| **The Browser Company: Arc → Dia** | Arc: macOS (+iOS/Android Arc Search); Dia: macOS | Arc: AI features only, no agent; Dia: AI-first Chromium, sidebar assistant, partial agent | Arc Search (iOS/Android) still listed but **unmaintained zombie**; Dia not mobile | Arc in maintenance since May 2025; **Atlassian acquired TBC for $610M** (closed Oct 21 2025); Dia inherits Arc UX (sidebar, vertical tabs), enterprise knowledge-work focus |
| **Brave Leo** | Desktop + mobile browsers | Leo chat (free/premium $7.99); **Agentic "AI browsing"** (Dec 10 2025 Nightly → all channels May 5 2026): opt-in flag, isolated fresh profile, open-tab execution, alignment-checker model gates risky actions, pause/inspect, no per-site prompts | Browser on mobile; agentic first shipped desktop | Active, privacy-first, double bug bounty |
| **Mozilla Firefox** | Desktop, Android, iOS (WebKit) | AI Window announced Nov 13 2025 → **Smart Window beta** (provider choice: 3 US models, Mistral EU, zero data retention); Fx145 agentic-friendly automation defaults; Fx148 "AI kill switch"; **"Dens"**: vibe-coded mini-widgets from page content; agents (price tracking, reservations) on roadmap with portable-context pitch | Mobile growing via EU DMA choice screens (6M users) | Active; agents not yet shipped |
| **Anthropic Claude in Chrome** | Chrome extension (desktop) | "Claude holding the mouse": reads signed-in pages, clicks/types/fills; side panel beta runs as **Cowork** sessions; injection defenses cut attack success 23.6%→11.2% | No | **GA on all paid plans** (Aug 2026); Enterprise admin controls |
| **Microsoft Edge Copilot Mode** | Edge desktop (+ Copilot on mobile) | Copilot Actions: multi-step tasks (forms, bookings, email) with explicit consent; Journeys session memory | Copilot assistant on mobile Edge; agentic Actions desktop-first | Active (Oct 2025) |
| **SigmaOS** | macOS | AI assistant (Airis) | No | **Dead** — team joined TBC Nov 2024, app sunset Jan 2025 |

**Mobile-first reality check:** Only Perplexity Comet ships a real browser+agent on Android and iOS. Arc Search is abandoned. Everything else is desktop or cloud-agent-in-a-chat-app (ChatGPT Agent, Gemini Agent). **Moch's in-app agentic browser on Android is close to greenfield.**

## (b) UX patterns worth adopting, ranked for a mobile in-app browser

1. **In-page visible agent + instant takeover** (Comet Android's pulsing blue highlight; Neon Do; Brave's "all browsing in an open tab, never hidden"). On mobile: agent drives the visible WebView; any touch pauses the agent and hands control back. This is the single strongest trust pattern — and Android (no WebKit mandate) allows the real on-device agent iOS couldn't.
2. **Confirmation cards for consequential actions** (Brave: alignment-checker flags risky actions → explicit permission; Neon pauses before purchase; Copilot Actions consent; Claude: "you decide what happens next"). Mobile: bottom-sheet card with site favicon, exact action, Approve/Cancel — reserved for purchases, logins, form submits, deletions (Brave deliberately avoids per-site prompts to prevent warning fatigue).
3. **Watch-it-work narration + step timeline with screenshots** (Comet iOS streams screenshots from its cloud browser with running commentary; Claude/ChatGPT agent live transcripts; Neon "shows its work"). Mobile: collapsible step timeline (URL + screenshot thumbnail per step) behind a live status line; doubles as the audit log Brave insists the agent can't delete.
4. **Chat as a bottom sheet over the page, not a sidepanel** (Comet iOS: Assistant button centered in the bottom address bar + docked glass button; swipe-on-address-bar tab switching). Desktop sidepanels (Atlas, Dia, Leo, Copilot) don't translate; Comet's mobile-native chat-over-page does.
5. **Background task queue + notifications, screen-off safe** (Mariner ran up to 10 tasks in parallel; Comet's iOS cloud browser keeps working after you switch away). Mobile: Android foreground service with persistent notification + progress + result notification; task list screen to queue/review runs. This is where mobile can *beat* desktop.
6. **Voice-driven tasking** (Comet iOS: OpenAI realtime voice API for inline conversations about the current page). Natural pairing with background queue: dictate a task, leave, get notified.
7. **Task workspaces / parallel tabs** (Neon Tasks = mini-browser with own tabs/history/notes; Comet "summarize across tabs", multi-tab comparison). Mobile: run agent in background tab(s) while user keeps browsing their own tab — the "parallel tabs" pattern.
8. **Reusable prompt recipes** (Neon Cards — shareable, versioned; Brave Leo Skills, Dec 2025 — keyboard-shortcut prompts). Mobile: one-tap recipe chips ("compare prices", "book again").
9. **Trust boundaries: isolated agent profile + distinct visual mode** (Brave: separate profile so cookies/logins never cross; agent mode styled differently like Private/Tor windows; blocks internal pages, non-HTTPS, flagged sites; memory saves visible + undoable). For Moch: separate cookie store for agent sessions vs user browsing, and an unmistakable agent-mode visual state.
10. **Replay/share of a run** (Brave session logs inspectable; Neon Tasks as audit containers; ChatGPT Agent shareable transcripts). Mobile: share a run as a step-by-step "how I booked this" card — screenshots + actions, exportable.

## (c) What users complain about

- **Comet desktop (launch):** persistent right-side assistant ate half the screen, no minimize/resize — "the UI feels like it's fighting me", "built for the AI, not the human"; laggy performance, freezing tabs (X/Reddit roundup, Oct 2025).
- **Comet iOS (MacStories hands-on):** barebones start page, buried bookmarks; clunky code-based "sync chains" instead of plain account login; connector/mode fragmentation across Perplexity surfaces; cloud cookie transfer to the virtual browser called "scary" — users advised never to use it with banking.
- **Comet pricing (Sept 2026):** core browser control moved behind metered "Computer credits" → backlash from paying Pro subscribers.
- **Platform trust:** Atlas was macOS-only then discontinued; Arc abandoned for Dia then sold to Atlassian — early adopters repeatedly burned, feeding "why switch from Chrome?" inertia.
- **Category-wide:** prompt-injection and "agent makes a mistake with real money" fears (Simon Willison; Brave's vulnerability disclosures); agents are slow ("the agent takes a long time to browse"); privacy — Time reported AI browsers training on user data (Brave differentiates with no-training).
- **Edge/Chrome incumbents:** chat sidebars read as bolt-on; Mozilla users pushed back so hard Firefox 148 shipped an AI kill switch.

## (d) Sources

1. https://the-agent-report.com/2026/07/agentic-browsers-landscape-2026-comet-atlas-dia/
2. https://www.macstories.net/news/comet-is-the-first-agentic-browser-for-ios-worth-trying/
3. https://en.wikipedia.org/wiki/Comet_(browser)
4. https://9to5mac.com/2026/07/09/openai-is-discontinuing-chatgpt-atlas-its-standalone-desktop-browser/
5. https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work
6. https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html
7. https://agentmarketcap.ai/agents/project-mariner
8. https://brave.com/blog/ai-browsing/
9. https://blog.mozilla.org/en/firefox/ai-window/
10. https://diginomica.com/firefoxs-ajit-varma-enterprise-security-ai-model-choice-and-what-open-source-makes-possible
11. https://claude.com/claude-in-chrome and https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
12. https://agentsdb.com/anthropic-claude-for-chrome-browser-agents-safety
13. https://agentsdb.com/opera-neon-turns-the-browser-into-your-local-ai-agent
14. https://www.operaneon.com/faq and https://blogs.opera.com/news/2026/03/opera-neon-adds-mcp-connector-to-the-browser/
15. https://press.opera.com/2025/03/03/opera-browser-operator-ai-agentics/
16. https://investor.opera.com/node/10006/pdf
17. https://secure.businesswire.com/news/home/20251021473486/en/Atlassian-Completes-Acquisition-of-The-Browser-Company-of-New-York
18. https://supasidebar.com/blog/is-arc-browser-dead
19. https://aitoolgraveyard.com/why-sigmaos-failed
20. https://globalmarketsx.substack.com/p/i-just-tried-perplexity-comet-and
21. https://piunikaweb.com/2026/09/15/perplexity-comet-browser-control-computer-credits/
22. https://windowsforum.com/news/edge-copilot-mode-the-ai-browser-that-reads-pages-and-executes-actions.386402/
23. https://alatirok.com/agentic-browsers-2026-dia-comet-arc-search/
24. https://www.firefox.com/en-US/firefox/145.0/releasenotes/ and https://www.techspot.com/news/111453-firefox-148-rolls-out-promised-ai-kill-switch.html
