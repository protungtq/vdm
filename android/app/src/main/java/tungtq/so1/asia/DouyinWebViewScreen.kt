package tungtq.so1.asia

import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import tungtq.so1.asia.dl.Downloader

/**
 * Mở trang video Douyin trong trình duyệt của app rồi đọc link video trực tiếp
 * từ thẻ <video> của trang. Douyin chặn API mà bộ quét dùng, nhưng link video
 * mà trình duyệt đang phát thì tải trực tiếp được.
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
                "Đợi video hiện và chạy, rồi bấm Lấy link video. " +
                    "Nếu trang hiện xác minh, hãy làm theo hướng dẫn trên trang.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Button(
                onClick = {
                    val wv = webView ?: return@Button
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
                Text("Lấy link video")
            }
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        // Giả dạng Chrome trên điện thoại để Douyin trả trang đầy đủ.
                        settings.userAgentString = Downloader.CHROME_UA
                        webViewClient = WebViewClient()
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
