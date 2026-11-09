import Foundation
import Network
import XCTest

// Minimal HTTP server that serves a target app's accessibility tree.
// Runs inside the resident UI-test process, so tree reads are window-agnostic
// (no Simulator.app window required — the tapflow headless path).
//
// Routes:
//   GET /health                     → the token the host passed, or "ok" without one (readiness probe)
//   GET /tree?bundleId=<id>         → `TAPFLOW_INTERFACE_ORIENTATION <UIInterfaceOrientation or 0>`, then the app's
//                                     XCUIApplication.debugDescription (text)
//   GET /field?bundleId=<id>        → the keyboard-focused text field as JSON, or `{"reason": …}` (Flow Capture, #1135),
//                                     with the soft keyboard beside it
//   GET /keyboard?bundleId=<id>     → the soft keyboard as JSON: `{"shown", "rect"?, "orientation"}` (#1135)
final class TreeServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.tapflow.treeserver")
    private let token: String

    init(port: UInt16, token: String) throws {
        self.token = token
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "TreeServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid port \(port)"])
        }
        // Bind loopback ONLY. The simulator shares the host's network stack, so a
        // default all-interfaces bind would expose the app's UI tree to the LAN with
        // no auth — tapflow keeps app data inside the machine. requiredLocalEndpoint
        // forces the listen socket onto 127.0.0.1 (requiredInterfaceType alone does not).
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: nwPort)
        listener = try NWListener(using: params)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.start(queue: self.queue)
            self.receive(conn, buffer: Data())
        }
        // Surface a bind failure immediately by
        // exiting — otherwise the process stays alive looking "ready" and the host
        // only fails after the full 90s /health poll.
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                // Announced only once bound, with the port the kernel gave (the host passes 0), because the host
                // talks to nothing but the port this line names. Printed before the bind, as it once was, a runner
                // that lost its port still announced it, and the host then read another simulator's tree from
                // whoever held it.
                print("TAPFLOW_TREE_READY port=\(self?.listener.port?.rawValue ?? 0)")
                fflush(stdout)
            case .failed(let error):
                FileHandle.standardError.write(Data("tree server failed to bind: \(error)\n".utf8))
                exit(1)
            default:
                break
            }
        }
        listener.start(queue: queue)
    }

    // Accumulate bytes until the full request head arrives (GET has no body).
    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let head = String(data: buf, encoding: .utf8), head.contains("\r\n\r\n") {
                self.handleRequest(conn, head: head)
                return
            }
            if isComplete || error != nil { conn.cancel(); return }
            self.receive(conn, buffer: buf)
        }
    }

    private func handleRequest(_ conn: NWConnection, head: String) {
        let requestLine = head.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let parts = requestLine.split(separator: " ")
        let path = parts.count >= 2 ? String(parts[1]) : "/"
        // XCUITest snapshot access must run on the main thread.
        DispatchQueue.main.async {
            let (status, body) = Self.route(path, token: self.token)
            self.respond(conn, status: status, body: body)
        }
    }

    private static func route(_ path: String, token: String) -> (String, String) {
        if path.hasPrefix("/health") {
            // The token tells the host this is the runner it started, not one another agent left on the port.
            return ("200 OK", token.isEmpty ? "ok" : token)
        }
        if path.hasPrefix("/tree") {
            guard let bundleId = query(path, "bundleId"), !bundleId.isEmpty else {
                return ("400 Bad Request", "missing bundleId")
            }
            let app = XCUIApplication(bundleIdentifier: bundleId)
            // The app's own interface orientation, which the tree's frames are in. Touches go to the portrait
            // framebuffer, so this — not the device's held orientation — is what turns a tree point into a touch
            // point (a portrait-locked app stays portrait on a turned device). Read as WebDriverAgent does, through a
            // private XCUIApplication property, and only once the app is up: while it is still starting, the tree is
            // a "not found" query chain and the getter has no app to ask. Read on both sides of the tree, and 0 when
            // the two differ — a turn caught mid-way is no information, not the wrong one. One line ahead of the tree.
            // `state` is public and asks nothing of the app; the private getter is only reached past it.
            let up = app.state == .runningForeground
            let before = up ? Self.interfaceOrientation(app) : 0
            let tree = app.debugDescription
            let orientation = up && tree.contains("Element subtree:") && before == Self.interfaceOrientation(app) ? before : 0
            return ("200 OK", "TAPFLOW_INTERFACE_ORIENTATION \(orientation)\n" + tree)
        }
        if path.hasPrefix("/field") {
            guard let bundleId = query(path, "bundleId"), !bundleId.isEmpty else {
                return ("400 Bad Request", "missing bundleId")
            }
            return ("200 OK", Self.field(XCUIApplication(bundleIdentifier: bundleId)))
        }
        if path.hasPrefix("/keyboard") {
            guard let bundleId = query(path, "bundleId"), !bundleId.isEmpty else {
                return ("400 Bad Request", "missing bundleId")
            }
            return ("200 OK", json(Self.keyboard(XCUIApplication(bundleIdentifier: bundleId))))
        }
        return ("404 Not Found", "unknown route")
    }

    private static let textInputTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .searchField, .textView]

    /// The text field that has keyboard focus, as JSON — what Flow Capture records as the text a person really typed
    /// (#1135). Not the tree's `value:`, which debugDescription prints unquoted and cuts at 18 characters (measured).
    /// A secure field's value never leaves this process: it reads `•••` anyway, and its length is a secret too.
    private static func field(_ app: XCUIApplication) -> String {
        guard app.state == .runningForeground else { return json(["reason": "no-app"]) }
        let keyboard = Self.keyboard(app)
        let inputs = app.descendants(matching: .any)
            .matching(NSPredicate(format: "elementType IN %@", textInputTypes.map { $0.rawValue }))
            .matching(NSPredicate(format: "hasKeyboardFocus == YES"))
        let found = inputs.allElementsBoundByIndex
        // Exactly one, or nothing is claimed: a second focused input means the read cannot say which one was typed in.
        guard found.count == 1, let snapshot = try? found[0].snapshot() else {
            return json(["reason": found.isEmpty ? "no-focus" : "ambiguous", "keyboard": keyboard])
        }
        let frame = snapshot.frame
        var out: [String: Any] = [
            "identifier": snapshot.identifier,
            "placeholder": snapshot.placeholderValue ?? "",
            "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height],
            "type": snapshot.elementType == .secureTextField ? "secure" : "text",
            "keyboard": keyboard,
        ]
        if snapshot.elementType == .secureTextField { out["reason"] = "secure"; return json(out) }
        let value = (snapshot.value as? String) ?? ""
        // UIKit puts the placeholder in an empty field's value (measured; SwiftUI does not). A field whose typed text
        // equals its placeholder reads as empty here — the one case this cannot tell apart.
        out["value"] = !value.isEmpty && value == snapshot.placeholderValue ? "" : value
        return json(out)
    }

    /// The soft keyboard, as fractions of the app's window in its interface orientation (the tree's space), with that
    /// orientation so the host can turn it into the framebuffer a touch lands in. Its bottom row (globe, dictation) sits
    /// below the `Keyboard` element (measured), so the rect runs to the window's bottom edge. Not shown with a hardware
    /// keyboard connected, where there is no soft one.
    private static func keyboard(_ app: XCUIApplication) -> [String: Any] {
        let orientation = Self.interfaceOrientation(app)
        guard app.state == .runningForeground else { return ["shown": NSNull(), "orientation": orientation] }
        let element = app.keyboards.firstMatch
        guard element.exists else { return ["shown": false, "orientation": orientation] }
        let window = app.frame
        let frame = element.frame
        guard window.width > 0, window.height > 0, !frame.isEmpty else { return ["shown": true, "orientation": orientation] }
        let top = max(frame.minY, window.minY)
        let rect: [String: Double] = [
            "x": Double((frame.minX - window.minX) / window.width),
            "y": Double((top - window.minY) / window.height),
            "width": Double(frame.width / window.width),
            "height": Double((window.maxY - top) / window.height),
        ]
        return ["shown": true, "rect": rect, "orientation": orientation]
    }

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    /// UIInterfaceOrientation (1 portrait, 2 upside down, 3 landscape right, 4 landscape left), or 0 when the
    /// runtime has no such property — guarded, so a missing getter answers 0 rather than raising.
    private static func interfaceOrientation(_ app: XCUIApplication) -> Int {
        guard app.responds(to: NSSelectorFromString("interfaceOrientation")) else { return 0 }
        return (app.value(forKey: "interfaceOrientation") as? Int) ?? 0
    }

    private static func query(_ path: String, _ key: String) -> String? {
        guard let q = path.split(separator: "?").dropFirst().first else { return nil }
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 && kv[0] == key {
                let raw = String(kv[1])
                return raw.removingPercentEncoding ?? raw
            }
        }
        return nil
    }

    private func respond(_ conn: NWConnection, status: String, body: String) {
        let bytes = Array(body.utf8)
        let header = "HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(contentsOf: bytes)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}
