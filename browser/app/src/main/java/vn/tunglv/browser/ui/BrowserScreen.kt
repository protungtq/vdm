package vn.tunglv.browser.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import vn.tunglv.browser.BrowserViewModel
import vn.tunglv.browser.data.BookmarkStore
import vn.tunglv.browser.data.SettingsStore
import vn.tunglv.browser.data.searchEngineById
import vn.tunglv.browser.filter.FilterStore
import vn.tunglv.browser.web.HOME_URL
import vn.tunglv.browser.web.TabManager
import vn.tunglv.browser.web.TabSession
import vn.tunglv.browser.web.resolveInput

private val VnRed = Color(0xFFDC2626)

private enum class AppScreen {
    BROWSER,
    TABS,
    HISTORY,
    BOOKMARKS,
    SETTINGS,
}

@Composable
fun BrowserApp(viewModel: BrowserViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val tabManager = remember {
        TabManager(context, context.applicationContext, scope)
    }
    var screen by remember { mutableStateOf(AppScreen.BROWSER) }
    val settings by SettingsStore.settings.collectAsState()
    val externalUrl by viewModel.externalUrl.collectAsState()
    val crashReport by viewModel.crashReport.collectAsState()

    LaunchedEffect(Unit) {
        tabManager.restoreIfNeeded()
        FilterStore.refreshIfNeeded(context)
    }

    // Link từ app khác gửi sang: mở thành tab mới.
    LaunchedEffect(externalUrl) {
        val text = externalUrl ?: return@LaunchedEffect
        val target = resolveInput(text, searchEngineById(settings.searchEngineId))
        if (target.isNotBlank()) {
            tabManager.createTab(target, activate = true)
            screen = AppScreen.BROWSER
        }
        viewModel.consumeExternalUrl()
    }

    DisposableEffect(Unit) {
        onDispose { tabManager.destroy() }
    }

    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = VnRed,
            onPrimary = Color.White,
        ),
    ) {
        when (screen) {
            AppScreen.TABS -> TabSwitcherScreen(
                tabs = tabManager.tabs,
                activeTabId = tabManager.activeTabId.value,
                onSelect = { id ->
                    tabManager.selectTab(id)
                    screen = AppScreen.BROWSER
                },
                onClose = tabManager::closeTab,
                onNewTab = {
                    tabManager.createTab(HOME_URL, activate = true)
                    screen = AppScreen.BROWSER
                },
                onCloseAll = {
                    tabManager.closeAllTabs()
                    screen = AppScreen.BROWSER
                },
                onBack = { screen = AppScreen.BROWSER },
            )
            AppScreen.HISTORY -> HistoryScreen(
                onOpen = { url ->
                    tabManager.createTab(url, activate = true)
                    screen = AppScreen.BROWSER
                },
                onBack = { screen = AppScreen.BROWSER },
            )
            AppScreen.BOOKMARKS -> BookmarksScreen(
                onOpen = { url ->
                    tabManager.createTab(url, activate = true)
                    screen = AppScreen.BROWSER
                },
                onBack = { screen = AppScreen.BROWSER },
            )
            AppScreen.SETTINGS -> SettingsScreen(
                onBack = { screen = AppScreen.BROWSER },
            )
            AppScreen.BROWSER -> BrowserMainScreen(
                tabManager = tabManager,
                onOpenTabs = { screen = AppScreen.TABS },
                onOpenHistory = { screen = AppScreen.HISTORY },
                onOpenBookmarks = { screen = AppScreen.BOOKMARKS },
                onOpenSettings = { screen = AppScreen.SETTINGS },
            )
        }
        crashReport?.let { report ->
            CrashReportDialog(report = report, onClose = viewModel::dismissCrashReport)
        }
    }
}

