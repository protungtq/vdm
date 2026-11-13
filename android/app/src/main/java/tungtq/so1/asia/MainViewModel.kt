package tungtq.so1.asia

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yausername.youtubedl_android.UpdateChannel
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tungtq.so1.asia.dl.DownloadService
import tungtq.so1.asia.dl.DownloadState
import tungtq.so1.asia.dl.Downloader
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
        _uiState.update { it.copy(urlText = url, message = null, scanned = null) }
        scan()
    }

    fun scan() {
        val url = _uiState.value.urlText.trim()
        if (url.isBlank()) {
            _uiState.update { it.copy(message = "Bố dán link video vào trước đã nhé.") }
            return
        }
        val directUrl = Downloader.extractUrl(url) ?: url
        viewModelScope.launch {
            _uiState.update { it.copy(scanning = true, message = null, scanned = null) }
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
                _uiState.update {
                    it.copy(
                        scanning = false,
                        message = "Không quét được link này: ${e.message ?: "lỗi không rõ"}",
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
        _uiState.update { it.copy(message = "Đang tải, bố cứ dùng điện thoại bình thường nhé.") }
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
                withContext(Dispatchers.IO) {
                    YoutubeDL.getInstance().updateYoutubeDL(
                        getApplication(),
                        UpdateChannel.STABLE,
                    )
                }
                _uiState.update {
                    it.copy(updatingEngine = false, message = "Bộ quét đã lên bản mới nhất.")
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

    fun clearMessage() {
        _uiState.update { it.copy(message = null) }
    }
}
