package tungtq.so1.asia

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import tungtq.so1.asia.dl.Downloader

private val VdmRed = Color(0xFFDC2626)
private val VdmDarkRed = Color(0xFF991B1B)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VdmApp(viewModel: MainViewModel) {
    val uiState by viewModel.uiState.collectAsState()
    val download by viewModel.downloadState.collectAsState()
    val context = LocalContext.current
    var pendingDownload by remember { mutableStateOf(false) }

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

    // Mở màn hình cấp quyền truy cập file qua launcher để nhận callback khi quay lại.
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
        if (!hasStorageAccess()) {
            pendingDownload = true
            openAllFilesAccessSettings(context)
        } else if (!hasNotificationPermission()) {
            pendingDownload = true
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            pendingDownload = false
            viewModel.startDownload(context)
        }
    }

    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = VdmRed,
            secondary = VdmDarkRed,
            onPrimary = Color.White,
        ),
    ) {
        val activePreview = uiState.preview
        if (activePreview != null) {
            PlayerScreen(
                preview = activePreview,
                title = uiState.scanned?.title ?: "",
                onClose = viewModel::closePreview,
                onOpenExternal = { viewModel.openExternalPlayer(context) },
            )
            return@MaterialTheme
        }
        if (uiState.showDownloadedFiles) {
            DownloadedFilesScreen(
                viewModel = viewModel,
                onClose = viewModel::closeDownloadedFiles,
            )
            return@MaterialTheme
        }
        val cookiePlatform = uiState.cookieWebViewPlatform
        if (cookiePlatform != null) {
            CookieWebViewScreen(
                platform = cookiePlatform,
                onClose = viewModel::closeCookieWebView,
            )
            return@MaterialTheme
        }
        if (uiState.showCookiePlatforms) {
            CookiePlatformsScreen(
                onOpenPlatform = viewModel::openCookieWebView,
                onClose = viewModel::closeCookiePlatforms,
            )
            return@MaterialTheme
        }
        val douyinUrl = uiState.douyinWebViewUrl
        if (douyinUrl != null) {
            DouyinWebViewScreen(
                videoUrl = douyinUrl,
                onVideoFound = viewModel::onDouyinVideoFound,
                onAutoDownload = { url, title, noWatermark ->
                    viewModel.onDouyinVideoFoundAndDownload(context, url, title, noWatermark)
                },
                onClose = viewModel::closeDouyinWebView,
            )
            return@MaterialTheme
        }
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("VDM", fontWeight = FontWeight.Bold)
                            Text(
                                "Tải video từ link chia sẻ",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = VdmRed,
                        titleContentColor = Color.White,
                    ),
                )
            },
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (!uiState.engineReady && uiState.engineError == null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Đang chuẩn bị bộ máy tải…")
                    }
                }
                uiState.engineError?.let { error ->
                    Text("Bộ máy tải chưa sẵn sàng: $error", color = MaterialTheme.colorScheme.error)
                }

                Card {
                    Column(Modifier.padding(16.dp)) {
                        OutlinedTextField(
                            value = uiState.urlText,
                            onValueChange = viewModel::setUrl,
                            label = { Text("Dán link video (YouTube, Facebook, TikTok…)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            trailingIcon = {
                                IconButton(onClick = {
                                    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE)
                                        as ClipboardManager).primaryClip
                                    val text = clip?.getItemAt(0)?.text?.toString()
                                    if (!text.isNullOrBlank()) {
                                        val url = Downloader.extractUrl(text) ?: text
                                        viewModel.setUrl(url)
                                    }
                                }) {
                                    Icon(Icons.Default.ContentPaste, contentDescription = "Dán")
                                }
                            },
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = { viewModel.scan() },
                            enabled = !uiState.scanning && uiState.engineReady,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Default.Search, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text(if (uiState.scanning) "Đang quét…" else "Quét link")
                        }
                        Text(
                            "Mẹo: trong Facebook, YouTube hay trình duyệt, bấm Chia sẻ rồi chọn VDM là link tự chạy vào đây.",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }

                if (uiState.scanning) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Đang quét link, chờ chút…")
                    }
                }

                uiState.scanned?.let { scanned ->
                    Card {
                        Column(Modifier.padding(16.dp)) {
                            scanned.thumbnailUrl?.let { thumb ->
                                AsyncImage(
                                    model = thumb,
                                    contentDescription = null,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .aspectRatio(16f / 9f)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable { viewModel.openImageViewer() },
                                )
                                Spacer(Modifier.height(12.dp))
                            }
                            Text(scanned.title, fontWeight = FontWeight.Bold)
                            if (scanned.viaFallback) {
                                Text(
                                    "Đang dùng nguồn dự phòng, vì bộ quét chính không đọc được link này.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            val meta = listOfNotNull(
                                scanned.uploader,
                                scanned.durationSeconds?.let { formatDuration(it) },
                            ).joinToString(" · ")
                            if (meta.isNotBlank()) {
                                Text(meta, style = MaterialTheme.typography.bodySmall)
                            }
                            Spacer(Modifier.height(12.dp))
                            Text("Chọn chất lượng:", fontWeight = FontWeight.SemiBold)
                            scanned.options.forEach { option ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .selectable(
                                            selected = uiState.selectedSpec == option.formatSpec,
                                            onClick = { viewModel.selectOption(option) },
                                            role = Role.RadioButton,
                                        )
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(
                                        selected = uiState.selectedSpec == option.formatSpec,
                                        onClick = { viewModel.selectOption(option) },
                                    )
                                    Text(option.label)
                                    option.sizeLabel?.let {
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            "($it)",
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                            if (scanned.previewVideo != null || scanned.previewAudio != null) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    OutlinedButton(
                                        onClick = { viewModel.openPreview() },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.PlayArrow, contentDescription = null)
                                        Spacer(Modifier.width(8.dp))
                                        Text("Xem trước")
                                    }
                                    OutlinedButton(
                                        onClick = { viewModel.openExternalPlayer(context) },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.OpenInNew, contentDescription = null)
                                        Spacer(Modifier.width(8.dp))
                                        Text("Mở app khác")
                                    }
                                }
                                Spacer(Modifier.height(12.dp))
                            }
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
                                )
                                Spacer(Modifier.height(8.dp))
                                OutlinedButton(
                                    onClick = { viewModel.cancelDownload(context) },
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Hủy tải") }
                            } else {
                                Button(
                                    onClick = { tryStartDownload() },
                                    modifier = Modifier.fillMaxWidth(),
                                    colors = ButtonDefaults.buttonColors(containerColor = VdmRed),
                                ) {
                                    Icon(Icons.Default.Download, contentDescription = null)
                                    Spacer(Modifier.width(8.dp))
                                    Text("Tải xuống")
                                }
                            }
                        }
                    }
                }

                download.statusText?.let { status ->
                    Text(status)
                }

                uiState.message?.let { message ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(message, modifier = Modifier.weight(1f))
                            TextButton(onClick = { viewModel.clearMessage() }) { Text("Đóng") }
                        }
                        if (uiState.douyinFallbackUrl != null) {
                            OutlinedButton(
                                onClick = { viewModel.openDouyinWebView() },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(Icons.Default.OpenInNew, contentDescription = null)
                                Spacer(Modifier.width(8.dp))
                                Text("Thử lấy link qua trình duyệt")
                            }
                        }
                    }
                }

                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text("File sẽ lưu trong thư mục Download/VDM trên điện thoại.")
                        Spacer(Modifier.height(8.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            OutlinedButton(
                                onClick = { viewModel.openDownloadedFiles() },
                                modifier = Modifier.weight(1f),
                            ) {
                                Icon(Icons.Default.FolderOpen, contentDescription = null)
                                Spacer(Modifier.width(8.dp))
                                Text("File đã tải")
                            }
                            OutlinedButton(
                                onClick = { viewModel.updateEngine() },
                                enabled = !uiState.updatingEngine && uiState.engineReady,
                                modifier = Modifier.weight(1f),
                            ) {
                                Icon(Icons.Default.Refresh, contentDescription = null)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    if (uiState.updatingEngine) {
                                        "Đang cập nhật…"
                                    } else {
                                        "Cập nhật bộ quét"
                                    },
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(
                            onClick = { viewModel.openCookiePlatforms() },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Default.Lock, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("Cookie & đăng nhập")
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Chỉ tải nội dung bạn có quyền lưu giữ. Một số trang đổi cấu trúc liên tục, nếu tải lỗi hãy bấm cập nhật bộ quét rồi thử lại.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
        if (uiState.showImageViewer) {
            uiState.scanned?.thumbnailUrl?.let { thumb ->
                ImageViewerDialog(imageUrl = thumb, onClose = viewModel::closeImageViewer)
            }
        }
    }
}

/** Xem ảnh đại diện phóng to toàn màn hình, bấm vào ảnh hoặc nút X để đóng. */
@Composable
fun ImageViewerDialog(imageUrl: String, onClose: () -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .clickable { onClose() },
        ) {
            AsyncImage(
                model = imageUrl,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
            IconButton(
                onClick = onClose,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(8.dp),
            ) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "Đóng",
                    tint = Color.White,
                )
            }
        }
    }
}

private fun formatDuration(seconds: Long): String {
    val hours = seconds / 3600
    val minutes = (seconds % 3600) / 60
    val secs = seconds % 60
    return if (hours > 0) {
        "%d:%02d:%02d".format(hours, minutes, secs)
    } else {
        "%d:%02d".format(minutes, secs)
    }
}
