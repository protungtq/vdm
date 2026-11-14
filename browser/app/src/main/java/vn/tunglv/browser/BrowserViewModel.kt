package vn.tunglv.browser

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class BrowserViewModel(application: Application) : AndroidViewModel(application) {

    /** Link hoặc nội dung được gửi từ app khác, chờ mở thành tab mới. */
    private val _externalUrl = MutableStateFlow<String?>(null)
    val externalUrl: StateFlow<String?> = _externalUrl.asStateFlow()

    /** Chi tiết lỗi làm app tự đóng ở lần chạy trước. */
    private val _crashReport = MutableStateFlow<String?>(null)
    val crashReport: StateFlow<String?> = _crashReport.asStateFlow()

    init {
        viewModelScope.launch(Dispatchers.IO) {
            CrashReporter.readReport(getApplication())?.let { report ->
                _crashReport.value = report
            }
        }
    }

    fun openExternalUrl(text: String) {
        _externalUrl.value = text
    }

    fun consumeExternalUrl() {
        _externalUrl.value = null
    }

    /** Đóng hộp báo lỗi và xóa báo cáo đã xem. */
    fun dismissCrashReport() {
        viewModelScope.launch(Dispatchers.IO) {
            CrashReporter.clearReport(getApplication())
        }
        _crashReport.value = null
    }
}
