package vn.tunglv.browser.filter

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Giả dạng Chrome trên điện thoại để các trang và máy chủ bộ lọc trả bản đầy đủ. */
internal const val CHROME_UA =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

/**
 * Tải và lưu đệm các bộ lọc quảng cáo, dựng bộ máy chặn từ bản đã lưu.
 * Bộ lọc tải về lưu trong bộ nhớ đệm của app, quá 24 giờ thì tải lại (dùng
 * conditional GET để khỏi tải lại khi máy chủ báo chưa đổi). Chưa có bộ lọc
 * nào trong máy thì bộ máy chặn coi như chưa sẵn sàng, WebView vẫn dùng
 * danh sách chặn ghi cứng làm dự phòng.
 */
object FilterStore {

    private const val TAG = "VNB"

    /** Quá hạn này thì kiểm tra bản mới khi mở trình duyệt. */
    private const val REFRESH_INTERVAL_MS = 24L * 60 * 60 * 1000

    private const val DIR_NAME = "filter_lists"

    private data class FilterList(val id: String, val url: String)

    private val LISTS = listOf(
        FilterList(
            "fmsf",
            "https://raw.githubusercontent.com/nmtrung/FMSF-2.0/master/fmsf_2.0.txt",
        ),
        FilterList(
            "abpvn",
            "https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt",
        ),
        FilterList(
            "adguard-mobile",
            "https://filters.adtidy.org/extension/ublock/filters/11.txt",
        ),
        FilterList(
            "easylist",
            "https://ublockorigin.pages.dev/thirdparties/easylist.txt",
        ),
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var engine: FilterListEngine? = null

    @Volatile
    private var refreshRunning = false

    /** Công tắc chặn quảng cáo, bật sẵn; tắt thì WebView chạy như thường. */
    @Volatile
    var adBlockingEnabled: Boolean = true

    private val _blockedCount = MutableStateFlow(0)

    /** Số request quảng cáo đã chặn từ lúc mở app. */
    val blockedCount: StateFlow<Int> = _blockedCount.asStateFlow()

    /** true khi đã nạp được ít nhất 1 bộ lọc vào bộ máy. */
    val isReady: Boolean
        get() = engine != null

    /**
     * true khi request nên bị chặn. Chưa nạp bộ lọc hoặc đã tắt công tắc
     * thì luôn trả về false. Mỗi lần chặn thì tăng bộ đếm để hiện lên
     * thanh công cụ. Lỗi trong lúc xét thì coi như không chặn, không để
     * lỗi này lan ra ngoài làm sập app.
     */
    fun isBlocked(url: String, documentUrl: String?): Boolean {
        if (!adBlockingEnabled) return false
        return try {
            val blocked = engine?.isBlocked(url, documentUrl) ?: false
            if (blocked) _blockedCount.update { it + 1 }
            blocked
        } catch (_: Throwable) {
            false
        }
    }

    /** Đọc các bộ lọc đã lưu trong máy và dựng bộ máy, chạy nền không chặn. */
    fun loadCached(context: Context) {
        val appContext = context.applicationContext
        scope.launch {
            buildEngine(appContext)
        }
    }

    /**
     * Kiểm tra và tải mới các bộ lọc đã quá hạn, rồi dựng lại bộ máy.
     * Lần đầu chưa có bộ lọc nào thì tải luôn cả 4. Chạy nền, gọi nhiều lần
     * cùng lúc cũng chỉ chạy 1 lượt.
     */
    fun refreshIfNeeded(context: Context) {
        if (refreshRunning) return
        refreshRunning = true
        val appContext = context.applicationContext
        scope.launch {
            try {
                var changed = false
                for (list in LISTS) {
                    if (refreshOne(appContext, list)) changed = true
                }
                if (changed || engine == null) {
                    buildEngine(appContext)
                }
            } finally {
                refreshRunning = false
            }
        }
    }

    /** Đọc toàn bộ file đã lưu và dựng bộ máy chặn mới. */
    private fun buildEngine(context: Context) {
        try {
            val dir = listsDir(context)
            val texts = LISTS.mapNotNull { list ->
                val file = File(dir, list.id + ".txt")
                if (file.exists() && file.length() > 0) {
                    file.readText(Charsets.UTF_8)
                } else {
                    null
                }
            }
            if (texts.isEmpty()) return
            val built = FilterListEngine.parse(texts)
            engine = built
            Log.d(TAG, "filter engine ready: ${built.ruleCount} rules from ${texts.size} lists")
        } catch (e: Throwable) {
            Log.w(TAG, "building filter engine failed", e)
        }
    }

    /**
     * Tải mới 1 bộ lọc nếu đã quá hạn. Trả về true khi file trên máy thay đổi.
     * Dùng conditional GET: máy chủ trả 304 thì giữ file cũ, chỉ cập nhật
     * thời điểm kiểm tra.
     */
    private fun refreshOne(context: Context, list: FilterList): Boolean {
        val dir = listsDir(context)
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, list.id + ".txt")
        val metaFile = File(dir, list.id + ".meta")
        val meta = readMeta(metaFile)
        val now = System.currentTimeMillis()
        if (file.exists() && file.length() > 0 && now - meta.fetchedAt < REFRESH_INTERVAL_MS) {
            return false
        }
        return try {
            val connection = URL(list.url).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            connection.setRequestProperty("User-Agent", CHROME_UA)
            connection.setRequestProperty("Accept", "text/plain,*/*")
            if (!meta.etag.isNullOrBlank()) {
                connection.setRequestProperty("If-None-Match", meta.etag)
            }
            if (!meta.lastModified.isNullOrBlank()) {
                connection.setRequestProperty("If-Modified-Since", meta.lastModified)
            }
            try {
                when (connection.responseCode) {
                    HttpURLConnection.HTTP_NOT_MODIFIED -> {
                        writeMeta(metaFile, meta.etag, meta.lastModified, now)
                        false
                    }
                    HttpURLConnection.HTTP_OK -> {
                        val body = connection.inputStream.bufferedReader(Charsets.UTF_8)
                            .use { it.readText() }
                        if (body.isBlank()) return false
                        file.writeText(body, Charsets.UTF_8)
                        writeMeta(
                            metaFile,
                            connection.getHeaderField("ETag"),
                            connection.getHeaderField("Last-Modified"),
                            now,
                        )
                        true
                    }
                    else -> {
                        Log.w(TAG, "filter ${list.id} returned HTTP ${connection.responseCode}")
                        false
                    }
                }
            } finally {
                connection.disconnect()
            }
        } catch (e: Throwable) {
            Log.w(TAG, "filter ${list.id} refresh failed", e)
            false
        }
    }

