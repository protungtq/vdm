package vn.tunglv.browser

import android.app.Application
import android.util.Log
import com.yausername.aria2c.Aria2c
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import vn.tunglv.browser.data.BookmarkStore
import vn.tunglv.browser.data.HistoryStore
import vn.tunglv.browser.data.SettingsStore
import vn.tunglv.browser.filter.FilterStore

class BrowserApplication : Application() {

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        // Gắn bộ ghi lỗi trước mọi thứ khác, để lỗi nào làm app tự đóng
        // cũng để lại báo cáo xem được ở lần mở sau.
        CrashReporter.install(this)
        HistoryStore.init(this)
        BookmarkStore.init(this)
        SettingsStore.init(this)
        // Nạp bộ lọc quảng cáo đã lưu trong máy và kiểm tra bản mới, để
        // chặn được ngay từ lần duyệt web đầu tiên.
        FilterStore.loadCached(this)
        FilterStore.refreshIfNeeded(this)
        // Khởi tạo bộ máy yt-dlp + FFmpeg + aria2c cho nút tải media (lần đầu
        // chạy sẽ giải nén Python/yt-dlp/FFmpeg từ native libs nên cần chạy
        // nền, tránh chặn UI).
        appScope.launch {
            try {
                YoutubeDL.getInstance().init(this@BrowserApplication)
                FFmpeg.getInstance().init(this@BrowserApplication)
                Aria2c.getInstance().init(this@BrowserApplication)
                _engineReady.value = true
                Log.i(TAG, "yt-dlp engine ready")
            } catch (e: YoutubeDLException) {
                Log.e(TAG, "failed to initialize youtubedl-android", e)
                _engineError.value = e.message ?: "Không khởi tạo được bộ máy tải"
            } catch (e: Exception) {
                Log.e(TAG, "failed to initialize youtubedl-android", e)
                _engineError.value = e.message ?: "Không khởi tạo được bộ máy tải"
            }
        }
    }

    companion object {
        private const val TAG = "VNBrowser"

        private val _engineReady = MutableStateFlow(false)
        val engineReady: StateFlow<Boolean> = _engineReady.asStateFlow()

        private val _engineError = MutableStateFlow<String?>(null)
        val engineError: StateFlow<String?> = _engineError.asStateFlow()
    }
}
