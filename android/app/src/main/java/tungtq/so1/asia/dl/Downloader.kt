package tungtq.so1.asia.dl

import android.os.Environment
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.youtubedl_android.YoutubeDLResponse
import com.yausername.youtubedl_android.mapper.VideoFormat
import com.yausername.youtubedl_android.mapper.VideoInfo
import java.io.File
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
)

object Downloader {

    const val PROCESS_ID = "vdm-download"

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

    /** Quét link, trả về tiêu đề + danh sách chất lượng có thể tải. */
    suspend fun fetchInfo(url: String): ScannedVideo = withContext(Dispatchers.IO) {
        val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-warnings")
        }
        val info: VideoInfo = YoutubeDL.getInstance().getInfo(request)
        val formats = info.formats ?: emptyList()
        ScannedVideo(
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

    private fun buildOptions(info: VideoInfo): List<VideoFormatOption> {
        val options = mutableListOf<VideoFormatOption>()
        val seenHeights = mutableSetOf<Int>()
        val formats = info.formats ?: emptyList()

        // Video: mỗi độ cao (1080, 720...) chỉ giữ 1 lựa chọn tốt nhất, ưu tiên mp4 có sẵn âm thanh.
        val videoFormats = formats
            .filter { it.height > 0 && it.vcodec != null && it.vcodec != "none" }
            .sortedWith(
                compareByDescending<VideoFormat> { it.height }
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
            .sortedByDescending { it.height }
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
     * Ném YoutubeDLException khi lỗi.
     */
    suspend fun download(
        url: String,
        option: VideoFormatOption,
        onProgress: (Float, Long) -> Unit,
    ): YoutubeDLResponse = withContext(Dispatchers.IO) {
        val dir = downloadDir()
        if (!dir.exists()) dir.mkdirs()
        val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-mtime")
            addOption("--no-warnings")
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

    /** Hủy lượt tải đang chạy (nếu có). */
    fun cancel() {
        try {
            YoutubeDL.getInstance().destroyProcessById(PROCESS_ID)
        } catch (_: Exception) {
            // Không có tiến trình nào đang chạy thì thôi.
        }
    }

    const val AUDIO_SPEC = "__audio__"
}
