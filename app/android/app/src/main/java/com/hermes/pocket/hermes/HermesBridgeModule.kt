package com.hermes.pocket.hermes

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * React Native surface of the embedded Hermes runtime.
 *
 * Milestone 1 exposes read-only status; lifecycle (start/stop/restart) and the
 * JSON-RPC frame channel with streaming events grow here from Milestone 3.
 * Never expose raw Python eval or shell passthroughs through this module —
 * the bridge contract is typed methods plus events, nothing more.
 */
class HermesBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "HermesBridge"

  @ReactMethod
  fun status(promise: Promise) {
    val status = HermesRuntime.status()
    val result = Arguments.createMap()
    result.putBoolean("running", status["running"] as Boolean)
    result.putString("pythonVersion", status["pythonVersion"] as String?)
    result.putString("hermesVersion", status["hermesVersion"] as String?)
    promise.resolve(result)
  }

  @ReactMethod
  fun getGateway(promise: Promise) {
    val raw = HermesRuntime.gatewayInfoJson()
    if (raw == null) {
      promise.resolve(null)
      return
    }
    try {
      val obj = org.json.JSONObject(raw)
      val result = Arguments.createMap()
      for (key in obj.keys()) {
        when (val v = obj.get(key)) {
          is Boolean -> result.putBoolean(key, v)
          is Int -> result.putInt(key, v)
          is String -> result.putString(key, v)
          else -> result.putString(key, if (v == org.json.JSONObject.NULL) null else v.toString())
        }
      }
      promise.resolve(result)
    } catch (e: org.json.JSONException) {
      promise.reject("gateway_info", "bad gateway json", e)
    }
  }

  /** User-controlled teardown of the background runtime (M6). */
  @ReactMethod
  fun stop(promise: Promise) {
    try {
      HermesService.stop(reactApplicationContext)
      promise.resolve(true)
    } catch (e: RuntimeException) {
      promise.reject("hermes_stop", e)
    }
  }

  /** True runtime restart (M6): fresh process = fresh CPython + gateway. */
  @ReactMethod
  fun restart(promise: Promise) {
    try {
      HermesService.restartApp(reactApplicationContext)
      promise.resolve(true)
    } catch (e: RuntimeException) {
      promise.reject("hermes_restart", e)
    }
  }

  /** Opt-in battery-optimization exemption dialog (sanctioned system flow). */
  @ReactMethod
  fun requestBatteryExemption(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val pm = ctx.getSystemService(android.os.PowerManager::class.java)
      if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
        promise.resolve("already")
        return
      }
      val intent =
          android.content.Intent(
              android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              android.net.Uri.parse("package:${ctx.packageName}"))
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve("requested")
    } catch (e: RuntimeException) {
      promise.reject("hermes_battery", e)
    }
  }

  /** Moch Linux (M7.5): bootstrap, exec, status. */
  @ReactMethod
  fun linuxBootstrap(distro: String, promise: Promise) {
    Thread {
      try {
        val py = com.chaquo.python.Python.getInstance()
        val result = py.getModule("moch.linux_env").callAttr("bootstrap", distro).toString()
        val obj = org.json.JSONObject(result)
        val map = Arguments.createMap()
        map.putBoolean("ok", obj.optBoolean("ok", false))
        map.putString("steps", obj.optJSONArray("steps")?.toString() ?: "[]")
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("linux_bootstrap", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun linuxExec(command: String, promise: Promise) {
    Thread {
      try {
        val py = com.chaquo.python.Python.getInstance()
        val result = py.getModule("moch.linux_env").callAttr("exec_in_guest", command).toString()
        val obj = org.json.JSONObject(result)
        val map = Arguments.createMap()
        map.putBoolean("ok", obj.optBoolean("ok", false))
        map.putString("stdout", obj.optString("stdout", ""))
        map.putString("stderr", obj.optString("stderr", ""))
        map.putString("error", obj.optString("error", ""))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("linux_exec", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun linuxStatus(promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.linux_env").callAttr("status").toString()
      val obj = org.json.JSONObject(result)
      val map = Arguments.createMap()
      map.putBoolean("bootstrapped", obj.optBoolean("bootstrapped", false))
      map.putDouble("sizeMb", obj.optDouble("size_mb", 0.0))
      map.putString("distro", obj.optString("distro", ""))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("linux_status", e.message, e)
    }
  }

  /**
   * Uncached status (walk=True): recomputes size_mb by stat()ing the whole
   * rootfs — seconds of GIL-hot Python. Install-wizard progress only; the
   * Settings poll uses the cached [linuxStatus]. Threaded like linuxExec so
   * the walk never occupies the native-module call path.
   */
  @ReactMethod
  fun linuxStatusLive(promise: Promise) {
    Thread {
      try {
        val py = com.chaquo.python.Python.getInstance()
        val result = py.getModule("moch.linux_env").callAttr("status", true).toString()
        val obj = org.json.JSONObject(result)
        val map = Arguments.createMap()
        map.putBoolean("bootstrapped", obj.optBoolean("bootstrapped", false))
        map.putDouble("sizeMb", obj.optDouble("size_mb", 0.0))
        map.putString("distro", obj.optString("distro", ""))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("linux_status_live", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun linuxReset(promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.linux_env").callAttr("reset").toString()
      val obj = org.json.JSONObject(result)
      promise.resolve(obj.optBoolean("ok", false))
    } catch (e: Exception) {
      promise.reject("linux_reset", e.message, e)
    }
  }

  /**
   * Interactive guest terminal (M9) — JS polls linuxTermDrain on a timer
   * while the terminal screen is mounted, so the bridge stays promise-only
   * (no native event emitter; same threading shape as linuxExec).
   */
  @ReactMethod
  fun linuxTermProbe(promise: Promise) {
    Thread {
      try {
        val py = com.chaquo.python.Python.getInstance()
        val result = py.getModule("moch.terminal").callAttr("probe").toString()
        val obj = org.json.JSONObject(result)
        val map = Arguments.createMap()
        map.putBoolean("pty", obj.optBoolean("pty", false))
        map.putBoolean("guest", obj.optBoolean("guest", false))
        map.putBoolean("shell", obj.optBoolean("shell", false))
        if (obj.has("error")) map.putString("error", obj.optString("error"))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("linux_term_probe", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun linuxTermStart(cols: Int, rows: Int, promise: Promise) {
    Thread {
      try {
        val py = com.chaquo.python.Python.getInstance()
        val result = py.getModule("moch.terminal").callAttr("start", cols, rows).toString()
        val obj = org.json.JSONObject(result)
        val map = Arguments.createMap()
        map.putBoolean("ok", obj.optBoolean("ok", false))
        map.putBoolean("alreadyRunning", obj.optBoolean("already_running", false))
        if (obj.has("error")) map.putString("error", obj.optString("error"))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("linux_term_start", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun linuxTermWrite(dataB64: String, promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.terminal").callAttr("write", dataB64).toString()
      val obj = org.json.JSONObject(result)
      if (obj.optBoolean("ok", false)) promise.resolve(true)
      else promise.reject("linux_term_write", obj.optString("error", "write failed"))
    } catch (e: Exception) {
      promise.reject("linux_term_write", e.message, e)
    }
  }

  @ReactMethod
  fun linuxTermDrain(promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.terminal").callAttr("drain").toString()
      val obj = org.json.JSONObject(result)
      val map = Arguments.createMap()
      val arr = Arguments.createArray()
      val raw = obj.optJSONArray("chunks")
      if (raw != null) {
        for (i in 0 until raw.length()) arr.pushString(raw.optString(i))
      }
      map.putArray("chunks", arr)
      map.putBoolean("alive", obj.optBoolean("alive", false))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("linux_term_drain", e.message, e)
    }
  }

  @ReactMethod
  fun linuxTermReplay(promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.terminal").callAttr("replay").toString()
      val obj = org.json.JSONObject(result)
      val map = Arguments.createMap()
      map.putString("chunk", obj.optString("chunk", ""))
      map.putBoolean("alive", obj.optBoolean("alive", false))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("linux_term_replay", e.message, e)
    }
  }

  @ReactMethod
  fun linuxTermResize(cols: Int, rows: Int, promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      py.getModule("moch.terminal").callAttr("resize", cols, rows)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("linux_term_resize", e.message, e)
    }
  }

  @ReactMethod
  fun linuxTermKill(promise: Promise) {
    try {
      val py = com.chaquo.python.Python.getInstance()
      val result = py.getModule("moch.terminal").callAttr("kill").toString()
      val obj = org.json.JSONObject(result)
      promise.resolve(obj.optBoolean("ok", false))
    } catch (e: Exception) {
      promise.reject("linux_term_kill", e.message, e)
    }
  }
}
