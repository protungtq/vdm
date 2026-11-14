package tungtq.so1.asia

import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tungtq.so1.asia.dl.DouyinDirect
import tungtq.so1.asia.dl.Downloader
import tungtq.so1.asia.dl.FilterStore

/** Một link file đã bắt được khi duyệt web, kèm nhãn loại và dung lượng (nếu đo được). */
private data class CapturedMedia(
    val url: String,
    val label: String,
    val sizeLabel: String? = null,
)

/**
 * Trình duyệt ngay trong app, dùng chung bộ lọc quảng cáo với màn hình
 * Douyin: mọi request phụ khớp rule trong 4 bộ lọc (FMSF, ABPVN, AdGuard
 * Mobile, EasyList) đều bị chặn, kèm lớp chặn theo tên máy chủ quảng cáo
 * làm dự phòng khi chưa tải được bộ lọc. Duyệt tới trang có video thì app
 * tự bắt link file video/âm thanh để tải trực tiếp, giống cách màn hình
 * Douyin bắt link.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowserScreen(
    onMediaFound: (directUrl: String, pageTitle: String?, pageUrl: String?) -> Unit,
    onScanPage: (pageUrl: String) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    var webView by remember { mutableStateOf<WebView?>(null) }
    var addressText by remember { mutableStateOf("") }
    var addressFocused by remember { mutableStateOf(false) }
    var currentUrl by remember { mutableStateOf("") }
    var pageTitle by remember { mutableStateOf("") }
    var progress by remember { mutableStateOf(100) }
    var canGoBack by remember { mutableStateOf(false) }
    var canGoForward by remember { mutableStateOf(false) }
    var showingStartPage by remember { mutableStateOf(true) }
    val capturedLinks = remember { mutableStateListOf<CapturedMedia>() }
    val blockedCount by FilterStore.blockedCount.collectAsState()
    var adBlockEnabled by remember { mutableStateOf(FilterStore.adBlockingEnabled) }

    // Mở trình duyệt thì kiểm tra bộ lọc mới, để lần chặn sau dùng bản mới nhất.
    LaunchedEffect(Unit) {
        FilterStore.refreshIfNeeded(context)
    }

    fun addCaptured(url: String, label: String) {
        // Gộp link trùng: cùng máy chủ + cùng đường dẫn thì là cùng 1 file,
        // kể cả khi chữ ký trong query khác nhau.
        val key = browserCaptureKey(url)
        if (capturedLinks.any { browserCaptureKey(it.url) == key && it.label == label }) return
        capturedLinks.add(CapturedMedia(url, label))
        // Đo dung lượng để hiện cạnh link, giúp chọn dễ hơn.
        scope.launch(Dispatchers.IO) {
            val size = DouyinDirect.probeContentLength(url, currentUrl.takeIf { it.isNotBlank() })
            val sizeLabel = DouyinDirect.formatBytes(size)
            if (sizeLabel != null) {
                withContext(Dispatchers.Main) {
                    val idx = capturedLinks.indexOfFirst { it.url == url }
                    if (idx >= 0) {
                        capturedLinks[idx] = capturedLinks[idx].copy(sizeLabel = sizeLabel)
                    }
                }
            }
        }
    }

    fun loadStartPage() {
        showingStartPage = true
        currentUrl = ""
        pageTitle = ""
        addressText = ""
        webView?.loadDataWithBaseURL(START_PAGE_BASE, START_PAGE_HTML, "text/html", "utf-8", null)
    }

    fun goTo(input: String) {
        val target = normalizeBrowserInput(input)
        if (target.isBlank()) return
        focusManager.clearFocus()
        showingStartPage = false
        webView?.loadUrl(target)
    }

    BackHandler {
        val wv = webView
        if (wv?.canGoBack() == true) {
            wv.goBack()
        } else {
            onClose()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (showingStartPage) "Trình duyệt" else pageTitle.ifBlank { "Trình duyệt" }) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Default.Close, contentDescription = "Đóng")
                    }
                },
                actions = {
                    // Số quảng cáo đã chặn + bấm để bật/tắt chặn.
                    Text(
                        "$blockedCount",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.White,
                    )
                    IconButton(onClick = {
                        adBlockEnabled = !adBlockEnabled
                        FilterStore.adBlockingEnabled = adBlockEnabled
                        Toast.makeText(
                            context,
                            if (adBlockEnabled) {
                                "Đã bật chặn quảng cáo."
                            } else {
                                "Đã tắt chặn quảng cáo."
                            },
                            Toast.LENGTH_SHORT,
                        ).show()
                    }) {
                        Icon(
                            Icons.Default.Shield,
                            contentDescription = if (adBlockEnabled) {
                                "Đang chặn quảng cáo, bấm để tắt"
                            } else {
                                "Đã tắt chặn quảng cáo, bấm để bật"
                            },
                            tint = if (adBlockEnabled) Color.White else Color(0xFFD1D5DB),
                        )
                    }
                    IconButton(
                        onClick = { onScanPage(currentUrl) },
                        enabled = !showingStartPage && currentUrl.isNotBlank(),
                    ) {
                        Icon(Icons.Default.Search, contentDescription = "Quét trang này")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(0xFFDC2626),
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White,
                    actionIconContentColor = Color.White,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 4.dp),
            ) {
                IconButton(
                    onClick = { webView?.goBack() },
                    enabled = canGoBack,
                ) {
                    Icon(Icons.Default.ArrowBack, contentDescription = "Quay lại")
                }
                IconButton(
                    onClick = { webView?.goForward() },
                    enabled = canGoForward,
                ) {
                    Icon(Icons.Default.ArrowForward, contentDescription = "Tiến tới")
                }
                IconButton(onClick = { webView?.reload() }) {
                    Icon(Icons.Default.Refresh, contentDescription = "Tải lại")
                }
                IconButton(onClick = { loadStartPage() }) {
                    Icon(Icons.Default.Home, contentDescription = "Trang chủ")
                }
                OutlinedTextField(
                    value = addressText,
                    onValueChange = { addressText = it },
                    placeholder = { Text("Nhập địa chỉ hoặc từ khóa…") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { goTo(addressText) }),
                    modifier = Modifier
                        .weight(1f)
                        .onFocusChanged { addressFocused = it.isFocused },
                )
                IconButton(onClick = { goTo(addressText) }) {
                    Icon(Icons.Default.Search, contentDescription = "Đi tới")
                }
            }
            if (progress in 1..99) {
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (capturedLinks.isNotEmpty()) {
                Text(
                    "Đã bắt được ${capturedLinks.size} link, bấm Tải để tải về:",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 160.dp)
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(capturedLinks, key = { it.url + it.label }) { captured ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val parts = listOfNotNull(
                                captured.label.takeIf { it.isNotEmpty() },
                                captured.sizeLabel,
                            )
                            Text(
                                if (parts.isNotEmpty()) {
                                    "${parts.joinToString(" · ")} · ${shortBrowserUrl(captured.url)}"
                                } else {
                                    shortBrowserUrl(captured.url)
                                },
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Spacer(Modifier.width(8.dp))
                            OutlinedButton(onClick = {
                                onMediaFound(captured.url, pageTitle, currentUrl)
                            }) {
                                Icon(Icons.Default.Download, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Tải")
                            }
                        }
                    }
                }
            }
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        // Giả dạng Chrome trên điện thoại để các trang trả bản đầy đủ.
                        settings.userAgentString = Downloader.CHROME_UA
                        webViewClient = object : SafeWebViewClient() {
                            override fun shouldInterceptRequest(
                                view: WebView,
                                request: WebResourceRequest,
                            ): WebResourceResponse? {
                                val url = request.url.toString()
                                // Bộ lọc quảng cáo chạy TRƯỚC khi bắt link, để link
                                // video quảng cáo bị chặn thì không lọt vào danh sách.
                                if (!request.isForMainFrame &&
                                    FilterStore.isBlocked(url, view.url)
                                ) {
                                    return emptyResponse()
                                }
                                if (isDownloadableMediaUrl(url)) {
                                    view.post {
                                        val clean = DouyinDirect.noWatermarkVariant(url)
                                        if (clean != null) {
                                            addCaptured(clean, LABEL_NO_WATERMARK)
                                            addCaptured(url, LABEL_WATERMARK)
                                        } else {
                                            addCaptured(url, mediaLabel(url))
                                        }
                                    }
                                    return null
                                }
                                // Tên máy chủ quảng cáo/theo dõi ghi cứng, làm lớp
                                // dự phòng khi bộ lọc chưa tải về máy.
                                if (!request.isForMainFrame && isBrowserAdHost(url)) {
                                    return emptyResponse()
                                }
                                return null
                            }

                            override fun onPageStarted(
                                view: WebView,
                                url: String,
                                favicon: android.graphics.Bitmap?,
                            ) {
                                super.onPageStarted(view, url, favicon)
                                progress = 0
                                if (url == START_PAGE_BASE || url.startsWith("data:")) {
                                    showingStartPage = true
                                    currentUrl = ""
                                } else {
                                    showingStartPage = false
                                    currentUrl = url
                                }
                            }

                            override fun onPageFinished(view: WebView, url: String) {
                                super.onPageFinished(view, url)
                                progress = 100
                                pageTitle = view.title ?: ""
                                canGoBack = view.canGoBack()
                                canGoForward = view.canGoForward()
                                if (!addressFocused) {
                                    addressText = if (showingStartPage) "" else url
                                }
                            }

                            override fun doUpdateVisitedHistory(
                                view: WebView,
                                url: String,
                                isReload: Boolean,
                            ) {
                                super.doUpdateVisitedHistory(view, url, isReload)
                                canGoBack = view.canGoBack()
                                canGoForward = view.canGoForward()
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) {
                                progress = newProgress
                            }

                            override fun onReceivedTitle(view: WebView, title: String?) {
                                pageTitle = title ?: ""
                            }
                        }
                        // Link tải file: giữ lại để tải bằng VDM thay vì để trình
                        // duyệt mặc định xử lý.
                        setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                            addCaptured(url, fileName)
                            Toast.makeText(
                                context,
                                "Đã thêm link tải: $fileName",
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                        val cm = CookieManager.getInstance()
                        cm.setAcceptCookie(true)
                        cm.setAcceptThirdPartyCookies(this, true)
                        loadDataWithBaseURL(
                            START_PAGE_BASE,
                            START_PAGE_HTML,
                            "text/html",
                            "utf-8",
                            null,
                        )
                        webView = this
                    }
                },
                update = {},
                onRelease = { it.destroy() },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

private const val LABEL_NO_WATERMARK = "Không logo"
private const val LABEL_WATERMARK = "Có logo"

/** Địa chỉ gốc của trang chủ tự dựng, để nhận biết khi đang ở trang chủ. */
private const val START_PAGE_BASE = "https://vdm.home/"

