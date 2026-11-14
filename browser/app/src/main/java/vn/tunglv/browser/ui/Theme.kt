package vn.tunglv.browser.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Màu đỏ chủ đạo của VN Browser (cùng màu nền icon app). */
val VnRed = Color(0xFFDC2626)

private val VnLightScheme = lightColorScheme(
    primary = VnRed,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFEE2E2),
    onPrimaryContainer = Color(0xFF7F1D1D),
    secondary = Color(0xFFB91C1C),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFEE2E2),
    onSecondaryContainer = Color(0xFF7F1D1D),
    tertiary = Color(0xFFEA580C),
    background = Color(0xFFFAFAF8),
    onBackground = Color(0xFF1C1B1A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1C1B1A),
    surfaceVariant = Color(0xFFF1EFEC),
    onSurfaceVariant = Color(0xFF6B6660),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF7F5F2),
    surfaceContainer = Color(0xFFF1EFEC),
    surfaceContainerHigh = Color(0xFFE8E5E1),
    surfaceContainerHighest = Color(0xFFDDD9D4),
    outline = Color(0xFFD6D2CC),
    outlineVariant = Color(0xFFE5E1DC),
)

private val VnDarkScheme = darkColorScheme(
    primary = Color(0xFFF87171),
    onPrimary = Color(0xFF450A0A),
    primaryContainer = Color(0xFF7F1D1D),
    onPrimaryContainer = Color(0xFFFECACA),
    secondary = Color(0xFFFCA5A5),
    onSecondary = Color(0xFF450A0A),
    secondaryContainer = Color(0xFF7F1D1D),
    onSecondaryContainer = Color(0xFFFECACA),
    tertiary = Color(0xFFFB923C),
    background = Color(0xFF131211),
    onBackground = Color(0xFFF5F2EF),
    surface = Color(0xFF1C1B1A),
    onSurface = Color(0xFFF5F2EF),
    surfaceVariant = Color(0xFF2B2926),
    onSurfaceVariant = Color(0xFFA8A29B),
    surfaceContainerLowest = Color(0xFF0E0D0C),
    surfaceContainerLow = Color(0xFF1E1C1A),
    surfaceContainer = Color(0xFF262421),
    surfaceContainerHigh = Color(0xFF322F2B),
    surfaceContainerHighest = Color(0xFF3E3A36),
    outline = Color(0xFF4B4741),
    outlineVariant = Color(0xFF38342F),
)

private val VnShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/**
 * Giao diện chung của VN Browser.
 * [themeMode]: "system" theo máy, "light" sáng, "dark" tối.
 */
@Composable
fun VnBrowserTheme(themeMode: String, content: @Composable () -> Unit) {
    val darkTheme = when (themeMode) {
        "light" -> false
        "dark" -> true
        else -> isSystemInDarkTheme()
    }
    MaterialTheme(
        colorScheme = if (darkTheme) VnDarkScheme else VnLightScheme,
        shapes = VnShapes,
        content = content,
    )
}
