package vn.tunglv.browser.data

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import vn.tunglv.browser.filter.FilterStore

/** Một mục lịch sử duyệt web. */
data class HistoryEntry(
    val id: Long,
    val url: String,
    val title: String,
    val time: Long,
)

/** Một dấu trang. */
data class Bookmark(
    val id: Long,
    val url: String,
    val title: String,
    val time: Long,
)

/** Tab đã lưu để mở lại khi mở app lần sau. */
data class SavedTab(
    val id: Long,
    val url: String,
    val title: String,
)

/** Công cụ tìm kiếm dùng khi gõ từ khóa ở thanh địa chỉ. */
data class SearchEngine(
    val id: String,
    val name: String,
    /** Mẫu địa chỉ, %s là từ khóa đã mã hóa. */
    val template: String,
)

val SEARCH_ENGINES = listOf(
    SearchEngine("google", "Google", "https://www.google.com/search?q=%s"),
    SearchEngine("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q=%s"),
    SearchEngine("coccoc", "Cốc Cốc", "https://coccoc.com/search?q=%s"),
    SearchEngine("bing", "Bing", "https://www.bing.com/search?q=%s"),
)

fun searchEngineById(id: String): SearchEngine {
    return SEARCH_ENGINES.firstOrNull { it.id == id } ?: SEARCH_ENGINES[0]
}

/** Cài đặt của app, lưu trong SharedPreferences. */
data class BrowserSettings(
    val adBlockEnabled: Boolean = true,
    val searchEngineId: String = "google",
    /** Giao diện: "system" theo máy, "light" sáng, "dark" tối. */
    val themeMode: String = "system",
)

private const val MAX_HISTORY_ENTRIES = 500

private fun newId(): Long = System.currentTimeMillis()

/**
 * Lịch sử duyệt web, lưu thành file JSON trong bộ nhớ riêng của app.
 * Chỉ ghi khi trang tải xong và là địa chỉ http/https thật.
 */
object HistoryStore {

    private const val FILE_NAME = "history.json"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _entries = MutableStateFlow<List<HistoryEntry>>(emptyList())
    val entries: StateFlow<List<HistoryEntry>> = _entries.asStateFlow()

    @Volatile
    private var loaded = false

    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context.applicationContext
        scope.launch {
            _entries.value = readFile(appContext)
            loaded = true
        }
    }

    fun add(url: String, title: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        val cleanTitle = title.ifBlank { url }
        val current = _entries.value
        // Cùng địa chỉ với mục mới nhất thì chỉ cập nhật tiêu đề, khỏi ghi trùng.
        if (current.firstOrNull()?.url == url) {
            if (current.first().title == cleanTitle) return
            val updated = current.toMutableList()
            updated[0] = updated[0].copy(title = cleanTitle, time = System.currentTimeMillis())
            _entries.value = updated
            saveAsync()
            return
        }
        val entry = HistoryEntry(newId(), url, cleanTitle, System.currentTimeMillis())
        _entries.value = (listOf(entry) + current).take(MAX_HISTORY_ENTRIES)
        saveAsync()
    }

    fun remove(id: Long) {
        _entries.update { list -> list.filter { it.id != id } }
        saveAsync()
    }

    fun clear() {
        _entries.value = emptyList()
        saveAsync()
    }

    /** Gộp lịch sử từ file sao lưu, bỏ mục trùng địa chỉ đã có. Trả về số mục thêm mới. */
    fun merge(imported: List<HistoryEntry>): Int {
        val current = _entries.value
        val knownUrls = current.map { it.url }.toSet()
        val fresh = imported.filter { it.url !in knownUrls }
        if (fresh.isEmpty()) return 0
        _entries.value = (current + fresh)
            .sortedByDescending { it.time }
            .take(MAX_HISTORY_ENTRIES)
        saveAsync()
        return fresh.size
    }

    internal fun snapshot(): List<HistoryEntry> = _entries.value

    private fun saveAsync() {
        if (!loaded) return
        val snapshot = _entries.value
        scope.launch { writeFile(appContext, snapshot) }
    }

    internal fun readFile(context: Context): List<HistoryEntry> {
        return try {
            val file = File(context.filesDir, FILE_NAME)
            if (!file.exists()) return emptyList()
            val array = JSONObject(file.readText(Charsets.UTF_8)).optJSONArray("entries")
                ?: return emptyList()
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                HistoryEntry(
                    id = item.optLong("id", 0L),
                    url = item.optString("url", ""),
                    title = item.optString("title", ""),
                    time = item.optLong("time", 0L),
                ).takeIf { it.url.isNotBlank() }
            }.sortedByDescending { it.time }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeFile(context: Context, entries: List<HistoryEntry>) {
        try {
            val array = JSONArray()
            for (entry in entries) {
                array.put(
                    JSONObject()
                        .put("id", entry.id)
                        .put("url", entry.url)
                        .put("title", entry.title)
                        .put("time", entry.time),
                )
            }
            File(context.filesDir, FILE_NAME)
                .writeText(JSONObject().put("entries", array).toString(), Charsets.UTF_8)
        } catch (_: Exception) {
            // Ghi thất bại thì lịch sử vẫn còn trong bộ nhớ, lần sau ghi lại.
        }
    }
}