private fun emptyResponse(): WebResourceResponse {
    return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
}

/**
 * Chuẩn hóa nội dung nhập ở thanh địa chỉ: có sẵn http(s) thì giữ nguyên,
 * trông như tên miền thì thêm https://, còn lại thì tìm bằng Google.
 */
private fun normalizeBrowserInput(input: String): String {
    val text = input.trim()
    if (text.isEmpty()) return ""
    if (text.startsWith("http://") || text.startsWith("https://")) return text
    if (!text.contains(" ") && text.contains(".")) return "https://$text"
    return "https://www.google.com/search?q=" + URLEncoder.encode(text, "UTF-8")
}

/**
 * Khóa gộp link trùng: cùng máy chủ + cùng đường dẫn thì là cùng 1 file,
 * kể cả khi chữ ký trong query khác nhau; playwm và play gộp chung vì bản
 * không logo được tạo ra từ chính link có logo đó.
 */
private fun browserCaptureKey(url: String): String {
    return try {
        val parsed = URL(url)
        val path = parsed.path.replace("/playwm/", "/play/")
        "${parsed.host}$path"
    } catch (_: Exception) {
        url
    }
}

/** Link nào trông như file video/âm thanh trực tiếp thì bắt. */
private fun isDownloadableMediaUrl(url: String): Boolean {
    val lower = url.lowercase()
    // Loại ảnh, mã trang và file phụ trước.
    if (lower.contains(".jpeg") || lower.contains(".jpg") ||
        lower.contains(".png") || lower.contains(".webp") ||
        lower.contains(".gif") || lower.contains(".svg") ||
        lower.contains(".css") || lower.contains(".js") ||
        lower.contains(".json") || lower.contains(".m3u8")
    ) {
        return false
    }
    if (lower.contains(".mp4") || lower.contains(".m4v") ||
        lower.contains(".mov") || lower.contains(".webm") ||
        lower.contains(".mkv") || lower.contains(".mp3") ||
        lower.contains(".m4a") || lower.contains(".ogg") ||
        lower.contains(".wav")
    ) {
        return true
    }
    // Đầu phát có logo của Douyin (playwm) cũng bắt để đổi sang bản không logo.
    if (lower.contains("/playwm/")) return true
    val host = try {
        URL(url).host.lowercase()
    } catch (_: Exception) {
        return false
    }
    // CDN video của Douyin/TikTok: link phát không có đuôi file.
    if (host.endsWith("douyinvod.com")) return true
    if (host.endsWith("snssdk.com") && lower.contains("/play/")) return true
    if (host.endsWith("byteoversea.com")) return true
    if (host.contains("tiktokcdn") && lower.contains("video")) return true
    return false
}

