package tungtq.so1.asia.dl

import android.content.Context
import android.os.Environment
import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.youtubedl_android.YoutubeDLResponse
import com.yausername.youtubedl_android.mapper.VideoFormat
import com.yausername.youtubedl_android.mapper.VideoInfo
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.regex.Pattern
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Một lựa chọn chất lượng để người dùng bấm tải. */
data class VideoFormatOption(
    /** Chuỗi -f truyền cho yt-dlp, ví dụ "136+bestaudio/best" hoặc "__audio__". */
    val formatSpec: String,
    val label: String,
    val sizeLabel: String?,
    val isAudioOnly: Boolean = false,
    /** Link file trực tiếp (nguồn dự phòng): có thì tải thẳng, không qua yt-dlp. */
    val directUrl: String? = null,
)

/** Nội dung xem trước/nghe thử sau khi quét: link trực tiếp + header cần kèm khi mở. */
data class PreviewMedia(
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val mimeType: String? = null,
    val isAudioOnly: Boolean = false,
    /** Bản xem trước là video rời, có thể không có tiếng. */
    val mayLackAudio: Boolean = false,
)

/** Thông tin video sau khi quét link. */
data class ScannedVideo(
    val title: String,
    val uploader: String?,
    val durationSeconds: Long?,
    val thumbnailUrl: String?,
    val webpageUrl: String?,
    val options: List<VideoFormatOption>,
    val previewVideo: PreviewMedia? = null,
    val previewAudio: PreviewMedia? = null,
    /** true khi kết quả đến từ nguồn dự phòng (tikwm) vì bộ quét chính lỗi. */
    val viaFallback: Boolean = false,
)

object Downloader {

    const val PROCESS_ID = "vdm-download"

    private const val TAG = "VDM"
    private const val CHROME_UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    @Volatile
    private var cancelRequested = false

    @Volatile
    private var appContext: Context? = null

    /** Gọi một lần từ Application để Downloader đọc được file cookie đã lưu. */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /** Gắn file cookie (nếu có) vào request yt-dlp để tải link cần đăng nhập. */
    private fun YoutubeDLRequest.withCookies(): YoutubeDLRequest {
        val context = appContext
        val file = context?.let { CookieStore.cookieFileIfAny(it) }
        if (file != null) addOption("--cookies", file.absolutePath)
        return this
    }

    private val URL_PATTERN: Pattern =
        Pattern.compile("https?://[^\\s\"'<>]+", Pattern.CASE_INSENSITIVE)

