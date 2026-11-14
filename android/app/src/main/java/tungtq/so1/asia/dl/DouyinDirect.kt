package tungtq.so1.asia.dl

import java.net.HttpURLConnection
import java.net.URL
import java.util.regex.Pattern

/**
 * Đường lấy link trực tiếp cho Douyin không qua yt-dlp (API của yt-dlp đã bị
 * Douyin chặn từ tháng 6/2026): đọc link phát không logo (play_addr) trong dữ
 * liệu nhúng của trang share iesdouyin.com.
 */
object DouyinDirect {

    const val REFERER = "https://www.douyin.com/"

    fun isDouyinUrl(url: String): Boolean {
        return try {
            URL(url).host.lowercase().endsWith("douyin.com")
        } catch (_: Exception) {
            url.lowercase().contains("douyin.com")
        }
    }

    /** Lấy mã số video từ link /video/<id> hoặc /note/<id> của Douyin. */
    fun extractVideoId(url: String): String? {
        val matcher = Pattern.compile("/(?:video|note)/(\\d+)").matcher(url)
        return if (matcher.find()) matcher.group(1) else null
    }

    /**
     * Đổi link phát có logo (playwm) sang bản không logo (play).
     * Trả về null nếu link không chứa playwm.
     */
    fun noWatermarkVariant(url: String): String? {
        val rewritten = url.replace("/playwm/", "/play/")
        return if (rewritten != url) rewritten else null
    }

    /**
     * Tải HTML trang share của video. Trả về null khi không lấy được.
     * [cookieHeader] là chuỗi cookie "a=1; b=2" (nếu có) để trang khỏi chặn.
     */
    fun fetchShareHtml(videoId: String, cookieHeader: String?): String? {
        return try {
            val shareUrl = "https://www.iesdouyin.com/share/video/$videoId/"
            val connection = URL(shareUrl).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("User-Agent", Downloader.CHROME_UA)
            connection.setRequestProperty(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            if (!cookieHeader.isNullOrBlank()) {
                connection.setRequestProperty("Cookie", cookieHeader)
            }
            try {
                if (connection.responseCode !in 200..299) return null
                connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Tìm link đầu tiên trong play_addr.url_list của dữ liệu nhúng trong trang. */
    fun extractPlayAddrUrl(html: String): String? {
        val text = unescapeJsonText(html)
        val matcher = Pattern.compile(
            "\"play_addr\"\\s*:\\s*\\{[^}]*?\"url_list\"\\s*:\\s*\\[\\s*\"([^\"]+)\"",
            Pattern.DOTALL,
        ).matcher(text)
        if (!matcher.find()) return null
        val raw = matcher.group(1) ?: return null
        if (raw.isBlank()) return null
        return noWatermarkVariant(raw) ?: raw
    }

    /** Lấy tiêu đề video từ og:title của trang share (nếu có). */
    fun extractShareTitle(html: String): String? {
        val matcher = Pattern.compile(
            "<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)[\"']",
            Pattern.CASE_INSENSITIVE,
        ).matcher(html)
        if (!matcher.find()) return null
        val raw = matcher.group(1)?.trim().orEmpty()
        if (raw.isBlank()) return null
        return raw
            .replace("&quot;", "\"")
            .replace("&amp;", "&")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .trim()
            .takeIf { it.isNotBlank() }
    }

    /** Đo dung lượng file ở link trực tiếp (HEAD, rồi fallback Range 0-0). Null khi không đo được. */
    fun probeContentLength(fileUrl: String, referer: String?): Long? {
        probeViaHead(fileUrl, referer)?.let { return it }
        return probeViaRange(fileUrl, referer)
    }

    private fun probeViaHead(fileUrl: String, referer: String?): Long? {
        return try {
            val connection = URL(fileUrl).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.requestMethod = "HEAD"
            connection.setRequestProperty("User-Agent", Downloader.CHROME_UA)
            if (!referer.isNullOrBlank()) connection.setRequestProperty("Referer", referer)
            try {
                if (connection.responseCode !in 200..299) return null
                connection.contentLengthLong.takeIf { it > 0 }
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun probeViaRange(fileUrl: String, referer: String?): Long? {
        return try {
            val connection = URL(fileUrl).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.setRequestProperty("User-Agent", Downloader.CHROME_UA)
            connection.setRequestProperty("Range", "bytes=0-0")
            if (!referer.isNullOrBlank()) connection.setRequestProperty("Referer", referer)
            try {
                if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) return null
                val range = connection.getHeaderField("Content-Range") ?: return null
                // Dạng: "bytes 0-0/12345678"
                range.substringAfter("/", "").toLongOrNull()?.takeIf { it > 0 }
            } finally {
                try {
                    connection.inputStream.close()
                } catch (_: Exception) {
                }
                connection.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Nhãn dung lượng kiểu "12 MB" / "1,5 GB" để hiện cạnh link bắt được. */
    fun formatBytes(bytes: Long?): String? {
        if (bytes == null || bytes <= 0) return null
        return when {
            bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1_000_000_000.0)
            bytes >= 1_000_000 -> "%.0f MB".format(bytes / 1_000_000.0)
            else -> "%d KB".format(bytes / 1_000)
        }
    }

    /** Gỡ escape JSON (\/, \uXXXX, \\, \") trong một đoạn văn bản. */
    private fun unescapeJsonText(raw: String): String {
        val out = StringBuilder(raw.length)
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (c == '\\' && i + 1 < raw.length) {
                when (raw[i + 1]) {
                    '/' -> {
                        out.append('/')
                        i += 2
                    }
                    'u' -> {
                        if (i + 5 < raw.length) {
                            raw.substring(i + 2, i + 6).toIntOrNull(16)?.let { out.append(it.toChar()) }
                            i += 6
                        } else {
                            i += 2
                        }
                    }
                    '\\' -> {
                        out.append('\\')
                        i += 2
                    }
                    '"' -> {
                        out.append('"')
                        i += 2
                    }
                    else -> {
                        out.append(raw[i + 1])
                        i += 2
                    }
                }
            } else {
                out.append(c)
                i += 1
            }
        }
        return out.toString()
    }
}
