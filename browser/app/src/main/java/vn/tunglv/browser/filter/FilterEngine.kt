package vn.tunglv.browser.filter

import java.net.URL
import java.util.regex.Pattern

/**
 * Bộ máy chặn quảng cáo theo danh sách lọc (cú pháp Adblock Plus / uBlock).
 * Chỉ xử lý rule mạng; rule ẩn phần tử giao diện (##, #@#...) được bỏ qua vì
 * việc chặn ở đây diễn ra ở tầng request mạng, không chạm tới DOM.
 *
 * Hỗ trợ đủ dùng cho các bộ lọc phổ biến: rule domain (||...), chuỗi con có
 * ký tự đại diện (*, ^, |), biểu thức chính quy (/.../), rule ngoại lệ (@@),
 * tùy chọn domain= và third-party. Rule nào dùng cú pháp nâng cao không hỗ
 * trợ (redirect, removeparam, csp...) thì bỏ qua cho an toàn.
 */
class FilterListEngine private constructor(
    private val blockByDomain: Map<String, List<DomainRule>>,
    private val exceptionByDomain: Map<String, List<DomainRule>>,
    private val blockOthers: List<GenericRule>,
    private val exceptionOthers: List<GenericRule>,
) {

    /** Số rule mạng đã nạp (để ghi log chẩn đoán). */
    val ruleCount: Int =
        blockByDomain.values.sumOf { it.size } +
            exceptionByDomain.values.sumOf { it.size } +
            blockOthers.size + exceptionOthers.size

    /**
     * true khi request tới [url] nên bị chặn. [documentUrl] là URL trang đang
     * mở trong WebView (để xét tùy chọn domain= và third-party), null khi
     * không biết.
     */
    fun isBlocked(url: String, documentUrl: String?): Boolean {
        val host = hostOf(url) ?: return false
        val documentHost = documentUrl?.let { hostOf(it) }
        // Ngoại lệ luôn thắng rule chặn.
        if (matches(exceptionByDomain, exceptionOthers, url, host, documentHost)) return false
        return matches(blockByDomain, blockOthers, url, host, documentHost)
    }

    private fun matches(
        byDomain: Map<String, List<DomainRule>>,
        others: List<GenericRule>,
        url: String,
        host: String,
        documentHost: String?,
    ): Boolean {
        // Rule domain: chỉ xét các rule gắn với host hoặc domain cha của host.
        var suffix = host
        while (true) {
            val rules = byDomain[suffix]
            if (rules != null) {
                for (rule in rules) {
                    if (rule.matches(url, host, documentHost)) return true
                }
            }
            val dot = suffix.indexOf('.')
            if (dot < 0) break
            suffix = suffix.substring(dot + 1)
        }
        for (rule in others) {
            if (rule.matches(url, host, documentHost)) return true
        }
        return false
    }

    /** Rule gắn với 1 domain: ||domain + phần còn lại của pattern. */
    private class DomainRule(
        val domain: String,
        private val remainderKind: Int,
        private val literal: String?,
        private val literalNeedsSeparator: Boolean,
        private val regex: Pattern?,
        private val options: RuleOptions,
    ) {
        fun matches(url: String, host: String, documentHost: String?): Boolean {
            if (!options.appliesTo(documentHost, host)) return false
            val remainder = remainderAfterDomain(url, host, domain) ?: return false
            return when (remainderKind) {
                KIND_NONE -> true
                KIND_LITERAL -> {
                    val lit = literal ?: return false
                    if (!remainder.startsWith(lit)) return false
                    if (!literalNeedsSeparator) return true
                    val after = remainder.length - lit.length
                    after == 0 || isSeparator(remainder[lit.length])
                }
                else -> regex?.matcher(remainder)?.find() ?: false
            }
        }

        companion object {
            const val KIND_NONE = 0
            const val KIND_LITERAL = 1
            const val KIND_REGEX = 2
        }
    }

    /** Rule không gắn domain: chuỗi con, ký tự đại diện, hoặc biểu thức chính quy. */
    private class GenericRule(
        private val literal: String?,
        private val regex: Pattern?,
        private val anchorStart: Boolean,
        private val anchorEnd: Boolean,
        private val requiredLiteral: String?,
        private val options: RuleOptions,
    ) {
        fun matches(url: String, host: String, documentHost: String?): Boolean {
            if (!options.appliesTo(documentHost, host)) return false
            val req = requiredLiteral
            if (req != null && !url.contains(req)) return false
            val rx = regex
            if (rx != null) return rx.matcher(url).find()
            val lit = literal ?: return false
            return when {
                anchorStart -> url.startsWith(lit)
                anchorEnd -> url.endsWith(lit)
                else -> url.contains(lit)
            }
        }
    }

    /** Tùy chọn domain= và third-party của 1 rule. */
    private class RuleOptions(
        private val domains: List<String>,
        private val notDomains: List<String>,
        private val thirdParty: Boolean?,
    ) {
        fun appliesTo(documentHost: String?, requestHost: String): Boolean {
            if (domains.isNotEmpty() || notDomains.isNotEmpty()) {
                if (documentHost == null) return false
                if (notDomains.any { hostMatchesDomain(documentHost, it) }) return false
                if (domains.isNotEmpty() &&
                    domains.none { hostMatchesDomain(documentHost, it) }
                ) {
                    return false
                }
            }
            if (thirdParty != null) {
                val isThird = isThirdParty(requestHost, documentHost)
                if (thirdParty != isThird) return false
            }
            return true
        }
    }

    companion object {

        /** Dựng bộ máy từ nội dung thô của các bộ lọc. */
        fun parse(texts: List<String>): FilterListEngine {
            val blockByDomain = mutableMapOf<String, MutableList<DomainRule>>()
            val exceptionByDomain = mutableMapOf<String, MutableList<DomainRule>>()
            val blockOthers = mutableListOf<GenericRule>()
            val exceptionOthers = mutableListOf<GenericRule>()
            val disabledKeys = mutableSetOf<String>()
            // Lượt 1: gom các rule $badfilter (rule phủ định rule khác).
            val parsed = mutableListOf<ParsedLine>()
            for (text in texts) {
                for (rawLine in text.lineSequence()) {
                    val parsedLine = parseLine(rawLine) ?: continue
                    if (parsedLine.isBadFilter) {
                        disabledKeys += parsedLine.key
                    } else {
                        parsed += parsedLine
                    }
                }
            }
            for (entry in parsed) {
                if (entry.key in disabledKeys) continue
                when (val rule = entry.rule) {
                    is DomainRule -> {
                        val target = if (entry.isException) exceptionByDomain else blockByDomain
                        target.getOrPut(rule.domain) { mutableListOf() } += rule
                    }
                    is GenericRule -> {
                        val target = if (entry.isException) exceptionOthers else blockOthers
                        target += rule
                    }
                }
            }
            return FilterListEngine(blockByDomain, exceptionByDomain, blockOthers, exceptionOthers)
        }

        private class ParsedLine(
            val key: String,
            val isException: Boolean,
            val isBadFilter: Boolean,
            val rule: Any,
        )

        /** Phân tích 1 dòng của bộ lọc. Trả về null khi dòng không phải rule mạng. */
        private fun parseLine(rawLine: String): ParsedLine? {
            var line = rawLine.trim()
            if (line.isEmpty()) return null
            if (line.startsWith("!") || line.startsWith("[") || line.startsWith("%")) return null
            // Rule ẩn phần tử giao diện: bỏ qua.
            if (line.contains("##") || line.contains("#@#") || line.contains("#\$#") ||
                line.contains("#?#") || line.contains("#\$?#")
            ) {
                return null
            }
            var isException = false
            if (line.startsWith("@@")) {
                isException = true
                line = line.substring(2)
            }
            // Tách tùy chọn sau dấu $ đầu tiên (pattern không chứa $ chưa escape).
            var pattern = line
            var optionsText: String? = null
            val dollar = line.indexOf('$')
            if (dollar >= 0) {
                pattern = line.substring(0, dollar)
                optionsText = line.substring(dollar + 1)
            }
            if (pattern.isEmpty()) return null
            val optionsResult = parseOptions(optionsText, isException) ?: return null
            // Khóa so khớp $badfilter: pattern + tùy chọn đã chuẩn hóa (bỏ
            // badfilter, sắp xếp), kèm cờ ngoại lệ để không nhầm lẫn nhau.
            val normalizedOptions = optionsText
                ?.split(",")
                ?.map { it.trim() }
                ?.filter { it != "badfilter" && it.isNotEmpty() }
                ?.sorted()
                ?.joinToString(",")
            val key = (if (isException) "1" else "0") + "|" + pattern + "|" +
                (normalizedOptions ?: "")
            val rule = parsePattern(pattern, optionsResult.options) ?: return null
            return ParsedLine(key, isException, optionsResult.isBadFilter, rule)
        }

        private class OptionsResult(val options: RuleOptions, val isBadFilter: Boolean)

        /** Phân tích chuỗi tùy chọn. Trả về null khi rule nên bỏ qua hẳn. */
        private fun parseOptions(raw: String?, isException: Boolean): OptionsResult? {
            if (raw.isNullOrEmpty()) return OptionsResult(RuleOptions(emptyList(), emptyList(), null), false)
            val domains = mutableListOf<String>()
            val notDomains = mutableListOf<String>()
            var thirdParty: Boolean? = null
            var isBadFilter = false
            var cosmeticOnly = true
            for (token in raw.split(",")) {
                val opt = token.trim()
                if (opt.isEmpty()) continue
                when {
                    opt == "badfilter" -> isBadFilter = true
                    opt == "third-party" -> {
                        thirdParty = true
                        cosmeticOnly = false
                    }
                    opt == "~third-party" || opt == "first-party" -> {
                        thirdParty = false
                        cosmeticOnly = false
                    }
                    opt.startsWith("domain=") -> {
                        cosmeticOnly = false
                        for (part in opt.removePrefix("domain=").split("|")) {
                            val d = part.trim().lowercase().trimEnd('.')
                            if (d.isEmpty()) continue
                            if (d.startsWith("~")) notDomains += d.substring(1) else domains += d
                        }
                    }
                    opt == "popup" || opt == "popunder" -> return null
                    opt == "elemhide" || opt == "generichide" -> Unit
                    opt == "document" -> {
                        // Rule chặn $document chỉ chặn cả trang, bộ máy không
                        // chặn frame chính nên bỏ; ngoại lệ $document thì giữ.
                        if (!isException) return null
                        cosmeticOnly = false
                    }
                    opt.startsWith("csp=") || opt.startsWith("redirect=") ||
                        opt.startsWith("removeparam=") || opt.startsWith("replace=") ||
                        opt.startsWith("header=") -> return null
                    // $empty (chặn và trả rỗng) và các tùy chọn loại tài
                    // nguyên khác: giữ rule như rule chặn thường.
                    else -> cosmeticOnly = false
                }
            }
            // Rule chỉ mang tùy chọn giao diện (elemhide/generichide) thì không
            // có tác dụng ở tầng mạng. Rule $badfilter thì luôn giữ lại để nó
            // phủ định được rule đích.
            if (cosmeticOnly && !isBadFilter) return null
            return OptionsResult(RuleOptions(domains, notDomains, thirdParty), isBadFilter)
        }

        /** Phân tích pattern thành rule domain hoặc rule thường. */
        private fun parsePattern(pattern: String, options: RuleOptions): Any? {
            if (pattern.startsWith("||")) {
                val rest = pattern.substring(2)
                // Tách domain khỏi phần còn lại ở ký tự / ^ * | đầu tiên.
                var cut = rest.length
                for (i in rest.indices) {
                    val c = rest[i]
                    if (c == '/' || c == '^' || c == '*' || c == '|') {
                        cut = i
                        break
                    }
                }
                val domain = rest.substring(0, cut).lowercase().trimEnd('.')
                if (domain.isEmpty() || domain.contains("*")) return null
                val remainder = rest.substring(cut)
                return parseDomainRemainder(domain, remainder, options)
            }
            // Biểu thức chính quy nguyên bản /.../
            if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
                val regex = try {
                    Pattern.compile(pattern.substring(1, pattern.length - 1))
                } catch (_: Exception) {
                    return null
                }
                return GenericRule(null, regex, false, false, null, options)
            }
            var body = pattern
            var anchorStart = false
            var anchorEnd = false
            if (body.startsWith("|")) {
                anchorStart = true
                body = body.substring(1)
            }
            if (body.endsWith("|")) {
                anchorEnd = true
                body = body.substring(0, body.length - 1)
            }
            if (body.isEmpty()) return null
            // Chuỗi con thuần: không cần regex.
            if (!body.contains("*") && !body.contains("^")) {
                return GenericRule(body, null, anchorStart, anchorEnd, null, options)
            }
            val regex = patternToRegex(body, anchorStart, anchorEnd) ?: return null
            return GenericRule(null, regex, anchorStart, anchorEnd, requiredLiteral(body), options)
        }

        private fun parseDomainRemainder(
            domain: String,
            remainder: String,
            options: RuleOptions,
        ): DomainRule? {
            if (remainder.isEmpty() || remainder == "^") {
                return DomainRule(domain, DomainRule.KIND_NONE, null, false, null, options)
            }
            var body = remainder
            var anchorEnd = false
            if (body.endsWith("|")) {
                anchorEnd = true
                body = body.substring(0, body.length - 1)
            }
            // Chỉ còn chữ thường + dấu ^ cuối: kiểm tra tiền tố chuỗi cho nhanh.
            val hatCount = body.count { it == '^' }
            if (!body.contains("*") && hatCount <= 1 && (hatCount == 0 || body.endsWith("^"))) {
                val needsSeparator = body.endsWith("^")
                val literal = if (needsSeparator) body.dropLast(1) else body
                return DomainRule(
                    domain,
                    DomainRule.KIND_LITERAL,
                    literal,
                    needsSeparator,
                    null,
                    options,
                )
            }
            val regex = patternToRegex(body, anchorStart = true, anchorEnd = anchorEnd)
                ?: return null
            return DomainRule(domain, DomainRule.KIND_REGEX, null, false, regex, options)
        }

        /** Đổi pattern Adblock (*, ^) thành regex, neo đầu/cuối nếu cần. */
        private fun patternToRegex(
            body: String,
            anchorStart: Boolean,
            anchorEnd: Boolean,
        ): Pattern? {
            val sb = StringBuilder()
            if (anchorStart) sb.append("\\A")
            for (c in body) {
                when (c) {
                    '*' -> sb.append(".*")
                    '^' -> sb.append("(?:[^A-Za-z0-9_.%-]|$)")
                    '\\', '.', '[', ']', '{', '}', '(', ')', '+', '-', '?', '<', '>' ->
                        sb.append('\\').append(c)
                    else -> sb.append(c)
                }
            }
            if (anchorEnd) sb.append("\\z")
            return try {
                Pattern.compile(sb.toString())
            } catch (_: Exception) {
                null
            }
        }

        /** Đoạn chữ dài nhất trong pattern, dùng lọc nhanh trước khi chạy regex. */
        private fun requiredLiteral(body: String): String? {
            var best = ""
            val cur = StringBuilder()
            for (c in body) {
                if (c == '*' || c == '^' || c == '|') {
                    if (cur.length > best.length) best = cur.toString()
                    cur.clear()
                } else {
                    cur.append(c)
                }
            }
            if (cur.length > best.length) best = cur.toString()
            return best.takeIf { it.length >= 4 }
        }

        /** Phần URL sau domain (kể cả cổng, đường dẫn, query). Null khi không khớp domain. */
        private fun remainderAfterDomain(url: String, host: String, domain: String): String? {
            if (host != domain && !host.endsWith(".$domain")) return null
            val schemeEnd = url.indexOf("://")
            var hostStart = if (schemeEnd >= 0) schemeEnd + 3 else 0
            // Bỏ qua userinfo nếu có.
            val slashAfterHost = url.indexOf('/', hostStart)
            val atIdx = url.indexOf('@', hostStart)
            if (atIdx >= 0 && (slashAfterHost < 0 || atIdx < slashAfterHost)) {
                hostStart = atIdx + 1
            }
            val domainStart = hostStart + (host.length - domain.length)
            val end = domainStart + domain.length
            if (end > url.length) return null
            return url.substring(end)
        }

        private fun hostOf(url: String): String? {
            return try {
                URL(url).host.lowercase().trimEnd('.').takeIf { it.isNotEmpty() }
            } catch (_: Exception) {
                null
            }
        }

        private fun hostMatchesDomain(host: String, domain: String): Boolean {
            return host == domain || host.endsWith(".$domain")
        }

        private fun isThirdParty(requestHost: String, documentHost: String?): Boolean {
            if (documentHost == null) return true
            return !hostMatchesDomain(requestHost, documentHost) &&
                !hostMatchesDomain(documentHost, requestHost)
        }

        /** Ký tự phân cách theo định nghĩa của Adblock Plus. */
        private fun isSeparator(c: Char): Boolean {
            return !(c.isLetterOrDigit() || c == '_' || c == '.' || c == '%' || c == '-')
        }
    }
}
