import SwiftUI

// Minimal host app required by the UI-test target. The runner drives a SEPARATE
// app (the app under test) via XCUIApplication(bundleIdentifier:), so this host
// stays empty.
@main
struct TreeHostApp: App {
    var body: some Scene {
        WindowGroup {
            Text("tapflow tree runner host")
        }
    }
}
