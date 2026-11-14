package vn.tunglv.browser.web

import android.annotation.TargetApi
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import java.io.ByteArrayInputStream
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import vn.tunglv.browser.data.HistoryStore
import vn.tunglv.browser.data.SavedTab
import vn.tunglv.browser.data.SearchEngine
import vn.tunglv.browser.data.TabStore
import vn.tunglv.browser.filter.CHROME_UA
import vn.tunglv.browser.filter.FilterStore

/** Địa chỉ giả của trang chủ tự dựng, để nhận biết tab đang ở trang chủ. */
const val HOME_URL = "vnbrowser://home"

/** Địa chỉ gốc khi nạp trang chủ tự dựng. */
private const val HOME_BASE_URL = "https://vn-browser.home/"

/**
 * Một tab duyệt web. WebView chỉ được tạo khi tab lần đầu được mở lên,
 * để mở lại nhiều tab cũ không tốn thời gian và bộ nhớ.
 */
class TabSession(
    val id: Long,
    /** Địa chỉ sẽ nạp khi tab lần đầu được mở (HOME_URL = trang chủ tự dựng). */
    val startUrl: String,
    initialTitle: String = "",
) {
    val url = mutableStateOf("")
    val title = mutableStateOf(initialTitle)
    val progress = mutableIntStateOf(100)
    val canGoBack = mutableStateOf(false)
    val canGoForward = mutableStateOf(false)
    val isStartPage = mutableStateOf(startUrl == HOME_URL)

    /** Link media bắt được từ request mạng của trang đang mở. */
    val capturedMedia = mutableStateListOf<CapturedMedia>()

    /** Thêm link bắt được, trùng luồng thì chỉ giữ link đầu tiên. */
    fun addCapture(media: CapturedMedia) {
        if (capturedMedia.any { captureKey(it) == captureKey(media) }) return
        if (capturedMedia.size >= 20) return
        capturedMedia.add(media)
    }

    internal var webView: WebView? = null
    internal var loaded = false
}

/**
 * WebViewClient chỉ cho http/https chạy trong WebView. Các link mở app ngoài
 * (vd snssdk1128:// của Douyin) sẽ bị chặn, tránh lỗi ERR_UNKNOWN_URL_SCHEME.
 */
open class SafeWebViewClient : WebViewClient() {

    @TargetApi(Build.VERSION_CODES.N)
    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
    ): Boolean {
        return !isWebUrl(request.url.toString())
    }

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
        return !isWebUrl(url)
    }

    private fun isWebUrl(url: String): Boolean {
        val lower = url.lowercase()
        return lower.startsWith("http://") || lower.startsWith("https://")
    }
}

/**
 * Quản lý các tab: tạo, đóng, chuyển tab, lưu và khôi phục tab.
 * WebView dùng context của Activity để hộp thoại JavaScript hiện được.
 */
