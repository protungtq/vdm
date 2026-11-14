package tungtq.so1.asia

import android.annotation.TargetApi
import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.net.HttpURLConnection
import java.net.URL
import java.util.regex.Pattern
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tungtq.so1.asia.dl.Downloader

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

/** Một link video đã bắt được, kèm nhãn loại (rỗng nếu chưa rõ có logo hay không). */
private data class CapturedLink(val url: String, val label: String)

/**
 * Mở trang video Douyin trong trình duyệt của app và BẮT request video
 * (giống cách extension trên trình duyệt máy tính bắt link): khi trang tải
 * video, mọi request mạng đi qua shouldInterceptRequest, link nào trông như
 * file video sẽ được giữ lại để tải trực tiếp.
 *
 * Trình phát của Douyin chiếu bản CÓ logo (đầu playwm). Bản không logo lấy
 * bằng cách đổi playwm thành play trên cùng link, hoặc đọc play_addr trong
 * dữ liệu nhúng của trang share iesdouyin.com.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DouyinWebViewScreen(
    videoUrl: String,
    onVideoFound: (directUrl: String, pageTitle: String?, noWatermark: Boolean) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var webView by remember { mutableStateOf<WebView?>(null) }
    val capturedLinks = remember { mutableStateListOf<CapturedLink>() }
    var notified by remember { mutableStateOf(false) }
    var triedAutoLookup by remember { mutableStateOf(false) }
    var lookingUp by remember { mutableStateOf(false) }

    fun addCaptured(url: String, label: String) {
        if (capturedLinks.any { it.url == url }) return
        val link = CapturedLink(url, label)
        // Bản không logo luôn xếp lên đầu để dễ thấy.
        if (label == LABEL_NO_WATERMARK) {
            capturedLinks.add(0, link)
        } else {
            capturedLinks.add(link)
        }
    }

    fun notifyCaptured() {
        if (!notified) {
            notified = true
            Toast.makeText(context, "Đã bắt được link video.", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Tìm bản không logo bằng cách tải trang share iesdouyin.com của video rồi
     * đọc play_addr trong dữ liệu nhúng, đổi playwm thành play nếu cần.
     * [announceFailure] = true thì báo khi không tìm thấy (bấm nút tay);
     * lần tự chạy khi trang vừa tải xong thì im lặng nếu thất bại.
     */
    fun findNoWatermarkLink(announceFailure: Boolean) {
        val videoId = extractDouyinVideoId(videoUrl)
        if (videoId == null) {
            if (announceFailure) {
                Toast.makeText(
                    context,
                    "Không lấy được mã video từ link này.",
                    Toast.LENGTH_LONG,
                ).show()
            }
            return
        }
        if (lookingUp) return
        lookingUp = true
        scope.launch(Dispatchers.IO) {
            val found = fetchNoWatermarkUrl(videoId)
            withContext(Dispatchers.Main) {
                lookingUp = false
                if (found != null) {
                    addCaptured(found, LABEL_NO_WATERMARK)
                    Toast.makeText(
                        context,
                        "Đã tìm thấy bản không logo.",
                        Toast.LENGTH_SHORT,
                    ).show()
                } else if (announceFailure) {
                    Toast.makeText(
                        context,
                        "Không tìm thấy bản không logo. Thử tải link đã bắt được.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
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
                title = { Text("Douyin") },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Default.Close, contentDescription = "Đóng")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(0xFFDC2626),
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Text(
                "Đợi video hiện và chạy, app sẽ tự bắt link video và tìm bản không logo. " +
                    "Nếu trang hiện xác minh, hãy làm theo hướng dẫn trên trang.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (capturedLinks.isNotEmpty()) {
                Text(
                    "Đã bắt được ${capturedLinks.size} link video:",
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
                    items(capturedLinks, key = { it.url }) { captured ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                if (captured.label.isNotEmpty()) {
                                    "${captured.label} · ${shortUrl(captured.url)}"
                                } else {
                                    shortUrl(captured.url)
                                },
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Spacer(Modifier.width(8.dp))
                            OutlinedButton(onClick = {
                                onVideoFound(
                                    captured.url,
                                    webView?.title,
                                    captured.label == LABEL_NO_WATERMARK,
                                )
                            }) {
                                Icon(Icons.Default.Download, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Tải")
                            }
                        }
                    }
                }
            } else {
                OutlinedButton(
                    onClick = {
                        val wv = webView ?: return@OutlinedButton
                        wv.evaluateJavascript(EXTRACT_VIDEO_SRC_JS) { result ->
                            val src = parseJsStringResult(result)
                            if (src.isBlank() || src.startsWith("blob:")) {
                                Toast.makeText(
                                    context,
                                    "Chưa lấy được link. Hãy đợi video chạy rồi thử lại.",
                                    Toast.LENGTH_LONG,
                                ).show()
                            } else {
                                val clean = noWatermarkVariant(src)
                                if (clean != null) {
                                    onVideoFound(clean, wv.title, true)
                                } else {
                                    onVideoFound(src, wv.title, src.contains("/play/"))
                                }
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    Text("Lấy link từ trình phát")
                }
            }
            OutlinedButton(
                onClick = { findNoWatermarkLink(announceFailure = true) },
                enabled = !lookingUp,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 4.dp),
            ) {
                Text(if (lookingUp) "Đang tìm bản không logo…" else "Tìm bản không logo")
            }
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        // Giả dạng Chrome trên điện thoại để Douyin trả trang đầy đủ.
                        settings.userAgentString = Downloader.CHROME_UA
                        webViewClient = object : SafeWebViewClient() {
                            override fun shouldInterceptRequest(
                                view: WebView,
                                request: WebResourceRequest,
                            ): WebResourceResponse? {
                                val url = request.url.toString()
                                if (isLikelyVideoUrl(url)) {
                                    view.post {
                                        val clean = noWatermarkVariant(url)
                                        if (clean != null) {
                                            // Link gốc có logo, bản đổi playwm->play thì không.
                                            addCaptured(clean, LABEL_NO_WATERMARK)
                                            addCaptured(url, LABEL_WATERMARK)
                                        } else if (url.contains("/play/")) {
                                            addCaptured(url, LABEL_NO_WATERMARK)
                                        } else {
                                            addCaptured(url, "")
                                        }
                                        notifyCaptured()
                                    }
                                }
                                // Trả null để request chạy bình thường.
                                return null
                            }

                            override fun onPageFinished(view: WebView, url: String) {
                                super.onPageFinished(view, url)
                                // Trang vừa tải xong thì tự tìm bản không logo một lần.
                                if (!triedAutoLookup) {
                                    triedAutoLookup = true
                                    findNoWatermarkLink(announceFailure = false)
                                }
                            }
                        }
                        val cm = CookieManager.getInstance()
                        cm.setAcceptCookie(true)
                        cm.setAcceptThirdPartyCookies(this, true)
                        loadUrl(videoUrl)
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

/** Link nào trông như file video trực tiếp thì bắt. */
private fun isLikelyVideoUrl(url: String): Boolean {
    val lower = url.lowercase()
    // Loại ảnh và file phụ trước.
    if (lower.contains(".jpeg") || lower.contains(".jpg") ||
        lower.contains(".png") || lower.contains(".webp") ||
        lower.contains(".gif") || lower.contains(".css") ||
        lower.contains(".js")
    ) {
        return false
    }
    if (lower.contains(".mp4") || lower.contains(".mov") || lower.contains(".webm")) {
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

/**
 * Đổi link phát có logo (playwm) sang bản không logo (play).
 * Trả về null nếu link không chứa playwm.
 */
private fun noWatermarkVariant(url: String): String? {
    val rewritten = url.replace("/playwm/", "/play/")
    return if (rewritten != url) rewritten else null
}

/** Lấy mã số video từ link /video/<id> hoặc /note/<id> của Douyin. */
private fun extractDouyinVideoId(url: String): String? {
    val matcher = Pattern.compile("/(?:video|note)/(\\d+)").matcher(url)
    return if (matcher.find()) matcher.group(1) else null
}

/**
 * Tải trang share của video rồi đọc link phát không logo (play_addr) trong
 * dữ liệu nhúng của trang. Trả về null khi không lấy được.
 */
private fun fetchNoWatermarkUrl(videoId: String): String? {
    return try {
        val shareUrl = "https://www.iesdouyin.com/share/video/$videoId/"
        val connection = URL(shareUrl).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("User-Agent", Downloader.CHROME_UA)
        connection.setRequestProperty(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        // Gửi kèm cookie trình duyệt trong app nếu có, để trang share khỏi chặn.
        val cookies = CookieManager.getInstance().getCookie("https://www.douyin.com")
        if (!cookies.isNullOrBlank()) {
            connection.setRequestProperty("Cookie", cookies)
        }
        try {
            if (connection.responseCode !in 200..299) return null
            val html = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            extractPlayAddrUrl(html)
        } finally {
            connection.disconnect()
        }
    } catch (_: Exception) {
        null
    }
}

/** Tìm link đầu tiên trong play_addr.url_list của dữ liệu nhúng trong trang. */
private fun extractPlayAddrUrl(html: String): String? {
    // Trang nhúng JSON đã escape (\/ và \uXXXX) nên gỡ escape trước rồi mới tìm.
    val text = unescapeJsonText(html)
    val matcher = Pattern.compile(
        "\"play_addr\"\\s*:\\s*\\{[^}]*?\"url_list\"\\s*:\\s*\\[\\s*\"([^\"]+)\"",
        Pattern.DOTALL,
    ).matcher(text)
    if (!matcher.find()) return null
    val raw = matcher.group(1) ?: return null
    if (raw.isBlank()) return null
    return noWatermarkVariant(raw) ?: raw
}

/** Gỡ escape JSON (\/, \uXXXX, \\, \") trong một đoạn văn bản. */
private fun unescapeJsonText(raw: String): String {
    val out = StringBuilder(raw.length)
    var i = 0
    while (i < raw.length) {
        val c = raw[i]
        if (c == '\\' && i + 1 < raw.length) {
            when (raw[i + 1]) {
                '/' -> {
                    out.append('/')
                    i += 2
                }
                'u' -> {
                    if (i + 5 < raw.length) {
                        raw.substring(i + 2, i + 6).toIntOrNull(16)?.let { out.append(it.toChar()) }
                        i += 6
                    } else {
                        i += 2
                    }
                }
                '\\' -> {
                    out.append('\\')
                    i += 2
                }
                '"' -> {
                    out.append('"')
                    i += 2
                }
                else -> {
                    out.append(raw[i + 1])
                    i += 2
                }
            }
        } else {
            out.append(c)
            i += 1
        }
    }
    return out.toString()
}

private fun shortUrl(url: String): String {
    val host = try {
        URL(url).host
    } catch (_: Exception) {
        ""
    }
    val tail = url.takeLast(48)
    return if (host.isNotEmpty()) "$host …$tail" else tail
}

private const val EXTRACT_VIDEO_SRC_JS =
    "(function(){var v=document.querySelector('video');if(!v)return '';" +
        "var s=v.currentSrc||v.src||'';" +
        "if(!s){var so=v.querySelector('source');if(so)s=so.src||'';}" +
        "return s;})()"

/** evaluateJavascript trả về chuỗi JSON (có ngoặc kép, đã escape). */
private fun parseJsStringResult(result: String?): String {
    if (result.isNullOrBlank() || result == "null") return ""
    var text = result.trim()
    if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
        text = text.substring(1, text.length - 1)
    }
    return text
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\/", "/")
}
