package tungtq.so1.asia.dl

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Trạng thái lượt tải hiện tại, dùng chung giữa DownloadService và giao diện. */
object DownloadState {

    data class Progress(
        val isDownloading: Boolean = false,
        val progress: Float = 0f,
        val etaSeconds: Long = 0L,
        val statusText: String? = null,
    )

    private val _state = MutableStateFlow(Progress())
    val state: StateFlow<Progress> = _state.asStateFlow()

    fun update(progress: Float, etaSeconds: Long) {
        _state.value = Progress(
            isDownloading = true,
            progress = progress,
            etaSeconds = etaSeconds,
            statusText = null,
        )
    }

    fun started() {
        _state.value = Progress(isDownloading = true, progress = 0f, etaSeconds = 0L)
    }

    fun finished(message: String) {
        _state.value = Progress(isDownloading = false, progress = 100f, statusText = message)
    }

    fun failed(message: String) {
        _state.value = Progress(isDownloading = false, progress = 0f, statusText = message)
    }

    fun reset() {
        _state.value = Progress()
    }
}
