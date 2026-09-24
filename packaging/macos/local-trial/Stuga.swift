// Stuga (local trial): a menu-bar launcher that runs Stuga's Postgres and node as LaunchAgents
// in your own launchd domain, waits for /ready, and opens the node in the browser. Quitting
// stops both. Built by build.sh, which writes these Info.plist keys:
//   StugaRoot   the runtime and data root (…/Application Support/Stuga Local)
//   StugaLogs   where launchd and the node write their logs
//   StugaPort   the node's port; readiness and the port check use 127.0.0.1
//   StugaOrigin the address other devices use (the node's PUBLIC_ORIGIN)
//   StugaOriginFollowsHostName  StugaOrigin came from the Mac's local host name: every start
//               re-derives it and rewrites the node's plist, so renaming the Mac moves the node
import AppKit
import Foundation
import SystemConfiguration

struct Failure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

struct Config {
    let root: String
    let logs: String
    let port: Int
    /// What other devices type, as built; equals `url` when built --local-only.
    let origin: URL
    /// Re-derive `origin` from the Mac's local host name at every start.
    let originFollowsHostName: Bool
    let postgresLabel = "dev.stuga.local.postgres"
    let nodeLabel = "dev.stuga.local.node"

    var domain: String { "gui/\(getuid())" }
    var agents: String { root + "/launchd" }
    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    static func fromBundle() -> Config {
        let info = Bundle.main.infoDictionary ?? [:]
        let home = NSHomeDirectory()
        return Config(
            root: info["StugaRoot"] as? String ?? home + "/Library/Application Support/Stuga Local",
            logs: info["StugaLogs"] as? String ?? home + "/Library/Logs/Stuga Local",
            port: info["StugaPort"] as? Int ?? 8787,
            origin: (info["StugaOrigin"] as? String).flatMap(URL.init) ?? URL(string: "http://127.0.0.1:\(info["StugaPort"] as? Int ?? 8787)")!,
            originFollowsHostName: info["StugaOriginFollowsHostName"] as? Bool ?? false
        )
    }

    /// http://<local host name>.local:<port> as the Mac is named right now, or nil
    /// when the system will not say (then the built-in value stands).
    func liveHostNameOrigin() -> URL? {
        guard originFollowsHostName, let name = SCDynamicStoreCopyLocalHostName(nil) as String?, !name.isEmpty else { return nil }
        return URL(string: "http://\(name.lowercased()).local:\(port)")
    }
}

/// Run a program to completion; its combined output and exit status.
@discardableResult
func run(_ path: String, _ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, "\(error)")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// The two launchd jobs, and the facts about them the menu shows.
final class Services {
    let config: Config
    init(_ config: Config) { self.config = config }

    func isLoaded(_ label: String) -> Bool {
        run("/bin/launchctl", ["print", "\(config.domain)/\(label)"]).status == 0
    }

