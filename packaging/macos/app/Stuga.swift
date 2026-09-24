// Stuga: the menu-bar app of an installed Stuga node. The node and its Postgres run as system
// daemons (dev.stuga.node, dev.stuga.postgres) from boot, whether or not anyone is logged in; this
// app only shows their state and opens the node. It reads the node's address and port from the
// node's job definition, which anyone may read, and asks for an administrator's password for what
// changes the system: restarting Stuga, reading the setup code, uninstalling.
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ServiceManagement

let root = "/Library/Application Support/Stuga"
let nodePlist = "/Library/LaunchDaemons/dev.stuga.node.plist"
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
    case missing, starting, running, unclaimed, stopped
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
    var state: State = .starting {
        didSet {
            // Claimed, stopped or reinstalled: whatever code was read is no longer this node's.
            if state != .unclaimed { setupCode = nil }
            refresh()
        }
    }
    var node: Node? = Node.read()
    /// Read once per unclaimed spell, so opening, copying and the QR code ask for the password once.
    var setupCode: String?

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
        for (title, action) in [("Show Logs", #selector(showLogs)), ("Restart Stuga…", #selector(restart)), ("Uninstall Stuga…", #selector(uninstall))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
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
            var next: State = .missing
            if let node {
                if let ready = fetch(node.local.appendingPathComponent("ready")) {
                    next = ready.status == 200 ? .running : .starting
                    if next == .running, let config = fetch(node.local.appendingPathComponent("auth/config")),
                       let json = try? JSONSerialization.jsonObject(with: config.body) as? [String: Any],
                       json["unclaimed"] as? Bool == true {
                        next = .unclaimed
                    }
                } else {
                    next = .stopped
                }
            }
            DispatchQueue.main.async {
                self.node = node
                self.state = next
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
        case .stopped: statusLine.title = "Stuga is not answering"
        }
        if state == .stopped {
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
        openItem.isEnabled = state == .running || state == .unclaimed
        copyItem.isEnabled = node != nil
        qrItem.isEnabled = node != nil
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

    /// The setup page with the node's setup code, which only root and the node can read.
    func setupLink(_ node: Node) -> URL? {
        // Only a code is kept: a refused password or an empty read asks again next time.
        if setupCode == nil,
           let read = asAdministrator("cat '\(root)/data/node/setup-code'", prompt: "Stuga needs your password to read its setup code.")?
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
        state = .starting
        DispatchQueue.global().async {
            asAdministrator("launchctl kickstart -k system/dev.stuga.postgres; launchctl kickstart -k system/dev.stuga.node", prompt: "Stuga needs your password to restart.")
            DispatchQueue.main.async { self.poll() }
        }
    }

    @objc func uninstall() {
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
        guard asAdministrator(script, prompt: "Stuga needs your password to uninstall.") != nil else { return }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
