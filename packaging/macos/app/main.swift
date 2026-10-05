// Stuga: the menu-bar app of an installed Stuga node. The node and its Postgres run as system
// daemons (dev.stuga.node, dev.stuga.postgres) from boot, whether or not anyone is logged in; this
// app only shows their state and opens the node. It reads the node's address and port from the
// node's job definition, which anyone may read, and asks for an administrator's password for what
// changes the system: restarting Stuga and uninstalling it. Until someone sets Stuga up, it opens the
// setup page once Stuga serves, each time it starts. Health.swift decides when Stuga has stopped
// rather than started slowly; this app then says so, once. When a package replaces it, an update or
// a go-back, it opens the new copy and quits.
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ServiceManagement

let root = "/Library/Application Support/Stuga"
let nodePlist = "/Library/LaunchDaemons/dev.stuga.node.plist"
/// The node's SETUP_CODE_FILE, which only the node and the Mac's administrators can read.
let setupCodeFile = root + "/setup/setup-code"
let logs = "/Library/Logs/Stuga"

/// What the node's job definition says about where it listens.
struct Node {
    let origin: URL
    let port: Int

    static func read() -> Node? {
        guard let data = FileManager.default.contents(atPath: nodePlist),
              let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: Any],
              let origin = (env["PUBLIC_ORIGIN"] as? String).flatMap(URL.init)
        else { return nil }
        return Node(origin: origin, port: Int(env["PORT"] as? String ?? "") ?? 8787)
    }

    var local: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

/// A GET on the node's own machine, answered or not within a few seconds.
func fetch(_ url: URL) -> (status: Int, body: Data)? {
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    let done = DispatchSemaphore(value: 0)
    var answer: (Int, Data)?
    URLSession.shared.dataTask(with: request) { data, response, _ in
        if let http = response as? HTTPURLResponse { answer = (http.statusCode, data ?? Data()) }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 4)
    return answer
}

/// Run a shell command as root, after macOS asks for an administrator's password. Nil when refused.
@discardableResult
func asAdministrator(_ command: String, prompt: String) -> String? {
    let quoted = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let source = "do shell script \"\(quoted)\" with prompt \"\(prompt)\" with administrator privileges"
    var error: NSDictionary?
    let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
    return error == nil ? (result?.stringValue ?? "") : nil
}

enum State: Equatable {
    case missing, starting, running, unclaimed, installing, restoring, uninstalling
    case down(Fault)
}

