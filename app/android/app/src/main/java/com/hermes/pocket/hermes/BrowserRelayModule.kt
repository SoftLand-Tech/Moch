package com.hermes.pocket.hermes

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

/**
 * RN surface of the WebView CDP relay (BUILD-PLAN.md).
 *
 * Typed promise methods + one map-returning status probe, mirroring the
 * HermesBridgeModule contract (JS polls or calls on demand) — plus the ONE
 * exception, BUG-136's outbound "mochTabOp" event (the relay round-trips
 * /json/new|close|activate to the RN tab owner; JS acks via [tabOpAck]).
 *
 * - [ensureRunning] starts the relay if needed and resolves with the full
 *   state (running/port/token/lastError) so JS can render real status and
 *   display a rich error when WebView debugging is off.
 * - [setActiveUrl] feeds the relay's active-tab filter; called by the
 *   Browser screen's onNavigationStateChange / onLoadEnd.
 * - [setWebDebugEnabled] is the explicit, user-visible opt-in switch for
 *   `WebView.setWebContentsDebuggingEnabled` — process-wide, so it lives
 *   behind the Browser screen's own enable flow, not Application.onCreate.
 */
class BrowserRelayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "BrowserRelay"

  /**
   * BH-000045 (BUG-99): bumped by [stop] so any in-flight gate-arm retry
   * loop from [ensureRunning] (up to 120 s of 1 s ticks waiting for Python)
   * exits instead of re-activating a relay this process just stopped. The
   * pre-activate check closes the common (sleeping-tick) race; an activate
   * that began mid-call is ordered after by the stop thread's own
   * deactivate, which runs last by construction.
   */
  private val relayGeneration = java.util.concurrent.atomic.AtomicInteger(0)

  init {
    // BUG-136: /json/new|close|activate round-trip to the RN tab owner —
    // install the relay's emitter sink at module creation. A React reload
    // constructs a fresh module (and thus re-installs over the stale sink);
    // emitting through a destroyed catalyst context throws inside CdpRelay's
    // handler, which answers with an honest 502 instead of hanging.
    CdpRelay.setTabOpSink { event, payload -> emitToJs(event, payload) }
  }

  /** Emit one relay event to JS (payload is all-strings by construction). */
  private fun emitToJs(event: String, payload: JSONObject) {
    val map = Arguments.createMap()
    for (key in payload.keys()) map.putString(key, payload.optString(key))
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, map)
  }

  @ReactMethod
  fun ensureRunning(preferPort: Int, promise: Promise) {
    Thread {
      try {
        if (!CdpRelay.status().running) CdpRelay.start(reactApplicationContext, preferPort)
        val s = CdpRelay.status()
        if (s.running) {
          // BUG-132: on a cold app start this runs while the hermes Python is
          // still booting (the AgentBrowserHost mounts long before the gateway
          // finishes importing), so the one-shot activate threw, the promise
          // rejected, and the browser tools stayed hidden for the WHOLE run —
          // the exact "new chats have no browser tools" report. The relay is
          // already up at this point, so arm it on a retry loop instead: keep
          // trying until Python is started and acknowledges, regardless of
          // boot order. The promise resolves immediately — the caller only
          // needs the relay state.
          promise.resolve(statusMap())
          // First-boot-after-install cold starts can take >60 s to reach a
          // started Python; a fixed 30 s window exhausted on exactly those
          // boots (observed on device). Poll cheaply instead: 1 s ticks, up
          // to 120 s, arming the moment Python exists.
          val gen = relayGeneration.get()
          var armed = false
          var ticks = 0
          while (ticks < 120 && relayGeneration.get() == gen) {
            ticks++
            if (com.chaquo.python.Python.isStarted()) {
              try {
                com.chaquo.python.Python.getInstance()
                  .getModule("moch.browser_gate")
                  .callAttr("activate", s.port, s.token)
                armed = true
                break
              } catch (e: Throwable) {
                // Python started but the module import raced the boot — retry.
              }
            }
            Thread.sleep(1000)
          }
          android.util.Log.i("MochBrowserRelay", "gate arm retry: armed=$armed ticks=$ticks pid=${android.os.Process.myPid()}")
        } else {
          promise.resolve(statusMap())
        }
      } catch (e: Exception) {
        promise.reject("cdp_relay_start", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun stop(promise: Promise) {
    // BH-000045 (BUG-99): a stop used to leave the Python-side gate ARMED
    // (BROWSER_CDP_URL/MOCH_BROWSER_RELAY set, tools advertised) against a
    // relay that would never answer — every browser tool then died as "No
    // browser page…". Same thread shape as ensureRunning: the relay stops,
    // then (when Python is up) moch.browser_gate.deactivate clears the env
    // gates + tool caches, and ONLY THEN does the promise resolve — a
    // follow-up ensureRunning can never race a still-pending deactivate.
    Thread {
      try {
        val s = CdpRelay.status()
        relayGeneration.incrementAndGet() // kill in-flight gate-arm loops first
        CdpRelay.stop() // also rewrites relay.json with pid:0 + closes tunnels
        if (com.chaquo.python.Python.isStarted()) {
          try {
            com.chaquo.python.Python.getInstance()
              .getModule("moch.browser_gate")
              .callAttr("deactivate", s.port, s.token)
            android.util.Log.i("MochBrowserRelay", "gate deactivated (port=${s.port})")
          } catch (e: Throwable) {
            android.util.Log.w("MochBrowserRelay", "gate deactivate failed: $e")
          }
        }
        promise.resolve(statusMap())
      } catch (e: Exception) {
        promise.reject("cdp_relay_stop", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun status(promise: Promise) {
    try {
      promise.resolve(statusMap())
    } catch (e: Exception) {
      promise.reject("cdp_relay_status", e.message, e)
    }
  }

  /** Sync the visible tab URL into the relay's active-tab filter. */
  @ReactMethod
  fun setActiveUrl(url: String?, promise: Promise) {
    try {
      CdpRelay.setActiveUrl(url)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("cdp_relay_active_url", e.message, e)
    }
  }

  /**
   * Process-wide WebView debugging switch. Guarded: only flips when
   * [enabled] differs from the cached state, so remounts don't spam it.
   * The DevTools socket only exists while this is on — the relay's upstream
   * connect fails with "no devtools socket" otherwise (surfaced via
   * [statusMap].lastError).
   */
  @ReactMethod
  fun setWebDebugEnabled(enabled: Boolean, promise: Promise) {
    // WebView.setWebContentsDebuggingEnabled MUST run on the UI thread
    // (throws "Toggling of Web Contents Debugging must be done on the UI
    // thread" otherwise — found on device, 1.0.11-browser).
    com.facebook.react.bridge.UiThreadUtil.runOnUiThread {
      try {
        if (debugEnabled != enabled) {
          android.webkit.WebView.setWebContentsDebuggingEnabled(enabled)
          debugEnabled = enabled
        }
        promise.resolve(debugEnabled)
      } catch (e: Exception) {
        promise.reject("webview_debug", e.message, e)
      }
    }
  }

  private var debugEnabled: Boolean = false

  /**
   * RN ack for a "mochTabOp" round-trip (BUG-136): the store op ran in JS
   * (browserRelay.ts); resolve the relay's CountDownLatch so the waiting
   * /json/new|close|activate handler can answer. Fire-and-forget — the relay
   * already bounds the wait with its own timeout.
   */
  @ReactMethod
  fun tabOpAck(requestId: String, ok: Boolean, error: String?) {
    CdpRelay.tabOpAck(requestId, ok, error)
  }

  /**
   * The relay's FULL upstream page list (the /json/moch-tabs data: every
   * WebView page with id/url/title, hidden agent host page filtered out) —
   * the JS tab⇔target registry maps store tabs to DevTools targetIds with it.
   */
  @ReactMethod
  fun tabTargets(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (page in CdpRelay.tabTargets()) {
        val m = Arguments.createMap()
        m.putString("id", page.optString("id", ""))
        m.putString("url", page.optString("url", ""))
        m.putString("title", page.optString("title", ""))
        arr.pushMap(m)
      }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject("cdp_relay_tab_targets", e.message, e)
    }
  }

  private fun statusMap(): WritableMap {
    val s = CdpRelay.status()
    val map = Arguments.createMap()
    map.putBoolean("running", s.running)
    map.putInt("port", s.port)
    map.putString("token", s.token)
    map.putString("activeUrlPrefix", s.activeUrlPrefix)
    map.putString("lastError", s.lastError)
    map.putBoolean("webDebugEnabled", debugEnabled)
    return map
  }
}
