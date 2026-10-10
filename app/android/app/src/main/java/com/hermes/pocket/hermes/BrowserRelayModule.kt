package com.hermes.pocket.hermes

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/**
 * RN surface of the WebView CDP relay (BUILD-PLAN.md).
 *
 * Typed promise methods + one map-returning status probe, mirroring the
 * HermesBridgeModule contract (no emitters; JS polls or calls on demand).
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

  @ReactMethod
  fun ensureRunning(preferPort: Int, promise: Promise) {
    Thread {
      try {
        if (!CdpRelay.status().running) CdpRelay.start(reactApplicationContext, preferPort)
        val s = CdpRelay.status()
        if (s.running) {
          // Tell the RUNNING hermes process now — relay.json alone only helps
          // at next boot, and the agent must see the browser tools this
          // session (the user opens the Browser screen after gateway boot).
          val py = com.chaquo.python.Python.getInstance()
          py.getModule("moch.browser_gate").callAttr("activate", s.port, s.token)
        }
        promise.resolve(statusMap())
      } catch (e: Exception) {
        promise.reject("cdp_relay_start", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      CdpRelay.stop()
      promise.resolve(statusMap())
    } catch (e: Exception) {
      promise.reject("cdp_relay_stop", e.message, e)
    }
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