/// A job as launchd has it; anyone may ask.
func job(_ label: String) -> Job {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["print", "system/\(label)"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    // Unable to ask is not evidence that anything ended.
    guard (try? process.run()) != nil else { return Job(loaded: true) }
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    return Job(print: process.terminationStatus == 0 ? output : nil)
}

/// A package's preinstall marks it installing before it stops Stuga, and its postinstall clears the
/// mark once Stuga is started again.
func installing() -> Bool {
    let mark = (try? FileManager.default.attributesOfItem(atPath: root + "/status/installing"))?[.modificationDate] as? Date
    return Watch.installing(markedAt: mark, now: Date())
}

/// bin/stuga's hold mark, as hold.sh reads it: a plain file naming a process by its id and its start
/// time in UTC, which holds only while that process runs.
func restoring() -> Bool {
    let path = root + "/status/restoring"
    guard (try? FileManager.default.attributesOfItem(atPath: path))?[.type] as? FileAttributeType == .typeRegular,
          let text = try? String(contentsOfFile: path, encoding: .utf8)
    else { return false }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard lines.count >= 2, let pid = Int32(lines[0]), pid > 0, !lines[1].isEmpty else { return false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-p", String(pid), "-o", "lstart="]
    process.environment = ["LC_ALL": "C", "TZ": "UTC0"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return false }
    let started = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    return started.trimmingCharacters(in: .whitespacesAndNewlines) == lines[1].trimmingCharacters(in: .whitespaces)
}

/// Stuga's mark, the web app's path as a template image the menu bar tints. The drawing sits low in
/// its 0 0 100 100 box, so the box is recentred on it, as in the web app: 8 13 84 84.
let mark: NSImage = {
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

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let openItem = NSMenuItem(title: "Open Stuga", action: #selector(openStuga), keyEquivalent: "o")
    let copyItem = NSMenuItem(title: "Copy Address", action: #selector(copyAddress), keyEquivalent: "c")
    let qrItem = NSMenuItem(title: "Show Address as QR Code…", action: #selector(showQRCode), keyEquivalent: "")
    let restartItem = NSMenuItem(title: "Restart Stuga…", action: #selector(restart), keyEquivalent: "")
    var state: State = .starting {
        didSet {
            // Claimed, stopped or reinstalled: whatever code was read is no longer this node's.
            if state != .unclaimed { setupCode = nil }
            refresh()
        }
    }
    var node: Node? = Node.read()
    /// Read once per unclaimed spell, so someone who is not an administrator is asked for a password once.
    var setupCode: String?
    /// Open the setup page when Stuga first serves after this app starts, if nobody has set it up.
    var greeting = true
    var watch = Watch()
    /// What the watch last said, for what Restart may cut into.
    var health: Health = .starting
    /// A newer or older copy of this app is opening; this one quits once it has.
    var relaunching = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Back at every login, so the menu is there whenever someone is.
        try? SMAppService.mainApp.register()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        for item in [openItem, copyItem, qrItem] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        for item in [NSMenuItem(title: "Show Logs", action: #selector(showLogs), keyEquivalent: ""), restartItem,
                     NSMenuItem(title: "Uninstall Stuga…", action: #selector(uninstall), keyEquivalent: "")] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Menu", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.autoenablesItems = false
        statusItem.menu = menu
        refresh()
        poll()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
    }

    /// Opened by double-clicking the app: the node, not a window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openStuga()
        return false
    }

    func poll() {
        DispatchQueue.global().async {
            let node = Node.read()
            var look: Look?
            var unclaimed = false
            if let node {
                let ready = fetch(node.local.appendingPathComponent("ready"))
                look = Look(
                    ready: Ready(status: ready?.status, body: ready?.body),
                    node: job("dev.stuga.node"),
                    postgres: job("dev.stuga.postgres"),
                    installing: installing(),
                    restoring: restoring()
                )
                if look?.ready == .serving, let config = fetch(node.local.appendingPathComponent("auth/config")),
                   let json = try? JSONSerialization.jsonObject(with: config.body) as? [String: Any] {
                    unclaimed = json["unclaimed"] as? Bool == true
                }
            }
            DispatchQueue.main.async {
                // The uninstall under way says what happens next.
                guard self.state != .uninstalling else { return }
                self.node = node
                guard let look else {
                    // Uninstalled from a terminal: nothing is left to show.
                    if !FileManager.default.fileExists(atPath: Bundle.main.bundlePath) { return NSApp.terminate(nil) }
                    self.watch.reset()
                    self.state = .missing
                    return
                }
                let (health, announce) = self.watch.observe(look, at: Date())
                self.health = health
                switch health {
                case .serving: self.state = unclaimed ? .unclaimed : .running
                case .starting: self.state = .starting
                case .installing: self.state = .installing
                case .restoring: self.state = .restoring
                case .down(let fault): self.state = .down(fault)
                }
                self.relaunchIfReplaced()
                if self.greeting && health == .serving {
                    self.greeting = false
                    // No password asked for here: it is not what someone who just logged in expects.
                    if unclaimed, let node, let link = self.setupLink(node, ask: false) { NSWorkspace.shared.open(link) }
                }
                // From the run loop, so the alert does not hold up the main queue.
                if let announce { self.perform(#selector(self.announce(_:)), with: announce.title, afterDelay: 0) }
            }
        }
    }

    /// The menu shows the state; this makes sure someone sees it, once per failure.
    @objc func announce(_ title: String) {
        // A restart changes nothing for a node refusing its data; its page says what does.
        let refused = title == Fault.refused.title
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = refused ? "Open Stuga to see what to do." : "Restarting Stuga often fixes this. The logs say what happened."
        alert.addButton(withTitle: refused ? "Open Stuga" : "Restart Stuga…")
        alert.addButton(withTitle: "Show Logs")
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn: if refused { openStuga() } else { restart() }
        case .alertSecondButtonReturn: showLogs()
        default: break
        }
    }

    /// An update or a go-back replaced this app on disk: open the copy there and quit, unless an
    /// install or a restore is still under way.
    func relaunchIfReplaced() {
        guard !relaunching, state != .installing, state != .restoring, state != .uninstalling,
              let data = FileManager.default.contents(atPath: Bundle.main.bundlePath + "/Contents/Info.plist"),
              let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let onDisk = plist["CFBundleShortVersionString"] as? String,
              let running = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              onDisk != running
        else { return }
        relaunching = true
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = false
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
            DispatchQueue.main.async {
                if error == nil { NSApp.terminate(nil) } else { self.relaunching = false }
            }
        }
    }

    func refresh() {
        guard let button = statusItem?.button else { return }
        let address = node?.origin.absoluteString ?? ""
        switch state {
        case .missing: statusLine.title = "Stuga is not installed"
        case .starting: statusLine.title = "Starting…"
        case .running: statusLine.title = "Running at \(address)"
        case .unclaimed: statusLine.title = "Ready to set up at \(address)"
        case .installing: statusLine.title = "Installing an update…"
        case .restoring: statusLine.title = "Restoring a backup…"
        case .uninstalling: statusLine.title = "Uninstalling…"
        case .down(let fault): statusLine.title = fault.title
        }
        if case .down = state {
            button.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Stuga")
            button.image?.isTemplate = true
        } else {
            button.image = mark
        }
        button.appearsDisabled = !(state == .running || state == .unclaimed)
        openItem.title = state == .unclaimed ? "Set Up Stuga…" : "Open Stuga"
        // Before setup the plain address only asks for the code, so both hand out the setup link instead.
        copyItem.title = state == .unclaimed ? "Copy Setup Link" : "Copy Address"
        qrItem.title = state == .unclaimed ? "Show Setup Link as QR Code…" : "Show Address as QR Code…"
        // A node refusing its data serves the page that says what to do.
        openItem.isEnabled = state == .running || state == .unclaimed || state == .down(.refused)
        copyItem.isEnabled = node != nil && state != .uninstalling
        qrItem.isEnabled = node != nil && state != .uninstalling
        restartItem.isEnabled = state != .uninstalling && health.mayRestart
    }

    // MARK: actions

    @objc func openStuga() {
        guard let node else { return }
        if state == .unclaimed, let link = setupLink(node) {
            NSWorkspace.shared.open(link)
        } else {
            NSWorkspace.shared.open(node.origin)
        }
    }

    /// The setup page with the node's setup code. Someone who is not an administrator of this Mac
    /// cannot read the code, and is asked for an administrator's password unless `ask` is false.
    func setupLink(_ node: Node, ask: Bool = true) -> URL? {
        // Only a code is kept: a refused password or an empty read asks again next time.
        if setupCode == nil,
           let read = ((try? String(contentsOfFile: setupCodeFile, encoding: .utf8))
               ?? (ask ? asAdministrator("cat '\(setupCodeFile)'", prompt: "Stuga needs an administrator's password to read its setup code.") : nil))?
               .trimmingCharacters(in: .whitespacesAndNewlines), !read.isEmpty {
            setupCode = read
        }
        guard let code = setupCode,
            var parts = URLComponents(url: node.origin, resolvingAgainstBaseURL: false)
        else { return nil }
        parts.path = "/login"
        parts.queryItems = [URLQueryItem(name: "setup", value: code)]
        return parts.url
    }

    /// What another browser should open: the setup link until someone has set Stuga up, then the address.
    func linkToShare(_ node: Node) -> URL? {
        state == .unclaimed ? setupLink(node) : node.origin
    }

    @objc func copyAddress() {
        guard let node, let link = linkToShare(node) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link.absoluteString, forType: .string)
    }

    @objc func showQRCode() {
        guard let node, let link = linkToShare(node), let image = qrCode(link.absoluteString) else { return }
        let alert = NSAlert()
        if state == .unclaimed {
            alert.messageText = "Set up Stuga on your phone"
            alert.informativeText = "Scan this on a phone on the same network. It carries the setup code, so keep it to yourself."
        } else {
            alert.messageText = "Open Stuga on your phone"
            alert.informativeText = "Scan this on a phone on the same network: \(node.origin.absoluteString)"
        }
        let view = NSImageView(frame: NSRect(x: 0, y: 0, width: 220, height: 220))
        view.image = image
        alert.accessoryView = view
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func qrCode(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    @objc func showLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logs))
    }

    @objc func restart() {
        // An install or a restore stops Stuga on purpose, and starts it again when it is done.
        guard state != .uninstalling, health.mayRestart, !installing(), !restoring() else { return }
        state = .starting
        DispatchQueue.global().async {
            let restarted = asAdministrator("launchctl kickstart -k system/dev.stuga.postgres; launchctl kickstart -k system/dev.stuga.node", prompt: "Stuga needs your password to restart.") != nil
            DispatchQueue.main.async {
                // Restarted on purpose, not a crash.
                if restarted { self.watch.reset() }
                self.poll()
            }
        }
    }

    @objc func uninstall() {
        guard state != .uninstalling else { return }
        let alert = NSAlert()
        alert.messageText = "Uninstall Stuga?"
        alert.informativeText = "Stuga stops and is removed from this Mac. Your documents and backups stay in \(root)/data unless you delete them too."
        alert.addButton(withTitle: "Uninstall, Keep Data")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Uninstall and Delete Data")
        NSApp.activate(ignoringOtherApps: true)
        let choice = alert.runModal()
        if choice == .alertSecondButtonReturn { return }
        let deleteData = choice == .alertThirdButtonReturn
        let script = "'\(root)/current/bin/uninstall.sh'\(deleteData ? " --delete-data" : "")"
        let before = state
        state = .uninstalling
        // Off the main thread, so the menu says what is happening while it does.
        DispatchQueue.global().async {
            let removed = asAdministrator(script, prompt: "Stuga needs your password to uninstall.") != nil
            DispatchQueue.main.async {
                if removed { return NSApp.terminate(nil) }
                self.state = before
                self.poll()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
