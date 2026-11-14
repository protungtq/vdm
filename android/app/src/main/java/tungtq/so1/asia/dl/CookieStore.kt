package tungtq.so1.asia.dl

import android.content.Context
import java.io.File

/** Nền tảng có thể lấy cookie qua trình duyệt trong app. */
enum class CookiePlatform(
    val label: String,
    /** Trang mở trong WebView. */
    val startUrl: String,
    /** Các URL để đọc cookie (gộp lại, tránh trùng tên). */
    val cookieUrls: List<String>,
    /** Domain ghi vào file Netscape. */
    val cookieDomain: String,
    /** Ghi chú riêng hiển thị trong WebView. */
    val hint: String,
) {
    DOUYIN(
        label = "Douyin",
        startUrl = "https://www.douyin.com/",
        cookieUrls = listOf("https://www.douyin.com/"),
        cookieDomain = ".douyin.com",
        hint = "Chỉ cần mở trang, không cần đăng nhập. Đợi trang tải xong rồi bấm Lưu cookie.",
    ),
    TIKTOK(
        label = "TikTok",
        startUrl = "https://www.tiktok.com/",
        cookieUrls = listOf("https://www.tiktok.com/"),
        cookieDomain = ".tiktok.com",
        hint = "Chỉ cần khi gặp link TikTok bị chặn. Đăng nhập nếu muốn, hoặc chỉ mở trang rồi lưu.",
    ),
    X(
        label = "X (Twitter)",
        startUrl = "https://x.com/",
        cookieUrls = listOf("https://x.com/", "https://twitter.com/", "https://api.x.com/"),
        cookieDomain = ".x.com",
        hint = "Đăng nhập tài khoản X trong trang này, đợi đăng nhập xong rồi bấm Lưu cookie.",
    ),
    REDDIT(
        label = "Reddit",
        startUrl = "https://www.reddit.com/login/",
        cookieUrls = listOf("https://www.reddit.com/", "https://reddit.com/"),
        cookieDomain = ".reddit.com",
        hint = "Đăng nhập tài khoản Reddit trong trang này, đợi đăng nhập xong rồi bấm Lưu cookie.",
    ),
}

/**
 * Lưu cookie từng nền tảng vào SharedPreferences (chỉ trong máy, không gửi đi đâu)
 * và ghi file cookies.txt định dạng Netscape để yt-dlp đọc qua tùy chọn --cookies.
 */
object CookieStore {

    private const val PREFS = "vdm_cookies"
    private const val FILE_NAME = "cookies.txt"

    /** Hạn xa trong tương lai: cookie thật hết hạn thì máy chủ tự từ chối. */
    private const val EXPIRY_SECONDS = 2_147_483_647L

    fun saveCookies(context: Context, platform: CookiePlatform, cookieString: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(platform.name, cookieString)
            .apply()
        writeCookiesFile(context)
    }

    fun clearCookies(context: Context, platform: CookiePlatform) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(platform.name)
            .apply()
        writeCookiesFile(context)
    }

    fun hasCookies(context: Context, platform: CookiePlatform): Boolean {
        return !context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(platform.name, null).isNullOrBlank()
    }

    /** Chuỗi cookie đã lưu của 1 nền tảng, hoặc null khi chưa có. */
    fun savedCookies(context: Context, platform: CookiePlatform): String? {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(platform.name, null)?.takeIf { it.isNotBlank() }
    }

    /** File cookie gộp mọi nền tảng, hoặc null khi chưa có cookie nào. */
    fun cookieFileIfAny(context: Context): File? {
        val file = File(context.cacheDir, FILE_NAME)
        if (!file.exists()) writeCookiesFile(context)
        return file.takeIf { it.exists() && it.length() > 0 }
    }

    /** Gộp nhiều chuỗi cookie "a=1; b=2" thành một, trùng tên thì cái sau thắng. */
    fun mergeCookieStrings(vararg cookieStrings: String?): String {
        val merged = linkedMapOf<String, String>()
        for (raw in cookieStrings) {
            if (raw.isNullOrBlank()) continue
            for (pair in raw.split(";")) {
                val trimmed = pair.trim()
                if (trimmed.isEmpty()) continue
                val eq = trimmed.indexOf('=')
                if (eq <= 0) continue
                val name = trimmed.substring(0, eq).trim()
                val value = trimmed.substring(eq + 1).trim()
                if (name.isNotEmpty()) merged[name] = value
            }
        }
        return merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    private fun writeCookiesFile(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lines = mutableListOf("# Netscape HTTP Cookie File")
        for (platform in CookiePlatform.entries) {
            val raw = prefs.getString(platform.name, null) ?: continue
            val seen = mutableSetOf<String>()
            for (pair in raw.split(";")) {
                val trimmed = pair.trim()
                if (trimmed.isEmpty()) continue
                val eq = trimmed.indexOf('=')
                if (eq <= 0) continue
                val name = trimmed.substring(0, eq).trim()
                val value = trimmed.substring(eq + 1).trim()
                if (name.isEmpty() || !seen.add(name)) continue
                lines += listOf(
                    platform.cookieDomain,
                    "TRUE",
                    "/",
                    "TRUE",
                    EXPIRY_SECONDS.toString(),
                    name,
                    value,
                ).joinToString("\t")
            }
        }
        val file = File(context.cacheDir, FILE_NAME)
        if (lines.size <= 1) {
            file.delete()
            return
        }
        file.writeText(lines.joinToString("\n") + "\n")
    }
}
