package vn.tunglv.browser.ui

import android.net.Uri
import android.webkit.CookieManager
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.yausername.youtubedl_android.YoutubeDL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import vn.tunglv.browser.BuildConfig
import vn.tunglv.browser.data.BackupManager
import vn.tunglv.browser.data.BookmarkStore
import vn.tunglv.browser.data.HistoryStore
import vn.tunglv.browser.data.SEARCH_ENGINES
import vn.tunglv.browser.data.SettingsStore
import vn.tunglv.browser.filter.FilterStore

/** Màn hình cài đặt: chặn quảng cáo, tìm kiếm, sao lưu, xóa dữ liệu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings by SettingsStore.settings.collectAsState()
    val blockedCount by FilterStore.blockedCount.collectAsState()
    var backupMessage by remember { mutableStateOf("") }
    var engineMessage by remember { mutableStateOf("") }
    var updatingEngine by remember { mutableStateOf(false) }
    var confirmClearHistory by remember { mutableStateOf(false) }
    var confirmClearBookmarks by remember { mutableStateOf(false) }

    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            val text = BackupManager.exportData(context)
            context.contentResolver.openOutputStream(uri)?.use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
            }
            backupMessage = "Đã xuất file sao lưu."
        } catch (e: Exception) {
            backupMessage = "Xuất file sao lưu thất bại: ${e.message ?: "lỗi không rõ"}"
        }
    }

    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            val text = context.contentResolver.openInputStream(uri)?.use { input ->
                input.bufferedReader(Charsets.UTF_8).readText()
            } ?: return@rememberLauncherForActivityResult
            val result = BackupManager.importData(context, text)
            backupMessage = if (result.error != null) {
                result.error
            } else {
                "Đã khôi phục: ${result.bookmarksAdded} dấu trang, " +
                    "${result.historyAdded} mục lịch sử, " +
                    "${result.tabsRestored} tab đã lưu (mở lại khi mở app lần sau)."
            }
        } catch (e: Exception) {
            backupMessage = "Khôi phục thất bại: ${e.message ?: "lỗi không rõ"}"
        }
    }

    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Cài đặt") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Quay lại")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                ),
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.height(8.dp))
            SectionTitle("Giao diện")
            Spacer(Modifier.height(4.dp))
            Text(
                "Chế độ sáng/tối của app.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(4.dp))
            for ((mode, label) in listOf(
                "system" to "Theo hệ thống",
                "light" to "Sáng",
                "dark" to "Tối",
            )) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { SettingsStore.update(themeMode = mode) }
                        .padding(vertical = 6.dp),
                ) {
                    RadioButton(
                        selected = settings.themeMode == mode,
                        onClick = { SettingsStore.update(themeMode = mode) },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(label)
                }
            }

            Spacer(Modifier.height(24.dp))
            SectionTitle("Chặn quảng cáo")
            Spacer(Modifier.height(8.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Bật chặn quảng cáo")
                    Text(
                        "Đã chặn $blockedCount request từ lúc mở app.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(
                    checked = settings.adBlockEnabled,
                    onCheckedChange = { checked ->
                        SettingsStore.update(adBlockEnabled = checked)
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    FilterStore.refreshIfNeeded(context)
                    Toast.makeText(
                        context,
                        "Đang kiểm tra bộ lọc mới…",
                        Toast.LENGTH_SHORT,
                    ).show()
                },
            ) { Text("Kiểm tra bộ lọc mới") }
            Text(
                "Bộ lọc: FMSF 2.0, ABPVN, AdGuard Mobile Ads, EasyList. " +
                    "App tự kiểm tra bản mới mỗi 24 giờ.",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(24.dp))
            SectionTitle("Tìm kiếm")
            Spacer(Modifier.height(4.dp))
            Text(
                "Công cụ tìm kiếm dùng khi gõ từ khóa ở thanh địa chỉ.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(4.dp))
            for (engine in SEARCH_ENGINES) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            SettingsStore.update(searchEngineId = engine.id)
                        }
                        .padding(vertical = 6.dp),
                ) {
                    RadioButton(
                        selected = settings.searchEngineId == engine.id,
                        onClick = { SettingsStore.update(searchEngineId = engine.id) },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(engine.name)
                }
            }

            Spacer(Modifier.height(24.dp))
            SectionTitle("Sao lưu và khôi phục")
            Spacer(Modifier.height(8.dp))
            Row {
                Button(
                    onClick = {
                        val stamp = SimpleDateFormat("yyyyMMdd-HHmm", Locale.US)
                            .format(Date())
                        exportLauncher.launch("vn-browser-backup-$stamp.json")
                    },
                ) { Text("Xuất file sao lưu") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = { importLauncher.launch(arrayOf("application/json")) }) {
                    Text("Khôi phục từ file")
                }
            }
            if (backupMessage.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(backupMessage, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                "File sao lưu gồm dấu trang, lịch sử, cài đặt và tab đã lưu. " +
                    "Khôi phục sẽ gộp thêm, không xóa dữ liệu đang có.",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(24.dp))
            SectionTitle("Dữ liệu")
            Spacer(Modifier.height(8.dp))
            Row {
                OutlinedButton(onClick = { confirmClearHistory = true }) {
                    Text("Xóa lịch sử")
                }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = { confirmClearBookmarks = true }) {
                    Text("Xóa dấu trang")
                }
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    CookieManager.getInstance().removeAllCookies(null)
                    CookieManager.getInstance().flush()
                    Toast.makeText(
                        context,
                        "Đã xóa cookie. Các trang đã đăng nhập sẽ phải đăng nhập lại.",
                        Toast.LENGTH_SHORT,
                    ).show()
                },
            ) { Text("Xóa cookie") }

            Spacer(Modifier.height(24.dp))
            SectionTitle("Bộ máy tải")
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    updatingEngine = true
                    engineMessage = ""
                    scope.launch {
                        try {
                            val status = withContext(Dispatchers.IO) {
                                YoutubeDL.getInstance().updateYoutubeDL(
                                    context.applicationContext,
                                    YoutubeDL.UpdateChannel.STABLE,
                                )
                            }
                            engineMessage =
                                if (status == YoutubeDL.UpdateStatus.ALREADY_UP_TO_DATE) {
                                    "Bộ quét đã là bản mới nhất rồi."
                                } else {
                                    "Bộ quét đã lên bản mới nhất."
                                }
                        } catch (e: Exception) {
                            engineMessage =
                                "Cập nhật bộ quét thất bại: ${e.message ?: "lỗi không rõ"}"
                        } finally {
                            updatingEngine = false
                        }
                    }
                },
                enabled = !updatingEngine,
            ) { Text(if (updatingEngine) "Đang cập nhật…" else "Cập nhật bộ quét") }
            if (engineMessage.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(engineMessage, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                "Bộ quét (yt-dlp) cần bản mới để theo kịp thay đổi của các trang video.",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(24.dp))
            SectionTitle("Giới thiệu")
            Spacer(Modifier.height(8.dp))
            Text("VN Browser ${BuildConfig.VERSION_NAME}")
            Text(
                "Trình duyệt gọn nhẹ, chặn quảng cáo, nhiều tab, lịch sử, " +
                    "dấu trang và sao lưu.",
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "Được làm bởi TungTQ.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(24.dp))
        }
        if (confirmClearHistory) {
            AlertDialog(
                onDismissRequest = { confirmClearHistory = false },
                title = { Text("Xóa hết lịch sử?") },
                text = { Text("Toàn bộ lịch sử duyệt web sẽ bị xóa, không khôi phục lại được.") },
                confirmButton = {
                    TextButton(onClick = {
                        HistoryStore.clear()
                        confirmClearHistory = false
                    }) { Text("Xóa hết") }
                },
                dismissButton = {
                    TextButton(onClick = { confirmClearHistory = false }) { Text("Giữ lại") }
                },
            )
        }
        if (confirmClearBookmarks) {
            AlertDialog(
                onDismissRequest = { confirmClearBookmarks = false },
                title = { Text("Xóa hết dấu trang?") },
                text = { Text("Toàn bộ dấu trang sẽ bị xóa, không khôi phục lại được.") },
                confirmButton = {
                    TextButton(onClick = {
                        BookmarkStore.clear()
                        confirmClearBookmarks = false
                    }) { Text("Xóa hết") }
                },
                dismissButton = {
                    TextButton(onClick = { confirmClearBookmarks = false }) { Text("Giữ lại") }
                },
            )
        }
    }
}

/** Tiêu đề một nhóm cài đặt: chữ đậm màu đỏ chủ đạo. */
@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
    )
}
