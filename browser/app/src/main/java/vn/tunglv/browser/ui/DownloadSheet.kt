package vn.tunglv.browser.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import vn.tunglv.browser.BrowserApplication
import vn.tunglv.browser.dl.DownloadService
import vn.tunglv.browser.dl.DownloadState
import vn.tunglv.browser.dl.MediaDownload
import vn.tunglv.browser.dl.ScannedVideo
import vn.tunglv.browser.dl.VideoFormatOption

private enum class ScanState { PREPARING, SCANNING, READY, FAILED }

/**
 * Bảng quét link trang đang mở tìm media để tải: quét xong hiện danh sách
 * chất lượng, bấm tải thì chạy nền qua DownloadService.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadSheet(
    pageUrl: String,
    cookieString: String?,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val download by DownloadState.state.collectAsState()
    var scanState by remember { mutableStateOf(ScanState.PREPARING) }
    var scanned by remember { mutableStateOf<ScannedVideo?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<VideoFormatOption?>(null) }
    var pendingDownload by remember { mutableStateOf(false) }

    suspend fun runScan() {
        scanState = ScanState.PREPARING
        // Chờ bộ máy yt-dlp sẵn sàng (lần đầu mở app cần giải nén native libs).
        val ready = withTimeoutOrNull(90_000L) {
            combine(
                BrowserApplication.engineReady,
                BrowserApplication.engineError,
            ) { ready, error -> ready to error }.first { (r, e) -> r || e != null }
        } ?: (false to "Bộ máy tải chuẩn bị quá lâu.")
        if (!ready.first) {
            errorMessage = ready.second ?: "Không khởi tạo được bộ máy tải."
            scanState = ScanState.FAILED
            return
        }
        scanState = ScanState.SCANNING
        try {
            val cookieFile = MediaDownload.writeCookieFile(context, pageUrl, cookieString)
            val result = MediaDownload.fetchInfo(pageUrl, cookieFile)
            scanned = result
            selected = result.options.firstOrNull()
            scanState = ScanState.READY
        } catch (e: Exception) {
            errorMessage = e.message ?: "Không quét được link này."
            scanState = ScanState.FAILED
        }
    }

    LaunchedEffect(pageUrl) {
        DownloadState.reset()
        runScan()
    }

    fun hasStorageAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            ) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    lateinit var tryStartDownload: () -> Unit

    val settingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        if (pendingDownload && hasStorageAccess()) {
            tryStartDownload()
        } else {
            pendingDownload = false
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        if (pendingDownload) tryStartDownload()
    }

    val storagePermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted && pendingDownload) tryStartDownload() else pendingDownload = false
    }

    fun openAllFilesAccessSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = Uri.parse("package:${ctx.packageName}")
            }
            settingsLauncher.launch(intent)
        } else {
            storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    tryStartDownload = {
        val option = selected
        val video = scanned
        if (option == null || video == null) return@tryStartDownload
        if (!hasStorageAccess()) {
            pendingDownload = true
            openAllFilesAccessSettings(context)
        } else if (!hasNotificationPermission()) {
            pendingDownload = true
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            pendingDownload = false
            DownloadService.start(context, pageUrl, option, video.title, cookieString)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Text("Tải media của trang này", fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            when (scanState) {
                ScanState.PREPARING -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Đang chuẩn bị bộ máy tải…")
                    }
                }
                ScanState.SCANNING -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Đang quét link, chờ chút…")
                    }
                }
                ScanState.FAILED -> {
                    Text(
                        errorMessage ?: "Không quét được link này.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { scope.launch { runScan() } }) { Text("Thử lại") }
                        OutlinedButton(onClick = onClose) { Text("Đóng") }
                    }
                }
                ScanState.READY -> {
                    val video = scanned
                    if (video != null) {
                    video.thumbnailUrl?.let { thumb ->
                        AsyncImage(
                            model = thumb,
                            contentDescription = null,
                            modifier = Modifier
                                .fillMaxWidth()
                                .aspectRatio(16f / 9f)
                                .clip(RoundedCornerShape(8.dp)),
                        )
                        Spacer(Modifier.height(12.dp))
                    }
                    Text(video.title, fontWeight = FontWeight.Bold)
                    if (video.viaFallback) {
                        Text(
                            "Đang dùng nguồn dự phòng, vì bộ quét chính không đọc được link này.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    val meta = listOfNotNull(
                        video.uploader,
                        video.durationSeconds?.let { formatDuration(it) },
                    ).joinToString(" · ")
                    if (meta.isNotBlank()) {
                        Text(meta, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(12.dp))
                    Text("Chọn chất lượng:", fontWeight = FontWeight.SemiBold)
                    video.options.forEach { option ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(
                                    selected = selected?.formatSpec == option.formatSpec &&
                                        selected?.label == option.label,
                                    onClick = { selected = option },
                                    role = Role.RadioButton,
                                )
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selected?.formatSpec == option.formatSpec &&
                                    selected?.label == option.label,
                                onClick = { selected = option },
                            )
                            Text(option.label)
                            option.sizeLabel?.let {
                                Spacer(Modifier.width(8.dp))
                                Text("($it)", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    if (download.isDownloading) {
                        LinearProgressIndicator(
                            progress = { (download.progress / 100f).coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Đang tải: ${download.progress.toInt()}%" +
                                if (download.etaSeconds > 0) {
                                    " · còn khoảng ${formatDuration(download.etaSeconds)}"
                                } else {
                                    ""
                                },
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(
                            onClick = onClose,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Đóng (vẫn tải nền)") }
                    } else {
                        Button(
                            onClick = { tryStartDownload() },
                            enabled = selected != null,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Tải về") }
                        download.statusText?.let { status ->
                            Spacer(Modifier.height(8.dp))
                            Text(status, style = MaterialTheme.typography.bodySmall)
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "File lưu ở thư mục Download/VN Browser.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

private fun formatDuration(seconds: Long): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) {
        "%d:%02d:%02d".format(h, m, s)
    } else {
        "%d:%02d".format(m, s)
    }
}
