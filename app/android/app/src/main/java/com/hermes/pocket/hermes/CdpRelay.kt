package com.hermes.pocket.hermes

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * CdpRelay — loopback HTTP+WS proxy from Python-visible `127.0.0.1:<port>`
 * to this app's WebView DevTools abstract unix socket
 * `webview_devtools_remote_<pid>`.
 *
 * Why (BUILD-PLAN.md decision #1): Chaquopy Python cannot speak Android's
 * abstract-namespace LocalSocket; Kotlin can. Same process ⇒ same UID ⇒ the
 * DevTools peer check (SO_PEERCRED, devtools_auth.cc) admits us. Python only
 * ever sees plain loopback TCP, so stock hermes (requests + websockets)
 * works unmodified.
 *
 * Auth: every path must carry the relay token as its FIRST segment
 * (`/<token>/json/version`, `/<token>/devtools/page/<id>`). Loopback TCP is
 * reachable by other apps on-device (unlike the abstract socket) — the token
 * is what keeps them out. The token + port are persisted to
 * `<hermesHome>/browser/relay.json`, read by `moch/hermes_boot.py` to set
 * BROWSER_CDP_URL; no native bridge surface is needed for that handoff.
 *
 * Active-tab filter (BUILD-PLAN decision #2): `/json/list` advertises at
 * most ONE target — the WebView whose URL matches the active URL when
 * unambiguous, else the first. Stock hermes attaches the first page target,
 * so a filtered list makes it land on the tab the user is looking at. The
 * filter is unchanged by BUG-136; the additive `/json/moch-tabs` serves the
 * FULL upstream page list when a tool needs to see every tab.
 *
 * Tab lifecycle (BUG-136): `/json/new|close|activate` used to 405 ("tab
 * lifecycle is native-owned"), which left the agent with no way to move the
 * tab strip. RN is STILL the single tab owner — the relay now round-trips:
 * ONE "mochTabOp" RCTDeviceEventEmitter event (payload {requestId, op,
 * url?, targetId?}), a CountDownLatch wait for the app's ack
 * (BrowserRelayModule.tabOpAck), and for open a diff of the upstream
 * /json/list to resolve the new page's DevTools target by URL. CDP never
 * mutates the tab strip behind the owner's back.
 *
 * WebSocket tunneling: the client's upgrade request (its own
 * Sec-WebSocket-Key etc.) is forwarded with the token segment stripped; the
 * upstream 101 passes back verbatim; then both legs are byte-pumped.
 *
 * Threading: one accept thread, one handler thread per connection, two pump
 * threads per WS tunnel. HTTP responses to /json routes are built from a
 * fresh upstream fetch per request (DevTools is keep-alive; per-request
 * sockets sidestep multiplexing entirely — connects are local and cheap).
 */
object CdpRelay {

  private const val TAG = "CdpRelay"
  private const val MAX_LINE = 64 * 1024
  private const val MAX_HEADERS = 256 * 1024
  private const val PUMP_CHUNK = 1 shl 20

  // BUG-136 tab-lifecycle round-trip (see class doc).
  private const val TAB_OP_EVENT = "mochTabOp"
  private const val TAB_OP_ACK_TIMEOUT_MS = 5_000L
  private const val TAB_OPEN_RESOLVE_TIMEOUT_MS = 3_000L

  // Mirror of AgentBrowserHost.tsx AGENT_START_URL — keep the two in
  // lockstep (same contract as the hermesHomeDir mirror below). The hidden
  // agent host page is a REAL upstream target but never a browserTabs-store
  // tab; /json/moch-tabs and the open-diff filter it out so listings match
  // the tab strip exactly. A user tab on the very same URL would be hidden
  // from moch-tabs too — accepted (the boring-safe option): its target still
  // exists upstream, only the listing folds the duplicate away.
  private const val AGENT_TAB_URL_PREFIX = "https://example.com/"

  data class Status(
    val running: Boolean,
    val port: Int,
    val token: String?,
    val activeUrlPrefix: String?,
    val lastError: String?,
  )

  private val running = AtomicBoolean(false)
  private var server: ServerSocket? = null

  // BH-000045: live WS tunnels by id — the client leg of each pump pair.
  // Closing the server socket does NOT close accepted connections, so stop()
  // needs this registry to tear tunnels down with the relay.
  private val liveTunnels = ConcurrentHashMap<String, Socket>()
  private val tunnelSeq = java.util.concurrent.atomic.AtomicInteger(0)

  @Volatile var port: Int = 0; private set
  @Volatile var token: String = ""; private set
  @Volatile var activeUrlPrefix: String? = null
  @Volatile var lastError: String? = null
  private var appContext: android.content.Context? = null

  // ── Control surface (BrowserRelayModule) ─────────────────────────────────

  fun start(context: android.content.Context, preferPort: Int = 9334) {
    if (running.get()) return
    appContext = context.applicationContext
    lastError = null
    val srv = ServerSocket()
    // BUG-106: bind the IPv4 loopback LITERAL. `InetAddress.getLoopbackAddress()`
    // resolves to ::1 on Android, so the relay listened IPv6-only while both
    // arming paths publish `http://127.0.0.1:<port>/<token>` — requests and
    // websockets dial that as IPv4, the connect is refused, and every browser
    // tool dies with "the Moch browser relay is not running". Verified on-device:
    // ::1:9334 LISTEN, nothing on 127.0.0.1, `nc 127.0.0.1 9334` refused; an
    // in-namespace IPv4→IPv6 forwarder made the whole feature work. Loopback only,
    // IPv4 only — no wildcard bind.
    val loopback = InetAddress.getByName("127.0.0.1")
    try {
      srv.reuseAddress = true
      srv.bind(InetSocketAddress(loopback, preferPort), 16)
    } catch (e: Exception) {
      try {
        srv.bind(InetSocketAddress(loopback, 0), 16)
      } catch (e2: Exception) {
        lastError = "bind failed: $e2"
        log("bind failed on $preferPort and ephemeral: $e2")
        return
      }
    }
    server = srv
    port = srv.localPort
    token = loadOrCreateToken()
    writeStateFile()
    running.set(true)
    val t = Thread {
      while (running.get()) {
        val client: Socket = try {
          srv.accept()
        } catch (e: Exception) {
          if (running.get()) { lastError = "accept failed: $e"; log("accept failed: $e") }
          break
        }
        Thread({ handleConnection(client) }, "cdp-relay-conn").start()
      }
    }
    t.name = "cdp-relay-accept"
    t.isDaemon = true
    t.start()
    log("relay up on 127.0.0.1:$port")
  }

  fun stop() {
    // BH-000045 (BUG-99): an in-process stop used to leave TWO armed things
    // behind: (a) relay.json still describing a "live" relay (pid == this
    // process, so hermes_boot's pid gate would arm BROWSER_CDP_URL on the
    // next boot against a relay that never answers), and (b) every live WS
    // tunnel (closing the server socket does NOT close accepted ones — the
    // pumps keep both legs alive until the page dies). Rewrite the state
    // file with pid:0 (stale by definition; the token stays — it is
    // deliberately stable per install) and close the tunnels.
    running.set(false)
    try { server?.close() } catch (_: Exception) {}
    server = null
    val tunnels = liveTunnels.size
    for ((_, tunnel) in liveTunnels) {
      try { tunnel.close() } catch (_: Exception) {}
    }
    liveTunnels.clear()
    // Guard: stop() can run before any start() (fresh process, RN calls stop
    // anyway) — stateFile() needs appContext, so only a relay that started
    // here rewrites its state file.
    if (appContext != null) writeStoppedStateFile()
    log("relay stopped ($tunnels tunnel(s) closed${if (appContext != null) ", state file pid:0" else ""})")
  }

  fun status(): Status =
    Status(running.get(), port, token.ifEmpty { null }, activeUrlPrefix, lastError)

  /** Called by BrowserRelayModule when the visible tab's URL changes. */
  fun setActiveUrl(url: String?) {
    activeUrlPrefix = url?.take(2048)
  }

  // ── Tab lifecycle round-trip (BUG-136) ───────────────────────────────────
  //
  // The RN tab store is the single owner of the tab strip; the relay ASKS it
  // to mutate: one "mochTabOp" event, then this handler thread blocks on a
  // CountDownLatch until BrowserRelayModule.tabOpAck lands (or the ~5 s
  // timeout expires → honest 504). The sink is installed by
  // BrowserRelayModule (it owns the ReactApplicationContext); a stale sink
  // after an RN reload throws inside emit, which surfaces as an honest 502.

  /** One in-flight tab op: the latch the HTTP handler waits on + its answer. */
  class TabOpAck internal constructor {
    internal val latch = CountDownLatch(1)
    @Volatile internal var ok = false
    @Volatile internal var error: String? = null
    internal fun resolve(ackOk: Boolean, ackError: String?) {
      ok = ackOk
      error = ackError
      latch.countDown()
    }
  }

  private val pendingTabOps = ConcurrentHashMap<String, TabOpAck>()

  /** Installed by BrowserRelayModule.init; emits (event, jsonPayload) to JS. */
  @Volatile private var tabOpSink: ((String, JSONObject) -> Unit)? = null

  fun setTabOpSink(sink: ((String, JSONObject) -> Unit)?) { tabOpSink = sink }

  /** RN ack (BrowserRelayModule.tabOpAck): resolve the op's latch. */
  fun tabOpAck(requestId: String, ok: Boolean, error: String?) {
    pendingTabOps.remove(requestId)?.resolve(ok, error)
  }

  // ── State file (read by moch/hermes_boot.py) ─────────────────────────────

  /**
   * Mirror of Python's `moch.hermes_boot._hermes_home()`: $HERMES_HOME env
   * override, else `$HOME/.hermes` where Chaquopy's HOME == app filesDir.
   * Keep the two in lockstep — a drift leaves BROWSER_CDP_URL unset
   * (feature off) rather than broken, but do drift it not.
   */
  private fun hermesHomeDir(): java.io.File {
    val env = System.getenv("HERMES_HOME")
    return if (!env.isNullOrBlank()) java.io.File(env) else java.io.File(appContext!!.filesDir, ".hermes")
  }

  private fun stateFile(): java.io.File {
    val dir = java.io.File(hermesHomeDir(), "browser")
    dir.mkdirs()
    return java.io.File(dir, "relay.json")
  }

  private fun loadOrCreateToken(): String {
    val f = stateFile()
    try {
      val existing = JSONObject(f.readText()).optString("token", "")
      if (existing.isNotEmpty()) return existing
    } catch (_: Exception) {}
    val fresh = UUID.randomUUID().toString().replace("-", "")
    try {
      f.writeText(JSONObject().put("token", fresh).toString())
    } catch (e: Exception) {
      lastError = "token persist failed: $e"
    }
    return fresh
  }

  private fun writeStateFile() {
    try {
      stateFile().writeText(
        JSONObject()
          .put("token", token)
          .put("port", port)
          .put("pid", android.os.Process.myPid())
          .toString(),
      )
    } catch (e: Exception) {
      lastError = "state write failed: $e"
    }
  }

  /**
   * BH-000045 (BUG-99): the stopped state file — same shape, pid forced to 0
   * so `moch/hermes_boot.py`'s pid gate (pid must equal getpid) treats it as
   * stale and never arms BROWSER_CDP_URL from a relay this process stopped.
   * The token is kept: it is deliberately stable per install.
   */
  private fun writeStoppedStateFile() {
    try {
      stateFile().writeText(
        JSONObject()
          .put("token", token)
          .put("port", port)
          .put("pid", 0)
          .toString(),
      )
    } catch (e: Exception) {
      lastError = "state write failed: $e"
    }
  }

  // ── Per-connection routing ───────────────────────────────────────────────

  private fun handleConnection(client: Socket) {
    try {
      client.soTimeout = 30_000
      client.tcpNoDelay = true
      val head = readHttpHead(client.getInputStream())
      val path = head.path.substringBefore('?')
      val query = head.path.substringAfter('?', "")
      val segs = path.trimStart('/').split('/')
      val out = client.getOutputStream()
      if (token.isEmpty() || segs.firstOrNull() != token) {
        writeSimpleResponse(out, 403, "forbidden")
        return
      }
      val inner = "/" + segs.drop(1).joinToString("/")
      var ws = false
      when {
        inner == "/json/version" && head.method == "GET" -> handleJsonVersion(out)
        (inner == "/json/list" || inner == "/json") && head.method == "GET" -> handleJsonList(out)
        inner == "/json/moch-tabs" && head.method == "GET" -> handleMochTabs(out)
        inner.startsWith("/json/new") || inner.startsWith("/json/close") ||
          inner.startsWith("/json/activate") -> handleTabLifecycle(out, head.method, inner, query)
        head.method == "GET" && inner.startsWith("/devtools/browser") -> {
          // No browser-level target exists upstream: tunnel the "browser" ws
          // to the ACTIVE page target's own socket (resolved NOW, per
          // connect — a later tab switch means a new supervisor connect).
          // The supervisor is told via Moch-Browser-Level:false to run
          // sessionless against it.
          val page = chosenPageJson()
          if (page == null) {
            writeSimpleResponse(out, 503, "no live page target (open the Moch browser screen)")
          } else {
            ws = true
            tunnelWebSocket(client, head, "/devtools/page/${page.optString("id", "")}", query)
          }
        }
        head.method == "GET" && inner.startsWith("/devtools/") -> { ws = true; tunnelWebSocket(client, head, inner, query) }
        else -> writeSimpleResponse(out, 404, "no route: $inner")
      }
      if (ws) return // tunnel owns the client socket from here
    } catch (e: Exception) {
      try { writeSimpleResponse(client.getOutputStream(), 400, "bad request: ${e.message}") } catch (_: Exception) {}
    }
    try { client.close() } catch (_: Exception) {}
  }

  // ── /json endpoints ──────────────────────────────────────────────────────

  /**
   * /json/version — truth from upstream (Browser/V8 versions), then the ws
   * URL rewritten into our tokenized browser path. `Moch-Browser-Level:
   * false` tells the supervisor this endpoint has NO browser-level target:
   * the /devtools/browser tunnel actually lands on the ACTIVE page target's
   * socket, so it must attach sessionless (BUILD-PLAN decision #3). Real
   * Chromium never sets this field, so the stock path stays stock.
   */
  private fun handleJsonVersion(out: OutputStream) {
    val upstream = fetchUpstreamBody("/json/version")
    val obj = try { JSONObject(upstream ?: "{}") } catch (_: Exception) { JSONObject() }
    if (obj.has("webSocketDebuggerUrl")) obj.remove("webSocketDebuggerUrl")
    obj.put("webSocketDebuggerUrl", "ws://127.0.0.1:$port/$token/devtools/browser")
    obj.put("Moch-Browser-Level", false)
    writeJsonResponse(out, obj)
  }

  /** /json/list — active-tab filter; at most ONE page target advertised. */
  private fun handleJsonList(out: OutputStream) {
    val body = chosenPageJson()?.let { JSONArray().put(it) } ?: JSONArray()
    writeJsonResponse(out, body)
  }

  /**
   * The ONE advertised page target: the WebView whose URL matches the
   * active URL when unambiguous, else the first. Null when none exist.
   */
  private fun chosenPageJson(): JSONObject? {
    val pages = upstreamPages().map { it.json }
    val prefix = activeUrlPrefix
    val chosen = if (!prefix.isNullOrEmpty()) {
      val matching = pages.filter { it.optString("url", "").startsWith(prefix) }
      matching.singleOrNull() ?: pages.firstOrNull()
    } else {
      pages.firstOrNull()
    } ?: return null
    chosen.put("webSocketDebuggerUrl", pageWsUrl(chosen.optString("id", "")))
    return chosen
  }

  // ── Upstream page list (shared by moch-tabs, the open-diff, the bridge) ──

  /** One upstream page target: its id, url and raw DevTools JSON. */
  private class UpstreamPage(val id: String, val url: String, val json: JSONObject)

  /** FULL (unfiltered) page-target list from upstream /json/list. */
  private fun upstreamPages(): List<UpstreamPage> {
    val body = fetchUpstreamBody("/json/list") ?: return emptyList()
    val arr = try { JSONArray(body) } catch (_: Exception) { return emptyList() }
    val pages = mutableListOf<UpstreamPage>()
    for (i in 0 until arr.length()) {
      val t = arr.optJSONObject(i) ?: continue
      if (t.optString("type", "page") != "page") continue
      val id = t.optString("id", "")
      if (id.isNotEmpty()) pages.add(UpstreamPage(id, t.optString("url", ""), t))
    }
    return pages
  }

  /** The hidden agent host page (see AGENT_TAB_URL_PREFIX). */
  private fun isHiddenAgentPage(url: String): Boolean = url.startsWith(AGENT_TAB_URL_PREFIX)

  /** The relay's own tokenized ws URL for a page target. */
  private fun pageWsUrl(id: String) = "ws://127.0.0.1:$port/$token/devtools/page/$id"

  /**
   * /json/moch-tabs — the FULL upstream page list, minus the hidden agent
   * host page, each with the relay's own ws URL (BUG-136; additive). The
   * classic /json/list stays active-tab-filtered — attach semantics depend
   * on that — while the tab tools need every tab's id/url/title to
   * list/close/switch them. Same data is exposed to the RN registry via
   * [tabTargets].
   */
  private fun handleMochTabs(out: OutputStream) {
    val arr = JSONArray()
    for (p in upstreamPages()) {
      if (isHiddenAgentPage(p.url)) continue
      p.json.put("webSocketDebuggerUrl", pageWsUrl(p.id))
      arr.put(p.json)
    }
    writeJsonResponse(out, arr)
  }

  /** The moch-tabs page list (same data as the endpoint) for the RN bridge. */
  fun tabTargets(): List<JSONObject> =
    upstreamPages().filter { !isHiddenAgentPage(it.url) }
      .map { it.json.put("webSocketDebuggerUrl", pageWsUrl(it.id)) }

  // ── /json/new|close|activate — the RN round-trip (BUG-136) ───────────────

  /**
   * Real tab lifecycle: forward the op to the RN tab owner and wait for the
   * ack. GET or PUT both accepted (Chrome ≥63 uses PUT on /json/new;
   * Python's _relay_lifecycle tries PUT first). Statuses: 200 on success —
   * the new page's DevTools JSON for open (the shape Chromium returns for
   * /json/new), "Target is closing"/"Target activated" text otherwise — 409
   * when the app refuses (unknown target, last-tab guard), 502 when the
   * event cannot reach JS, 504 when the ack never arrives. 400/405 for
   * malformed requests. The token gate has already run (router order).
   */
  private fun handleTabLifecycle(out: OutputStream, method: String, inner: String, query: String) {
    if (method != "GET" && method != "PUT") {
      writeSimpleResponse(out, 405, "method not allowed: use GET or PUT on $inner")
      return
    }
    val op: String
    var url: String? = null
    var targetId: String? = null
    when {
      inner.startsWith("/json/new") -> {
        op = "open"
        url = decodeRequestedUrl(query)
        if (url.isEmpty()) {
          writeSimpleResponse(out, 400, "/json/new needs the target url as its query string (/json/new?url=…)")
          return
        }
      }
      inner == "/json/close" || inner.startsWith("/json/close/") -> {
        op = "close"
        targetId = if (inner.length > "/json/close/".length) inner.removePrefix("/json/close/").trim() else ""
      }
      inner == "/json/activate" || inner.startsWith("/json/activate/") -> {
        op = "activate"
        targetId = if (inner.length > "/json/activate/".length) inner.removePrefix("/json/activate/").trim() else ""
      }
      else -> { writeSimpleResponse(out, 404, "no route: $inner"); return }
    }
    if (targetId != null && targetId.isEmpty()) {
      writeSimpleResponse(out, 400, "/json/$op needs a target id: /json/$op/<id>")
      return
    }

    val sink = tabOpSink
    if (sink == null) {
      writeSimpleResponse(out, 503, "tab lifecycle unavailable: the app's Browser relay module is not loaded (restart Moch)")
      return
    }

    val requestId = UUID.randomUUID().toString()
    val payload = JSONObject().put("requestId", requestId).put("op", op)
    if (url != null) payload.put("url", url)
    if (targetId != null) payload.put("targetId", targetId)

    // Snapshot BEFORE the op so the open-diff sees exactly what the op added
    // (a concurrent user-opened tab is disambiguated by the URL match).
    val beforeIds = if (op == "open") upstreamPages().map { it.id }.toSet() else emptySet()

    val ack = TabOpAck()
    pendingTabOps[requestId] = ack
    try {
      sink(TAB_OP_EVENT, payload)
    } catch (e: Exception) {
      pendingTabOps.remove(requestId)
      lastError = "tab op emit failed: $e"
      writeSimpleResponse(out, 502, "tab op '$op' never reached the app UI (${e.message ?: e.javaClass.simpleName}) — is Moch running?")
      return
    }
    if (!ack.latch.await(TAB_OP_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      pendingTabOps.remove(requestId)
      writeSimpleResponse(out, 504, "tab op '$op' timed out: the Moch UI did not acknowledge within ${TAB_OP_ACK_TIMEOUT_MS / 1000}s")
      return
    }
    if (!ack.ok) {
      writeSimpleResponse(out, 409, ack.error ?: "tab op '$op' refused by the Moch tab strip")
      return
    }
    when (op) {
      "open" -> resolveOpenedPage(out, url!!, beforeIds)
      "close" -> writeSimpleResponse(out, 200, "Target is closing")
      else -> writeSimpleResponse(out, 200, "Target activated")
    }
  }

  /** The URL a /json/new wants: the whole query (Chromium's classic shape),
   *  optionally `url=`-prefixed, percent-decoded ONCE (Python sends it
   *  quoted with :/?&= safe, so a literal % in the url arrives as %25). */
  private fun decodeRequestedUrl(query: String): String {
    val raw = if (query.startsWith("url=")) query.substring(4) else query
    return try { android.net.Uri.decode(raw) } catch (_: Exception) { raw }
  }

  /**
   * Resolve the just-opened page: RN added the store tab at ack time, the
   * WebView and its DevTools target follow a render later — poll the
   * upstream diff (≤ ~3 s) for a FRESH page serving `url`. Responds with
   * that page's DevTools JSON (ws URL rewritten), or an honest 502 when no
   * target shows up (e.g. the Browser screen is closed: the tab IS in the
   * RN strip, but nothing mounts a WebView for it until the screen opens).
   */
  private fun resolveOpenedPage(out: OutputStream, url: String, beforeIds: Set<String>) {
    val deadlineMs = System.currentTimeMillis() + TAB_OPEN_RESOLVE_TIMEOUT_MS
    var freshLoading: JSONObject? = null
    while (true) {
      val fresh = upstreamPages()
        .filter { it.id !in beforeIds && !isHiddenAgentPage(it.url) }
      val match = fresh.firstOrNull { pageServesUrl(it.url, url) }?.json
      if (match != null) {
        match.put("webSocketDebuggerUrl", pageWsUrl(match.optString("id", "")))
        writeJsonResponse(out, match)
        return
      }
      // A brand-new WebView can sit at about:blank for a beat before its
      // first navigation commits — remember a lone such target as fallback.
      freshLoading = fresh.singleOrNull { it.url.isEmpty() || it.url == "about:blank" }?.json ?: freshLoading
      if (System.currentTimeMillis() >= deadlineMs) break
      Thread.sleep(250)
    }
    freshLoading?.let {
      it.put("webSocketDebuggerUrl", pageWsUrl(it.optString("id", "")))
      writeJsonResponse(out, it)
      return
    }
    writeSimpleResponse(
      out, 502,
      "tab added to the Moch Browser strip, but no WebView DevTools target for $url appeared within " +
        "${TAB_OPEN_RESOLVE_TIMEOUT_MS / 1000}s (the Browser screen may be closed — open it and the tab is there)",
    )
  }

  /** URL match tolerant of trailing-slash and pre-redirect drift. */
  private fun pageServesUrl(pageUrl: String, wanted: String): Boolean {
    if (pageUrl.isEmpty() || wanted.isEmpty()) return false
    val p = pageUrl.trimEnd('/')
    val w = wanted.trimEnd('/')
    return p == w || p.startsWith("$w/") || w.startsWith("$p/")
  }

  /** Fresh LocalSocket per request — see class doc for why. */
  private fun fetchUpstreamBody(path: String): String? {
    val sock = connectUpstream() ?: return null
    try {
      sock.soTimeout = 10_000
      val req = "GET $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
      sock.outputStream.write(req.toByteArray(StandardCharsets.ISO_8859_1))
      sock.outputStream.flush()
      return readHttpBody(sock.inputStream)
    } catch (e: Exception) {
      lastError = "upstream $path failed: $e"
      log("upstream $path failed: $e")
      return null
    } finally {
      try { sock.close() } catch (_: Exception) {}
    }
  }

  private fun connectUpstream(): LocalSocket? {
    return try {
      val s = LocalSocket()
      s.connect(
        LocalSocketAddress(
          "webview_devtools_remote_${android.os.Process.myPid()}",
          LocalSocketAddress.Namespace.ABSTRACT,
        ),
      )
      s
    } catch (e: Exception) {
      lastError = "no devtools socket: $e"
      null
    }
  }

  // ── WebSocket tunnel ─────────────────────────────────────────────────────

  /**
   * Forward the client's ACTUAL upgrade request (preserving its
   * Sec-WebSocket-Key — the upstream computes the accept hash from it) with
   * only the path rewritten; pass the 101 back verbatim; pump bytes.
   * `head` was already parsed by the router — never re-read here.
   */
  private fun tunnelWebSocket(client: Socket, head: ParsedHead, innerPath: String, query: String) {
    val fullTarget = if (query.isEmpty()) innerPath else "$innerPath?$query"
    val upstream = connectUpstream() ?: run {
      writeSimpleResponse(client.getOutputStream(), 502, "no devtools socket")
      try { client.close() } catch (_: Exception) {}
      return
    }
    try {
      client.soTimeout = 0 // tunnels live as long as the page does
      upstream.soTimeout = 0
      val req = StringBuilder("GET $fullTarget HTTP/1.1\r\n")
      for ((k, v) in head.headers) {
        if (k == "host") continue // upstream wants localhost, not our port
        req.append(k.replaceFirstChar { it.uppercase() }).append(": ").append(v).append("\r\n")
      }
      req.append("Host: localhost\r\n\r\n")
      upstream.outputStream.write(req.toString().toByteArray(StandardCharsets.ISO_8859_1))
      upstream.outputStream.flush()

      val respHead = readUntilDoubleCrlf(upstream.inputStream)
      client.getOutputStream().write(respHead)
      client.getOutputStream().flush()
      if (!String(respHead, StandardCharsets.ISO_8859_1).startsWith("HTTP/1.1 101")) {
        // Upgrade refused (no such target, browser-level path absent…).
        try { client.close() } catch (_: Exception) {}
        try { upstream.close() } catch (_: Exception) {}
        return
      }

      // BH-000045: this tunnel is now live — register the client leg so
      // stop() can close it (see liveTunnels).
      val tunnelId = "t${tunnelSeq.incrementAndGet()}"
      liveTunnels[tunnelId] = client

      val cin = client.getInputStream()
      val uout = upstream.outputStream
      val uin = upstream.inputStream
      val cout = client.getOutputStream()
      val done = AtomicBoolean(false)
      val closeBoth = Runnable {
        done.set(true)
        liveTunnels.remove(tunnelId)
        try { client.close() } catch (_: Exception) {}
        try { upstream.close() } catch (_: Exception) {}
      }
      fun pump(src: InputStream, dst: OutputStream, name: String): Thread = Thread {
        try {
          val buf = ByteArray(PUMP_CHUNK)
          while (!done.get()) {
            val n = src.read(buf)
            if (n < 0) break
            dst.write(buf, 0, n)
            dst.flush()
          }
        } catch (_: Exception) {
        } finally {
          closeBoth.run()
          log("tunnel $name closed")
        }
      }
      val c2u = pump(cin, uout, "c2u").apply { name = "cdp-pump-c2u"; isDaemon = true; start() }
      val u2c = pump(uin, cout, "u2c").apply { name = "cdp-pump-u2c"; isDaemon = true; start() }
      // This handler thread parks until the tunnel dies; the accept loop
      // keeps accepting meanwhile.
      c2u.join()
      u2c.interrupt()
    } catch (e: Exception) {
      lastError = "tunnel failed: $e"
      log("tunnel failed: $e")
      try { client.close() } catch (_: Exception) {}
      try { upstream.close() } catch (_: Exception) {}
    }
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private class ParsedHead(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
  )

  private fun readHttpHead(input: InputStream): ParsedHead {
    val requestLine = readLineAscii(input) ?: throw EOFException("empty request")
    if (requestLine.length > MAX_LINE) throw EOFException("request line too long")
    val parts = requestLine.split(" ")
    if (parts.size < 3) throw EOFException("malformed request line: $requestLine")
    var total = requestLine.length
    val headers = mutableMapOf<String, String>()
    while (true) {
      val line = readLineAscii(input) ?: break
      if (line.isEmpty()) break
      total += line.length
      if (total > MAX_HEADERS) throw EOFException("headers too large")
      val idx = line.indexOf(':')
      if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
    }
    // Bodies: /json routes never POST here; upgrade requests have none.
    return ParsedHead(parts[0], parts[1], headers)
  }

  /** One full HTTP response body from DevTools (Content-Length or to-EOF). */
  private fun readHttpBody(input: InputStream): String {
    val head = readUntilDoubleCrlf(input)
    val text = String(head, StandardCharsets.ISO_8859_1)
    val cl = Regex("(?i)content-length:\\s*(\\d+)").find(text)?.groupValues?.get(1)?.toIntOrNull() ?: -1
    val body = if (cl >= 0) {
      val buf = ByteArray(cl)
      var off = 0
      while (off < cl) {
        val n = input.read(buf, off, cl - off)
        if (n < 0) break
        off += n
      }
      buf.copyOf(off)
    } else {
      input.readBytes() // Connection: close — read to EOF
    }
    return String(body, StandardCharsets.UTF_8)
  }

  /** Bytes up to and including the first \r\n\r\n. */
  private fun readUntilDoubleCrlf(input: InputStream): ByteArray {
    val buf = ByteArrayOutputStream(1024)
    var prev = 0
    while (true) {
      val cur = input.read()
      if (cur == -1) break
      buf.write(cur)
      if (prev == '\r'.code.toInt() && cur == '\n'.code.toInt()) {
        val bytes = buf.toByteArray()
        if (bytes.size >= 4 && bytes.copyOfRange(bytes.size - 4, bytes.size)
            .contentEquals(byteArrayOf(13, 10, 13, 10))
        ) return bytes
      }
      prev = cur
      if (buf.size() > MAX_HEADERS) throw EOFException("response head too large")
    }
    return buf.toByteArray()
  }

  private fun readLineAscii(input: InputStream): String? {
    val sb = StringBuilder(80)
    while (true) {
      val b = input.read()
      if (b == -1) return if (sb.isEmpty()) null else sb.toString()
      if (b == '\n'.code.toInt()) {
        if (sb.isNotEmpty() && sb[sb.length - 1] == '\r') sb.setLength(sb.length - 1)
        return sb.toString()
      }
      sb.append(b.toChar())
      if (sb.length > MAX_LINE) throw EOFException("line too long")
    }
  }

  private fun writeJsonResponse(out: OutputStream, obj: JSONObject) {
    val body = obj.toString().toByteArray(StandardCharsets.UTF_8)
    val head = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n" +
      "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
    out.write(head.toByteArray(StandardCharsets.ISO_8859_1))
    out.write(body)
    out.flush()
  }

  private fun writeJsonResponse(out: OutputStream, arr: JSONArray) {
    val body = arr.toString().toByteArray(StandardCharsets.UTF_8)
    val head = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n" +
      "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
    out.write(head.toByteArray(StandardCharsets.ISO_8859_1))
    out.write(body)
    out.flush()
  }

  private fun writeSimpleResponse(out: OutputStream, code: Int, message: String) {
    val body = message.toByteArray(StandardCharsets.UTF_8)
    val head = "HTTP/1.1 $code ${reasonFor(code)}\r\nContent-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
    out.write(head.toByteArray(StandardCharsets.ISO_8859_1))
    out.write(body)
    out.flush()
  }

  private fun reasonFor(code: Int): String = when (code) {
    200 -> "OK"
    400 -> "Bad Request"
    403 -> "Forbidden"
    404 -> "Not Found"
    405 -> "Method Not Allowed"
    409 -> "Conflict"
    502 -> "Bad Gateway"
    503 -> "Service Unavailable"
    504 -> "Gateway Timeout"
    else -> "Error"
  }

  private fun log(msg: String) = Log.i(TAG, msg)
}
