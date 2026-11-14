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
import androidx.compose.material3.TextButton
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
import vn.tunglv.browser.web.CapturedKind
import vn.tunglv.browser.web.CapturedMedia
import vn.tunglv.browser.web.isProgressiveYouTube

private enum class ScanState { PREPARING, SCANNING, READY, FAILED }

/**
 * Bảng tải media của trang đang mở: ưu tiên link bắt được khi trang phát
 * video (đường này tải được cả YouTube, nơi bộ quét không đọc được), dưới
 * là kết quả quét bằng bộ máy yt-dlp. Bấm tải thì chạy nền qua DownloadService.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadSheet(
    pageUrl: String,
    cookieString: String?,
    captures: List<CapturedMedia>,
    pageTitle: String,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val download by DownloadState.state.collectAsState()
    var scanState by remember { mutableStateOf(ScanState.PREPARING) }
    var scanned by remember { mutableStateOf<ScannedVideo?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<VideoFormatOption?>(null) }
    var selectedCapture by remember { mutableStateOf<CapturedMedia?>(null) }
    var pendingDownload by remember { mutableStateOf(false) }

    // Link bắt được xếp: video chất lượng cao trước, rồi video thường, rồi tiếng.
    val orderedCaptures = remember(captures) {
        captures.sortedWith(
            compareByDescending<CapturedMedia> { it.kind == CapturedKind.VIDEO }
                .thenByDescending { it.height }
                .thenBy { it.kind != CapturedKind.GENERIC },
        )
    }
    val audioCapture = remember(captures) { bestAudioCapture(captures) }

    // Mặc định chọn link video tốt nhất đã bắt được (ưu tiên bản có tiếng).
    LaunchedEffect(orderedCaptures) {
        if (selectedCapture == null) {
            selectedCapture = orderedCaptures.firstOrNull { it.kind == CapturedKind.VIDEO }
                ?: orderedCaptures.firstOrNull()
        }
    }

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
            // Chỉ chọn sẵn kết quả quét khi chưa có link bắt được.
            if (selectedCapture == null) {
                selected = result.options.firstOrNull()
            }
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
        val capture = selectedCapture
        val option = selected
        val video = scanned
        val canDownload = capture != null || (option != null && video != null)
        if (canDownload) {
            if (!hasStorageAccess()) {
                pendingDownload = true
                openAllFilesAccessSettings(context)
            } else if (!hasNotificationPermission()) {
                pendingDownload = true
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                pendingDownload = false
                if (capture != null) {
                    // Video rời chưa có tiếng thì gộp thêm luồng tiếng đã bắt được.
                    val audio = if (capture.kind == CapturedKind.VIDEO &&
                        !capture.isProgressiveYouTube()
                    ) {
                        audioCapture
                    } else {
                        null
                    }
                    val title = pageTitle.ifBlank { video?.title ?: pageUrl }
                    DownloadService.startCaptured(
                        context,
                        pageUrl,
                        capture.url,
                        audio?.url,
                        title,
                    )
                } else if (option != null && video != null) {
                    DownloadService.start(context, pageUrl, option, video.title, cookieString)
                }
            }
        }
    }

    val hasChoice = selectedCapture != null || selected != null

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
            if (orderedCaptures.isNotEmpty()) {
                Text("Link bắt được từ trang:", fontWeight = FontWeight.SemiBold)
                Text(
                    "Các link này lấy từ lúc trang phát video, tải thẳng không qua bộ quét.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(4.dp))
                orderedCaptures.forEach { media ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = selectedCapture?.url == media.url,
                                onClick = {
                                    selectedCapture = media
                                    selected = null
                                },
                                role = Role.RadioButton,
                            )
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = selectedCapture?.url == media.url,
                            onClick = {
                                selectedCapture = media
                                selected = null
                            },
                        )
                        Text(media.label)
                        if (media.kind == CapturedKind.VIDEO &&
                            !media.isProgressiveYouTube() && audioCapture != null
                        ) {
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "(sẽ gộp tiếng)",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
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
                    if (orderedCaptures.isEmpty()) {
                        Text(
                            errorMessage ?: "Không quét được link này.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { scope.launch { runScan() } }) { Text("Thử lại") }
                            OutlinedButton(onClick = onClose) { Text("Đóng") }
                        }
                    } else {
                        Text(
                            errorMessage ?: "Không quét được link này.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        TextButton(onClick = { scope.launch { runScan() } }) {
                            Text("Thử quét lại")
                        }
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
                                        onClick = {
                                            selected = option
                                            selectedCapture = null
                                        },
                                        role = Role.RadioButton,
                                    )
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = selected?.formatSpec == option.formatSpec &&
                                        selected?.label == option.label,
                                    onClick = {
                                        selected = option
                                        selectedCapture = null
                                    },
                                )
                                Text(option.label)
                                option.sizeLabel?.let {
                                    Spacer(Modifier.width(8.dp))
                                    Text("($it)", style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
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
            } else if (hasChoice) {
                Button(
                    onClick = { tryStartDownload() },
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
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * Luồng tiếng tốt nhất để gộp: ưu tiên AAC (itag 140/139/141) vì MediaMuxer
 * gộp AAC vào mp4 chắc chắn được, Opus thì tùy máy.
 */
private fun bestAudioCapture(captures: List<CapturedMedia>): CapturedMedia? {
    val audios = captures.filter { it.kind == CapturedKind.AUDIO }
    return audios.firstOrNull { it.itag in setOf("140", "139", "141") }
        ?: audios.firstOrNull()
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