/** Dấu trang, lưu thành file JSON trong bộ nhớ riêng của app. */
object BookmarkStore {

    private const val FILE_NAME = "bookmarks.json"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _bookmarks = MutableStateFlow<List<Bookmark>>(emptyList())
    val bookmarks: StateFlow<List<Bookmark>> = _bookmarks.asStateFlow()

    @Volatile
    private var loaded = false

    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context.applicationContext
        scope.launch {
            _bookmarks.value = readFile(appContext)
            loaded = true
        }
    }

    fun isBookmarked(url: String): Boolean {
        return _bookmarks.value.any { it.url == url }
    }

    /** Thêm hoặc gỡ dấu trang. Trả về true khi trang đang có dấu trang sau khi bấm. */
    fun toggle(url: String, title: String): Boolean {
        val current = _bookmarks.value
        return if (current.any { it.url == url }) {
            _bookmarks.value = current.filter { it.url != url }
            saveAsync()
            false
        } else {
            val mark = Bookmark(newId(), url, title.ifBlank { url }, System.currentTimeMillis())
            _bookmarks.value = listOf(mark) + current
            saveAsync()
            true
        }
    }

    fun remove(id: Long) {
        _bookmarks.update { list -> list.filter { it.id != id } }
        saveAsync()
    }

    fun clear() {
        _bookmarks.value = emptyList()
        saveAsync()
    }

    /** Gộp dấu trang từ file sao lưu, bỏ địa chỉ đã có. Trả về số mục thêm mới. */
    fun merge(imported: List<Bookmark>): Int {
        val current = _bookmarks.value
        val knownUrls = current.map { it.url }.toSet()
        val fresh = imported.filter { it.url !in knownUrls }
        if (fresh.isEmpty()) return 0
        _bookmarks.value = current + fresh
        saveAsync()
        return fresh.size
    }

    internal fun snapshot(): List<Bookmark> = _bookmarks.value

    private fun saveAsync() {
        if (!loaded) return
        val snapshot = _bookmarks.value
        scope.launch { writeFile(appContext, snapshot) }
    }

    private fun readFile(context: Context): List<Bookmark> {
        return try {
            val file = File(context.filesDir, FILE_NAME)
            if (!file.exists()) return emptyList()
            val array = JSONObject(file.readText(Charsets.UTF_8)).optJSONArray("bookmarks")
                ?: return emptyList()
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                Bookmark(
                    id = item.optLong("id", 0L),
                    url = item.optString("url", ""),
                    title = item.optString("title", ""),
                    time = item.optLong("time", 0L),
                ).takeIf { it.url.isNotBlank() }
            }.sortedByDescending { it.time }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeFile(context: Context, marks: List<Bookmark>) {
        try {
            val array = JSONArray()
            for (mark in marks) {
                array.put(
                    JSONObject()
                        .put("id", mark.id)
                        .put("url", mark.url)
                        .put("title", mark.title)
                        .put("time", mark.time),
                )
            }
            File(context.filesDir, FILE_NAME)
                .writeText(JSONObject().put("bookmarks", array).toString(), Charsets.UTF_8)
        } catch (_: Exception) {
            // Ghi thất bại thì dấu trang vẫn còn trong bộ nhớ, lần sau ghi lại.
        }
    }
}

