package vn.tunglv.browser

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Ghi lại lỗi làm app tự đóng, để lần mở sau xem được chi tiết và gửi cho
 * người làm app. Báo cáo chỉ lưu trong máy, không gửi đi đâu.
 */
object CrashReporter {

    private const val FILE_NAME = "crash-report.txt"

    /** Gắn bộ bắt lỗi chưa được xử lý. Gọi ngay đầu Application.onCreate. */
    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val appContext = context.applicationContext
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                writeReport(appContext, thread, error)
            } catch (_: Exception) {
                // Ghi log thất bại thì thôi, vẫn để hệ thống xử lý như thường.
            }
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                // Không có bộ xử lý trước đó: tự đóng tiến trình như mặc định.
                android.os.Process.killProcess(android.os.Process.myPid())
                kotlin.system.exitProcess(1)
            }
        }
    }

    /** Đọc báo cáo lỗi của lần chạy trước, null khi không có. */
    fun readReport(context: Context): String? {
        return try {
            val file = File(context.filesDir, FILE_NAME)
            if (file.exists() && file.length() > 0) file.readText(Charsets.UTF_8) else null
        } catch (_: Exception) {
            null
        }
    }

    /** Xóa báo cáo lỗi đã xem. */
    fun clearReport(context: Context) {
        try {
            File(context.filesDir, FILE_NAME).delete()
        } catch (_: Exception) {
            // Xóa thất bại thì lần sau vẫn hiện lại, không sao.
        }
    }

    private fun writeReport(context: Context, thread: Thread, error: Throwable) {
        val version = try {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            @Suppress("DEPRECATION")
            "${info.versionName} (${info.versionCode})"
        } catch (_: Exception) {
            "không rõ"
        }
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val text = buildString {
            appendLine("VN Browser $version")
            appendLine(
                "Android ${android.os.Build.VERSION.RELEASE} " +
                    "(SDK ${android.os.Build.VERSION.SDK_INT}), " +
                    "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
            )
            appendLine("Thời điểm: $time")
            appendLine("Luồng: ${thread.name}")
            appendLine()
            append(trace)
        }
        File(context.filesDir, FILE_NAME).writeText(text, Charsets.UTF_8)
    }
}