    func bootstrap(_ label: String) throws {
        if isLoaded(label) { return }
        let result = run("/bin/launchctl", ["bootstrap", config.domain, "\(config.agents)/\(label).plist"])
        if result.status != 0 && !isLoaded(label) {
            throw Failure("launchd would not load \(label): \(result.output.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    /// Unload a job and wait until launchd has let it go; bootout can return first.
    func bootout(_ label: String, timeout: TimeInterval) {
        guard isLoaded(label) else { return }
        run("/bin/launchctl", ["bootout", "\(config.domain)/\(label)"])
        let deadline = Date().addingTimeInterval(timeout)
        while isLoaded(label) && Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
    }

    /// Does the node answer /ready with 200?
    func isReady() -> Bool {
        var request = URLRequest(url: config.url.appendingPathComponent("ready"))
        request.timeoutInterval = 2
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        return ok
    }

    /// Is something already listening on the port?
    func portIsTaken() -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(config.port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    /// The node's PUBLIC_ORIGIN as its plist has it.
    func publicOrigin() -> URL? {
        guard let env = nodePlist()?["EnvironmentVariables"] as? [String: Any] else { return nil }
        return (env["PUBLIC_ORIGIN"] as? String).flatMap(URL.init)
    }

    /// Point the node's plist at `origin`. Only meaningful while the job is not
    /// loaded: launchd reads the file at bootstrap.
    func setPublicOrigin(_ origin: URL) throws {
        guard var plist = nodePlist(), var env = plist["EnvironmentVariables"] as? [String: Any] else {
            throw Failure("the node's plist is missing or unreadable")
        }
        env["PUBLIC_ORIGIN"] = origin.absoluteString
        plist["EnvironmentVariables"] = env
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: URL(fileURLWithPath: nodePlistPath), options: .atomic)
    }

    var nodePlistPath: String { "\(config.agents)/\(config.nodeLabel).plist" }

    private func nodePlist() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: nodePlistPath) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }

    var hasCluster: Bool {
        FileManager.default.fileExists(atPath: config.root + "/data/pgdata/PG_VERSION")
    }

    func createCluster() throws {
        let result = run("/bin/bash", [
            config.root + "/current/bin/init-cluster.sh",
            "--pgbin", config.root + "/current/postgres/bin",
            "--data", config.root + "/data/pgdata",
            "--socket", config.root + "/data/run",
        ])
        try? result.output.write(toFile: config.logs + "/init-cluster.log", atomically: true, encoding: .utf8)
        if result.status != 0 {
            throw Failure("setting up the database failed (see init-cluster.log in the logs folder)")
        }
    }
}

enum Phase: Equatable {
    case stopped, settingUp, starting, running, stopping
    case failed(String)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let config = Config.fromBundle()
    lazy var services = Services(config)
    let work = DispatchQueue(label: "dev.stuga.local.services")

    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let openItem = NSMenuItem(title: "Open Stuga", action: #selector(openStuga), keyEquivalent: "o")
    /// The address for other devices, copied on click; absent when there is none. Until
    /// someone sets the node up it copies the setup link, since the address alone asks for the code.
    let addressItem = NSMenuItem(title: "Copy Address", action: #selector(copyAddress), keyEquivalent: "c")
    let toggleItem = NSMenuItem(title: "Stop", action: #selector(toggle), keyEquivalent: "")

    /// The address in force: the built one until a start re-derives it from the host name.
    var origin: URL

    override init() {
        origin = config.origin
        super.init()
    }

    /// A start or stop is in progress; the poll leaves the phase alone meanwhile.
    var busy = false
    var openedBrowser = false
    var pollTimer: Timer?

    var phase: Phase = .stopped {
        didSet { refresh() }
    }

    /// Stuga's mark, the web app's path as a template image the menu bar tints. The drawing sits
    /// low in its 0 0 100 100 box, so the box is recentred on it, as in the web app: 8 13 84 84.
    static let mark: NSImage = {
        let side: CGFloat = 16
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { _ in
            let s = side / 84
            func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: (x - 8) * s, y: (y - 13) * s) }
            let path = NSBezierPath()
            path.move(to: p(78, 43))
            path.line(to: p(50, 18))
            path.curve(to: p(20, 46), controlPoint1: p(40, 27), controlPoint2: p(28, 36))
            path.curve(to: p(36, 69), controlPoint1: p(13, 54), controlPoint2: p(18, 64))
            path.curve(to: p(76, 77), controlPoint1: p(54, 73), controlPoint2: p(64, 73))
            path.curve(to: p(72, 92), controlPoint1: p(86, 81), controlPoint2: p(84, 92))
            path.line(to: p(22, 92))
            path.lineWidth = 8 * s
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Stuga"
        return image
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        for item in config.origin == config.url && !config.originFollowsHostName ? [openItem, toggleItem] : [openItem, addressItem, toggleItem] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let logs = NSMenuItem(title: "Show Logs", action: #selector(showLogs), keyEquivalent: "l")
        let data = NSMenuItem(title: "Show Data Folder", action: #selector(showData), keyEquivalent: "")
        for item in [logs, data] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Stuga", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        menu.autoenablesItems = false
        statusItem.menu = menu
        refresh()

        start()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let running = services.isLoaded(config.nodeLabel) || services.isLoaded(config.postgresLabel)
        guard running else { return .terminateNow }
        stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    // MARK: actions

    /// The same address other devices use, so the owner has one origin and one
    /// session; 127.0.0.1 stays in EXTRA_ORIGINS as the offline fallback. While
    /// nobody has set the node up, the setup page with its setup code filled in:
    /// the node keeps the code in its data directory until it is claimed.
    @objc func openStuga() {
        NSWorkspace.shared.open(setupLink() ?? origin)
    }

    func setupLink() -> URL? {
        guard let raw = try? String(contentsOfFile: config.root + "/data/node/setup-code", encoding: .utf8) else { return nil }
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = "/login"
        parts.queryItems = [URLQueryItem(name: "setup", value: code)]
        return parts.url
    }

    @objc func copyAddress() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString((setupLink() ?? origin).absoluteString, forType: .string)
    }

    @objc func toggle() {
        if phase == .running || phase == .starting {
            stop(then: nil)
        } else {
            start()
        }
    }

    @objc func showLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: config.logs))
    }

    @objc func showData() {
        NSWorkspace.shared.open(URL(fileURLWithPath: config.root + "/data"))
    }

    // MARK: start, stop, poll

    func start() {
        guard !busy else { return }
        busy = true
        phase = .starting
        work.async { [self] in
            do {
                if !services.isLoaded(config.nodeLabel) && services.portIsTaken() {
                    throw Failure("port \(config.port) is already in use by another program")
                }
                if !services.hasCluster {
                    DispatchQueue.main.async { self.phase = .settingUp }
                    try services.createCluster()
                    DispatchQueue.main.async { self.phase = .starting }
                }
                try services.bootstrap(config.postgresLabel)
                // Follow a renamed Mac so invite links carry a name that resolves; sessions
                // on the old origin end, which a stale name would make worse.
                if let live = config.liveHostNameOrigin(), live != services.publicOrigin() {
                    services.bootout(config.nodeLabel, timeout: 90)
                    try services.setPublicOrigin(live)
                }
                let inForce = services.publicOrigin() ?? config.origin
                DispatchQueue.main.async { self.origin = inForce; self.refresh() }
                try services.bootstrap(config.nodeLabel)
                // A first start migrates the database and builds its search
                // indexes before it serves anything.
                let deadline = Date().addingTimeInterval(300)
                while !services.isReady() {
                    guard Date() < deadline else {
                        throw Failure("Stuga did not answer within 5 minutes — see the logs")
                    }
                    Thread.sleep(forTimeInterval: 1)
                }
                DispatchQueue.main.async {
                    self.busy = false
                    self.phase = .running
                    if !self.openedBrowser {
                        self.openedBrowser = true
                        self.openStuga()
                    }
                }
            } catch {
                let message = (error as? Failure)?.message ?? "\(error)"
                DispatchQueue.main.async {
                    self.busy = false
                    self.phase = .failed(message)
                }
            }
        }
    }

    func stop(then done: (() -> Void)?) {
        busy = true
        phase = .stopping
        work.async { [self] in
            // The node first: it holds connections a Postgres shutdown would otherwise cut.
            services.bootout(config.nodeLabel, timeout: 90)
            services.bootout(config.postgresLabel, timeout: 330)
            DispatchQueue.main.async {
                self.busy = false
                self.phase = .stopped
                done?()
            }
        }
    }

    func poll() {
        guard !busy else { return }
        work.async { [self] in
            let loaded = services.isLoaded(config.nodeLabel)
            let ready = loaded && services.isReady()
            DispatchQueue.main.async {
                guard !self.busy else { return }
                if ready {
                    self.phase = .running
                } else if loaded {
                    // launchd is (re)starting it: KeepAlive after a crash, or waiting for Postgres.
                    self.phase = .starting
                } else if case .failed = self.phase {
                    // Keep the reason on screen until the next start.
                } else {
                    self.phase = .stopped
                }
            }
        }
    }

    // MARK: menu

    func refresh() {
        guard let button = statusItem?.button else { return }
        switch phase {
        case .stopped:
            statusLine.title = "Stuga is stopped"
        case .settingUp:
            statusLine.title = "Setting up the database…"
        case .starting:
            statusLine.title = "Starting…"
        case .running:
            statusLine.title = "Running at \(origin.absoluteString)"
        case .stopping:
            statusLine.title = "Stopping…"
        case .failed(let message):
            statusLine.title = "Could not start: \(message)"
        }
        // The mark, dimmed until the node answers; a warning sign when it could not start.
        if case .failed = phase {
            let warning = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Stuga")
            warning?.isTemplate = true
            button.image = warning
            button.appearsDisabled = false
        } else {
            button.image = Self.mark
            button.appearsDisabled = phase != .running
        }
        button.toolTip = "Stuga (local trial) — \(statusLine.title)"
        openItem.isEnabled = phase == .running
        // The node deletes its setup code once claimed, and the poll refreshes every few seconds.
        addressItem.title = FileManager.default.fileExists(atPath: config.root + "/data/node/setup-code") ? "Copy Setup Link" : "Copy Address"
        toggleItem.title = (phase == .running || phase == .starting) ? "Stop" : "Start"
        toggleItem.isEnabled = !busy
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
