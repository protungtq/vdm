package tungtq.so1.asia

import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import tungtq.so1.asia.dl.CookiePlatform
import tungtq.so1.asia.dl.CookieStore

/** Màn hình chọn nền tảng để lấy cookie, kèm trạng thái đã có/chưa có cookie. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CookiePlatformsScreen(
    onOpenPlatform: (CookiePlatform) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var states by remember { mutableStateOf(mapOf<CookiePlatform, Boolean>()) }
    var refreshKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(refreshKey) {
        states = CookiePlatform.entries.associateWith { CookieStore.hasCookies(context, it) }
    }
    BackHandler(onBack = onClose)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Cookie & đăng nhập") },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Quay lại")
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
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                "Một số link cần đăng nhập hoặc cookie mới tải được. " +
                    "Cookie chỉ lưu trong máy này, không gửi đi đâu.",
                style = MaterialTheme.typography.bodySmall,
            )
            CookiePlatform.entries.forEach { platform ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenPlatform(platform) }
                        .padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(platform.label, fontWeight = FontWeight.Bold)
                        Text(
                            if (states[platform] == true) "Đã có cookie" else "Chưa có cookie",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (states[platform] == true) {
                        TextButton(onClick = {
                            CookieStore.clearCookies(context, platform)
                            refreshKey++
                        }) {
                            Text("Xóa")
                        }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}

/** Trình duyệt trong app để đăng nhập (hoặc chỉ mở trang) rồi lưu cookie. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CookieWebViewScreen(platform: CookiePlatform, onClose: () -> Unit) {
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
                title = { Text(platform.label) },
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
                platform.hint,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Button(
                onClick = {
                    val cm = CookieManager.getInstance()
                    val merged = CookieStore.mergeCookieStrings(
                        *platform.cookieUrls.map { cm.getCookie(it) }.toTypedArray(),
                    )
                    if (merged.isBlank()) {
                        Toast.makeText(
                            context,
                            "Chưa thấy cookie. Hãy đợi trang tải xong hoặc đăng nhập rồi thử lại.",
                            Toast.LENGTH_LONG,
                        ).show()
                    } else {
                        CookieStore.saveCookies(context, platform, merged)
                        Toast.makeText(
                            context,
                            "Đã lưu cookie ${platform.label}.",
                            Toast.LENGTH_SHORT,
                        ).show()
                        onClose()
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 4.dp),
            ) {
                Text("Lưu cookie")
            }
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        webViewClient = WebViewClient()
                        val cm = CookieManager.getInstance()
                        cm.setAcceptCookie(true)
                        cm.setAcceptThirdPartyCookies(this, true)
                        loadUrl(platform.startUrl)
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
