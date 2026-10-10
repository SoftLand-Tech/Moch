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
 * so a filtered list makes it land on the tab the user is looking at. Tab
 * creation/activation is RN-owned (`/json/new|close|activate` → 405).
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

  data class Status(
    val running: Boolean,
    val port: Int,
    val token: String?,
    val activeUrlPrefix: String?,
    val lastError: String?,
  )

  private val running = AtomicBoolean(false)
  private var server: ServerSocket? = null

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
    try {
      srv.reuseAddress = true
      srv.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), preferPort), 16)
    } catch (e: Exception) {
      try {
        srv.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16)
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
    running.set(false)
    try { server?.close() } catch (_: Exception) {}
    server = null
    log("relay stopped")
  }

  fun status(): Status =
    Status(running.get(), port, token.ifEmpty { null }, activeUrlPrefix, lastError)

  /** Called by BrowserRelayModule when the visible tab's URL changes. */
  fun setActiveUrl(url: String?) {
    activeUrlPrefix = url?.take(2048)
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
        inner.startsWith("/json/new") || inner.startsWith("/json/close") ||
          inner.startsWith("/json/activate") ->
          writeSimpleResponse(out, 405, "tab lifecycle is native-owned in Moch")
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
    val body = fetchUpstreamBody("/json/list") ?: return null
    val arr = try { JSONArray(body) } catch (_: Exception) { return null }
    val pages = mutableListOf<JSONObject>()
    for (i in 0 until arr.length()) {
      val t = arr.optJSONObject(i) ?: continue
      if (t.optString("type", "page") == "page") pages.add(t)
    }
    val prefix = activeUrlPrefix
    val chosen = if (!prefix.isNullOrEmpty()) {
      val matching = pages.filter { it.optString("url", "").startsWith(prefix) }
      matching.singleOrNull() ?: pages.firstOrNull()
    } else {
      pages.firstOrNull()
    } ?: return null
    chosen.put(
      "webSocketDebuggerUrl",
      "ws://127.0.0.1:$port/$token/devtools/page/${chosen.optString("id", "")}",
    )
    return chosen
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

      val cin = client.getInputStream()
      val uout = upstream.outputStream
      val uin = upstream.inputStream
      val cout = client.getOutputStream()
      val done = AtomicBoolean(false)
      val closeBoth = Runnable {
        done.set(true)
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
    502 -> "Bad Gateway"
    else -> "Error"
  }

  private fun log(msg: String) = Log.i(TAG, msg)
}
