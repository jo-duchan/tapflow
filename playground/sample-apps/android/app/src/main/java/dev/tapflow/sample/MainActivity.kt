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
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex

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
    Tab("tab.views", "Views", Icons.Filled.Menu),
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
                "tab.views" -> ViewsScreen(tapped)
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

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ListScreen(tapped: (String) -> Unit) {
    var scrim by remember { mutableStateOf(false) }
    // Fifty rows so the list runs past the screen: LazyColumn composes only what is on screen, and the
    // measurement records whether the tree reports the rest anyway.
    //
    // Three layers over the rows, as the iOS targets have them: a label that takes no touches over Row 5, a floating
    // button at the bottom right, and the scrim it opens over every row until Close. Siblings drawn after the list, so
    // the tree's drawing order is what says they are on top.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Declared before the list, drawn over it by its zIndex: child order says the list is on top, z says this is.
        Text(
            "Z",
            Modifier.zIndex(1f).align(Alignment.TopEnd).offset(x = (-24).dp, y = 160.dp)
                .background(Color(0xFF7E57C2), RoundedCornerShape(50)).clickable { tapped("list.zbadge") }
                .padding(horizontal = 16.dp, vertical = 8.dp).testTag("list.zbadge"),
        )
        LazyColumn(Modifier.fillMaxSize().testTag("list.table")) {
            // Stays at the top while rows scroll under it: a row partly under it is covered by a sibling of its own list.
            stickyHeader {
                Text(
                    "Header",
                    Modifier.fillMaxWidth().background(Color(0xFFE0E0E0)).clickable { tapped("list.header") }
                        .padding(16.dp).testTag("list.header"),
                )
            }
            items(50) { row ->
                Text(
                    "Row $row",
                    Modifier.fillMaxWidth().clickable { tapped("list.row.$row") }.padding(16.dp).testTag("list.row.$row"),
                )
            }
        }
        Text(
            "Decor",
            Modifier.align(Alignment.TopCenter).offset(y = maxHeight * 0.4f - 22.dp)
                .background(Color(0x80FFEB3B), RoundedCornerShape(50)).padding(horizontal = 24.dp, vertical = 12.dp)
                .testTag("list.decor"),
        )
        FloatingActionButton(
            onClick = { tapped("list.fab"); scrim = true },
            Modifier.align(Alignment.BottomEnd).padding(16.dp).testTag("list.fab"),
        ) { Icon(Icons.Filled.Add, contentDescription = "Add") }
        if (scrim) {
            Box(
                Modifier.fillMaxSize().background(Color(0x4D000000))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { tapped("list.scrim") }
                    .testTag("list.scrim"),
            )
            Button(
                onClick = { tapped("list.scrim.close"); scrim = false },
                Modifier.align(Alignment.Center).testTag("list.scrim.close"),
            ) { Text("Close") }
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
    // Which way the app itself is drawn — what a flow's `setOrientation` should leave.
    val configuration = LocalConfiguration.current
    val landscape = configuration.screenWidthDp > configuration.screenHeightDp
    Column(Modifier.padding(20.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(
            if (landscape) "orientation:landscape" else "orientation:portrait",
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().testTag("gesture.orientation"),
        )
        // A phone in landscape has no height left for the two stacked, so they sit side by side there. The zoom area
        // stays wide because a pinch at a point spreads its fingers across the screen, not across the element.
        if (landscape) {
            Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                ZoomArea(tapped, Modifier.weight(1f).fillMaxHeight())
                HoldArea(tapped, Modifier.width(120.dp).fillMaxHeight())
            }
        } else {
            HoldArea(tapped, Modifier.fillMaxWidth().height(64.dp))
            ZoomArea(tapped, Modifier.fillMaxWidth().weight(1f))
        }
    }
}

@Composable
private fun HoldArea(tapped: (String) -> Unit, modifier: Modifier) {
    Text(
        "Hold me",
        textAlign = TextAlign.Center,
        modifier = modifier.background(Color(0x332196F3)).testTag("gesture.hold")
            .pointerInput(Unit) {
                detectTapGestures(onTap = { tapped("gesture.hold.short") }, onLongPress = { tapped("gesture.hold.long") })
            },
    )
}

// Judged once every finger lifts, by which way the scale went, so how far a pinch spread does not matter.
@Composable
private fun ZoomArea(tapped: (String) -> Unit, modifier: Modifier) {
    Box(
        modifier.background(Color(0x334CAF50)).testTag("gesture.zoom")
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

/**
 * The List screen's layers again, in classic Views rather than Compose: a View-based app's accessibility tree orders
 * siblings by where they are on screen, not by how they are drawn, and reports a real drawing order where Compose
 * reports 0 for every sibling. Programmatic Views have no resource name, so each is found by its content description.
 *
 * - `views.badge`: added first, drawn last by its elevation, over Row 2 — the index says the list is on top, the drawing
 *   order says the badge is.
 * - `views.decor`: takes no touches, over Row 4.
 * - `views.fab`: clickable, bottom right; opens the scrim.
 * - `views.scrim`: consumes every touch through an OnTouchListener without being clickable — what an accessibility tree
 *   cannot show takes the touch. `views.scrim.close` closes it.
 */
@Composable
private fun ViewsScreen(tapped: (String) -> Unit) {
    AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
        val dp = context.resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        android.widget.FrameLayout(context).apply {
            val badge = android.widget.TextView(context).apply {
                text = "Badge"
                contentDescription = "views.badge"
                setBackgroundColor(0xFFFF7043.toInt())
                setPadding(px(16), px(8), px(16), px(8))
                elevation = px(8).toFloat()
                setOnClickListener { tapped("views.badge") }
            }
            val rows = android.widget.LinearLayout(context).apply { orientation = android.widget.LinearLayout.VERTICAL }
            for (row in 0 until 30) {
                rows.addView(android.widget.TextView(context).apply {
                    text = "Row $row"
                    contentDescription = "views.row.$row"
                    textSize = 16f
                    setPadding(px(16), px(16), px(16), px(16))
                    setOnClickListener { tapped("views.row.$row") }
                })
            }
            val list = android.widget.ScrollView(context).apply { addView(rows) }
            val decor = android.widget.TextView(context).apply {
                text = "Decor"
                contentDescription = "views.decor"
                setBackgroundColor(0x80FFEB3B.toInt())
                setPadding(px(24), px(12), px(24), px(12))
            }
            val scrim = android.widget.FrameLayout(context).apply {
                setBackgroundColor(0x4D000000)
                contentDescription = "views.scrim"
                visibility = android.view.View.GONE
                elevation = px(12).toFloat()
                @SuppressLint("ClickableViewAccessibility")
                setOnTouchListener { _, e -> if (e.action == android.view.MotionEvent.ACTION_UP) tapped("views.scrim"); true }
            }
            val close = android.widget.Button(context).apply {
                text = "Close"
                contentDescription = "views.scrim.close"
                setOnClickListener { tapped("views.scrim.close"); scrim.visibility = android.view.View.GONE }
            }
            scrim.addView(close, android.widget.FrameLayout.LayoutParams(px(120), px(56), android.view.Gravity.CENTER))
            val fab = android.widget.ImageButton(context).apply {
                setImageResource(android.R.drawable.ic_input_add)
                contentDescription = "views.fab"
                elevation = px(6).toFloat()
                setOnClickListener { tapped("views.fab"); scrim.visibility = android.view.View.VISIBLE }
            }
            // The badge goes in before the list on purpose: only its elevation puts it on top.
            addView(badge, android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL).apply { topMargin = px(2 * 52 + 8) })
            addView(list, android.widget.FrameLayout.LayoutParams(-1, -1))
            addView(decor, android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL).apply { topMargin = px(4 * 52 + 4) })
            addView(fab, android.widget.FrameLayout.LayoutParams(px(56), px(56), android.view.Gravity.BOTTOM or android.view.Gravity.END).apply { setMargins(0, 0, px(16), px(16)) })
            addView(scrim, android.widget.FrameLayout.LayoutParams(-1, -1))
        }
    })
}

