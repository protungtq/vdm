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
import androidx.compose.material3.Button
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.net.URL
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

/**
 * Mở trang video Douyin trong trình duyệt của app và BẮT request video
 * (giống cách extension trên trình duyệt máy tính bắt link): khi trang tải
 * video, mọi request mạng đi qua shouldInterceptRequest, link nào trông như
 * file video sẽ được giữ lại để tải trực tiếp.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DouyinWebViewScreen(
    videoUrl: String,
    onVideoFound: (directUrl: String, pageTitle: String?) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    val capturedUrls = remember { mutableStateListOf<String>() }
    var notified by remember { mutableStateOf(false) }

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
                "Đợi video hiện và chạy, app sẽ tự bắt link video. " +
                    "Nếu trang hiện xác minh, hãy làm theo hướng dẫn trên trang.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (capturedUrls.isNotEmpty()) {
                Text(
                    "Đã bắt được ${capturedUrls.size} link video:",
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
                    items(capturedUrls, key = { it }) { captured ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                shortUrl(captured),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Spacer(Modifier.width(8.dp))
                            OutlinedButton(onClick = {
                                onVideoFound(captured, webView?.title)
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
                                onVideoFound(src, wv.title)
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
                                        if (!capturedUrls.contains(url)) {
                                            capturedUrls.add(url)
                                            if (!notified) {
                                                notified = true
                                                Toast.makeText(
                                                    context,
                                                    "Đã bắt được link video.",
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                            }
                                        }
                                    }
                                }
                                // Trả null để request chạy bình thường.
                                return null
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
