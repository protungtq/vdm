package tungtq.so1.asia

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

class VdmApplication : Application() {

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _engineReady = MutableStateFlow(false)
    val engineReady: StateFlow<Boolean> = _engineReady.asStateFlow()

    private val _engineError = MutableStateFlow<String?>(null)
    val engineError: StateFlow<String?> = _engineError.asStateFlow()

    override fun onCreate() {
        super.onCreate()
        // Khởi tạo bộ máy yt-dlp + FFmpeg + aria2c (lần đầu chạy sẽ giải nén
        // Python/yt-dlp/FFmpeg từ native libs nên cần chạy nền, tránh chặn UI).
        appScope.launch {
            try {
                YoutubeDL.getInstance().init(this@VdmApplication)
                FFmpeg.getInstance().init(this@VdmApplication)
                Aria2c.getInstance().init(this@VdmApplication)
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
        private const val TAG = "VDM"
    }
}