    /** Thư mục lưu file: Download/VDM/ trong bộ nhớ chung của máy. */
    fun downloadDir(): File =
        File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "VDM",
        )

    /** Tìm URL đầu tiên trong đoạn văn bản được chia sẻ (kèm cả chữ thì vẫn lấy được link). */
    fun extractUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val matcher = URL_PATTERN.matcher(text)
        if (!matcher.find()) return null
        // Cắt dấu câu dính ở cuối link khi người ta share kèm câu chữ.
        return matcher.group().trimEnd('.', ',', ';', ')', ']', '!')
    }

    /**
     * Quét link, trả về tiêu đề + danh sách chất lượng có thể tải.
     * Link rút gọn được mở rộng trước; nếu bộ quét chính (yt-dlp) lỗi với link
     * TikTok thì tự thử nguồn dự phòng tikwm.
     */
    suspend fun fetchInfo(url: String): ScannedVideo = withContext(Dispatchers.IO) {
        val resolvedUrl = resolveRedirects(url)
        try {
            fetchViaYtDlp(resolvedUrl)
        } catch (ytError: Exception) {
            Log.w(TAG, "yt-dlp scan failed, trying fallback", ytError)
            if (!isTikTokUrl(resolvedUrl)) throw ytError
            try {
                fetchViaTikwm(resolvedUrl)
            } catch (fbError: Exception) {
                Log.e(TAG, "tikwm fallback failed", fbError)
                throw Exception(
                    "Không quét được link này. Bộ quét chính báo: " +
                        "${ytError.message}; nguồn dự phòng báo: ${fbError.message}",
                )
            }
        }
    }

    private fun fetchViaYtDlp(url: String): ScannedVideo {
        val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-warnings")
            withCookies()
        }
        val info: VideoInfo = YoutubeDL.getInstance().getInfo(request)
        val formats = info.formats ?: emptyList()
        return ScannedVideo(
            title = info.title ?: url,
            uploader = info.uploader,
            durationSeconds = info.duration.takeIf { it > 0 }?.toLong(),
            thumbnailUrl = info.thumbnail,
            webpageUrl = info.webpageUrl,
            options = buildOptions(info),
            previewVideo = buildPreviewVideo(formats),
            previewAudio = buildPreviewAudio(formats),
        )
    }

    private fun isTikTokUrl(url: String): Boolean {
        return try {
            URL(url).host.lowercase().endsWith("tiktok.com")
        } catch (_: Exception) {
            url.lowercase().contains("tiktok.com")
        }
    }

    /**
     * Mở rộng link rút gọn (vm.tiktok.com, vt.tiktok.com, v.douyin.com, tiktok.com/t/)
     * thành link đầy đủ trước khi quét. Lỗi thì giữ nguyên link gốc.
     */
    private fun resolveRedirects(url: String): String {
        val host = try {
            URL(url).host.lowercase()
        } catch (_: Exception) {
            return url
        }
        val shortHosts = setOf("vm.tiktok.com", "vt.tiktok.com", "v.douyin.com")
        val needsResolve = host in shortHosts ||
            (host.endsWith("tiktok.com") && url.contains("/t/"))
        if (!needsResolve) return url
        return try {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.setRequestProperty("User-Agent", CHROME_UA)
            connection.requestMethod = "GET"
            connection.connect()
            val finalUrl = connection.url.toString()
            connection.disconnect()
            // Chỉ nhận link đích khi nó trỏ tới đúng 1 video, còn không giữ link gốc
            // để bộ quét tự xử lý link rút gọn.
            if (finalUrl.contains("/video/")) finalUrl else url
        } catch (e: Exception) {
            Log.w(TAG, "redirect resolve failed", e)
            url
        }
    }

    /** Nguồn dự phòng cho TikTok: API tikwm trả về link không watermark, không cần key. */
    private fun fetchViaTikwm(url: String): ScannedVideo {
        val apiUrl = "https://www.tikwm.com/api/?url=" +
            URLEncoder.encode(url, "UTF-8") + "&hd=1"
        val connection = URL(apiUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("User-Agent", CHROME_UA)
        connection.setRequestProperty("Accept", "application/json")
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                throw Exception("nguồn dự phòng trả về HTTP $code")
            }
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            return parseTikwm(body, url)
        } finally {
            connection.disconnect()
        }
    }

    private fun parseTikwm(body: String, originalUrl: String): ScannedVideo {
        val code = jsonInt(body, "code")
        if (code != 0L) {
            throw Exception(jsonString(body, "msg") ?: "nguồn dự phòng không xử lý được link này")
        }
        val play = jsonString(body, "play")
        val hdPlay = jsonString(body, "hdplay")
        val music = jsonString(body, "music")
        if (play.isNullOrBlank() && hdPlay.isNullOrBlank()) {
            throw Exception("nguồn dự phòng không trả về link video")
        }
        val title = jsonString(body, "title")?.takeIf { it.isNotBlank() } ?: originalUrl
        val options = mutableListOf<VideoFormatOption>()
        if (!hdPlay.isNullOrBlank()) {
            options += VideoFormatOption(
                formatSpec = DIRECT_SPEC,
                label = "HD · Không watermark",
                sizeLabel = formatSizeLabel(jsonInt(body, "hd_size")),
                directUrl = hdPlay,
            )
        }
        if (!play.isNullOrBlank()) {
            options += VideoFormatOption(
                formatSpec = DIRECT_SPEC,
                label = "Thường · Không watermark",
                sizeLabel = formatSizeLabel(jsonInt(body, "size")),
                directUrl = play,
            )
        }
        if (!music.isNullOrBlank()) {
            options += VideoFormatOption(
                formatSpec = DIRECT_SPEC,
                label = "Chỉ âm thanh (MP3)",
                sizeLabel = null,
                isAudioOnly = true,
                directUrl = music,
            )
        }
        val previewVideoUrl = hdPlay?.takeIf { it.isNotBlank() } ?: play
        return ScannedVideo(
            title = title,
            uploader = jsonString(body, "nickname"),
            durationSeconds = jsonInt(body, "duration")?.takeIf { it > 0 },
            thumbnailUrl = jsonString(body, "cover"),
            webpageUrl = originalUrl,
            options = options,
            previewVideo = previewVideoUrl?.let {
                PreviewMedia(url = it, mimeType = "video/mp4")
            },
            previewAudio = music?.takeIf { it.isNotBlank() }?.let {
                PreviewMedia(url = it, mimeType = "audio/mpeg", isAudioOnly = true)
            },
            viaFallback = true,
        )
    }

    /** Trích giá trị chuỗi của 1 khóa JSON cấp nông (đủ cho phản hồi tikwm). */
    private fun jsonString(body: String, key: String): String? {
        val pattern = Pattern.compile(
            "\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"",
        )
        val matcher = pattern.matcher(body)
        if (!matcher.find()) return null
        return unescapeJson(matcher.group(1))
    }

    private fun jsonInt(body: String, key: String): Long? {
        val pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(\\d+)")
        val matcher = pattern.matcher(body)
        return if (matcher.find()) matcher.group(1).toLongOrNull() else null
    }

    private fun unescapeJson(raw: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (c == '\\' && i + 1 < raw.length) {
                when (raw[i + 1]) {
                    '/' -> { out.append('/'); i += 2 }
                    'u' -> {
                        if (i + 5 < raw.length) {
                            raw.substring(i + 2, i + 6).toIntOrNull(16)?.let { out.append(it.toChar()) }
                            i += 6
                        } else {
                            i += 2
                        }
                    }
                    'n' -> { out.append('\n'); i += 2 }
                    't' -> { out.append('\t'); i += 2 }
                    'r' -> { out.append('\r'); i += 2 }
                    'b' -> { out.append('\b'); i += 2 }
                    'f' -> { out.append('\u000C'); i += 2 }
                    '"' -> { out.append('"'); i += 2 }
                    '\\' -> { out.append('\\'); i += 2 }
                    else -> { out.append(raw[i + 1]); i += 2 }
                }
            } else {
                out.append(c)
                i += 1
            }
        }
        return out.toString()
    }

    private fun buildOptions(info: VideoInfo): List<VideoFormatOption> {
        val options = mutableListOf<VideoFormatOption>()
        val seenHeights = mutableSetOf<Int>()
        val formats = info.formats ?: emptyList()

        // Video: mỗi độ cao (1080, 720...) chỉ giữ 1 lựa chọn tốt nhất. Cùng độ cao
        // thì ưu tiên bản không watermark (yt-dlp hạ preference + ghi chú watermark
        // cho bản có watermark, vd luồng download_addr của TikTok).
        val videoFormats = formats
            .filter { it.height > 0 && it.vcodec != null && it.vcodec != "none" }
            .sortedWith(
                compareByDescending<VideoFormat> { it.height }
                    .thenBy { it.formatNote?.contains("watermark", ignoreCase = true) ?: false }
                    .thenByDescending { it.preference }
                    .thenByDescending { it.fileSize },
            )
        for (format in videoFormats) {
            val formatId = format.formatId ?: continue
            val height = format.height
            if (!seenHeights.add(height)) continue
            val hasAudio = format.acodec != null && format.acodec != "none"
            val spec = if (hasAudio) {
                formatId
            } else {
                // Video rời + âm thanh tốt nhất, FFmpeg tự gộp lại thành 1 file.
                "$formatId+bestaudio/best"
            }
            val sizeBytes = if (format.fileSize > 0) {
                format.fileSize
            } else {
                format.fileSizeApproximate
            }
            options += VideoFormatOption(
                formatSpec = spec,
                label = "${height}p · ${format.ext?.uppercase() ?: "MP4"}" +
                    if (hasAudio) "" else " (gộp âm thanh)",
                sizeLabel = formatSizeLabel(sizeBytes.takeIf { it > 0 }),
            )
        }

        // Chỉ lấy âm thanh (mp3).
        options += VideoFormatOption(
            formatSpec = AUDIO_SPEC,
            label = "Chỉ âm thanh (MP3)",
            sizeLabel = null,
            isAudioOnly = true,
        )
        return options
    }

    /** Chọn 1 format để xem trước: ưu tiên có cả hình lẫn tiếng, tối đa 1080p cho nhẹ. */
    private fun buildPreviewVideo(formats: List<VideoFormat>): PreviewMedia? {
        val withUrl = formats.filter {
            !it.url.isNullOrBlank() && it.height > 0 && it.vcodec != null && it.vcodec != "none"
        }
        val combined = withUrl
            .filter { it.acodec != null && it.acodec != "none" }
            .sortedWith(
                compareByDescending<VideoFormat> { it.height }
                    .thenBy { it.formatNote?.contains("watermark", ignoreCase = true) ?: false }
                    .thenByDescending { it.preference },
            )
        val combinedPick = combined.firstOrNull { it.height <= 1080 } ?: combined.lastOrNull()
        if (combinedPick != null) return combinedPick.toPreview(isAudioOnly = false)
        val videoOnly = withUrl.sortedByDescending { it.height }
        val pick = videoOnly.firstOrNull { it.height <= 1080 } ?: videoOnly.lastOrNull()
            ?: return null
        return pick.toPreview(isAudioOnly = false, mayLackAudio = true)
    }

    /** Chọn 1 format chỉ âm thanh để nghe thử: ưu tiên bitrate cao nhất. */
    private fun buildPreviewAudio(formats: List<VideoFormat>): PreviewMedia? {
        val audio = formats.filter {
            !it.url.isNullOrBlank() && it.acodec != null && it.acodec != "none" &&
                (it.vcodec == null || it.vcodec == "none")
        }.sortedByDescending { it.abr }
        return audio.firstOrNull()?.toPreview(isAudioOnly = true)
    }

    private fun VideoFormat.toPreview(
        isAudioOnly: Boolean,
        mayLackAudio: Boolean = false,
    ): PreviewMedia {
        val directUrl = url ?: ""
        return PreviewMedia(
            url = directUrl,
            headers = httpHeaders ?: emptyMap(),
            mimeType = mimeTypeFor(ext, directUrl),
            isAudioOnly = isAudioOnly,
            mayLackAudio = mayLackAudio,
        )
    }

    private fun mimeTypeFor(ext: String?, url: String): String? {
        if (url.contains(".m3u8")) return "application/x-mpegURL"
        if (url.contains(".mpd")) return "application/dash+xml"
        return when (ext?.lowercase()) {
            "mp4", "m4v" -> "video/mp4"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            "mov" -> "video/quicktime"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "opus" -> "audio/opus"
            "ogg", "oga" -> "audio/ogg"
            "wav" -> "audio/wav"
            "flac" -> "audio/flac"
            else -> null
        }
    }

    private fun formatSizeLabel(bytes: Long?): String? {
        if (bytes == null || bytes <= 0) return null
        return when {
            bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1_000_000_000.0)
            bytes >= 1_000_000 -> "%.0f MB".format(bytes / 1_000_000.0)
            else -> "%d KB".format(bytes / 1_000)
        }
    }

    /**
     * Tải video theo [option]. [onProgress] nhận (phần trăm 0–100, số giây còn lại ước tính).
     * Lựa chọn từ nguồn dự phòng có link trực tiếp thì tải thẳng bằng HTTP,
     * còn lại tải qua yt-dlp. Ném Exception khi lỗi.
     */
    suspend fun download(
        url: String,
        option: VideoFormatOption,
        onProgress: (Float, Long) -> Unit,
    ): YoutubeDLResponse = withContext(Dispatchers.IO) {
        cancelRequested = false
        val dir = downloadDir()
        if (!dir.exists()) dir.mkdirs()
        val directUrl = option.directUrl
        if (!directUrl.isNullOrBlank()) {
            downloadDirect(directUrl, dir, option.isAudioOnly, onProgress)
            // Trả về response rỗng để giữ nguyên chữ ký hàm cho DownloadService.
            return@withContext YoutubeDLResponse(emptyList(), 0, 0L, "", "")
        }
        val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-mtime")
            addOption("--no-warnings")
            withCookies()
            addOption("-o", dir.absolutePath + "/%(title)s.%(ext)s")
            if (option.isAudioOnly) {
                addOption("--extract-audio")
                addOption("--audio-format", "mp3")
                addOption("-f", "bestaudio/best")
            } else {
                addOption("-f", option.formatSpec)
            }
            // aria2c tải đa kết nối cho nhanh, giống bản desktop.
            addOption("--downloader", "libaria2c.so")
        }
        // execute() nhận callback dạng lambda (tiến trình %, số giây còn lại, trạng thái).
        YoutubeDL.getInstance().execute(request, PROCESS_ID) { progress, etaInSeconds, _ ->
            onProgress(progress, etaInSeconds)
        }
    }

    /** Tải thẳng 1 file từ link trực tiếp (nguồn dự phòng), báo tiến trình theo Content-Length. */
    private fun downloadDirect(
        fileUrl: String,
        dir: File,
        isAudio: Boolean,
        onProgress: (Float, Long) -> Unit,
    ) {
        val connection = URL(fileUrl).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("User-Agent", CHROME_UA)
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw Exception("Tải trực tiếp thất bại (HTTP $code)")
            val total = connection.contentLengthLong.takeIf { it > 0 }
            val ext = if (isAudio) "mp3" else "mp4"
            val outFile = File(dir, "vdm-${System.currentTimeMillis()}.$ext")
            val startAt = System.currentTimeMillis()
            var downloaded = 0L
            BufferedInputStream(connection.inputStream).use { input ->
                FileOutputStream(outFile).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        if (cancelRequested) {
                            outFile.delete()
                            throw Exception("Đã hủy lượt tải.")
                        }
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        if (total != null) {
                            val progress = (downloaded * 100f / total).coerceIn(0f, 100f)
                            val elapsedSec = (System.currentTimeMillis() - startAt) / 1000.0
                            val eta = if (elapsedSec > 0 && downloaded > 0) {
                                ((total - downloaded) / (downloaded / elapsedSec)).toLong()
                            } else {
                                0L
                            }
                            onProgress(progress, eta)
                        }
                    }
                }
            }
            onProgress(100f, 0L)
        } finally {
            connection.disconnect()
        }
    }

    /** Hủy lượt tải đang chạy (nếu có). */
    fun cancel() {
        cancelRequested = true
        try {
            YoutubeDL.getInstance().destroyProcessById(PROCESS_ID)
        } catch (_: Exception) {
            // Không có tiến trình nào đang chạy thì thôi.
        }
    }

    const val AUDIO_SPEC = "__audio__"
    const val DIRECT_SPEC = "__direct__"
}
