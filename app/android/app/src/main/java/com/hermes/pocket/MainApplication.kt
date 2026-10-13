package com.hermes.pocket

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.hermes.pocket.hermes.BrowserRelayPackage
import com.hermes.pocket.hermes.HermesBridgePackage
import com.hermes.pocket.hermes.HermesRuntime
import com.hermes.pocket.hermes.MochLogs
import com.hermes.pocket.sharein.ShareInPackage

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(HermesBridgePackage())
          add(ShareInPackage())
          add(BrowserRelayPackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Crash telemetry for the embedded runtime process: last crash lands in
    // files/Moch/logs/crash-last.txt (the agent itself can read it back).
    // Recovery is START_STICKY on HermesService — the system restarts the
    // service, and with it the process and the Python runtime. The write
    // itself goes through MochLogs, shared with HermesService's FGS-timeout
    // marker (BH-000046) so both files come from one code path.
    val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      try {
        android.util.Log.e("MochHermes", "uncaught exception on ${t.name}", e)
        MochLogs.write(this, "crash-last.txt", "${java.util.Date()} thread=${t.name}\n${android.util.Log.getStackTraceString(e)}")
      } catch (_: Exception) {
      }
      previousHandler?.uncaughtException(t, e)
    }
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
    // BUG-132 (cause 1): start the CDP relay NATIVELY, before the Python boot
    // reads relay.json. Every arming path is then guaranteed a live file
    // within milliseconds of process creation — including START_STICKY
    // service restarts, where the process comes back WITHOUT MainActivity and
    // no RN UI ever mounts (the previous, RN-only start left the gateway
    // serving a browser-less catalog until the user next opened the app).
    // WebView debugging becomes process-wide from boot: the accepted posture
    // of the always-available browser (see PR #61). SECURITY NOTE (C-06 /
    // BH-000039): this CANNOT be gated on BuildConfig.DEBUG — CdpRelay's
    // upstream IS the DevTools abstract socket (CdpRelay.connectUpstream),
    // so a release gate would kill every browser tool. Verified surface:
    // abstract unix socket (no network path), SO_PEERCRED rejects other
    // apps, the relay's loopback TCP is token-gated; the only real path is
    // an adb-AUTHORIZED host (USB debugging + prior RSA trust). Full
    // analysis + conditions for changing this posture: SECURITY.md (root).
    try {
      android.webkit.WebView.setWebContentsDebuggingEnabled(true)
      com.hermes.pocket.hermes.CdpRelay.start(this, 9334)
    } catch (e: Exception) {
      android.util.Log.w("MochBrowserRelay", "native relay boot-start failed", e)
    }
    // Boot the embedded Hermes runtime (Chaquopy CPython) off the main thread;
    // MochHermes logcat tag is the on-device proof.
    HermesRuntime.start(this)
    // Keep the embedded runtime alive in the background (M6): automations
    // and long turns survive swipe-away/screen-off via the foreground
    // service; its Stop action is the user-controlled teardown.
    com.hermes.pocket.hermes.HermesService.start(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
