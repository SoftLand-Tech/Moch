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

/**
 * Foreground service that keeps the embedded hermes runtime (Chaquopy
 * CPython + gateway + automations scheduler) alive while Moch is backgrounded
 * or the screen is off. Android only guarantees long-running work to a
 * process with a foreground service — this is the platform-legit mechanism,
 * no battery-optimization bypasses.
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

    fun stop(context: Context) {
      context.applicationContext.stopService(Intent(context, HermesService::class.java))
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_STICKY
  }

  private fun buildNotification(): Notification {
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
        .setContentTitle("Mochi is running")
        .setContentText("Mochi is awake on this phone — automations and tasks keep working.")
        .setOngoing(true)
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
