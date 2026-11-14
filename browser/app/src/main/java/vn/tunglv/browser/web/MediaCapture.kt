package vn.tunglv.browser.web

import android.net.Uri

/** Loại media bắt được từ request mạng của trang. */
enum class CapturedKind { VIDEO, AUDIO, GENERIC }

/**
 * Một link media bắt được khi trang phát video/âm thanh. Link YouTube giữ
 * thêm mã itag để chọn chất lượng và gộp hình + tiếng.
 */
data class CapturedMedia(
    val url: String,
    val label: String,
    val kind: CapturedKind,
    val itag: String? = null,
    /** Chiều cao video (px) để xếp chất lượng, 0 nếu không biết. */
    val height: Int = 0,
)

/** Link phát của YouTube có sẵn cả hình lẫn tiếng thì tải thẳng 1 file. */
fun CapturedMedia.isProgressiveYouTube(): Boolean = itag == "18" || itag == "22"

/**
 * Khóa gộp link trùng: cùng một luồng phát thì chỉ giữ 1 link, kể cả khi
 * trình phát xin lại nhiều lần với chữ ký khác nhau.
 */
fun captureKey(media: CapturedMedia): String {
    return if (media.itag != null) {
        "yt:${media.itag}:${media.kind}"
    } else {
        try {
            val parsed = java.net.URL(media.url)
            "${parsed.host}${parsed.path}"
        } catch (_: Exception) {
            media.url
        }
    }
}

/**
 * Request mạng nào trông như file video/âm thanh trực tiếp thì bắt, kể cả
 * link phát của YouTube (googlevideo, không có đuôi file).
 */
fun classifyMediaUrl(url: String): CapturedMedia? {
    val lower = url.lowercase()
    // Loại ảnh, mã trang và file phụ trước.
    if (lower.contains(".jpeg") || lower.contains(".jpg") ||
        lower.contains(".png") || lower.contains(".webp") ||
        lower.contains(".gif") || lower.contains(".svg") ||
        lower.contains(".css") || lower.contains(".js") ||
        lower.contains(".json") || lower.contains(".m3u8")
    ) {
        return null
    }
    val host = try {
        java.net.URL(url).host.lowercase()
    } catch (_: Exception) {
        return null
    }
    // Link phát của YouTube: videoplayback trên googlevideo, chất lượng nằm
    // ở tham số itag, loại nằm ở tham số mime.
    if (host.endsWith("googlevideo.com") && lower.contains("videoplayback")) {
        val uri = Uri.parse(url)
        val itag = uri.getQueryParameter("itag") ?: return null
        val mime = uri.getQueryParameter("mime")?.lowercase() ?: ""
        val height = ITAG_HEIGHTS[itag] ?: 0
        val isAudioItag = itag in AUDIO_ITAGS
        return when {
            mime.startsWith("audio/") || isAudioItag -> CapturedMedia(
                url, "Âm thanh", CapturedKind.AUDIO, itag, 0,
            )
            mime.startsWith("video/") || height > 0 -> {
                val label = if (itag == "18" || itag == "22") {
                    "Video ${labelForItag(itag, height)} (có tiếng)"
                } else {
                    "Video ${labelForItag(itag, height)}"
                }
                CapturedMedia(url, label, CapturedKind.VIDEO, itag, height)
            }
            else -> null
        }
    }
    if (lower.contains(".mp4") || lower.contains(".m4v") ||
        lower.contains(".mov") || lower.contains(".webm") ||
        lower.contains(".mkv")
    ) {
        return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    }
    if (lower.contains(".mp3") || lower.contains(".m4a") ||
        lower.contains(".ogg") || lower.contains(".wav")
    ) {
        return CapturedMedia(url, "Âm thanh", CapturedKind.GENERIC)
    }
    // Đầu phát có logo của Douyin (playwm) cũng bắt để đổi sang bản không logo.
    if (lower.contains("/playwm/")) return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    // CDN video của Douyin/TikTok: link phát không có đuôi file.
    if (host.endsWith("douyinvod.com")) return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    if (host.endsWith("snssdk.com") && lower.contains("/play/")) {
        return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    }
    if (host.endsWith("byteoversea.com")) return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    if (host.contains("tiktokcdn") && lower.contains("video")) {
        return CapturedMedia(url, "Video", CapturedKind.GENERIC)
    }
    return null
}

private fun labelForItag(itag: String, height: Int): String {
    return if (height > 0) "${height}p" else "itag $itag"
}

/** Mã itag chỉ có tiếng của YouTube (AAC trước, Opus sau). */
private val AUDIO_ITAGS = setOf("139", "140", "141", "249", "250", "251", "256", "258")

/** Chiều cao theo mã itag của YouTube (H.264, VP9, AV1). */
private val ITAG_HEIGHTS = mapOf(
    "133" to 240, "134" to 360, "135" to 480, "136" to 720, "137" to 1080,
    "18" to 360, "22" to 720,
    "242" to 240, "243" to 360, "244" to 480, "247" to 720, "248" to 1080,
    "271" to 1440, "313" to 2160, "272" to 4320,
    "395" to 240, "396" to 360, "397" to 480, "398" to 720, "399" to 1080,
    "400" to 1440, "401" to 2160,
)
