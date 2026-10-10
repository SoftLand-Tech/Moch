package com.hermes.pocket.hermes

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/** Registers BrowserRelayModule (WebView CDP relay surface). */
class BrowserRelayPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(BrowserRelayModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
