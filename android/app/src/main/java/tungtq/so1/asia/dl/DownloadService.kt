package tungtq.so1.asia.dl

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Chạy lượt tải ở foreground để Android không giết khi người dùng tắt màn hình
 * hay chuyển sang app khác.
 */
class DownloadService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var lastNotifiedAt = 0L
    private var lastNotifiedProgress = -1f

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val url = intent?.getStringExtra(EXTRA_URL) ?: return START_NOT_STICKY
        val formatSpec = intent.getStringExtra(EXTRA_FORMAT_SPEC) ?: return START_NOT_STICKY
        val label = intent.getStringExtra(EXTRA_LABEL) ?: ""
        val isAudio = intent.getBooleanExtra(EXTRA_IS_AUDIO, false)
        val directUrl = intent.getStringExtra(EXTRA_DIRECT_URL)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: url

        val notification = buildNotification(title, 0f, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        DownloadState.started()

        scope.launch {
            try {
                val option = VideoFormatOption(formatSpec, label, null, isAudio, directUrl)
                Downloader.download(url, option) { progress, eta ->
                    DownloadState.update(progress, eta)
                    maybeUpdateNotification(title, progress)
                }
                val done = "Đã tải xong: $title"
                DownloadState.finished(done)
                showFinishedNotification(done)
            } catch (e: Exception) {
                Log.e(TAG, "download failed", e)
                val msg = "Tải thất bại: ${e.message ?: "lỗi không rõ"}"
                DownloadState.failed(msg)
                showFinishedNotification(msg)
            } finally {
                stopForeground(STOP_FOREGROUND_DETACH)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Downloader.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun maybeUpdateNotification(title: String, progress: Float) {
        val now = System.currentTimeMillis()
        if (now - lastNotifiedAt < 500 && progress - lastNotifiedProgress < 2f) return
        lastNotifiedAt = now
        lastNotifiedProgress = progress
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(title, progress, true))
    }

    private fun showFinishedNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("VDM")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(title: String, progress: Float, ongoing: Boolean) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("VDM đang tải")
            .setContentText(title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(title))
            .setProgress(100, progress.toInt(), false)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .build()

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Tải xuống",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Tiến trình tải video của VDM" }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "VDM"
        private const val CHANNEL_ID = "vdm_downloads"
        private const val NOTIFICATION_ID = 1

        const val EXTRA_URL = "extra_url"
        const val EXTRA_FORMAT_SPEC = "extra_format_spec"
        const val EXTRA_LABEL = "extra_label"
        const val EXTRA_IS_AUDIO = "extra_is_audio"
        const val EXTRA_DIRECT_URL = "extra_direct_url"
        const val EXTRA_TITLE = "extra_title"

        fun start(context: Context, url: String, option: VideoFormatOption, title: String) {
            val intent = Intent(context, DownloadService::class.java).apply {
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_FORMAT_SPEC, option.formatSpec)
                putExtra(EXTRA_LABEL, option.label)
                putExtra(EXTRA_IS_AUDIO, option.isAudioOnly)
                putExtra(EXTRA_DIRECT_URL, option.directUrl)
                putExtra(EXTRA_TITLE, title)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DownloadService::class.java))
        }
    }
}
