package com.hermes.pocket.hermes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.hermes.pocket.MainActivity
import com.hermes.pocket.R
import java.util.Date

/**
 * Foreground service that keeps the embedded hermes runtime (Chaquopy
 * CPython + gateway + automations scheduler) alive while Moch is backgrounded
 * or the screen is off. Android only guarantees long-running work to a
 * process with a foreground service — this is the platform-legit mechanism,
 * no battery-optimization bypasses.
 *
 * FGS type (BH-000046 / GH #100): specialUse from API 34 — dataSync (the
 * pre-migration type, still used on API 29-33) carries a ~6 h per rolling
 * 24 h hard timeout at targetSdk 35+, after which Android 15 calls
 * [onTimeout] and crashes the app if the service doesn't stop within a few
 * seconds. specialUse has no timeout and is the honest type for an embedded
 * agent runtime gateway (declared subtype: embedded_agent_runtime_gateway).
 * [onTimeout] remains as defense-in-depth.
 *
 * Lifecycle: started from MainApplication.onCreate after the runtime boot
 * kicks off; START_STICKY so the system restarts it (and with it the process
 * and the Python runtime) after a kill or crash. The notification carries a
 * Stop action for an explicit, user-controlled teardown.
 */
class HermesService : Service() {

  companion object {
    private const val TAG = "MochHermes"
    private const val CHANNEL_ID = "hermes_runtime"
    private const val NOTIFICATION_ID = 0x4D48 // "MH"
    private const val ACTION_STOP = "com.hermes.pocket.hermes.STOP"
    private const val ACTION_LINUX_TEST = "com.hermes.pocket.hermes.LINUX_TEST"
    private var running = false

    fun isRunning(): Boolean = running
    fun start(context: Context) {
      val appContext = context.applicationContext
      try {
        appContext.startForegroundService(Intent(appContext, HermesService::class.java))
      } catch (e: RuntimeException) {
        // e.g. app in background at the moment of the call (background
        // start limits) — the next app open retries via onCreate wiring.
        Log.w(TAG, "foreground service start deferred: ${e.message}")
      }
    }

    /**
     * User-facing "Stop runtime" (Settings row, BUG-129): FULL teardown via
     * the service's ACTION_STOP path — stopForeground(STOP_FOREGROUND_REMOVE)
     * + stopService + process exit(0). The old bare stopService left the
     * Python runtime and gateway serving while the UI claimed success
     * (Chaquopy cannot unload Python in-process). The process exit is the
     * INTENDED UX — the brain IS the process — and the next app launch
     * auto-starts it fresh (MainApplication.onCreate wiring).
     */
    fun stop(context: Context) {
      val app = context.applicationContext
      try {
        // Delivered as a start command so a live service instance runs its
        // own stopForeground first — the exact machinery the notification's
        // Stop action uses. If the service is already gone (crashed, timed
        // out) this recreates it just long enough to fall into the same
        // ACTION_STOP teardown, so the runtime's process still exits.
        app.startService(Intent(app, HermesService::class.java).setAction(ACTION_STOP))
      } catch (e: RuntimeException) {
        // Background service-start restriction (the settings row is
        // foreground, so this shouldn't fire) — fall back to the direct
        // teardown rather than swallowing the stop like the old bug did.
        Log.w(TAG, "stop: direct shutdown after startService refusal: ${e.message}")
        shutdownProcess(app)
      }
    }

    /** Full runtime teardown: stop the service, then end the process.
     *  Chaquopy cannot unload Python in-process, so "stopped" only becomes
     *  true (memory freed, sockets gone) when the process dies. Called from
     *  the notification's Stop action — the user is not looking at the app. */
    fun shutdownProcess(context: Context) {
      val app = context.applicationContext
      app.stopService(Intent(app, HermesService::class.java))
      android.os.Handler(android.os.Looper.getMainLooper())
          .postDelayed(
              {
                Log.i(TAG, "runtime stopped by user — exiting process")
                Runtime.getRuntime().exit(0)
              },
              600)
    }

    /** True runtime restart: schedule the app's own relaunch, then exit.
     *  Fresh process = fresh CPython + gateway (START_STICKY would also
     *  restart, but only on the SYSTEM'S schedule and only after a kill). */
    fun restartApp(context: Context) {
      val app = context.applicationContext
      val intent =
          Intent(app, MainActivity::class.java)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      val pending =
          PendingIntent.getActivity(
              app, 2, intent, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val am = app.getSystemService(android.app.AlarmManager::class.java)
      am.set(android.app.AlarmManager.ELAPSED_REALTIME, android.os.SystemClock.elapsedRealtime() + 800, pending)
      Log.i(TAG, "runtime restart requested — exiting process")
      Runtime.getRuntime().exit(0)
    }
  }

  override fun onCreate() {
    super.onCreate()
    running = true
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Mochi runtime", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps Mochi and its automations running"
            setShowBadge(false)
          })
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_LINUX_TEST) {
      Thread {
        try {
          val py = com.chaquo.python.Python.getInstance()
          val report = py.getModule("moch.linux_env").callAttr("bootstrap").toString()
          Log.i(TAG, "linux bootstrap: $report")
          val result = py.getModule("moch.linux_env").callAttr("exec_in_guest", "uname -a && head -2 /etc/os-release").toString()
          Log.i(TAG, "linux exec: $result")
        } catch (e: Exception) {
          Log.e(TAG, "linux test failed", e)
        }
      }.start()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      shutdownProcess(this)
      return START_NOT_STICKY
    }
    val notification = buildNotification()
    when {
      // BH-000046 / GH #100: specialUse from API 34 — dataSync's ~6h/24h
      // timeout (enforced at targetSdk 35+ / Android 15) would kill the
      // always-on runtime; specialUse has no time budget.
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
          startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      // API 29-33 keep the legacy type (its permission is still declared
      // for exactly this branch); no timeout exists there.
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
          startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else -> startForeground(NOTIFICATION_ID, notification)
    }
    return START_STICKY
  }

  /**
   * FGS timeout contract (BH-000046): when a timed foreground-service type
   * (dataSync was ours — ~6 h per rolling 24 h at targetSdk 35+) hits its
   * budget, the system calls [onTimeout] and grants a grace period of a few
   * seconds to leave foreground state; lingering past it throws
   * ForegroundServiceDidNotStopInTimeException (process crash). Our
   * specialUse type has no timeout, so reaching here means policy shifted
   * under us or the type got reverted — defense-in-depth that must stay
   * FAST: marker file, sleep notice, stop. All in this one callback, no
   * delayed work, and deliberately NO process exit — the graceful outcome
   * is "Mochi sleeps", not another crash.
   */
  private fun handleFgsTimeout(startId: Int, fgsType: Int?) {
    Log.w(TAG, "FGS timeout: startId=$startId type=$fgsType — going to sleep gracefully")
    // (i) Durable marker beside crash-last.txt (same Moch/logs directory,
    //     shared writer) so the next boot can explain the gap.
    MochLogs.write(this, "fgs-timeout.txt", "${Date()} startId=$startId type=$fgsType\n")
    // (ii) Sleep notice reusing the running-notification machinery (open
    //      + Stop actions); non-ongoing so the user can dismiss it.
    val sleep =
        buildNotification(
            title = "Mochi went to sleep",
            text = "Android's 6-hour background limit was reached; reopen the app to wake her.",
            ongoing = false)
    // (iii) Stop NOW, in this callback: stopForeground(REMOVE) drops the
    //       FGS notification, stopSelf ends the service. The system throws
    //       ForegroundServiceDidNotStopInTimeException if we linger.
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    // The sleep notice is posted only AFTER the REMOVE above — a moment
    // earlier and the teardown would cancel it (same notification id).
    // This is a plain NotificationManager post, not an FGS notification.
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, sleep)
  }

  /**
   * API 34+ timeout callback (shortService budgets). See
   * [handleFgsTimeout] for the contract.
   */
  override fun onTimeout(startId: Int) {
    handleFgsTimeout(startId, null)
  }

  /**
   * API 35+ timeout callback for timed FGS types (e.g. dataSync's 6 h cap);
   * [fgsType] is the ServiceInfo type that timed out. NOTE: this is the
   * compileSdk 36 shape — API 35's (startId, Service.StartArgToken) was
   * replaced by (startId, fgsType) in API 36, and Service.StartArgToken no
   * longer resolves against the API 36 SDK. Implementing this overload
   * covers 35+ (the platform calls it for both shortService and timed-type
   * budgets from VANILLA_ICE_CREAM on).
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    handleFgsTimeout(startId, fgsType)
  }

  private fun buildNotification(
      title: String = "Mochi is running",
      text: String = "Mochi is awake on this phone — automations and tasks keep working.",
      ongoing: Boolean = true
  ): Notification {
    val open =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val stop =
        PendingIntent.getService(
            this,
            1,
            Intent(this, HermesService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(ongoing)
        .setContentIntent(open)
        .addAction(0, "Stop", stop)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
