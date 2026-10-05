package com.hermes.pocket.hermes

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.hermes.pocket.MainActivity
import com.hermes.pocket.R

/**
 * Posts the local "knock" notification when an on-phone automation finishes
 * or fails. Called from Python (moch/cron_knocks.py) via Chaquopy interop —
 * the method name and signature are the cross-language contract.
 *
 * The method is deliberately named `knock`, NOT `notify`: `notify` collides
 * with the final java.lang.Object.notify() threading primitive, and
 * Chaquopy's overload dispatch on that name is unreliable.
 *
 * Uses the existing `hermes-alerts` channel (the app's knock channel); it is
 * created here if notifications haven't initialized yet.
 */
class CronKnockNotifier(private val context: Context) {

  fun knock(title: String, text: String) {
    try {
      val app = context.applicationContext
      val nm = app.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(KNOCK_CHANNEL) == null) {
        nm.createNotificationChannel(
            NotificationChannel(
                KNOCK_CHANNEL, "Agent knocks", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Automations and agent activity on this phone" })
      }
      val open =
          PendingIntent.getActivity(
              app,
              0,
              Intent(Intent.ACTION_VIEW, android.net.Uri.parse("hermes://automations"), app, MainActivity::class.java)
                  .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notification =
          NotificationCompat.Builder(app, KNOCK_CHANNEL)
              .setSmallIcon(R.drawable.ic_notification)
              .setContentTitle(title)
              .setContentText(text)
              .setStyle(NotificationCompat.BigTextStyle().bigText(text))
              .setContentIntent(open)
              .setAutoCancel(true)
              .build()
      NotificationManagerCompat.from(app).notify(System.currentTimeMillis().toInt(), notification)
    } catch (e: Exception) {
      Log.w("MochHermes", "cron knock notification failed: ${e.message}")
    }
  }

  companion object {
    private const val KNOCK_CHANNEL = "hermes-alerts"
  }
}
