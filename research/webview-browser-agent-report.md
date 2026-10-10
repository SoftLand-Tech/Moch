# Moch Embedded-WebView Browser Agent — Feasibility, Anti-Bot & Security Report

**Scope:** AI agent driving a real, visible Android WebView (CDP in-app) inside Moch's Expo/RN + Chaquopy/proot shell. Researched via primary docs (Google, Cloudflare, DataDome, Anthropic, arXiv). Note: `web_search` was unavailable (no API key); findings use direct fetches of canonical sources + DuckDuckGo HTML discovery.

## (a) Anti-bot reality check + hardening checklist

**How WebViews are detected.** Vendors (Cloudflare, DataDome, Kasada, HUMAN/PerimeterX) score requests with ML over headers, session characteristics and browser telemetry [5][8]. Classic WebView tells:

- **`X-Requested-With: <package>`** — verified: Chromium shipped removal in WebView **110** (slow rollout, Feb 2023); the header is now **opt-in only** (explicit site allowlist) [1][2][3]. On WebView ≥110 the default header is gone — one less tell for free. (Pre-110 devices still send it; `shouldInterceptRequest` re-issue hacks are unreliable [older Focus findings].)
- **UA `wv` token + Sec-CH-UA brand "Android WebView"**: WebView's UA contains `; wv)` and its `Sec-CH-UA` brand list literally includes `"Android WebView"` — a low-entropy hint sent by default on every request, and a *forbidden request header*, so page JS cannot override it [4].
- **WebGL/canvas, fonts, codecs**: on a real device with hardware acceleration, WebView reports the same ANGLE/GPU strings as Chrome — parity, not a tell. DataDome's JS tag collects "hundreds of signals" (screen/window dims, timezone, fonts, canvas/WebGL hashes, codecs) and flags *inconsistencies* more than any single value [8]; its Android SDK exists precisely to challenge WebView/app traffic [9].
- **TLS/HTTP2 (JA3/JA4)**: WebView uses Chromium's network stack, so fingerprints match Chrome of the same version — Cloudflare exposes JA3/JA4 but they won't distinguish you [5].
- **Behavioral signals**: DataDome explicitly collects behavioral signals [9]. Key advantage of CDP: `Input.dispatchMouseEvent`/`dispatchTouchEvent` produce **`isTrusted: true`** events (they enter the browser input pipeline, unlike synthetic JS events). But perfectly linear, instantaneous, jitter-free motion is machine-flagged; humanized trajectories are required.

**How close to real Chrome?** Network-layer: nearly identical. Remaining tells: UA `wv` token, `Sec-CH-UA` brand list, and historical XRW. Turnstile's own docs require "no modification to core browser behavior" and a **consistent UA** — changing UA mid-session makes challenges fail [6]. Community reports show Turnstile failing ~100% in some third-party WebViews [7][24], but Cloudflare's official guidance is that WebView *works* if JS + DOM storage are enabled, `challenges.cloudflare.com` and `about:blank`/`about:srcdoc` are reachable, and cookies/localStorage persist [6].

**Hardening checklist**
1. Keep the default WebView UA except stripping the ` wv` token once at startup — never change UA mid-session [6].
2. Require WebView ≥110; never opt into the XRW allowlist [1][3].
3. Enable JS, DOM storage, third-party cookies; persist `CookieManager` (`setAcceptCookie`, `setAcceptThirdPartyCookies`, `flush()`) so reputation/cookies accumulate across runs [6][13].
4. Drive input only via CDP `Input.*` with humanized timing/curves; never JS-dispatched events.
5. Keep hardware acceleration on (WebGL parity; SwiftShader is a bot tell).
6. Don't attempt `navigator.userAgentData` brand overrides — readonly, and tampering creates inconsistency detectors love [4].
7. Design for challenge hand-off: when a CAPTCHA/interstitial appears, pause the agent and let the user solve in the same visible view (acceptable and honest — it's your app's WebView, the human is present).
8. Accept residual risk: Kasada/DataDome/PX will sometimes challenge regardless; treat "agent blocked" as a normal outcome, not a bug.

## (b) Login / passkey strategy

- **Google OAuth is hard-blocked in embedded WebViews** since Sept 2021 ("use secure browsers" policy → `403 disallowed_user_agent`); Google's remediation doc directs apps to Custom Tabs / browser-based flows [10][11]. Facebook behaves similarly. **Route IdP OAuth through Custom Tabs or native Credential Manager**, never the agent WebView.
- **Passkeys/WebAuthn in WebView**: supported since **androidx.webkit 1.12.0** (early 2025) but only via explicit native opt-in — `setWebAuthenticationSupport()` bridging to **Credential Manager**; most host apps don't wire it, so `navigator.credentials` silently fails [12][25]. Wire it up; it gives you Google Password Manager passkeys, passwords, and federated sign-in inside the WebView.
- **Password managers**: WebView integrates with the system `AutofillManager`; autofill services (Google PM, 1Password, Bitwarden) can fill WebViews heuristically. Ensure autofill isn't disabled and mark views `importantForAutofill`.
- **Cookies/session**: WebView cookies persist to disk (call `CookieManager.flush()` on pauses); never wipe the profile between agent runs — aged cookies materially reduce challenge rates [6][13].

## (c) Security architecture for agentic browsing

