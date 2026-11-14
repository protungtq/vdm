package tungtq.so1.asia.dl

import android.content.Context
import android.os.Environment
import android.util.Log
import android.webkit.CookieManager
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.youtubedl_android.YoutubeDLResponse
import com.yausername.youtubedl_android.mapper.VideoFormat
import com.yausername.youtubedl_android.mapper.VideoInfo
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import java.util.regex.Pattern
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
    /** Referer gửi kèm khi tải trực tiếp (một số CDN như Douyin yêu cầu). */
    val referer: String? = null,
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

    /** User-Agent Chrome trên điện thoại, dùng cho cả HTTP trực tiếp lẫn WebView. */
    internal const val CHROME_UA =
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
    private fun YoutubeDLRequest.withCookieFile(file: File?): YoutubeDLRequest {
        if (file != null && file.exists()) addOption("--cookies", file.absolutePath)
        return this
    }

    /**
     * Lỗi đúng dạng #15161 của yt-dlp: Facebook trả về trang mà bộ quét không
     * đọc được khi request gửi kèm cookie (cần impersonation, Android không có).
     */
    private fun isFacebookParseError(e: Exception): Boolean {
        val message = e.message ?: return false
        return message.contains("[facebook]", ignoreCase = true) &&
            message.contains("Cannot parse data", ignoreCase = true)
    }

    /**
     * Lỗi Facebook đọc được cho người dùng, thay cho bản dump dài của yt-dlp.
     * Lỗi khác thì giữ nguyên.
     */
    private fun facebookGuidance(e: Exception): Exception {
        val message = e.message ?: ""
        return if (message.contains("Cannot parse data", ignoreCase = true)) {
            Exception(
                "Không đọc được video Facebook này (Facebook đổi cách trả dữ liệu, " +
                    "bộ quét chưa theo kịp). Hãy bấm \"Cập nhật bộ quét\" rồi quét lại; " +
                    "nếu vẫn không được thì video này hiện chưa tải được.",
            )
        } else {
            e
        }
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
        val cookieFile = appContext?.let { CookieStore.cookieFileIfAny(it) }
        try {
            fetchViaYtDlp(resolvedUrl, cookieFile)
        } catch (ytError: Exception) {
            Log.w(TAG, "yt-dlp scan failed, trying fallback", ytError)
            // Lỗi #15161: request gửi kèm cookie làm Facebook trả về dạng trang
            // mà bộ quét không đọc được. Thử lại 1 lần không gửi cookie:
            // video công khai thường đọc được bình thường.
            if (isFacebookParseError(ytError) && cookieFile != null) {
                try {
                    return@withContext fetchViaYtDlp(resolvedUrl, null)
                } catch (retryError: Exception) {
                    Log.w(TAG, "facebook no-cookie retry failed", retryError)
                    throw facebookGuidance(retryError)
                }
            }
            if (isFacebookParseError(ytError)) throw facebookGuidance(ytError)
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

    private fun fetchViaYtDlp(url: String, cookieFile: File?): ScannedVideo {
        val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-warnings")
            withCookieFile(cookieFile)
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

    /** Mở rộng link rút gọn thành link đầy đủ (dùng khi mở trang video trong WebView). */
    suspend fun resolveUrl(url: String): String = withContext(Dispatchers.IO) {
        resolveRedirects(url)
    }

    /**
     * Lấy link Douyin không qua yt-dlp: đọc play_addr (bản không logo) từ trang
     * share. Trả về null khi không lấy được để caller mở WebView bắt link.
     */
    suspend fun fetchDouyinDirect(pageUrl: String): ScannedVideo? =
        withContext(Dispatchers.IO) {
            val resolved = resolveRedirects(pageUrl)
            val videoId = DouyinDirect.extractVideoId(resolved) ?: return@withContext null
            val webCookies = try {
                CookieManager.getInstance().getCookie("https://www.douyin.com")
            } catch (_: Exception) {
                null
            }
            val saved = appContext?.let { CookieStore.savedCookies(it, CookiePlatform.DOUYIN) }
            val cookies = CookieStore.mergeCookieStrings(webCookies, saved)
                .takeIf { it.isNotBlank() }
            val html = DouyinDirect.fetchShareHtml(videoId, cookies) ?: return@withContext null
            val directUrl = DouyinDirect.extractPlayAddrUrl(html) ?: return@withContext null
            val title = DouyinDirect.extractShareTitle(html)?.takeIf { it.isNotBlank() }
                ?: "Video Douyin"
            val option = VideoFormatOption(
                formatSpec = DIRECT_SPEC,
                label = "Video · Không logo (tải trực tiếp)",
                sizeLabel = null,
                directUrl = directUrl,
                referer = DouyinDirect.REFERER,
            )
            ScannedVideo(
                title = title,
                uploader = null,
                durationSeconds = null,
                thumbnailUrl = null,
                webpageUrl = resolved,
                options = listOf(option),
                previewVideo = PreviewMedia(
                    url = directUrl,
                    headers = mapOf("Referer" to DouyinDirect.REFERER),
                    mimeType = "video/mp4",
                ),
                viaFallback = true,
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
            // Chỉ nhận link đích khi nó trỏ tới đúng 1 video/bài đăng, còn không giữ
            // link gốc để bộ quét tự xử lý link rút gọn.
            if (finalUrl.contains("/video/") || finalUrl.contains("/note/")) finalUrl else url
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
        if (!dir.exists() || !dir.canWrite()) {
            throw Exception(
                "Không ghi được vào thư mục Download/VDM. " +
                    "Hãy cấp quyền truy cập mọi file cho app rồi thử lại.",
            )
        }
        val directUrl = option.directUrl
        if (!directUrl.isNullOrBlank()) {
            downloadDirect(directUrl, dir, option.isAudioOnly, option.referer, onProgress)
            // Trả về response rỗng để giữ nguyên chữ ký hàm cho DownloadService.
            return@withContext YoutubeDLResponse(emptyList(), 0, 0L, "", "")
        }
        val cookieFile = appContext?.let { CookieStore.cookieFileIfAny(it) }
        try {
            return@withContext downloadViaYtDlp(url, option, dir, cookieFile, onProgress)
        } catch (e: Exception) {
            // Lỗi #15161 (xem fetchInfo): thử lại 1 lần không gửi cookie.
            if (isFacebookParseError(e) && cookieFile != null && !cancelRequested) {
                Log.w(TAG, "facebook download failed with cookies, retrying without", e)
                try {
                    return@withContext downloadViaYtDlp(url, option, dir, null, onProgress)
                } catch (retryError: Exception) {
                    throw facebookGuidance(retryError)
                }
            }
            if (isFacebookParseError(e)) throw facebookGuidance(e)
            throw e
        }
    }

    /** Tải qua yt-dlp: thử aria2 trước, lỗi do aria2 thì thử lại bằng trình tải thường. */
    private fun downloadViaYtDlp(
        url: String,
        option: VideoFormatOption,
        dir: File,
        cookieFile: File?,
        onProgress: (Float, Long) -> Unit,
    ): YoutubeDLResponse {
        val request = buildYtDlpRequest(url, option, dir, cookieFile, useAria2 = true)
        try {
            return executeRequest(request, onProgress)
        } catch (ariaError: Exception) {
            // Chỉ thử lại khi lỗi đến từ trình tải phụ aria2 (vd exit code 16:
            // không tạo được file). Lỗi do link/video thì thử lại cũng vậy.
            val message = ariaError.message ?: ""
            if (cancelRequested || !message.contains("aria2c", ignoreCase = true)) {
                throw ariaError
            }
            Log.w(TAG, "aria2 download failed, retrying with built-in downloader", ariaError)
            val fallback = buildYtDlpRequest(url, option, dir, cookieFile, useAria2 = false)
            try {
                return executeRequest(fallback, onProgress)
            } catch (fallbackError: Exception) {
                throw Exception(
                    "Tải bằng trình tải phụ thất bại (${ariaError.message}); " +
                        "thử lại bằng cách tải thường cũng thất bại " +
                        "(${fallbackError.message})",
                )
            }
        }
    }

    /** Dựng request yt-dlp. [useAria2] = false thì dùng trình tải có sẵn của yt-dlp. */
    private fun buildYtDlpRequest(
        url: String,
        option: VideoFormatOption,
        dir: File,
        cookieFile: File?,
        useAria2: Boolean,
    ): YoutubeDLRequest {
        return YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-mtime")
            addOption("--no-warnings")
            withCookieFile(cookieFile)
            // Tên file cắt còn tối đa 60 ký tự tiêu đề + id: tiêu đề dài (nhất là
            // tiếng Việt có dấu, mỗi chữ tới 3 byte) vượt 255 byte sẽ làm aria2
            // không tạo được file (exit code 16). Kèm id để khỏi trùng tên.
            addOption("-o", dir.absolutePath + "/%(title).60s-[%(id)s].%(ext)s")
            if (option.isAudioOnly) {
                addOption("--extract-audio")
                addOption("--audio-format", "mp3")
                addOption("-f", "bestaudio/best")
            } else {
                addOption("-f", option.formatSpec)
            }
            if (useAria2) {
                // aria2c tải đa kết nối cho nhanh, giống bản desktop.
                // file-allocation=none: tránh lỗi tạo file trên bộ nhớ ngoài
                // của Android; allow-overwrite: tải lại cùng tên không bị từ chối.
                addOption("--downloader", "libaria2c.so")
                addOption(
                    "--downloader-args",
                    "aria2c:--file-allocation=none --allow-overwrite=true",
                )
            }
        }
    }

    /** Chạy request yt-dlp, báo tiến trình qua callback. */
    private fun executeRequest(
        request: YoutubeDLRequest,
        onProgress: (Float, Long) -> Unit,
    ): YoutubeDLResponse {
        // execute() nhận callback dạng lambda (tiến trình %, số giây còn lại, trạng thái).
        return YoutubeDL.getInstance().execute(request, PROCESS_ID) { progress, etaInSeconds, _ ->
            onProgress(progress, etaInSeconds)
        }
    }

    /**
     * Tải thẳng 1 file từ link trực tiếp (nguồn dự phòng). File từ 4 MB trở lên
     * mà máy chủ hỗ trợ Range thì chia 4 đoạn tải song song; đứt giữa chừng thì
     * lần tải sau tải tiếp các đoạn còn thiếu thay vì tải lại từ đầu.
     */
    private suspend fun downloadDirect(
        fileUrl: String,
        dir: File,
        isAudio: Boolean,
        referer: String?,
        onProgress: (Float, Long) -> Unit,
    ) = withContext(Dispatchers.IO) {
        cleanStaleParts(dir)
        val ext = if (isAudio) "mp3" else "mp4"
        val key = sha256Hex(fileUrl).take(16)
        val partFile = File(dir, "vdm-$key.part")
        val metaFile = File(dir, "vdm-$key.meta")
        val probe = probeDownload(fileUrl, referer)
        val total = probe.total
        if (probe.rangeSupported && total != null && total >= MIN_SEGMENTED_BYTES) {
            try {
                downloadSegmented(fileUrl, referer, partFile, metaFile, total, onProgress)
            } catch (e: RangeUnsupportedException) {
                // Máy chủ đổi ý giữa chừng: xóa file dở, tải lại 1 luồng.
                partFile.delete()
                metaFile.delete()
                downloadSingle(fileUrl, referer, partFile, total, onProgress)
            } catch (e: LinkExpiredException) {
                // Link ký đã hết hạn: file dở không dùng lại được nữa.
                partFile.delete()
                metaFile.delete()
                throw e
            }
        } else {
            downloadSingle(fileUrl, referer, partFile, total, onProgress)
        }
        val outFile = File(dir, "vdm-${System.currentTimeMillis()}.$ext")
        if (!partFile.renameTo(outFile)) {
            partFile.copyTo(outFile, overwrite = true)
            partFile.delete()
        }
        metaFile.delete()
        onProgress(100f, 0L)
    }

    private data class DownloadProbe(val total: Long?, val rangeSupported: Boolean)

    /** Hỏi máy chủ bằng 1 request Range 0-0: biết tổng dung lượng + có hỗ trợ Range không. */
    private fun probeDownload(fileUrl: String, referer: String?): DownloadProbe {
        try {
            val connection = openDirectConnection(fileUrl, referer)
            connection.setRequestProperty("Range", "bytes=0-0")
            try {
                val code = connection.responseCode
                if (code == HttpURLConnection.HTTP_PARTIAL) {
                    val range = connection.getHeaderField("Content-Range") ?: ""
                    val total = range.substringAfter("/", "").toLongOrNull()?.takeIf { it > 0 }
                    return DownloadProbe(total, true)
                }
                if (code in 200..299) {
                    return DownloadProbe(
                        connection.contentLengthLong.takeIf { it > 0 },
                        false,
                    )
                }
            } finally {
                try {
                    connection.inputStream.close()
                } catch (_: Exception) {
                }
                connection.disconnect()
            }
        } catch (_: Exception) {
            // Không dò được thì tải 1 luồng như thường.
        }
        return DownloadProbe(null, false)
    }

    private fun openDirectConnection(fileUrl: String, referer: String?): HttpURLConnection {
        val connection = URL(fileUrl).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("User-Agent", CHROME_UA)
        if (!referer.isNullOrBlank()) {
            connection.setRequestProperty("Referer", referer)
        }
        return connection
    }

    /** Tải file lớn theo từng đoạn song song, ghi đúng vị trí vào file dở. */
    private suspend fun downloadSegmented(
        fileUrl: String,
        referer: String?,
        partFile: File,
        metaFile: File,
        total: Long,
        onProgress: (Float, Long) -> Unit,
    ) {
        val partSize = (total + SEGMENT_COUNT - 1) / SEGMENT_COUNT
        val ranges = (0 until SEGMENT_COUNT).map { i ->
            val start = i * partSize
            val end = minOf(start + partSize - 1, total - 1)
            start to end
        }
        // File dở từ lần trước chỉ dùng lại được khi vẫn cùng tổng dung lượng.
        val meta = readMeta(metaFile)
        val done: MutableSet<Int>
        if (meta != null && meta.first == total &&
            partFile.exists() && partFile.length() == total
        ) {
            done = meta.second.toMutableSet()
        } else {
            done = mutableSetOf()
            partFile.delete()
            metaFile.delete()
            RandomAccessFile(partFile, "rw").use { it.setLength(total) }
        }
        val downloaded = AtomicLong(
            done.sumOf { i -> ranges[i].second - ranges[i].first + 1 },
        )
        val reporter = ProgressReporter(total, System.currentTimeMillis(), onProgress)
        reporter.report(downloaded.get())
        coroutineScope {
            val jobs = ranges.mapIndexed { index, (start, end) ->
                async {
                    if (index in done) return@async
                    downloadSegment(fileUrl, referer, partFile, start, end, downloaded, reporter)
                    synchronized(META_LOCK) {
                        done += index
                        writeMeta(metaFile, total, done)
                    }
                }
            }
            jobs.awaitAll()
        }
        if (partFile.length() != total) throw Exception("File tải về chưa đủ dung lượng.")
    }

    /** Tải 1 đoạn, thử lại tối đa 3 lần khi mạng chập chờn. */
    private fun downloadSegment(
        fileUrl: String,
        referer: String?,
        partFile: File,
        start: Long,
        end: Long,
        downloaded: AtomicLong,
        reporter: ProgressReporter,
    ) {
        var attempt = 0
        while (true) {
            attempt++
            try {
                downloadSegmentOnce(fileUrl, referer, partFile, start, end, downloaded, reporter)
                return
            } catch (e: Exception) {
                if (cancelRequested || e is RangeUnsupportedException ||
                    e is LinkExpiredException
                ) {
                    throw e
                }
                if (attempt >= SEGMENT_MAX_ATTEMPTS) throw e
            }
        }
    }

    private fun downloadSegmentOnce(
        fileUrl: String,
        referer: String?,
        partFile: File,
        start: Long,
        end: Long,
        downloaded: AtomicLong,
        reporter: ProgressReporter,
    ) {
        val connection = openDirectConnection(fileUrl, referer)
        connection.setRequestProperty("Range", "bytes=$start-$end")
        try {
            when (connection.responseCode) {
                HttpURLConnection.HTTP_PARTIAL -> Unit
                HttpURLConnection.HTTP_FORBIDDEN, HttpURLConnection.HTTP_GONE -> {
                    throw LinkExpiredException()
                }
                HttpURLConnection.HTTP_OK -> throw RangeUnsupportedException()
                else -> throw Exception("Tải trực tiếp thất bại (HTTP ${connection.responseCode})")
            }
            var offset = start
            BufferedInputStream(connection.inputStream).use { input ->
                RandomAccessFile(partFile, "rw").use { raf ->
                    raf.seek(start)
                    val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                    while (true) {
                        if (cancelRequested) throw Exception("Đã hủy lượt tải.")
                        val read = input.read(buffer)
                        if (read < 0) break
                        raf.write(buffer, 0, read)
                        offset += read
                        downloaded.addAndGet(read.toLong())
                        reporter.report(downloaded.get())
                    }
                }
            }
            if (offset != end + 1) throw Exception("Đoạn tải chưa đủ dữ liệu.")
        } finally {
            connection.disconnect()
        }
    }

    /** Tải 1 luồng: file nhỏ, máy chủ không hỗ trợ Range, hoặc dự phòng khi chia đoạn lỗi. */
    private fun downloadSingle(
        fileUrl: String,
        referer: String?,
        partFile: File,
        total: Long?,
        onProgress: (Float, Long) -> Unit,
    ) {
        val connection = openDirectConnection(fileUrl, referer)
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw Exception("Tải trực tiếp thất bại (HTTP $code)")
            val knownTotal = total ?: connection.contentLengthLong.takeIf { it > 0 }
            val startAt = System.currentTimeMillis()
            var downloaded = 0L
            var lastReportAt = 0L
            BufferedInputStream(connection.inputStream).use { input ->
                FileOutputStream(partFile).use { output ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                    while (true) {
                        if (cancelRequested) {
                            partFile.delete()
                            throw Exception("Đã hủy lượt tải.")
                        }
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        if (knownTotal != null) {
                            val now = System.currentTimeMillis()
                            if (now - lastReportAt >= 200) {
                                lastReportAt = now
                                val progress = (downloaded * 100f / knownTotal)
                                    .coerceIn(0f, 100f)
                                val elapsedSec = (now - startAt) / 1000.0
                                val eta = if (elapsedSec > 0 && downloaded > 0) {
                                    ((knownTotal - downloaded) / (downloaded / elapsedSec)).toLong()
                                } else {
                                    0L
                                }
                                onProgress(progress, eta)
                            }
                        }
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    /** Gom tiến trình từ nhiều đoạn tải, báo ra ngoài tối đa ~5 lần/giây. */
    private class ProgressReporter(
        private val total: Long,
        private val startAt: Long,
        private val onProgress: (Float, Long) -> Unit,
    ) {
        private var lastReportAt = 0L

        @Synchronized
        fun report(downloaded: Long) {
            val now = System.currentTimeMillis()
            val progress = (downloaded * 100f / total).coerceIn(0f, 100f)
            if (progress < 100f && now - lastReportAt < 200) return
            lastReportAt = now
            val elapsedSec = (now - startAt) / 1000.0
            val eta = if (elapsedSec > 0 && downloaded > 0) {
                ((total - downloaded) / (downloaded / elapsedSec)).toLong()
            } else {
                0L
            }
            onProgress(progress, eta)
        }
    }

    /** File ghi chú tải dở: tổng dung lượng + các đoạn đã xong. */
    private fun readMeta(metaFile: File): Pair<Long, Set<Int>>? {
        return try {
            if (!metaFile.exists()) return null
            var total: Long? = null
            val done = mutableSetOf<Int>()
            metaFile.forEachLine { line ->
                when {
                    line.startsWith("total=") -> total = line.removePrefix("total=").toLongOrNull()
                    line.startsWith("done=") -> {
                        line.removePrefix("done=").toIntOrNull()?.let { done += it }
                    }
                }
            }
            total?.let { it to done }
        } catch (_: Exception) {
            null
        }
    }

    private fun writeMeta(metaFile: File, total: Long, done: Set<Int>) {
        try {
            val text = buildString {
                appendLine("total=$total")
                done.sorted().forEach { appendLine("done=$it") }
            }
            metaFile.writeText(text)
        } catch (_: Exception) {
            // Ghi chú tải dở thất bại thì lần sau tải lại từ đầu, không chặn lượt tải.
        }
    }

    /** Dọn file tải dở quá 24 giờ để khỏi chật thư mục. */
    private fun cleanStaleParts(dir: File) {
        try {
            val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
            dir.listFiles()?.forEach { file ->
                if ((file.name.endsWith(".part") || file.name.endsWith(".meta")) &&
                    file.lastModified() < cutoff
                ) {
                    file.delete()
                }
            }
        } catch (_: Exception) {
            // Dọn dẹp thất bại thì thôi, không chặn lượt tải.
        }
    }

    private fun sha256Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    /** Máy chủ từ chối Range giữa chừng: caller sẽ tải lại 1 luồng. */
    private class RangeUnsupportedException : Exception()

    /** Link ký hết hạn (403/410): file dở không dùng lại được, cần quét link mới. */
    private class LinkExpiredException :
        Exception("Link tải đã hết hạn. Hãy quét lại link để lấy link mới.")

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

    /** File từ 4 MB trở lên mới đáng chia đoạn tải song song. */
    private const val MIN_SEGMENTED_BYTES = 4L * 1024 * 1024

    /** Số đoạn tải song song cho file lớn. */
    private const val SEGMENT_COUNT = 4

    /** Mỗi đoạn thử lại tối đa 3 lần khi mạng chập chờn. */
    private const val SEGMENT_MAX_ATTEMPTS = 3

    /** Bộ đệm đọc/ghi 256 KB cho lượt tải trực tiếp. */
    private const val DOWNLOAD_BUFFER_SIZE = 262_144

    /** Khóa ghi file ghi chú tải dở từ nhiều đoạn cùng lúc. */
    private val META_LOCK = Any()
}