    private class Meta(
        val etag: String?,
        val lastModified: String?,
        val fetchedAt: Long,
    )

    private fun readMeta(metaFile: File): Meta {
        return try {
            if (!metaFile.exists()) return Meta(null, null, 0L)
            var etag: String? = null
            var lastModified: String? = null
            var fetchedAt = 0L
            metaFile.forEachLine { line ->
                when {
                    line.startsWith("etag=") -> etag = line.removePrefix("etag=").takeIf { it.isNotEmpty() }
                    line.startsWith("last-modified=") -> {
                        lastModified = line.removePrefix("last-modified=").takeIf { it.isNotEmpty() }
                    }
                    line.startsWith("fetched-at=") -> {
                        fetchedAt = line.removePrefix("fetched-at=").toLongOrNull() ?: 0L
                    }
                }
            }
            Meta(etag, lastModified, fetchedAt)
        } catch (_: Exception) {
            Meta(null, null, 0L)
        }
    }

    private fun writeMeta(metaFile: File, etag: String?, lastModified: String?, fetchedAt: Long) {
        try {
            val text = buildString {
                appendLine("etag=${etag ?: ""}")
                appendLine("last-modified=${lastModified ?: ""}")
                appendLine("fetched-at=$fetchedAt")
            }
            metaFile.writeText(text)
        } catch (_: Exception) {
            // Ghi chú thất bại thì lần sau kiểm tra lại, không sao.
        }
    }

    private fun listsDir(context: Context): File = File(context.cacheDir, DIR_NAME)
}
