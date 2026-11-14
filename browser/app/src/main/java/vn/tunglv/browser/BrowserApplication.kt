package vn.tunglv.browser

import android.app.Application
import vn.tunglv.browser.data.BookmarkStore
import vn.tunglv.browser.data.HistoryStore
import vn.tunglv.browser.data.SettingsStore
import vn.tunglv.browser.filter.FilterStore

class BrowserApplication : Application() {

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
    }
}
