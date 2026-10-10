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
    // service, and with it the process and the Python runtime.
    val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      try {
        android.util.Log.e("MochHermes", "uncaught exception on ${t.name}", e)
        java.io.File(filesDir, "Moch/logs/crash-last.txt").apply {
          parentFile?.mkdirs()
          writeText("${java.util.Date()} thread=${t.name}\n${android.util.Log.getStackTraceString(e)}")
        }
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