- **Isolation**: give the agent its own WebView **profile / data directory** (androidx.webkit `ProfileStore`, or separate `WebView.setDataDirectorySuffix`) — separate cookies/storage from any user-facing in-app browsing; agent profile is disposable + auditable.
- **Permission gating**: a URL-class policy engine *outside* the LLM. Default-deny for banking/payments/government/health eTLD+1s; allow-list per task; re-classify on every navigation and abort on class change mid-form.
- **Input confirmation**: intercept form submits via CDP; if a POST contains PII-looking fields or targets a sensitive class, pause and require the user to confirm a masked diff of the payload. Irreversible actions (pay, send, delete) always require confirmation regardless of domain.
- **Screenshot privacy (local+cloud hybrid)**: default to sending **structured DOM snapshots (text)** to the cloud reasoner — not raw screenshots; redact on-device (emails, card numbers, tokens) before anything leaves the device; screenshots to cloud only with per-session consent.
- **Prompt-injection defenses** — this is the dominant threat: Greshake et al. established indirect prompt injection as arbitrary-control of LLM-integrated apps [18]; InjecAgent benchmarked it: ReAct-prompted **GPT-4 was exploited 24% of the time** (≈2× with reinforced attack prompts) [19]; Anthropic's browser-use write-up (Nov 2025) states **no browser agent is immune** — even at ~1% ASR "meaningful risk" remains, and their stack is RL-trained robustness + classifiers scanning untrusted content + human red teaming [20]; Claude docs prescribe input screening, hardened system prompts, and "safe handling of untrusted tool content" [21]. Concrete engineering for Moch: (1) page content enters the prompt only as quoted data in a rigid schema, never concatenated as instructions; (2) instruction channel is user-only — strip CSS/hidden/white-on-white text from DOM snapshots before they reach any model; (3) capability-scoped action space (the executor only knows current-task verbs, not arbitrary tool calls); (4) plan-validating checker on-device rejects out-of-scope actions; (5) exfil detection on outbound submits/URLs; (6) confirmation gates as above.

## (d) WebView runtime risks on Android + mitigations

- **Renderer crashes**: WebViews render out-of-process; a renderer kill (OOM, bug) invokes `WebViewClient.onRenderProcessGone` — you must destroy and recreate the WebView; crashes can take down all WebViews sharing that renderer [14]. Mitigation: serialize agent task state so any tab can be rebuilt; budget for 1–2 live WebViews max (unused WebViews still hold memory — destroy, don't cache) [14].
- **Background operation**: WebView is Activity/UI-thread-bound; a "headless WebView in a foreground service" partially works but rendering throttles, and `pauseTimers()` pauses JS/timers for **all** WebViews app-wide — do not call it while the agent works. Simplest robust model: keep the agent Activity foregrounded (the user is watching anyway) + partial wakelock.
- **Hardware acceleration** must stay enabled (challenges depend on WebGL/canvas).
- **CDP exposure**: `setWebContentsDebuggingEnabled(true)` exposes an abstract socket `@webview_devtools_remote_<pid>` — this is your in-app CDP transport [15], but security vendors flag it as dangerous: anyone with adb/devtools (and potentially other processes) can read WebView contents [16]. Enable only during live agent sessions, disable immediately after; treat the socket as sensitive.
- **Play policy**: shipping an in-app browser with AI automation requires **no special declaration** — WebView usage is unrestricted; you are *not* using the AccessibilityService API, which is the thing Play restricts (declaration + prominent disclosure; permitted uses don't cover generic automation) [17]. Fill the Data Safety form for any DOM content sent to cloud.

## (e) On-device vs cloud LLM

Raw DOM snapshots run 5–50k tokens. On-device options (Gemma 3n E2B/E4B via MediaPipe/LiteRT-LM/llama.cpp; Qwen3 0.6–4B; Phi-class) run at roughly 5–20 tok/s decode on flagship SoCs, and **prefill of a 30k-token DOM on CPU takes minutes** — unusable for a full-DOM grounding loop; sub-4B models also degrade at retrieving from long context. Gemma 3n is explicitly "optimized for phones" (PLE + MatFormer) [22][23], but that optimizes cost, not long-context grounding quality. **Recommendation — hybrid split:** on-device **observer/actor**: CDP `DOMSnapshot` → deterministic pruning → compact 1–3k-token representation + element ranking; local small model handles grounded single actions (click/type by role+name) and privacy redaction; **cloud reasoner** handles planning, multi-step reasoning, and recovery, receiving only the compacted snapshot and never secrets. This also bounds what untrusted page content can reach.

## Sources

1. https://groups.google.com/a/chromium.org/g/blink-dev/c/Z70s8CQ8PbU
2. https://developer.chrome.com/blog/chrome-110-beta/
3. https://android-developers.googleblog.com/2023/02/improving-user-privacy-by-requiring-opt-in-to-send-x-requested-wih-header-from-webview.html
4. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA
5. https://developers.cloudflare.com/bots/concepts/bot-score/
6. https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/
7. https://community.cloudflare.com/t/turnstile-always-fails-in-a-webview/423520
8. https://docs.datadome.co/docs/device-check
9. https://docs.datadome.co/docs/sdk-android
10. https://support.google.com/faqs/answer/12284343
11. https://support.auth0.com/center/s/article/google-blocks-SSO-signup-login-embedded-browsers
12. https://developer.android.com/identity/sign-in/credential-manager-webview
13. https://developer.android.com/reference/android/webkit/CookieManager
14. https://developer.android.com/develop/ui/views/layout/webapps/managing-webview
15. https://developer.chrome.com/docs/devtools/remote-debugging/webviews/
16. https://docs.ostorlab.co/kb/DANGEROUS_API_WEBVIEW_REMOTE_DEBUGGING_ENABLED/
17. https://support.google.com/googleplay/android-developer/answer/10964491
18. https://arxiv.org/abs/2302.12173
19. https://arxiv.org/abs/2403.02691
20. https://www.anthropic.com/research/prompt-injection-defenses
21. https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
22. https://ai.google.dev/gemma/docs/gemma-3n
23. https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference
24. https://discuss.grapheneos.org/d/40379-cloudflare-turnstile-and-webview
25. https://github.com/komyun-app/capacitor-native-passkey
