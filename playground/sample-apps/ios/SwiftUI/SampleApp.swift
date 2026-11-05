import SwiftUI
import WebKit

// The SwiftUI half of the tree measurement sample: the same screens and ids as the UIKit target, written
// the way a SwiftUI author would, so the measurement sees what each framework reports for the same intent.

final class Status: ObservableObject {
    @Published var text = "tapped:none"
    func tapped(_ id: String) { text = "tapped:\(id)" }
}

@main
struct SampleApp: App {
    @StateObject private var status = Status()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(status)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var status: Status
    @Environment(\.scenePhase) private var phase
    @State private var tab = "tab.form"

    var body: some View {
        VStack(spacing: 8) {
            Text(status.text)
                .font(.system(size: 15, design: .monospaced))
                .accessibilityIdentifier("status")
            TabView(selection: $tab) {
                FormScreen()
                    .tabItem { Label("Form", systemImage: "square.and.pencil") }
                    .tag("tab.form")
                ListScreen()
                    .tabItem { Label("List", systemImage: "list.bullet") }
                    .tag("tab.list")
                HardScreen()
                    .tabItem { Label("Hard", systemImage: "exclamationmark.triangle") }
                    .tag("tab.hard")
                WebScreen()
                    .tabItem { Label("Web", systemImage: "globe") }
                    .tag("tab.web")
                GesturesScreen()
                    .tabItem { Label("Gestures", systemImage: "hand.tap") }
                    .tag("tab.gestures")
            }
            // SwiftUI gives a tab item no identifier hook that survives into the tab bar, so the tabs are
            // reached by label. Recorded in `expected/` rather than worked around here.
            .onChange(of: tab) { _, new in status.tapped(new) }
        }
        // What a flow's `pressButton: home` leaves behind, read once the app is brought back.
        .onChange(of: phase) { _, new in if new == .background { status.tapped("app.background") } }
    }
}

// MARK: - Form

struct FormScreen: View {
    @EnvironmentObject private var status: Status
    @State private var email = ""
    @State private var password = ""
    @State private var notify = false
    @State private var volume = 0.5
    @FocusState private var focused: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField("Email", text: $email)
                .textFieldStyle(.roundedBorder)
                .focused($focused, equals: "form.email")
                .accessibilityIdentifier("form.email")
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .focused($focused, equals: "form.password")
                .accessibilityIdentifier("form.password")
            Toggle("Notifications", isOn: $notify)
                .accessibilityIdentifier("form.notify")
            // Reported when a drag begins on it. The UIKit target reports a value change, which a drag also makes.
            Slider(value: $volume) { editing in
                if editing { status.tapped("form.volume") }
            }
            .accessibilityLabel("Volume")
            .accessibilityIdentifier("form.volume")
            Button("Submit") {
                focused = nil
                status.tapped("form.submit")
            }
            .accessibilityIdentifier("form.submit")
            Spacer()
        }
        .padding(20)
        .onChange(of: focused) { _, new in if let new { status.tapped(new) } }
        .onChange(of: notify) { _, _ in status.tapped("form.notify") }
    }
}

// MARK: - List

struct ListScreen: View {
    @EnvironmentObject private var status: Status

    // Fifty rows so the list runs past the screen. SwiftUI's List is lazy, so the rows that are not on
    // screen are not built, and the measurement records whether the tree reports them anyway.
    var body: some View {
        List(0..<50, id: \.self) { row in
            Button("Row \(row)") { status.tapped("list.row.\(row)") }
                .accessibilityIdentifier("list.row.\(row)")
        }
        .listStyle(.plain)
        .accessibilityIdentifier("list.table")
    }
}

// MARK: - Hard

struct HardScreen: View {
    @EnvironmentObject private var status: Status
    @State private var nickname = ""
    @FocusState private var nicknameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // A label and no identifier: a selector can only use the text.
            Button("Help") { status.tapped("hard.help") }

            // An image and nothing else. SwiftUI may still derive a label from the symbol name, which is
            // exactly the kind of difference from UIKit the measurement is for.
            Button { status.tapped("hard.image") } label: { Image(systemName: "trash") }

            // A shape with a tap gesture and an identifier, but no accessibility traits — how a custom
            // control looks when its author never thought about accessibility.
            RoundedRectangle(cornerRadius: 8)
                .fill(.orange)
                .frame(height: 44)
                .accessibilityIdentifier("hard.custom")
                .onTapGesture { status.tapped("hard.custom") }

            // Plain text that happens to be tappable.
            Text("Tap this text")
                .onTapGesture { status.tapped("hard.text") }

            // A field whose only text is its placeholder: no identifier, no label.
            TextField("Nickname", text: $nickname)
                .textFieldStyle(.roundedBorder)
                .focused($nicknameFocused)
                .onChange(of: nicknameFocused) { _, focused in if focused { status.tapped("hard.field") } }
            Spacer()
        }
        .padding(20)
    }
}

// MARK: - Gestures

/// What a flow's `longPressOn` and `pinch` steps act on. A quick tap and a long press on the same element say
/// different things, so a long press that arrived as a tap is visible as one.
struct GesturesScreen: View {
    @EnvironmentObject private var status: Status

    var body: some View {
        // Which way the app itself is drawn — what a flow's `setOrientation` should leave — read from the screen's
        // own size, so a portrait-locked build stays portrait on a turned device.
        GeometryReader { geo in
            content(landscape: geo.size.width > geo.size.height)
        }
    }

    private func content(landscape: Bool) -> some View {
        VStack(spacing: 20) {
            Text(landscape ? "orientation:landscape" : "orientation:portrait")
                .accessibilityIdentifier("gesture.orientation")
            Text("Hold me")
                .frame(maxWidth: .infinity, minHeight: 64)
                .background(Color.blue.opacity(0.2))
                .accessibilityIdentifier("gesture.hold")
                .onTapGesture { status.tapped("gesture.hold.short") }
                .onLongPressGesture(minimumDuration: 0.5) { status.tapped("gesture.hold.long") }

            // Judged once the fingers lift, by which way the scale went, so how far a pinch spread does not matter.
            Rectangle()
                .fill(Color.green.opacity(0.2))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("gesture.zoom")
                .gesture(MagnifyGesture().onEnded { value in
                    if value.magnification > 1.2 { status.tapped("gesture.zoom.in") }
                    else if value.magnification < 0.8 { status.tapped("gesture.zoom.out") }
                })
        }
        .padding(20)
    }
}

// MARK: - Web

struct WebScreen: UIViewRepresentable {
    @EnvironmentObject private var status: Status

    func makeCoordinator() -> Coordinator { Coordinator(status: status) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "tapped")
        let web = WKWebView(frame: .zero, configuration: config)
        web.accessibilityIdentifier = "web.view"
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            web.loadHTMLString(html, baseURL: nil)
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let status: Status
        init(status: Status) { self.status = status }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let id = message.body as? String { status.tapped(id) }
        }
    }
}
