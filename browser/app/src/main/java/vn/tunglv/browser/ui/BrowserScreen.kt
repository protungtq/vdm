package vn.tunglv.browser.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

    VnBrowserTheme(themeMode = settings.themeMode) {
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
    var downloadSheet by remember { mutableStateOf<Pair<String, String?>?>(null) }

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
                .background(MaterialTheme.colorScheme.surfaceContainerLow)
                // Android 15 vẽ tràn lên thanh trạng thái: chừa chỗ cho nó
                // thì hàng công cụ mới không bị lố lên trên màn hình.
                .statusBarsPadding()
                .padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            // Chip chặn quảng cáo: khiên + số request đã chặn, bấm để bật/tắt.
            Surface(
                onClick = {
                    val next = !settings.adBlockEnabled
                    SettingsStore.update(adBlockEnabled = next)
                    Toast.makeText(
                        context,
                        if (next) "Đã bật chặn quảng cáo." else "Đã tắt chặn quảng cáo.",
                        Toast.LENGTH_SHORT,
                    ).show()
                },
                shape = CircleShape,
                color = if (settings.adBlockEnabled) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHigh
                },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Icon(
                        Icons.Default.Shield,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = if (settings.adBlockEnabled) {
                            MaterialTheme.colorScheme.onPrimaryContainer
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        "$blockedCount",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (settings.adBlockEnabled) {
                            MaterialTheme.colorScheme.onPrimaryContainer
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            // Ô địa chỉ dạng pill 44dp: OutlinedTextField mặc định cao 56dp, đặt
            // trong hàng công cụ trông lố và đẩy các nút khác lệch.
            BasicTextField(
                value = addressText,
                onValueChange = { addressText = it },
                singleLine = true,
                textStyle = TextStyle(
                    fontSize = 15.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { goTo(addressText) }),
                modifier = Modifier
                    .weight(1f)
                    .onFocusChanged { addressFocused = it.isFocused },
                decorationBox = { innerTextField ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .background(
                                MaterialTheme.colorScheme.surfaceContainerHigh,
                                RoundedCornerShape(22.dp),
                            )
                            .height(44.dp)
                            .padding(horizontal = 12.dp),
                    ) {
                        Icon(
                            if (tabUrl.startsWith("https://")) Icons.Default.Lock else Icons.Default.Search,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(8.dp))
                        Box(Modifier.weight(1f)) {
                            if (addressText.isEmpty()) {
                                Text(
                                    "Nhập địa chỉ hoặc từ khóa…",
                                    fontSize = 15.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            innerTextField()
                        }
                        if (addressFocused && addressText.isNotEmpty()) {
                            IconButton(
                                onClick = { addressText = "" },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    Icons.Default.Close,
                                    contentDescription = "Xóa địa chỉ",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                },
            )
            Spacer(Modifier.width(6.dp))
            // Nút xem tab, hiện số tab đang mở.
            Surface(
                onClick = onOpenTabs,
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.size(40.dp),
            ) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "${tabManager.tabs.size}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            // Nút tải media của trang đang mở, kèm số link đã bắt được.
            Box {
                IconButton(
                    onClick = {
                        val cookies = try {
                            CookieManager.getInstance().getCookie(tabUrl)
                        } catch (_: Exception) {
                            null
                        }
                        downloadSheet = tabUrl to cookies
                    },
                    enabled = tabUrl.startsWith("http://") || tabUrl.startsWith("https://"),
                ) {
                    Icon(Icons.Default.Download, contentDescription = "Tải media của trang này")
                }
                val captureCount = activeTab?.capturedMedia?.size ?: 0
                if (captureCount > 0) {
                    Surface(
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 2.dp, end = 2.dp),
                    ) {
                        Text(
                            "$captureCount",
                            color = MaterialTheme.colorScheme.onPrimary,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                        )
                    }
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
                        leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            tabManager.createTab(HOME_URL, activate = true)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Lịch sử") },
                        leadingIcon = { Icon(Icons.Default.History, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            onOpenHistory()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Dấu trang") },
                        leadingIcon = { Icon(Icons.Default.Star, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            onOpenBookmarks()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Cài đặt") },
                        leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            onOpenSettings()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Sao chép link") },
                        leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
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
                        leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
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
                        leadingIcon = { Icon(Icons.Default.OpenInNew, contentDescription = null) },
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
                color = MaterialTheme.colorScheme.primary,
                trackColor = Color.Transparent,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
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
        // Thanh dưới: nền riêng + nhãn dưới mỗi nút để nhìn là biết nút gì.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerLow)
                .navigationBarsPadding(),
        ) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BottomBarButton(
                    icon = Icons.Default.ArrowBack,
                    label = "Quay lại",
                    enabled = tabCanGoBack,
                    active = false,
                    onClick = { activeTab?.let { tabManager.goBack(it) } },
                    modifier = Modifier.weight(1f),
                )
                BottomBarButton(
                    icon = Icons.Default.ArrowForward,
                    label = "Tiến tới",
                    enabled = tabCanGoForward,
                    active = false,
                    onClick = { activeTab?.let { tabManager.goForward(it) } },
                    modifier = Modifier.weight(1f),
                )
                BottomBarButton(
                    icon = Icons.Default.Home,
                    label = "Trang chủ",
                    enabled = true,
                    active = tabIsStartPage,
                    onClick = { activeTab?.let { tabManager.openStartPage(it) } },
                    modifier = Modifier.weight(1f),
                )
                BottomBarButton(
                    icon = Icons.Default.Refresh,
                    label = "Tải lại",
                    enabled = true,
                    active = false,
                    onClick = { activeTab?.let { tabManager.reload(it) } },
                    modifier = Modifier.weight(1f),
                )
                val bookmarked = tabUrl.isNotBlank() && bookmarks.any { it.url == tabUrl }
                BottomBarButton(
                    icon = Icons.Default.Star,
                    label = "Dấu trang",
                    enabled = tabUrl.isNotBlank(),
                    active = bookmarked,
                    onClick = {
                        if (tabUrl.isBlank()) return@BottomBarButton
                        val nowMarked = BookmarkStore.toggle(tabUrl, tabTitle)
                        Toast.makeText(
                            context,
                            if (nowMarked) "Đã thêm dấu trang." else "Đã gỡ dấu trang.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
    downloadSheet?.let { (sheetUrl, sheetCookies) ->
        val tabCaptures = activeTab?.capturedMedia?.toList().orEmpty()
        DownloadSheet(
            pageUrl = sheetUrl,
            cookieString = sheetCookies,
            captures = tabCaptures,
            pageTitle = tabTitle,
            onClose = { downloadSheet = null },
        )
    }
}

/** Một nút ở thanh dưới: icon + nhãn nhỏ bên dưới, nút đang bật thì đỏ. */
@Composable
private fun BottomBarButton(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tint = when {
        !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
        active -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 6.dp),
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
        Spacer(Modifier.height(2.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = tint)
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
