package com.hermes.pocket.sharein

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * "Ask Moch" share target — the OS entry point every mobile assistant ships
 * (share-to-Gemini / share-to-ChatGPT) that Moch lacked: share text, links,
 * images or files from any app straight into the chat composer.
 *
 * MainActivity forwards every ACTION_SEND / ACTION_SEND_MULTIPLE intent to
 * [ShareInRelay.capture] (onCreate = cold start, onNewIntent = app was
 * alive). Stream extras are content Uris owned by the SHARING app — they die
 * with its process — so ingestion copies the bytes into our own cacheDir on a
 * worker thread before JS ever sees them.
 *
 * JS pulls with [take] (return-and-clear, bounded wait while a copy is in
 * flight) and additionally polls on mount and on AppState active; the
 * MochShareIn event is only a nudge, so a lost event costs nothing.
 *
 * Limits mirror the composer's own gates (media.ts): ≤4 files, ≤8 MB each,
 * text capped at 8000 chars. Over-cap files are counted in `skipped` and
 * surfaced as an alert, never silently dropped.
 */
object ShareInRelay {
  private const val TAG = "MochShareIn"

  @Volatile private var payload: SharedData? = null
  @Volatile private var ingesting: CaptureJob? = null
  @Volatile var module: ShareInModule? = null

  fun capture(appContext: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    // A new share replaces a not-yet-consumed one — the newest intent is
    // what the user just meant.
    payload = null
    val job = CaptureJob(appContext, intent)
    ingesting = job
    Thread(job, "moch-share-in").start()
  }

  /**
   * Return the pending share and clear it; waits up to [timeoutMs] when a
   * capture is still copying. Null when nothing was shared (or the copy is
   * still running past the timeout — JS will be nudged by the event / its
   * next poll).
   */
  fun take(timeoutMs: Long): SharedData? {
    val job = ingesting
    if (job != null) {
      try {
        job.latch.await(timeoutMs, TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      if (!job.done) return null
      if (ingesting === job) ingesting = null
    }
    val p = payload
    payload = null
    return p
  }

  class SharedFile(val uri: String, val name: String, val size: Long, val mime: String)
  class SharedData(
    val text: String,
    val subject: String,
    val files: List<SharedFile>,
    val skipped: Int,
    val at: Long,
  )

  class CaptureJob(private val ctx: Context, private val intent: Intent) : Runnable {
    val latch = CountDownLatch(1)
    @Volatile var done = false
      private set

    override fun run() {
      val built = try {
        ingest(ctx, intent)
      } catch (e: Exception) {
        Log.w(TAG, "share ingest failed", e)
        null
      }
      if (built != null) payload = built
      done = true
      latch.countDown()
      module?.notifyJs()
    }
  }

  // ── Ingestion ────────────────────────────────────────────────────────────

  private class CopyResult(val file: SharedFile?, val skipped: Boolean)

  private fun ingest(ctx: Context, intent: Intent): SharedData? {
    val extras = intent.extras
    var text = extras?.getCharSequence(Intent.EXTRA_TEXT)?.toString() ?: ""
    var subject = extras?.getCharSequence(Intent.EXTRA_SUBJECT)?.toString()
      ?: extras?.getCharSequence(Intent.EXTRA_TITLE)?.toString() ?: ""

    val dir = File(ctx.cacheDir, "share-in").apply { mkdirs() }
    // Opportunistic sweep: consumed shares' copies never outlive a day.
    val dayAgo = System.currentTimeMillis() - 24 * 3600_000L
    dir.listFiles()?.forEach { if (it.lastModified() < dayAgo) it.delete() }

    val mime = (intent.type ?: "").substringBefore(';').trim().lowercase()
    val files = ArrayList<SharedFile>()
    var skipped = 0
    when (intent.action) {
      Intent.ACTION_SEND -> {
        @Suppress("DEPRECATION")
        val stream = extras?.getParcelable<Uri>(Intent.EXTRA_STREAM)
        if (stream != null) {
          val r = copyShared(ctx, stream, mime, dir)
          if (r.file != null) files.add(r.file) else if (r.skipped) skipped++
        }
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        @Suppress("DEPRECATION")
        val streams = extras?.getParcelableArrayList<Uri>(Intent.EXTRA_STREAM)
        streams?.take(ShareInModule.MAX_FILES)?.forEach { uri ->
          val r = copyShared(ctx, uri, mime, dir)
          if (r.file != null) files.add(r.file) else if (r.skipped) skipped++
        }
      }
    }

    if (text.length > ShareInModule.MAX_TEXT) text = text.take(ShareInModule.MAX_TEXT)
    text = text.trim()
    subject = subject.trim()
    if (text.isEmpty() && subject.isEmpty() && files.isEmpty() && skipped == 0) return null
    return SharedData(text, subject, files, skipped, System.currentTimeMillis())
  }

  /** Copy one shared stream into cacheDir/share-in, enforcing the size cap.
   *  A queryable size over the cap skips the copy entirely; otherwise the
   *  copy aborts (and cleans up) the moment it passes the cap. */
  private fun copyShared(ctx: Context, uri: Uri, mime: String, dir: File): CopyResult {
    var name: String? = null
    var declaredSize = -1L
    try {
      ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIdx >= 0 && !c.isNull(nameIdx)) name = c.getString(nameIdx)
          val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
          if (sizeIdx >= 0 && !c.isNull(sizeIdx)) declaredSize = c.getLong(sizeIdx)
        }
      }
    } catch (_: Exception) {
      // Metadata unreadable — the stream copy below is still worth trying.
    }
    if (declaredSize > ShareInModule.MAX_BYTES) return CopyResult(null, skipped = true)

