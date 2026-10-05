package com.hermes.pocket.hermes

import android.content.Context
import android.util.Log
import com.chaquo.python.PyException
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lifecycle owner for the embedded Hermes agent runtime.
 *
 * Milestone 1 boots the bundled CPython (Chaquopy) on a background thread and
 * runs moch.bootstrap.selftest() to prove the interpreter is alive; the agent
 * itself attaches to the same start() entry point in Milestone 2+. Python
 * startup is hundreds of milliseconds under the GIL — never call this from the
 * UI or JS thread.
 */
object HermesRuntime {
  private const val TAG = "MochHermes"
  private val bootAttempted = AtomicBoolean(false)

  val isRunning: Boolean
    get() = Python.isStarted()

  /** Idempotent; safe to call from Application.onCreate. */
  fun start(context: Context) {
    if (!bootAttempted.compareAndSet(false, true)) return
    val appContext = context.applicationContext
    Thread(
        {
          try {
            if (!Python.isStarted()) Python.start(AndroidPlatform(appContext))
            val info = Python.getInstance().getModule("moch.bootstrap").callAttr("selftest")
            Log.i(TAG, "python alive: $info")
            val boot = Python.getInstance().getModule("moch.hermes_boot").callAttr("boot")
            Log.i(TAG, "hermes boot: $boot")
          } catch (e: PyException) {
            Log.e(TAG, "python boot failed", e)
          } catch (e: RuntimeException) {
            Log.e(TAG, "runtime boot failed", e)
          }
        },
        "moch-hermes-boot",
    )
        .apply { isDaemon = false }
        .start()
  }

  fun status(): Map<String, Any?> {
    val running = isRunning
    var version: String? = null
    var hermesVersion: String? = null
    if (running) {
      try {
        version = Python.getInstance().getModule("moch.bootstrap").callAttr("python_version").toString()
        hermesVersion =
            Python.getInstance().getModule("moch.hermes_boot").callAttr("version").toString()
      } catch (e: PyException) {
        Log.w(TAG, "status probe failed", e)
      }
    }
    return mapOf("running" to running, "pythonVersion" to version, "hermesVersion" to hermesVersion)
  }
}
