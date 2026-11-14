package vn.tunglv.browser

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import vn.tunglv.browser.ui.BrowserApp

class MainActivity : ComponentActivity() {

    private val viewModel: BrowserViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { BrowserApp(viewModel) }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_VIEW -> {
                // Mở link từ app khác: mở thành tab mới.
                intent.dataString?.takeIf { it.isNotBlank() }?.let { url ->
                    viewModel.openExternalUrl(url)
                }
            }
            Intent.ACTION_SEND -> {
                if (intent.type != "text/plain") return
                val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
                viewModel.openExternalUrl(sharedText)
            }
        }
    }
}
