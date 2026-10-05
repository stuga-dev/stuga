// Stuga (local trial): a menu-bar launcher that runs Stuga's Postgres and node as LaunchAgents
// in your own launchd domain, waits for /ready, and opens the node in the browser; ../app/Health.swift
// tells a slow start from a failure, which it then says once. Quitting stops both. Built by
// build.sh, which writes these Info.plist keys:
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
    let heading: String
    let detail: String?
    init(_ message: String) {
        heading = "Could not start"
        detail = message
    }
    init(_ fault: Fault, detail: String?) {
        heading = fault.title
        self.detail = detail
    }
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

/// A log's last lines, from its last 64 KB.
func tail(_ path: String) -> [String] {
    guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
    defer { try? handle.close() }
    let end = (try? handle.seekToEnd()) ?? 0
    try? handle.seek(toOffset: end > 65_536 ? end - 65_536 : 0)
    return String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self).split(separator: "\n").map(String.init)
}

func modified(_ path: String) -> Date {
    (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date ?? .distantPast
}

/// The two launchd jobs, and the facts about them the menu shows.
final class Services: JobControl {
    let config: Config
    init(_ config: Config) { self.config = config }

    func job(_ label: String) -> Job {
        let result = run("/bin/launchctl", ["print", "\(config.domain)/\(label)"])
        return Job(print: result.status == 0 ? result.output : nil)
    }

    func isLoaded(_ label: String) -> Bool {
        job(label).loaded
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

    /// Tells a slow start from a failure (Health.swift). Only `work` touches it.
    var watch = Watch()

    /// /ready's answer and both jobs, for the watch.
    func look() -> Look {
        var request = URLRequest(url: config.url.appendingPathComponent("ready"))
        request.timeoutInterval = 2
        let done = DispatchSemaphore(value: 0)
        var answer: (status: Int, body: Data?)?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse { answer = (http.statusCode, data) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        return Look(ready: Ready(status: answer?.status, body: answer?.body), node: job(config.nodeLabel), postgres: job(config.postgresLabel))
    }

    /// What the logs add to a stopped node, or one refusing its data: why, when they say.
    func detail(_ fault: Fault) -> String? {
        if fault == .refused {
            let prefix = "[node] refusing this database: "
            guard let newest = newestNodeLog(), let line = tail(newest).last(where: { $0.hasPrefix(prefix) }) else { return nil }
            return String(line.dropFirst(prefix.count))
        }
        guard fault == .nodeStopped else { return nil }
        // The wrapper's last word is the latest try: still waiting for Postgres, or given up on it.
        if let wrapper = tail(config.logs + "/node-wrapper.log").last,
           wrapper.contains("Postgres has not accepted connections") || wrapper.contains("waiting for Postgres") {
            return "Postgres is not accepting connections."
        }
        // Else the node's own log: its last word, when that is why it stopped.
        guard let newest = newestNodeLog(), let last = tail(newest).last(where: { $0.hasPrefix("[node] ") }),
              last.hasPrefix("[node] configuration error: ") || last.hasPrefix("[node] failed to start")
        else { return nil }
        return String(last.dropFirst("[node] ".count))
    }

    /// The node's own log, one per weekday: the one written last.
    func newestNodeLog() -> String? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: config.logs)) ?? []
        return names.filter { $0.hasPrefix("node-") && $0.hasSuffix(".log") && $0 != "node-wrapper.log" }
            .map { config.logs + "/" + $0 }
            .max { modified($0) < modified($1) }
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
    /// After a failure: the reason, which can run long, in the alert rather than the status line.
    let detailsItem = NSMenuItem(title: "Show Details…", action: #selector(announceFailure), keyEquivalent: "")

    /// The address in force: the built one until a start re-derives it from the host name.
    var origin: URL

    override init() {
        origin = config.origin
        super.init()
    }

    var openedBrowser = false
    var pollTimer: Timer?

    /// Starts and stops, and which is the latest (Lifecycle.swift).
    lazy var lifecycle: Lifecycle = {
        let lifecycle = Lifecycle(
            jobs: services, node: config.nodeLabel, postgres: config.postgresLabel,
            work: { [work] in work.async(execute: $0) },
            main: { DispatchQueue.main.async(execute: $0) }
        )
        lifecycle.changed = { [unowned self] before in
            refresh()
            // Once per failure, from the run loop rather than inside the setter.
            if phase.failed && !before.failed {
                perform(#selector(announceFailure), with: nil, afterDelay: 0)
            }
        }
        return lifecycle
    }()

    var busy: Bool {
        get { lifecycle.busy }
        set { lifecycle.busy = newValue }
    }

    var phase: Phase {
        get { lifecycle.phase }
        set { lifecycle.phase = newValue }
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
        detailsItem.target = self
        menu.addItem(detailsItem)
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
        switch phase.action {
        case .start?: start()
        case .stop?: stop(then: nil)
        case .restart?: stop { self.start() }
        case nil: break
        }
    }

    @objc func showLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: config.logs))
    }

    /// The menu keeps the failure; this makes sure someone sees it.
    @objc func announceFailure() {
        guard case .failed(let heading, let detail) = phase else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = heading
        alert.informativeText = detail ?? ""
        alert.addButton(withTitle: "Show Logs")
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { showLogs() }
    }

    @objc func showData() {
        NSWorkspace.shared.open(URL(fileURLWithPath: config.root + "/data"))
    }

    // MARK: start, stop, poll

    func start() {
        guard !busy else { return }
        busy = true
        let mine = lifecycle.begin()
        phase = .starting
        // Main-queue updates from this start, unless a stop or another start has come since.
        func update(_ change: @escaping () -> Void) { lifecycle.finish(mine, change) }
        work.async { [self] in
            do {
                if !services.isLoaded(config.nodeLabel) && services.portIsTaken() {
                    throw Failure("port \(config.port) is already in use by another program")
                }
                if !services.hasCluster {
                    update { self.phase = .settingUp }
                    try services.createCluster()
                    update { self.phase = .starting }
                }
                try services.bootstrap(config.postgresLabel)
                // Follow a renamed Mac so invite links carry a name that resolves; sessions
                // on the old origin end, which a stale name would make worse.
                if let live = config.liveHostNameOrigin(), live != services.publicOrigin() {
                    services.bootout(config.nodeLabel, timeout: 90)
                    try services.setPublicOrigin(live)
                }
                let inForce = services.publicOrigin() ?? config.origin
                update { self.origin = inForce; self.refresh() }
                try services.bootstrap(config.nodeLabel)
                // A first start migrates the database and builds its search indexes before it
                // serves anything, however long that takes; only a failure ends the wait.
                waiting: while lifecycle.attempt == mine {
                    switch services.watch.observe(services.look(), at: Date()).health {
                    case .serving: break waiting
                    case .down(let fault): throw Failure(fault, detail: services.detail(fault))
                    case .starting, .installing, .restoring: Thread.sleep(forTimeInterval: 1)
                    }
                }
                update {
                    self.busy = false
                    self.phase = .running
                    if !self.openedBrowser {
                        self.openedBrowser = true
                        self.openStuga()
                    }
                }
            } catch {
                let failure = error as? Failure ?? Failure("\(error)")
                update {
                    self.busy = false
                    self.phase = .failed(heading: failure.heading, detail: failure.detail)
                }
            }
        }
    }

    func stop(then done: (() -> Void)?) {
        lifecycle.stop(then: done)
    }

    func poll() {
        guard !busy else { return }
        work.async { [self] in
            let look = services.look()
            // Not loaded: stopped, by this app or by hand.
            let health = look.node.loaded ? services.watch.observe(look, at: Date()).health : nil
            var detail: String?
            if case .down(let fault) = health { detail = services.detail(fault) }
            DispatchQueue.main.async {
                guard !self.busy else { return }
                // A failure stays on screen until the node serves or the next start.
                guard health == .serving || !self.phase.failed else { return }
                switch health {
                case .serving: self.phase = .running
                // launchd is (re)starting it: KeepAlive after a crash, or waiting for Postgres.
                case .starting, .installing, .restoring: self.phase = .starting
                case .down(let fault): self.phase = .failed(heading: fault.title, detail: detail)
                case nil: self.phase = .stopped
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
        case .failed(let heading, _):
            statusLine.title = heading
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
        if case .failed(_, let detail?) = phase {
            detailsItem.isHidden = detail.isEmpty
        } else {
            detailsItem.isHidden = true
        }
        toggleItem.title = phase.action?.title ?? "Stop"
        // Stop stays available while starting: a node that never answers must not trap the owner.
        toggleItem.isEnabled = phase.action != nil && (!busy || phase == .starting)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
