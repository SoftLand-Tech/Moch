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
}
