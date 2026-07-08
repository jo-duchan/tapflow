import XCTest

// Resident runner: starts the HTTP tree server, then blocks so the process stays
// alive serving queries until the host terminates it (session end / shutdown).
// The host detects readiness by polling GET /health on the chosen port.
final class TreeServerTest: XCTestCase {
    func testServeTree() throws {
        let portStr = ProcessInfo.processInfo.environment["TAPFLOW_TREE_PORT"] ?? "22087"
        guard let port = UInt16(portStr) else {
            XCTFail("invalid TAPFLOW_TREE_PORT: \(portStr)")
            return
        }
        let server = try TreeServer(port: port)
        server.start()
        print("TAPFLOW_TREE_READY port=\(port)")
        // Block forever — the host kills the process to stop the runner.
        RunLoop.current.run()
    }
}