class TabManager(
    private val activityContext: Context,
    private val appContext: Context,
    private val scope: CoroutineScope,
) {
    val tabs = mutableStateListOf<TabSession>()
    val activeTabId = mutableStateOf<Long?>(null)

    val activeTab: TabSession?
        get() = tabs.firstOrNull { it.id == activeTabId.value }

    private var nextId = 1L
    private var restored = false

    /** Khôi phục tab đã lưu, chưa có tab nào thì mở tab trang chủ. Chỉ chạy 1 lần. */
    fun restoreIfNeeded() {
        if (restored) return
        restored = true
        scope.launch {
            val saved = withContext(Dispatchers.IO) { TabStore.loadTabs(appContext) }
            val activeId = withContext(Dispatchers.IO) { TabStore.loadActiveId(appContext) }
            if (saved.isEmpty()) {
                createTab(HOME_URL, activate = true)
            } else {
                for (savedTab in saved) {
                    tabs.add(TabSession(savedTab.id, savedTab.url, savedTab.title))
                    if (savedTab.id >= nextId) nextId = savedTab.id + 1
                }
                selectTab(activeId?.takeIf { id -> tabs.any { it.id == id } } ?: saved.first().id)
            }
        }
    }

    fun createTab(url: String, activate: Boolean): TabSession {
        val session = TabSession(nextId++, url)
        tabs.add(session)
        if (activate) {
            selectTab(session.id)
        } else {
            saveTabs()
        }
        return session
    }

    fun selectTab(id: Long) {
        val session = tabs.firstOrNull { it.id == id } ?: return
        activeTabId.value = id
        ensureWebView(session)
        saveTabs()
    }

    fun closeTab(id: Long) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return
        val session = tabs.removeAt(index)
        destroyWebView(session)
        if (tabs.isEmpty()) {
            createTab(HOME_URL, activate = true)
        } else if (activeTabId.value == id) {
            val next = tabs.getOrNull(index.coerceAtMost(tabs.size - 1)) ?: tabs.first()
            selectTab(next.id)
        }
        saveTabs()
    }

    fun closeAllTabs() {
        for (session in tabs) destroyWebView(session)
        tabs.clear()
        createTab(HOME_URL, activate = true)
    }

    /** Tạo WebView cho tab nếu chưa có, nạp địa chỉ ban đầu của tab. */
    fun ensureWebView(session: TabSession): WebView {
        session.webView?.let { return it }
        val webView = WebView(activityContext)
        session.webView = webView
        configureWebView(webView, session)
        if (!session.loaded) {
            session.loaded = true
            if (session.startUrl == HOME_URL) {
                loadStartPage(session)
            } else {
                try {
                    webView.loadUrl(session.startUrl)
                } catch (_: Throwable) {
                    // Nạp lỗi thì để tab trắng, người dùng gõ lại địa chỉ.
                }
            }
        }
        return webView
    }

    /** Mở địa chỉ hoặc từ khóa trong tab đang chọn. */
    fun navigate(session: TabSession, input: String, engine: SearchEngine) {
        val target = resolveInput(input, engine)
        if (target.isBlank()) return
        session.isStartPage.value = false
        try {
            ensureWebView(session).loadUrl(target)
        } catch (_: Throwable) {
            // Nạp lỗi thì thôi, tab giữ nguyên trang cũ.
        }
    }

    /** Mở trang chủ tự dựng trong tab đang chọn. */
    fun openStartPage(session: TabSession) {
        session.isStartPage.value = true
        session.url.value = ""
        session.title.value = ""
        session.progress.intValue = 0
        loadStartPage(session)
    }

    fun goBack(session: TabSession) {
        try {
            session.webView?.goBack()
        } catch (_: Throwable) {
        }
    }

    fun goForward(session: TabSession) {
        try {
            session.webView?.goForward()
        } catch (_: Throwable) {
        }
    }

    fun reload(session: TabSession) {
        try {
            session.webView?.reload()
        } catch (_: Throwable) {
        }
    }

    /** Hủy toàn bộ WebView, gọi khi Activity bị hủy hẳn. */
    fun destroy() {
        for (session in tabs) destroyWebView(session)
        tabs.clear()
    }

    private fun destroyWebView(session: TabSession) {
        try {
            val webView = session.webView ?: return
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        } catch (_: Throwable) {
        }
        session.webView = null
    }

    private fun loadStartPage(session: TabSession) {
        try {
            session.webView?.loadDataWithBaseURL(
                HOME_BASE_URL,
                START_PAGE_HTML,
                "text/html",
                "utf-8",
                null,
            )
        } catch (_: Throwable) {
            // Trang chủ tự dựng nạp lỗi thì mở Google cho khỏi trắng trang.
            try {
                session.webView?.loadUrl("https://www.google.com")
            } catch (_: Throwable) {
            }
        }
    }

    private fun configureWebView(webView: WebView, session: TabSession) {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // Giả dạng Chrome trên điện thoại để các trang trả bản đầy đủ.
        webView.settings.userAgentString = CHROME_UA
        webView.webViewClient = object : SafeWebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                // Lỗi trong lúc chặn quảng cáo thì để request chạy bình
                // thường, không để lỗi này làm sập app.
                try {
                    return interceptSafely(view, request)
                } catch (_: Throwable) {
                    return null
                }
            }

            private fun interceptSafely(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url.toString()
                // Đọc URL trang đang mở có thể lỗi khi gọi ngoài luồng giao
                // diện, lỗi thì coi như không biết.
                val documentUrl = try {
                    view.url
                } catch (_: Throwable) {
                    null
                }
                // Bộ lọc quảng cáo: chặn request khớp rule, trừ frame chính
                // để trang vẫn tải được.
                if (!request.isForMainFrame && FilterStore.isBlocked(url, documentUrl)) {
                    return emptyResponse()
                }
                // Tên máy chủ quảng cáo/theo dõi ghi cứng, làm lớp dự phòng
                // khi bộ lọc chưa tải về máy.
                if (!request.isForMainFrame && isAdHost(url)) {
                    return emptyResponse()
                }
                // Bắt link media để nút tải dùng khi bộ quét không đọc được
                // trang (vd YouTube). Chỉ bắt request phụ, không bắt frame chính.
                if (!request.isForMainFrame) {
                    val captured = classifyMediaUrl(url)
                    if (captured != null) {
                        view.post { session.addCapture(captured) }
                    }
                }
                return null
            }

            override fun onPageStarted(
                view: WebView,
                url: String?,
                favicon: android.graphics.Bitmap?,
            ) {
                super.onPageStarted(view, url, favicon)
                session.progress.intValue = 0
                if (url == null) return
                if (url == HOME_BASE_URL || url.startsWith("data:")) {
                    session.isStartPage.value = true
                    session.url.value = ""
                } else {
                    session.isStartPage.value = false
                    session.url.value = url
                    // Trang mới thì bỏ link media của trang cũ.
                    session.capturedMedia.clear()
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                session.progress.intValue = 100
                session.title.value = view.title ?: ""
                session.canGoBack.value = view.canGoBack()
                session.canGoForward.value = view.canGoForward()
                val finishedUrl = session.url.value
                if (finishedUrl.isNotBlank()) {
                    HistoryStore.add(finishedUrl, session.title.value)
                }
                saveTabs()
            }

            override fun doUpdateVisitedHistory(
                view: WebView,
                url: String?,
                isReload: Boolean,
            ) {
                super.doUpdateVisitedHistory(view, url, isReload)
                session.canGoBack.value = view.canGoBack()
                session.canGoForward.value = view.canGoForward()
                // Trang tự đổi địa chỉ không tải lại (vd lướt Shorts): cập nhật
                // địa chỉ tab và bỏ link media của trang cũ.
                if (url != null &&
                    (url.startsWith("http://") || url.startsWith("https://"))
                ) {
                    val clean = url.substringBefore("#")
                    if (clean != session.url.value.substringBefore("#") &&
                        !session.isStartPage.value
                    ) {
                        session.capturedMedia.clear()
                    }
                    session.url.value = url
                    session.isStartPage.value = false
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                try {
                    session.progress.intValue = newProgress
                } catch (_: Throwable) {
                    // Cập nhật tiến trình lỗi thì thôi.
                }
            }

            override fun onReceivedTitle(view: WebView, title: String?) {
                try {
                    session.title.value = title ?: ""
                } catch (_: Throwable) {
                    // Cập nhật tiêu đề lỗi thì thôi.
                }
            }
        }
        // Link tải file: tải bằng DownloadManager của máy, kèm cookie và
        // User-Agent để các trang cần đăng nhập vẫn tải được.
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val cookie = try {
                    CookieManager.getInstance().getCookie(url)
                } catch (_: Throwable) {
                    null
                }
                val request = DownloadManager.Request(Uri.parse(url))
                    .setTitle(fileName)
                    .setDescription(url)
                    .setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
                    )
                    .setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        fileName,
                    )
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(true)
                if (!cookie.isNullOrBlank()) {
                    request.addRequestHeader("Cookie", cookie)
                }
                request.addRequestHeader("User-Agent", userAgent)
                val manager =
                    appContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                manager.enqueue(request)
                Toast.makeText(appContext, "Đang tải: $fileName", Toast.LENGTH_SHORT).show()
            } catch (_: Throwable) {
                Toast.makeText(appContext, "Không tải được file này.", Toast.LENGTH_SHORT).show()
            }
        }
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)
    }

    /** Lưu danh sách tab và tab đang chọn để mở lại lần sau. */
    fun saveTabs() {
        val snapshot = tabs.map { session ->
            SavedTab(
                id = session.id,
                url = if (session.isStartPage.value) {
                    HOME_URL
                } else {
                    session.url.value.ifBlank { session.startUrl }
                },
                title = session.title.value,
            )
        }
        val activeId = activeTabId.value
        scope.launch(Dispatchers.IO) {
            TabStore.saveTabs(appContext, snapshot, activeId)
        }
    }

    private fun emptyResponse(): WebResourceResponse {
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }
}