/** Cài đặt của app, lưu trong SharedPreferences. */
object SettingsStore {

    private const val PREFS_NAME = "vn_browser_settings"
    private const val KEY_AD_BLOCK = "ad_block_enabled"
    private const val KEY_SEARCH_ENGINE = "search_engine_id"
    private const val KEY_THEME_MODE = "theme_mode"

    private val _settings = MutableStateFlow(BrowserSettings())
    val settings: StateFlow<BrowserSettings> = _settings.asStateFlow()

    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context.applicationContext
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val loaded = BrowserSettings(
            adBlockEnabled = prefs.getBoolean(KEY_AD_BLOCK, true),
            searchEngineId = prefs.getString(KEY_SEARCH_ENGINE, "google") ?: "google",
            themeMode = prefs.getString(KEY_THEME_MODE, "system") ?: "system",
        )
        _settings.value = loaded
        FilterStore.adBlockingEnabled = loaded.adBlockEnabled
    }

    fun update(
        adBlockEnabled: Boolean? = null,
        searchEngineId: String? = null,
        themeMode: String? = null,
    ) {
        val next = _settings.value.copy(
            adBlockEnabled = adBlockEnabled ?: _settings.value.adBlockEnabled,
            searchEngineId = searchEngineId ?: _settings.value.searchEngineId,
            themeMode = themeMode ?: _settings.value.themeMode,
        )
        _settings.value = next
        FilterStore.adBlockingEnabled = next.adBlockEnabled
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AD_BLOCK, next.adBlockEnabled)
            .putString(KEY_SEARCH_ENGINE, next.searchEngineId)
            .putString(KEY_THEME_MODE, next.themeMode)
            .apply()
    }

    internal fun snapshot(): BrowserSettings = _settings.value
}

/** Tab đã lưu, đọc/ghi đồng bộ để TabManager gọi từ luồng nền của nó. */
object TabStore {

    private const val FILE_NAME = "tabs.json"

    fun saveTabs(context: Context, tabs: List<SavedTab>, activeId: Long? = null) {
        try {
            val array = JSONArray()
            for (tab in tabs) {
                array.put(
                    JSONObject()
                        .put("id", tab.id)
                        .put("url", tab.url)
                        .put("title", tab.title),
                )
            }
            val root = JSONObject().put("tabs", array)
            if (activeId != null) root.put("activeId", activeId)
            File(context.filesDir, FILE_NAME).writeText(root.toString(), Charsets.UTF_8)
        } catch (_: Exception) {
            // Ghi thất bại thì lần sau ghi lại, tab vẫn còn trong bộ nhớ.
        }
    }

    /** Tab đang chọn lúc lưu gần nhất, null khi chưa từng lưu. */
    fun loadActiveId(context: Context): Long? {
        return try {
            val file = File(context.filesDir, FILE_NAME)
            if (!file.exists()) return null
            JSONObject(file.readText(Charsets.UTF_8)).optLong("activeId").takeIf { it != 0L }
        } catch (_: Exception) {
            null
        }
    }

