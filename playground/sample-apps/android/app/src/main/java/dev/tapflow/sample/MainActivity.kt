package dev.tapflow.sample

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

// The Android half of the tree measurement sample: the same screens and element ids as the iOS targets.
// Every element that can be used sets the status label to `tapped:<id>`, so the measurement script proves
// a tap landed by reading the tree again. Ids are `testTag`s, exposed as `resource-id` by
// `testTagsAsResourceId` on the root — without it Compose keeps them out of the accessibility tree.

class MainActivity : ComponentActivity() {
    // Held here rather than in `Root`, so leaving the app can be written to it from `onPause`.
    private val status = mutableStateOf("tapped:none")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Root(status) } }
    }

    // What a flow's `pressButton: home` leaves behind, read once the app is brought back. `onPause`, not `onStop`: a
    // `launchApp` right after the press brings the app back before it is stopped (measured on API 34), so a status
    // written on stop is never written at all.
    override fun onPause() {
        super.onPause()
        status.value = "tapped:app.background"
    }
}

private data class Tab(val id: String, val title: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val TABS = listOf(
    Tab("tab.form", "Form", Icons.Filled.Edit),
    Tab("tab.list", "List", Icons.Filled.List),
    Tab("tab.hard", "Hard", Icons.Filled.Warning),
    Tab("tab.web", "Web", Icons.Filled.Info),
    Tab("tab.gestures", "Gestures", Icons.Filled.Star),
)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Root(statusState: MutableState<String>) {
    var status by statusState
    var tab by remember { mutableStateOf("tab.form") }
    val tapped: (String) -> Unit = { status = "tapped:$it" }
    // `pressButton: back` on the Gestures screen, which would otherwise close the app.
    BackHandler(enabled = tab == "tab.gestures") { tapped("app.back") }

    Scaffold(
        modifier = Modifier.semantics { testTagsAsResourceId = true },
        topBar = {
            Text(
                status,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth().padding(top = 48.dp, bottom = 8.dp).testTag("status"),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        },
        bottomBar = {
            NavigationBar {
                for (t in TABS) {
                    NavigationBarItem(
                        selected = tab == t.id,
                        onClick = { if (tab != t.id) { tab = t.id; tapped(t.id) } },
                        icon = { Icon(t.icon, contentDescription = null) },
                        label = { Text(t.title) },
                        modifier = Modifier.testTag(t.id),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                "tab.form" -> FormScreen(tapped)
                "tab.list" -> ListScreen(tapped)
                "tab.hard" -> HardScreen(tapped)
                "tab.gestures" -> GesturesScreen(tapped)
                else -> WebScreen(tapped)
            }
        }
    }
}

@Composable
private fun FormScreen(tapped: (String) -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var notify by remember { mutableStateOf(false) }
    var volume by remember { mutableFloatStateOf(0.5f) }
    val focus = LocalFocusManager.current

    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        TextField(
            value = email,
            onValueChange = { email = it },
            placeholder = { Text("Email") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth().testTag("form.email")
                .onFocusChanged { if (it.isFocused) tapped("form.email") },
        )
        TextField(
            value = password,
            onValueChange = { password = it },
            placeholder = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth().testTag("form.password")
                .onFocusChanged { if (it.isFocused) tapped("form.password") },
        )
        Row(Modifier.fillMaxWidth()) {
            Text("Notifications", Modifier.weight(1f))
            Switch(
                checked = notify,
                onCheckedChange = { notify = it; tapped("form.notify") },
                modifier = Modifier.testTag("form.notify"),
            )
        }
        // Reported on a value change, as the iOS targets do, so "landed" means the same on every platform.
        Slider(
            value = volume,
            onValueChange = { volume = it; tapped("form.volume") },
            modifier = Modifier.testTag("form.volume"),
        )
        // Clears focus so the keyboard goes away, as the iOS targets' Submit does — left up, it covers the tab bar.
        Button(
            onClick = { focus.clearFocus(); tapped("form.submit") },
            modifier = Modifier.testTag("form.submit"),
        ) { Text("Submit") }
    }
}

@Composable
private fun ListScreen(tapped: (String) -> Unit) {
    // Fifty rows so the list runs past the screen: LazyColumn composes only what is on screen, and the
    // measurement records whether the tree reports the rest anyway.
    LazyColumn(Modifier.fillMaxSize().testTag("list.table")) {
        items(50) { row ->
            Text(
                "Row $row",
                Modifier.fillMaxWidth().clickable { tapped("list.row.$row") }.padding(16.dp).testTag("list.row.$row"),
            )
        }
    }
}

@Composable
private fun HardScreen(tapped: (String) -> Unit) {
    var nickname by remember { mutableStateOf("") }
    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        // A label and no id: a selector can only use the text.
        TextButton(onClick = { tapped("hard.help") }) { Text("Help") }

        // An icon and nothing else: no content description, no id.
        IconButton(onClick = { tapped("hard.image") }) { Icon(Icons.Filled.Delete, contentDescription = null) }

        // A box with a click handler and an id, but no role and no text — a custom control whose author never
        // thought about accessibility.
        Box(
            Modifier.fillMaxWidth().height(44.dp).background(Color(0xFFFF9500))
                .testTag("hard.custom").clickable { tapped("hard.custom") },
        )

        // Plain text that happens to be clickable.
        Text("Tap this text", Modifier.clickable { tapped("hard.text") })

        // A field whose only text is its placeholder: no id, no label.
        TextField(
            value = nickname,
            onValueChange = { nickname = it },
            placeholder = { Text("Nickname") },
            modifier = Modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) tapped("hard.field") },
        )
        Spacer(Modifier.weight(1f))
    }
}

/**
 * What a flow's `longPressOn` and `pinch` steps act on. A quick tap and a long press on the hold area say different
 * things, so a long press that arrived as a tap shows as one.
 */
@Composable
private fun GesturesScreen(tapped: (String) -> Unit) {
    Column(Modifier.padding(20.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(
            "Hold me",
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().height(64.dp).background(Color(0x332196F3)).testTag("gesture.hold")
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { tapped("gesture.hold.short") }, onLongPress = { tapped("gesture.hold.long") })
                },
        )
        // Judged once every finger lifts, by which way the scale went, so how far a pinch spread does not matter.
        Box(
            Modifier.fillMaxWidth().weight(1f).background(Color(0x334CAF50)).testTag("gesture.zoom")
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var scale = 1f
                        do {
                            val event = awaitPointerEvent()
                            scale *= event.calculateZoom()
                        } while (event.changes.any { it.pressed })
                        if (scale > 1.2f) tapped("gesture.zoom.in") else if (scale < 0.8f) tapped("gesture.zoom.out")
                    }
                },
        )
    }
}

/** Receives taps from the page, the Android side of the bridge `web/index.html` calls. */
private class WebBridge(private val tapped: (String) -> Unit) {
    @JavascriptInterface
    fun tapped(id: String) = tapped.invoke(id)
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun WebScreen(tapped: (String) -> Unit) {
    AndroidView(
        modifier = Modifier.fillMaxSize().testTag("web.view"),
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                // JavaScript calls arrive on a WebView thread; the status state is updated from the main one.
                addJavascriptInterface(WebBridge { id -> post { tapped(id) } }, "TapflowAndroid")
                loadUrl("file:///android_asset/web/index.html")
            }
        },
    )
}