/**
 * Chuẩn hóa nội dung nhập ở thanh địa chỉ: có sẵn http(s) thì giữ nguyên,
 * trông như tên miền thì thêm https://, còn lại thì tìm bằng công cụ đã chọn.
 */
fun resolveInput(input: String, engine: SearchEngine): String {
    val text = input.trim()
    if (text.isEmpty()) return ""
    if (text.startsWith("http://") || text.startsWith("https://")) return text
    if (!text.contains(" ") && text.contains(".")) return "https://$text"
    return engine.template.replace("%s", URLEncoder.encode(text, "UTF-8"))
}

/** Tên máy chủ quảng cáo/theo dõi thì chặn, làm dự phòng cho bộ lọc. */
private fun isAdHost(url: String): Boolean {
    val host = try {
        URL(url).host.lowercase()
    } catch (_: Exception) {
        return false
    }
    return AD_HOST_MARKERS.any { host.contains(it) }
}

private val AD_HOST_MARKERS = listOf(
    "doubleclick",
    "googlesyndication",
    "adservice",
    "adsystem",
    "bytead",
    "pangle",
    "advertising",
    "tracking",
    "analytics",
)

/** Trang chủ tự dựng: ô tìm kiếm và lối tắt tới các trang hay dùng. */
private const val START_PAGE_HTML = """
<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VN Browser</title>
<style>
*{box-sizing:border-box}
body{font-family:sans-serif;background:#fafaf8;color:#1c1b1a;margin:0;padding:28px 20px 32px}
.head{display:flex;align-items:center;gap:12px;margin:0 0 6px}
.logo{width:48px;height:48px;border-radius:16px;background:#DC2626;color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800}
h1{color:#DC2626;font-size:26px;margin:0;line-height:1.1}
p{color:#6b6660;font-size:14px;margin:0 0 22px}
form{display:flex;gap:8px;margin:0 0 24px}
input{flex:1;min-width:0;padding:13px 18px;border:1px solid #e5e1dc;border-radius:999px;
  font-size:15px;background:#fff;color:#1c1b1a;outline:none;box-shadow:0 1px 3px rgba(0,0,0,.06)}
input:focus{border-color:#DC2626}
button{padding:13px 20px;border:0;border-radius:999px;background:#DC2626;color:#fff;
  font-size:15px;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 8px}
a{display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;
  color:#1c1b1a;font-weight:600;font-size:13px;text-align:center}
a i{width:56px;height:56px;border-radius:18px;display:flex;align-items:center;
  justify-content:center;font-style:normal;font-size:24px;font-weight:800;color:#fff}
.g{background:#4285F4}.y{background:#FF0000}.f{background:#1877F2}.t{background:#111}
.d{background:#FE2C55}.x{background:#000}.r{background:#FF4500}.v{background:#17B3E8}
@media (prefers-color-scheme:dark){
body{background:#131211;color:#f5f2ef}
p{color:#a8a29b}
input{background:#262421;border-color:#38342f;color:#f5f2ef}
a{color:#f5f2ef}
.t,.x{background:#333}
}
</style></head><body>
<div class="head"><div class="logo">V</div><h1>VN Browser</h1></div>
<p>Đã bật chặn quảng cáo. Gõ từ khóa để tìm, hoặc mở nhanh một trang dưới đây.</p>
<form action="https://www.google.com/search" method="get">
<input type="search" name="q" placeholder="Tìm kiếm…">
<button type="submit">Tìm</button>
</form>
<div class="grid">
<a href="https://www.google.com"><i class="g">G</i>Google</a>
<a href="https://m.youtube.com"><i class="y">▶</i>YouTube</a>
<a href="https://m.facebook.com"><i class="f">f</i>Facebook</a>
<a href="https://www.tiktok.com"><i class="t">♪</i>TikTok</a>
<a href="https://www.douyin.com"><i class="d">♪</i>Douyin</a>
<a href="https://x.com"><i class="x">𝕏</i>X</a>
<a href="https://www.reddit.com"><i class="r">R</i>Reddit</a>
<a href="https://vimeo.com"><i class="v">V</i>Vimeo</a>
</div></body></html>
"""
