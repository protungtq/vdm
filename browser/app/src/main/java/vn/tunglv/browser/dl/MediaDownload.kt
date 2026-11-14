package vn.tunglv.browser.dl

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

/** Thông tin video sau khi quét link. */
data class ScannedVideo(
    val title: String,
    val uploader: String?,
    val durationSeconds: Long?,
    val thumbnailUrl: String?,
    val webpageUrl: String?,
    val options: List<VideoFormatOption>,
    /** true khi kết quả đến từ nguồn dự phòng (tikwm) vì bộ quét chính lỗi. */
    val viaFallback: Boolean = false,
)

/**
 * Quét link trang đang mở tìm media và tải về, dùng chung bộ máy yt-dlp với
 * app VDM. Gọn hơn bản VDM: không xem trước, không đường tải Douyin riêng.
 */
object MediaDownload {

    const val PROCESS_ID = "vnbrowser-download"

    private const val TAG = "VNBrowser"

    /** User-Agent Chrome trên điện thoại, dùng cho cả HTTP trực tiếp lẫn WebView. */
    internal const val CHROME_UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    @Volatile
    private var cancelRequested = false

    /** Thư mục lưu file: Download/VN Browser/ trong bộ nhớ chung của máy. */
    fun downloadDir(): File =
        File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "VN Browser",
        )

    /**
     * Ghi chuỗi cookie của WebView thành file định dạng Netscape để yt-dlp
     * dùng được (tải link cần đăng nhập, vd Facebook khi đã đăng nhập sẵn
     * trong trình duyệt). Trả về null khi không có cookie.
     */
    fun writeCookieFile(context: Context, pageUrl: String, cookieString: String?): File? {
        if (cookieString.isNullOrBlank()) return null
        val host = try {
            URL(pageUrl).host.lowercase()
        } catch (_: Exception) {
            return null
        }
        val secure = pageUrl.lowercase().startsWith("https://")
        val expiry = System.currentTimeMillis() / 1000 + 86_400
        val lines = StringBuilder("# Netscape HTTP Cookie File\n")
        cookieString.split(";").forEach { part ->
            val trimmed = part.trim()
            val eq = trimmed.indexOf("=")
            if (eq > 0) {
                val name = trimmed.substring(0, eq).trim()
                val value = trimmed.substring(eq + 1).trim()
                if (name.isNotEmpty()) {
                    lines.append(".$host\tTRUE\t/\t")
                    lines.append(if (secure) "TRUE" else "FALSE")
                    lines.append("\t$expiry\t$name\t$value\n")
                }
            }
        }
        return try {
            val file = File(context.cacheDir, "browser-cookies.txt")
            file.writeText(lines.toString(), Charsets.UTF_8)
            file
        } catch (_: Exception) {
            null
        }
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
                    "bộ quét chưa theo kịp). Hãy vào Cài đặt > Cập nhật bộ quét rồi thử lại; " +
                    "nếu vẫn không được thì video này hiện chưa tải được.",
            )
        } else {
            e
        }
    }

    /**
     * Quét link, trả về tiêu đề + danh sách chất lượng có thể tải.
     * Link rút gọn được mở rộng trước; nếu bộ quét chính (yt-dlp) lỗi với link
     * TikTok thì tự thử nguồn dự phòng tikwm.
     */
    suspend fun fetchInfo(url: String, cookieFile: File?): ScannedVideo =
        withContext(Dispatchers.IO) {
            val resolvedUrl = resolveRedirects(url)
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
        return ScannedVideo(
            title = info.title ?: url,
            uploader = info.uploader,
            durationSeconds = info.duration.takeIf { it > 0 }?.toLong(),
            thumbnailUrl = info.thumbnail,
            webpageUrl = info.webpageUrl,
            options = buildOptions(info),
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
        return ScannedVideo(
            title = title,
            uploader = jsonString(body, "nickname"),
            durationSeconds = jsonInt(body, "duration")?.takeIf { it > 0 },
            thumbnailUrl = jsonString(body, "cover"),
            webpageUrl = originalUrl,
            options = options,
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
        cookieFile: File?,
        onProgress: (Float, Long) -> Unit,
    ): YoutubeDLResponse = withContext(Dispatchers.IO) {
        cancelRequested = false
        val dir = downloadDir()
        if (!dir.exists()) dir.mkdirs()
        if (!dir.exists() || !dir.canWrite()) {
            throw Exception(
                "Không ghi được vào thư mục Download/VN Browser. " +
                    "Hãy cấp quyền truy cập mọi file cho app rồi thử lại.",
            )
        }
        val directUrl = option.directUrl
        if (!directUrl.isNullOrBlank()) {
            downloadDirectSingle(directUrl, dir, option.isAudioOnly, onProgress)
            // Trả về response rỗng để giữ nguyên chữ ký hàm cho DownloadService.
            return@withContext YoutubeDLResponse(emptyList(), 0, 0L, "", "")
        }
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
     * Tải thẳng 1 file từ link trực tiếp (nguồn dự phòng tikwm), 1 luồng.
     * Video TikTok thường nhỏ nên không cần chia đoạn như bản VDM.
     */
    private fun downloadDirectSingle(
        fileUrl: String,
        dir: File,
        isAudio: Boolean,
        onProgress: (Float, Long) -> Unit,
    ) {
        val ext = if (isAudio) "mp3" else "mp4"
        val outFile = File(dir, "vnbrowser-${System.currentTimeMillis()}.$ext")
        val connection = URL(fileUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("User-Agent", CHROME_UA)
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw Exception("Máy chủ trả về HTTP $code")
            val total = connection.contentLengthLong.takeIf { it > 0 }
            val input = BufferedInputStream(connection.inputStream)
            var read = 0L
            val buffer = ByteArray(262_144)
            FileOutputStream(outFile).use { output ->
                while (true) {
                    if (cancelRequested) {
                        output.close()
                        outFile.delete()
                        throw Exception("Đã hủy tải.")
                    }
                    val n = input.read(buffer)
                    if (n < 0) break
                    output.write(buffer, 0, n)
                    read += n
                    if (total != null) onProgress(read * 100f / total, 0L)
                }
            }
            input.close()
        } finally {
            connection.disconnect()
        }
        onProgress(100f, 0L)
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
