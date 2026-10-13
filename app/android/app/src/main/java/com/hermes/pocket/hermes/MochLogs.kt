package com.hermes.pocket.hermes

import android.content.Context
import java.io.File

/**
 * Diagnostic log-file writer for the runtime process: markers land in
 * files/Moch/logs/&lt;name&gt; (same directory the agent itself can read
 * back). Extracted from MainApplication's crash handler when BH-000046
 * added the FGS-timeout marker, so the crash and timeout writes share one
 * code path instead of two copies of the same mkdirs/writeText dance.
 */
object MochLogs {
  private const val TAG = "MochHermes"
  private const val DIR = "Moch/logs"

  /**
   * Best-effort write; never throws — a failing marker must not take down
   * the crash or timeout handler that is writing it.
   */
  fun write(context: Context, fileName: String, body: String) {
    try {
      File(context.filesDir, "$DIR/$fileName").apply {
        parentFile?.mkdirs()
        writeText(body)
      }
    } catch (e: Exception) {
      android.util.Log.w(TAG, "failed to write $DIR/$fileName", e)
    }
  }
}
