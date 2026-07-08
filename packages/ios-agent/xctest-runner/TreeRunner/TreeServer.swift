import Foundation
import Network
import XCTest

// Minimal HTTP server that serves a target app's accessibility tree.
// Runs inside the resident UI-test process, so tree reads are window-agnostic
// (no Simulator.app window required — the tapflow headless path).
//
// Routes:
//   GET /health                     → "ok" (readiness probe)
//   GET /tree?bundleId=<id>         → the app's XCUIApplication.debugDescription (text)
final class TreeServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.tapflow.treeserver")

    init(port: UInt16) throws {
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
        // Surface a bind failure (e.g. port held by a stale runner) immediately by
        // exiting — otherwise the process stays alive looking "ready" and the host
        // only fails after the full 90s /health poll.
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                FileHandle.standardError.write(Data("tree server failed to bind: \(error)\n".utf8))
                exit(1)
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
            let (status, body) = Self.route(path)
            self.respond(conn, status: status, body: body)
        }
    }

    private static func route(_ path: String) -> (String, String) {
        if path.hasPrefix("/health") {
            return ("200 OK", "ok")
        }
        if path.hasPrefix("/tree") {
            guard let bundleId = query(path, "bundleId"), !bundleId.isEmpty else {
                return ("400 Bad Request", "missing bundleId")
            }
            let app = XCUIApplication(bundleIdentifier: bundleId)
            return ("200 OK", app.debugDescription)
        }
        return ("404 Not Found", "unknown route")
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
