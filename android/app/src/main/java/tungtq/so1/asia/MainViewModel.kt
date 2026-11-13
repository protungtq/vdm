package tungtq.so1.asia

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tungtq.so1.asia.dl.CookiePlatform
import tungtq.so1.asia.dl.DownloadService
import tungtq.so1.asia.dl.DownloadState
import tungtq.so1.asia.dl.Downloader
import tungtq.so1.asia.dl.PreviewMedia
import tungtq.so1.asia.dl.ScannedVideo
import tungtq.so1.asia.dl.VideoFormatOption

data class VdmUiState(
    val urlText: String = "",
    val scanning: Boolean = false,
    val scanned: ScannedVideo? = null,
    val selectedSpec: String? = null,
    val message: String? = null,
    val updatingEngine: Boolean = false,
    val engineReady: Boolean = false,
    val engineError: String? = null,
    val preview: PreviewMedia? = null,
    val showImageViewer: Boolean = false,
    val showDownloadedFiles: Boolean = false,
    val showCookiePlatforms: Boolean = false,
    val cookieWebViewPlatform: CookiePlatform? = null,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val app = application as VdmApplication

    private val _uiState = MutableStateFlow(VdmUiState())
    val uiState: StateFlow<VdmUiState> = _uiState.asStateFlow()

    val downloadState: StateFlow<DownloadState.Progress> = DownloadState.state

    init {
        viewModelScope.launch {
            app.engineReady.collect { ready ->
                _uiState.update { it.copy(engineReady = ready) }
            }
        }
        viewModelScope.launch {
            app.engineError.collect { error ->
                _uiState.update { it.copy(engineError = error) }
            }
        }
    }

    fun setUrl(text: String) {
        _uiState.update { it.copy(urlText = text, message = null) }
    }

    fun selectOption(option: VideoFormatOption) {
        _uiState.update { it.copy(selectedSpec = option.formatSpec) }
    }

    /** Nhận đoạn văn bản từ nút Chia sẻ của app khác: lấy link trong đó rồi quét luôn. */
    fun onSharedText(text: String) {
        val url = Downloader.extractUrl(text)
        if (url == null) {
            _uiState.update {
                it.copy(message = "Không tìm thấy link trong nội dung được chia sẻ.")
            }
            return
        }
        _uiState.update {
            it.copy(urlText = url, message = null, scanned = null, preview = null, showImageViewer = false)
        }
        scan()
    }

    fun scan() {
        val url = _uiState.value.urlText.trim()
        if (url.isBlank()) {
            _uiState.update { it.copy(message = "Dán link video vào trước đã nhé.") }
            return
        }
        val directUrl = Downloader.extractUrl(url) ?: url
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    scanning = true,
                    message = null,
                    scanned = null,
                    preview = null,
                    showImageViewer = false,
                )
            }
            try {
                val scanned = Downloader.fetchInfo(directUrl)
                _uiState.update {
                    it.copy(
                        scanning = false,
                        scanned = scanned,
                        selectedSpec = scanned.options.firstOrNull()?.formatSpec,
                    )
                }
            } catch (e: Exception) {
                val raw = e.message ?: "lỗi không rõ"
                val needsLogin = raw.contains("cookie", ignoreCase = true) ||
                    raw.contains("authentication", ignoreCase = true) ||
                    raw.contains("login", ignoreCase = true)
                val hint = if (needsLogin) {
                    "\nLink này có thể cần đăng nhập. Mở mục Cookie & đăng nhập " +
                        "để lấy cookie rồi thử lại."
                } else {
                    ""
                }
                _uiState.update {
                    it.copy(
                        scanning = false,
                        message = "Không quét được link này: $raw$hint",
                    )
                }
            }
        }
    }

    fun startDownload(context: Context) {
        val state = _uiState.value
        val scanned = state.scanned ?: return
        val option = scanned.options.firstOrNull { it.formatSpec == state.selectedSpec }
            ?: scanned.options.firstOrNull() ?: return
        val url = Downloader.extractUrl(state.urlText) ?: state.urlText
        DownloadState.reset()
        DownloadService.start(context, url, option, scanned.title)
        _uiState.update { it.copy(message = "Đang tải. Bạn cứ dùng điện thoại bình thường nhé.") }
    }

    fun cancelDownload(context: Context) {
        Downloader.cancel()
        DownloadService.stop(context)
        DownloadState.reset()
        _uiState.update { it.copy(message = "Đã hủy lượt tải.") }
    }

    /** Cập nhật bộ quét yt-dlp lên bản mới nhất (không cần cập nhật cả app). */
    fun updateEngine() {
        viewModelScope.launch {
            _uiState.update { it.copy(updatingEngine = true, message = null) }
            try {
                val status = withContext(Dispatchers.IO) {
                    YoutubeDL.getInstance().updateYoutubeDL(
                        getApplication(),
                        YoutubeDL.UpdateChannel.STABLE,
                    )
                }
                val alreadyLatest = status == YoutubeDL.UpdateStatus.ALREADY_UP_TO_DATE
                _uiState.update {
                    it.copy(
                        updatingEngine = false,
                        message = if (alreadyLatest) {
                            "Bộ quét đã là bản mới nhất rồi."
                        } else {
                            "Bộ quét đã lên bản mới nhất."
                        },
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        updatingEngine = false,
                        message = "Cập nhật bộ quét thất bại: ${e.message ?: "lỗi không rõ"}",
                    )
                }
            }
        }
    }

    /** Bản xem trước theo lựa chọn đang chọn: chọn "Chỉ âm thanh" thì nghe thử bản audio. */
    private fun currentPreview(): PreviewMedia? {
        val scanned = _uiState.value.scanned ?: return null
        val selected = scanned.options.firstOrNull { it.formatSpec == _uiState.value.selectedSpec }
        return if (selected?.isAudioOnly == true) {
            scanned.previewAudio ?: scanned.previewVideo
        } else {
            scanned.previewVideo
        }
    }

    /** Mở màn hình xem trước / nghe thử ngay trong app. */
    fun openPreview() {
        val preview = currentPreview()
        if (preview == null) {
            _uiState.update { it.copy(message = "Link này không có bản xem trước.") }
            return
        }
        _uiState.update { it.copy(preview = preview) }
    }

    fun closePreview() {
        _uiState.update { it.copy(preview = null) }
    }

    /** Mở link xem trước bằng app khác (VLC, MX Player...). */
    fun openExternalPlayer(context: Context) {
        val preview = _uiState.value.preview ?: currentPreview()
        if (preview == null) {
            _uiState.update { it.copy(message = "Link này không có bản xem trước.") }
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            if (preview.mimeType != null) {
                setDataAndType(Uri.parse(preview.url), preview.mimeType)
            } else {
                data = Uri.parse(preview.url)
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(Intent.createChooser(intent, "Mở bằng…"))
        } catch (e: ActivityNotFoundException) {
            _uiState.update { it.copy(message = "Không tìm thấy app nào mở được link này.") }
        }
    }

    fun openImageViewer() {
        _uiState.update { it.copy(showImageViewer = true) }
    }

    fun closeImageViewer() {
        _uiState.update { it.copy(showImageViewer = false) }
    }

    fun openDownloadedFiles() {
        _uiState.update { it.copy(showDownloadedFiles = true) }
    }

    fun closeDownloadedFiles() {
        _uiState.update { it.copy(showDownloadedFiles = false) }
    }

    /**
     * Thử mở thư mục Download/VDM trong trình quản lý file của máy.
     * Trả về false nếu máy không có app nào nhận mở thư mục kiểu này.
     */
    fun openFolderExternal(context: Context): Boolean {
        val uri = Uri.parse(
            "content://com.android.externalstorage.documents/document/primary:Download/VDM",
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    fun openCookiePlatforms() {
        _uiState.update { it.copy(showCookiePlatforms = true) }
    }

    fun closeCookiePlatforms() {
        _uiState.update { it.copy(showCookiePlatforms = false) }
    }

    fun openCookieWebView(platform: CookiePlatform) {
        _uiState.update { it.copy(cookieWebViewPlatform = platform) }
    }

    fun closeCookieWebView() {
        _uiState.update { it.copy(cookieWebViewPlatform = null) }
    }

    fun clearMessage() {
        _uiState.update { it.copy(message = null) }
    }
}