/** Nhãn theo đuôi file để phân biệt video với âm thanh trong danh sách. */
private fun mediaLabel(url: String): String {
    val lower = url.lowercase()
    return when {
        lower.contains(".mp3") || lower.contains(".m4a") ||
            lower.contains(".ogg") || lower.contains(".wav") -> "Âm thanh"
        lower.contains(".mp4") || lower.contains(".m4v") ||
            lower.contains(".mov") || lower.contains(".webm") ||
            lower.contains(".mkv") -> "Video"
        else -> "Video"
    }
}

/** Tên máy chủ quảng cáo/theo dõi thì chặn, làm dự phòng cho bộ lọc. */
private fun isBrowserAdHost(url: String): Boolean {
    val host = try {
        URL(url).host.lowercase()
    } catch (_: Exception) {
        return false
    }
    return BROWSER_AD_HOST_MARKERS.any { host.contains(it) }
}

private val BROWSER_AD_HOST_MARKERS = listOf(
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

private fun shortBrowserUrl(url: String): String {
    val host = try {
        URL(url).host
    } catch (_: Exception) {
        ""
    }
    val tail = url.takeLast(48)
    return if (host.isNotEmpty()) "$host …$tail" else tail
}

/** Trang chủ tự dựng: lối tắt tới các trang video hay dùng. */
private const val START_PAGE_HTML = """
<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VDM</title>
<style>
body{font-family:sans-serif;background:#fafafa;color:#222;margin:0;padding:24px 16px}
h1{color:#DC2626;font-size:22px;margin:0 0 4px}
p{color:#666;font-size:14px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
a{display:block;background:#fff;border:1px solid #e5e5e5;border-radius:12px;
  padding:16px 12px;text-align:center;text-decoration:none;color:#222;
  font-weight:700;font-size:15px}
a span{display:block;font-weight:400;font-size:12px;color:#888;margin-top:4px}
</style></head><body>
<h1>VDM</h1>
<p>Trình duyệt đã bật chặn quảng cáo. Mở trang video, link tải được sẽ tự hiện phía trên.</p>
<div class="grid">
<a href="https://m.youtube.com">YouTube<span>Video</span></a>
<a href="https://m.facebook.com">Facebook<span>Mạng xã hội</span></a>
<a href="https://www.tiktok.com">TikTok<span>Video ngắn</span></a>
<a href="https://www.douyin.com">Douyin<span>Video ngắn</span></a>
<a href="https://x.com">X<span>Mạng xã hội</span></a>
<a href="https://www.reddit.com">Reddit<span>Cộng đồng</span></a>
<a href="https://www.google.com">Google<span>Tìm kiếm</span></a>
<a href="https://vimeo.com">Vimeo<span>Video</span></a>
</div></body></html>
"""