    var safe = (name ?: "shared").map { if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_') it else '_' }
      .joinToString("").take(120).trim('.', '_').ifEmpty { "shared" }
    if (!safe.contains('.')) safe += extensionFor(mime)
    val out = File(dir, "${System.currentTimeMillis()}-${safe}")

    var result: CopyResult? = null
    try {
      val input = ctx.contentResolver.openInputStream(uri)
      if (input == null) {
        out.delete()
        return CopyResult(null, skipped = false)
      }
      input.use { src ->
        FileOutputStream(out).use { fout ->
          val buf = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val n = src.read(buf)
            if (n < 0) break
            total += n
            if (total > ShareInModule.MAX_BYTES) {
              out.delete()
              result = CopyResult(null, skipped = true)
              return@use
            }
            fout.write(buf, 0, n)
          }
          result =
            if (total == 0L) {
              out.delete()
              CopyResult(null, skipped = false)
            } else {
              CopyResult(SharedFile(Uri.fromFile(out).toString(), safe, total, mime), skipped = false)
            }
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "stream copy failed: ${e.message}")
      out.delete()
      return CopyResult(null, skipped = false)
    }
    return result ?: CopyResult(null, skipped = false)
  }

  /** The composer classifies attachments by file extension (media.ts
   *  mediaKindForPath), so a name without one must gain one. Image mimes map
   *  to .jpg — every image attachment is re-encoded to JPEG by the upload
   *  ladder anyway (mediaSend.ts). Anything unrecognized falls back to .bin,
   *  which classifies as a plain file — a correct, if lossy, ride. */
  private fun extensionFor(mime: String): String = when (mime) {
    "image/jpeg", "image/jpg", "image/pjpeg" -> ".jpg"
    "image/png" -> ".png"
    "image/webp" -> ".webp"
    "image/gif" -> ".gif"
    "image/bmp" -> ".bmp"
    "video/mp4" -> ".mp4"
    "video/webm" -> ".webm"
    "video/3gpp", "video/3gp" -> ".3gp"
    "audio/mpeg" -> ".mp3"
    "audio/mp4", "audio/m4a" -> ".m4a"
    "audio/ogg" -> ".ogg"
    "audio/wav" -> ".wav"
    "audio/3gpp" -> ".3gp"
    "audio/amr" -> ".amr"
    "audio/flac" -> ".flac"
    "application/pdf" -> ".pdf"
    "text/plain" -> ".txt"
    "text/html", "application/json" -> ".txt"
    else -> if (mime.startsWith("image/")) ".jpg"
      else if (mime.startsWith("video/")) ".mp4"
      else if (mime.startsWith("audio/")) ".m4a"
      else if (mime.startsWith("text/")) ".txt"
      else ".bin"
  }
}

class ShareInModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    ShareInRelay.module = this
  }

  override fun getName() = "ShareIn"

  override fun invalidate() {
    if (ShareInRelay.module === this) ShareInRelay.module = null
    super.invalidate()
  }

  /** Return the pending share (if any) and clear the relay. */
  @ReactMethod
  fun take(promise: Promise) {
    val data = try {
      ShareInRelay.take(TAKE_TIMEOUT_MS)
    } catch (e: Exception) {
      promise.reject("sharein_take", e)
      return
    }
    if (data == null) {
      promise.resolve(null)
      return
    }
    val m = Arguments.createMap()
    m.putString("text", data.text)
    m.putString("subject", data.subject)
    m.putDouble("at", data.at.toDouble())
    m.putInt("skipped", data.skipped)
    val arr = Arguments.createArray()
    for (f in data.files) {
      val fm = Arguments.createMap()
      fm.putString("uri", f.uri)
      fm.putString("name", f.name)
      fm.putDouble("size", f.size.toDouble())
      fm.putString("mime", f.mime)
      arr.pushMap(fm)
    }
    m.putArray("files", arr)
    promise.resolve(m)
  }

  fun notifyJs() {
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, null)
    } catch (e: Exception) {
      // JS polls on mount / foreground as well — an event failure is inert.
      Log.w("MochShareIn", "emit failed: ${e.message}")
    }
  }

  companion object {
    const val EVENT = "MochShareIn"
    const val TAKE_TIMEOUT_MS = 4000L
    const val MAX_FILES = 4
    const val MAX_BYTES = 8_000_000L
    const val MAX_TEXT = 8000
  }
}
