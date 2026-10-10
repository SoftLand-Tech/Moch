# Agent-driven automation on Android — control surfaces for an in-app browsing agent

Scope: one Android app, no root, no adb, no desktop companion. The agent browses the web inside the app's own browser view.

## 1. Accessibility Service (AccessibilityNodeInfo)

Mechanics: an `AccessibilityService` receives window/event callbacks; `onAccessibilityEvent` + `getRootInWindow()` yield a serialized `AccessibilityNodeInfo` tree (text, IDs, bounds, `ACTION_CLICK`/`ACTION_SCROLL_FORWARD`/`ACTION_SET_TEXT`), and `dispatchGesture()` injects touches system-wide [13]. This is the only sanctioned cross-app control surface for a regular app.

Projects & grounding:
- **Mobile-Agent family (X-PLUG/Tongyi, v1→v3.5/GUI-Owl)**: vision-first — screenshot + OCR/icon detection for grounding, adb tap/swap execution; v2 (NeurIPS'24) adds a multi-agent loop (planner/decision/reflectors); v3/GUI-Owl (arXiv 2508.15144) is a native GUI VLM (perception + grounding + planning) with progress management and reflection; deployed on Alibaba's Wuying cloud phones, evaluated on AndroidWorld [1].
- **AppAgent (CHI 2025)**: simplified human-like action space (tap/swipe/text), "bypasses the need for system back-end access"; learns app knowledge via autonomous exploration or observing human demos; 50 tasks / 10 apps; grounded in screenshot + UI XML dump [3].
- **AutoGLM (Zhipu/THUDM, arXiv 2411.00820)**: deployed phone-use agent; key design: an "intermediate interface" separating planning from grounding (each optimized differently) + progressive online-curriculum RL; 89.7% on common Chinese-app tasks, 36.2% on AndroidLab [4]. Follow-ups (AgentRL, ComputerRL) scale RL training.
- **AndroidWorld (Google DeepMind, arXiv 2405.14573)**: benchmark on a live emulator; observation = screenshot + accessibility tree; actions via a JSON action space through AndroidEnv's gRPC "accessibility forwarding app" — i.e., a11y-tree + vision hybrid; ships M3A multimodal agent [2]. AndroidEnv is the same lineage.
- **OS-Copilot** is desktop-only (Linux/macOS generalist, FRIDAY) — not a mobile stack [6].
- Field survey (arXiv 2505.12981) categorizes deployed agents: OEM system-level (Honor YOYO), third-party universal (AutoGLM), framework-based (Alibaba Mobile-Agent); all rely on a11y-style GUI interaction, and all 9 audited agents had exploitable attack surfaces [5].

Maturity: highest for cross-app reach; grounding is best as hybrid (a11y tree for structure + screenshot/VLM for pixels), matching AndroidWorld/M3A and AutoGLM's intermediate interface.

## 2. On-device test-automation stacks

- **UiAutomator/UiAutomator2**: instrumentation-based; the server APK is installed and launched via adb (`am instrument`), typically from a host (CI) or adb-over-WiFi. Confirmed by the Appium UiAutomator2 driver docs: requires Android SDK platform-tools, USB debugging enabled, device visible in `adb devices`, and proxies commands through `appium-adb` and the UiAutomator2 instrumentation server [7]. **Cannot run inside a regular app without adb.**
- **Espresso**: runs in-process against your own app — but as *instrumentation tests* (`androidTest` APK, launched via adb/orchestrator). Not shippable as a production in-app driver; no cross-app reach.
- **Maestro**: host-driven CLI; flows run through a connected device (adb/USB/WiFi) [8]. Not embeddable.
- **Darwin (mobile-native)**: repo unreachable during this research; could not verify current state — treat as unverified.

Verdict: no mainstream test stack runs *inside* an app with no host. They assume the adb/shell privilege lane.

## 3. Chrome-on-Android remote debugging without adb

Chrome exposes DevTools over a Unix domain socket (`chrome_devtools_remote`), normally reached via `adb forward localabstract:…` and `chrome://inspect` [9]. Another app attaching to Chrome's socket is blocked: Android's app sandbox is enforced by SELinux with full enforcing mode since Android 5.0 [11]; sockets (including abstract-namespace sockets) carry the creating process's SELinux label/MCS categories, so an `untrusted_app` connect() to another app's labeled socket is denied. Only privileged domains (adb/shell) may attach. Conclusion: **driving another app's Chrome via CDP is not available to a normal app; CDP is only viable on a WebView you own** (see §6).

## 4. Headless embedded Chromium (rejected)

Bundling a headless/embedded Chromium inside app-private storage would give full CDP control without permissions, but it is a heavy, non-native surface (large binary, Play review friction for bundled engines, degraded rendering fidelity, login/DRM quirks). Per prior decision, we are not doing this; it only matters if the Play-safe surfaces below prove insufficient.

## 5. Commercial products (public engineering detail)

- **OpenAI ChatGPT agent (July 17, 2025)**: cloud-side CUA driving a *virtual computer/browser in OpenAI's VM* (Operator lineage + Deep Research); nothing runs on-device [14].
- **Perplexity Comet**: agentic *browser* — the agent acts inside Perplexity's own browser engine (their own app ⇒ DOM-level control, no a11y needed). Mobile status unverified this session (site blocked).
- **Anthropic**: "computer use" is an API for desktop VMs; the Claude mobile app does not drive the phone UI.
- **Rabbit r1**: LAM runs cloud-side against web services (LAM playground); no on-device Android surface.
- **Honor/Huawei**: YOYO / system agents ship as OEM system-level agents with privileged system access — a lane unavailable to third-party apps [5].
- **Apple Intelligence/Siri**: on-screen awareness is OS-integrated (private on-device models + system privileges), iOS 18.2+ era, fully delayed/re-shipped since — again OEM-only [15].

Pattern: consumer agents either run the browser in the cloud, or are the OS vendor.

## 6. Tradeoff matrix (our in-app browser view)

| Criterion | A11y Service | CDP on own WebView | Vision-only (screenshot+coords) | Hybrid (CDP + vision) |
|---|---|---|---|---|
| Latency/step | Med (event stream, tree diffing) | **Low** (DOM/JS, no pixel loop) | High (VLM per step) | Low–Med |
| Reliability | Med (nodes unlabeled/invisible in games, canvas) | **High** for DOM pages; blind to canvas | Med (OCR/grounding errors) | **High** |
| Cross-app reach | **Full** | None (our process only) | None without injection | None |
| Play policy risk | **High** — AccessibilityService API requires a declaration & permitted/promoted use; automating your own app is not an accessibility purpose [12] | **None** (own WebView debugging) | None (plus we can `dispatchTouchEvent` on our own views in-process) | None |
| Battery | Persistent listener cost | ~Zero | GPU/VLM cost | Low |
| Extras | System dialogs, other apps | Network interception, JS eval, `Page.captureScreenshot`, console logs | Visual verification | Best of both |

**Recommendation**: primary = **CDP on our own WebView** (`WebView.setWebContentsDebuggingEnabled(true)` [10], connect from our own process to the socket our app created), with **vision-only as fallback** (WebView screenshot + coordinate model + in-process `dispatchTouchEvent`) for pages where DOM info is insufficient or a rendering-verification step is needed. Keep an **optional AccessibilityService module** as the future "cross-app mode" — only if the product later needs to operate other apps — because it carries declaration, review, and battery costs. Test-automation stacks (§2) and cross-app Chrome CDP (§3) are dead ends under our constraints.

## Sources

1. https://github.com/X-PLUG/MobileAgent
2. https://github.com/google-research/android_world (paper: https://arxiv.org/abs/2405.14573)
3. https://arxiv.org/abs/2312.13771 (AppAgent, CHI 2025)
4. https://arxiv.org/abs/2411.00820 (AutoGLM)
5. https://arxiv.org/abs/2505.12981 (mobile LLM agent security survey; YOYO/AutoGLM/Mobile-Agent)
6. https://github.com/OS-Copilot/OS-Copilot
7. https://github.com/appium/appium-uiautomator2-driver
8. https://docs.maestro.dev/
9. https://developer.chrome.com/docs/devtools/remote-debugging
10. https://developer.chrome.com/docs/devtools/remote-debugging/webviews
11. https://source.android.com/docs/security/features/selinux
12. https://support.google.com/googleplay/android-developer/answer/10964491 (Use of the AccessibilityService API — Play Console Help)
13. https://developer.android.com/guide/topics/ui/accessibility/service
14. https://en.wikipedia.org/wiki/ChatGPT#Agents (citing The Verge 2025-07-17 and openai.com/index/introducing-chatgpt-agent/)
15. https://en.wikipedia.org/wiki/Apple_Intelligence