    fun loadTabs(context: Context): List<SavedTab> {
        return try {
            val file = File(context.filesDir, FILE_NAME)
            if (!file.exists()) return emptyList()
            val array = JSONObject(file.readText(Charsets.UTF_8)).optJSONArray("tabs")
                ?: return emptyList()
            (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                SavedTab(
                    id = item.optLong("id", 0L),
                    url = item.optString("url", ""),
                    title = item.optString("title", ""),
                ).takeIf { it.url.isNotBlank() }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}

/** Kết quả khôi phục từ file sao lưu. */
data class ImportResult(
    val bookmarksAdded: Int,
    val historyAdded: Int,
    val tabsRestored: Int,
    val settingsApplied: Boolean,
    val error: String? = null,
)

/**
 * Sao lưu và khôi phục: xuất dấu trang, lịch sử, cài đặt và tab đã lưu ra
 * một file JSON, đọc lại file đó để gộp vào máy này. Tab khôi phục sẽ mở
 * lại khi mở app lần sau.
 */
object BackupManager {

    private const val BACKUP_VERSION = 1

    /** Dựng nội dung file sao lưu từ dữ liệu hiện tại trong máy. */
    fun exportData(context: Context): String {
        val root = JSONObject()
        root.put("version", BACKUP_VERSION)
        root.put("app", "VN Browser")
        val settings = SettingsStore.snapshot()
        root.put(
            "settings",
            JSONObject()
                .put("adBlockEnabled", settings.adBlockEnabled)
                .put("searchEngineId", settings.searchEngineId)
                .put("themeMode", settings.themeMode),
        )
        val marks = JSONArray()
        for (mark in BookmarkStore.snapshot()) {
            marks.put(
                JSONObject()
                    .put("id", mark.id)
                    .put("url", mark.url)
                    .put("title", mark.title)
                    .put("time", mark.time),
            )
        }
        root.put("bookmarks", marks)
        val entries = JSONArray()
        for (entry in HistoryStore.snapshot()) {
            entries.put(
                JSONObject()
                    .put("id", entry.id)
                    .put("url", entry.url)
                    .put("title", entry.title)
                    .put("time", entry.time),
            )
        }
        root.put("history", entries)
        val tabs = JSONArray()
        for (tab in TabStore.loadTabs(context)) {
            tabs.put(
                JSONObject()
                    .put("id", tab.id)
                    .put("url", tab.url)
                    .put("title", tab.title),
            )
        }
        root.put("tabs", tabs)
        return root.toString(2)
    }

    /** Đọc file sao lưu và gộp dữ liệu vào máy. */
    fun importData(context: Context, jsonText: String): ImportResult {
        return try {
            val root = JSONObject(jsonText)
            if (root.optString("app", "") != "VN Browser") {
                return ImportResult(0, 0, 0, false, "Đây không phải file sao lưu của VN Browser.")
            }
            val settingsJson = root.optJSONObject("settings")
            var settingsApplied = false
            if (settingsJson != null) {
                SettingsStore.update(
                    adBlockEnabled = settingsJson.optBoolean("adBlockEnabled", true),
                    searchEngineId = settingsJson.optString("searchEngineId", "google"),
                    themeMode = settingsJson.optString("themeMode", "system"),
                )
                settingsApplied = true
            }
            val marks = mutableListOf<Bookmark>()
            root.optJSONArray("bookmarks")?.let { array ->
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val url = item.optString("url", "")
                    if (url.isBlank()) continue
                    marks += Bookmark(
                        id = item.optLong("id", newId()),
                        url = url,
                        title = item.optString("title", url),
                        time = item.optLong("time", System.currentTimeMillis()),
                    )
                }
            }
            val bookmarksAdded = BookmarkStore.merge(marks)
            val entries = mutableListOf<HistoryEntry>()
            root.optJSONArray("history")?.let { array ->
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val url = item.optString("url", "")
                    if (url.isBlank()) continue
                    entries += HistoryEntry(
                        id = item.optLong("id", newId()),
                        url = url,
                        title = item.optString("title", url),
                        time = item.optLong("time", System.currentTimeMillis()),
                    )
                }
            }
            val historyAdded = HistoryStore.merge(entries)
            val tabs = mutableListOf<SavedTab>()
            root.optJSONArray("tabs")?.let { array ->
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val url = item.optString("url", "")
                    if (url.isBlank()) continue
                    tabs += SavedTab(
                        id = item.optLong("id", newId()),
                        url = url,
                        title = item.optString("title", ""),
                    )
                }
            }
            if (tabs.isNotEmpty()) {
                TabStore.saveTabs(context, tabs)
            }
            ImportResult(bookmarksAdded, historyAdded, tabs.size, settingsApplied)
        } catch (e: Exception) {
            ImportResult(0, 0, 0, false, "Không đọc được file sao lưu: ${e.message ?: "lỗi không rõ"}")
        }
    }
}