@Composable
private fun BrowserMainScreen(
    tabManager: TabManager,
    onOpenTabs: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenBookmarks: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val activeTab = tabManager.activeTab
    val settings by SettingsStore.settings.collectAsState()
    val blockedCount by FilterStore.blockedCount.collectAsState()
    val bookmarks by BookmarkStore.bookmarks.collectAsState()

    var addressText by remember { mutableStateOf("") }
    var addressFocused by remember { mutableStateOf(false) }
    var menuExpanded by remember { mutableStateOf(false) }

    val tabUrl = activeTab?.url?.value ?: ""
    val tabIsStartPage = activeTab?.isStartPage?.value ?: true
    val tabTitle = activeTab?.title?.value ?: ""
    val tabProgress = activeTab?.progress?.intValue ?: 100
    val tabCanGoBack = activeTab?.canGoBack?.value ?: false
    val tabCanGoForward = activeTab?.canGoForward?.value ?: false

    // Địa chỉ trang đổi thì thanh địa chỉ hiện theo, trừ lúc đang gõ.
    LaunchedEffect(activeTab?.id, tabUrl, tabIsStartPage) {
        if (!addressFocused) {
            addressText = if (tabIsStartPage) "" else tabUrl
        }
    }

    fun goTo(input: String) {
        val tab = activeTab ?: return
        focusManager.clearFocus()
        tabManager.navigate(tab, input, searchEngineById(settings.searchEngineId))
    }

    BackHandler(enabled = tabCanGoBack) {
        activeTab?.let { tabManager.goBack(it) }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
        ) {
            // Công tắc chặn quảng cáo + số request đã chặn.
            IconButton(onClick = {
                val next = !settings.adBlockEnabled
                SettingsStore.update(adBlockEnabled = next)
                Toast.makeText(
                    context,
                    if (next) "Đã bật chặn quảng cáo." else "Đã tắt chặn quảng cáo.",
                    Toast.LENGTH_SHORT,
                ).show()
            }) {
                Icon(
                    Icons.Default.Shield,
                    contentDescription = if (settings.adBlockEnabled) {
                        "Đang chặn quảng cáo, bấm để tắt"
                    } else {
                        "Đã tắt chặn quảng cáo, bấm để bật"
                    },
                    tint = if (settings.adBlockEnabled) VnRed else Color.Gray,
                )
            }
            Text(
                "$blockedCount",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedTextField(
                value = addressText,
                onValueChange = { addressText = it },
                placeholder = { Text("Nhập địa chỉ hoặc từ khóa…") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { goTo(addressText) }),
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 4.dp)
                    .onFocusChanged { addressFocused = it.isFocused },
            )
            // Nút xem tab, hiện số tab đang mở.
            IconButton(onClick = onOpenTabs) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .border(2.dp, MaterialTheme.colorScheme.onSurface, RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "${tabManager.tabs.size}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "Thêm")
                }
                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("Tab mới") },
                        onClick = {
                            menuExpanded = false
                            tabManager.createTab(HOME_URL, activate = true)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Lịch sử") },
                        onClick = {
                            menuExpanded = false
                            onOpenHistory()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Dấu trang") },
                        onClick = {
                            menuExpanded = false
                            onOpenBookmarks()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Cài đặt") },
                        onClick = {
                            menuExpanded = false
                            onOpenSettings()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Sao chép link") },
                        onClick = {
                            menuExpanded = false
                            if (tabUrl.isNotBlank()) {
                                val clip = ClipData.newPlainText("Link", tabUrl)
                                (context.getSystemService(Context.CLIPBOARD_SERVICE)
                                    as ClipboardManager).setPrimaryClip(clip)
                                Toast.makeText(context, "Đã sao chép link.", Toast.LENGTH_SHORT).show()
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Chia sẻ link") },
                        onClick = {
                            menuExpanded = false
                            if (tabUrl.isNotBlank()) {
                                val intent = Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, tabUrl)
                                }
                                context.startActivity(Intent.createChooser(intent, "Chia sẻ link"))
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Mở bằng app khác") },
                        onClick = {
                            menuExpanded = false
                            if (tabUrl.isNotBlank()) {
                                try {
                                    context.startActivity(
                                        Intent(Intent.ACTION_VIEW, Uri.parse(tabUrl)),
                                    )
                                } catch (_: Exception) {
                                    Toast.makeText(
                                        context,
                                        "Không mở được link này.",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        },
                    )
                }
            }
        }
        if (tabProgress in 1..99) {
            LinearProgressIndicator(
                progress = { tabProgress / 100f },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (activeTab == null) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        } else {
            AndroidView(
                factory = { ctx -> FrameLayout(ctx) },
                update = { container ->
                    val tab: TabSession = activeTab
                    val webView = tabManager.ensureWebView(tab)
                    if (webView.parent !== container) {
                        (webView.parent as? ViewGroup)?.removeView(webView)
                        container.removeAllViews()
                        container.addView(
                            webView,
                            FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT,
                                FrameLayout.LayoutParams.MATCH_PARENT,
                            ),
                        )
                    }
                },
                onRelease = { container ->
                    // Chỉ gỡ WebView khỏi khung, tab vẫn giữ WebView để mở lại.
                    container.removeAllViews()
                },
                modifier = Modifier.weight(1f),
            )
        }
        // Thanh dưới: điều hướng, trang chủ, dấu trang.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = { activeTab?.let { tabManager.goBack(it) } },
                enabled = tabCanGoBack,
            ) {
                Icon(Icons.Default.ArrowBack, contentDescription = "Quay lại")
            }
            IconButton(
                onClick = { activeTab?.let { tabManager.goForward(it) } },
                enabled = tabCanGoForward,
            ) {
                Icon(Icons.Default.ArrowForward, contentDescription = "Tiến tới")
            }
            IconButton(onClick = { activeTab?.let { tabManager.openStartPage(it) } }) {
                Icon(Icons.Default.Home, contentDescription = "Trang chủ")
            }
            IconButton(onClick = { activeTab?.let { tabManager.reload(it) } }) {
                Icon(Icons.Default.Refresh, contentDescription = "Tải lại")
            }
            val bookmarked = tabUrl.isNotBlank() && bookmarks.any { it.url == tabUrl }
            IconButton(
                onClick = {
                    if (tabUrl.isBlank()) return@IconButton
                    val nowMarked = BookmarkStore.toggle(tabUrl, tabTitle)
                    Toast.makeText(
                        context,
                        if (nowMarked) "Đã thêm dấu trang." else "Đã gỡ dấu trang.",
                        Toast.LENGTH_SHORT,
                    ).show()
                },
                enabled = tabUrl.isNotBlank(),
            ) {
                Icon(
                    Icons.Default.Star,
                    contentDescription = if (bookmarked) "Đã gắn dấu trang" else "Gắn dấu trang",
                    tint = if (bookmarked) VnRed else Color.Gray,
                )
            }
        }
    }
}

/** Hộp hiện chi tiết lỗi làm app tự đóng ở lần mở trước, để sao chép gửi đi. */
@Composable
private fun CrashReportDialog(report: String, onClose: () -> Unit) {
    val context = LocalContext.current
    Dialog(onDismissRequest = onClose) {
        Card {
            Column(Modifier.padding(16.dp)) {
                Text("App gặp lỗi lần mở trước", fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(
                    "Lần mở trước, app tự đóng vì lỗi. Chi tiết ở dưới — " +
                        "sao chép rồi gửi cho người làm app để sửa nhé.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    report,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 400.dp)
                        .verticalScroll(rememberScrollState()),
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = {
                        val clip = ClipData.newPlainText("Chi tiết lỗi VN Browser", report)
                        (context.getSystemService(Context.CLIPBOARD_SERVICE)
                            as ClipboardManager).setPrimaryClip(clip)
                        Toast.makeText(
                            context,
                            "Đã sao chép chi tiết lỗi.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }) { Text("Sao chép") }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = onClose) { Text("Đóng") }
                }
            }
        }
    }
}
