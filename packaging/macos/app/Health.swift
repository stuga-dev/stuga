// How the menu-bar apps tell a slow start from a failure, shared by Stuga.app (app/main.swift) and
// the local trial (local-trial/main.swift). The callers look; this decides. Time is an argument, so
// test/HealthTests.swift runs it without waiting.
import Foundation

/// What /ready answered. The node answers once it owns its database: 200 when it serves, 503 with a
/// `status` while it starts, backs up, upgrades or makes a backup, and a bare 503 when its database
/// does not answer. Silent is no answer within the caller's timeout.
enum Ready: Equatable {
    case serving, busy, databaseUnreachable, silent

    init(status: Int?, body: Data?) {
        guard let status else {
            self = .silent
            return
        }
        let json = body.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        self = status == 200 ? .serving : json?["status"] is String ? .busy : .databaseUnreachable
    }
}

/// A launchd job's process, from `launchctl print`, which anyone may run.
struct Job: Equatable {
    var loaded = false
    var pid: Int?
    /// How often launchd has run it since it was loaded.
    var runs = 0

    init(loaded: Bool = false, pid: Int? = nil, runs: Int = 0) {
        self.loaded = loaded
        self.pid = pid
        self.runs = runs
    }

    /// From `launchctl print`'s output; nil when the job is not loaded.
    init(print output: String?) {
        guard let output else {
            self.init()
            return
        }
        // The job's own fields are one tab in; nested ones are deeper.
        func field(_ name: String) -> Int? {
            let prefix = "\t\(name) = "
            return output.split(separator: "\n").first { $0.hasPrefix(prefix) }.flatMap { Int($0.dropFirst(prefix.count)) }
        }
        self.init(loaded: true, pid: field("pid"), runs: field("runs") ?? 0)
    }

    /// Nothing is running it: it ran and ended, or it is not loaded at all.
    var ended: Bool { !loaded || (pid == nil && runs > 0) }

    /// Run again since `earlier`: it ended in between, even if too briefly to be seen. A first run
    /// is not that, but a second one is, however few looks saw the first.
    func restarted(since earlier: Job) -> Bool { loaded && earlier.loaded && runs > 1 && runs > earlier.runs }
}

/// What a failure looks like from outside.
enum Fault: Equatable {
    case nodeStopped, postgresStopped, databaseUnreachable, notResponding

    var title: String {
        switch self {
        case .nodeStopped: return "Stuga stopped and has not started again"
        case .postgresStopped: return "Stuga's database stopped and has not started again"
        case .databaseUnreachable: return "Stuga cannot reach its database"
        case .notResponding: return "Stuga is not responding"
        }
    }
}

/// One look at the node: /ready's answer, both jobs, and whether a package is being installed.
struct Look {
    var ready: Ready
    var node: Job
    var postgres: Job
    var installing = false
}

enum Health: Equatable {
    case serving
    /// Starting, backing up or upgrading, however slowly; or failing for less than a minute.
    case starting
    /// A package is being installed, which stops Stuga on purpose.
    case installing
    /// Failing for a minute. It stays until the node serves again.
    case down(Fault)
}

/// Tells a slow start from a failure, across looks a few seconds apart.
///
/// Starting is never a failure, however slow the Mac: the processes running with no answer yet
/// (Postgres recovering, the node loading), or the node saying it starts, backs up or upgrades. A
/// failure needs evidence: a process that ended or was run again, a database that does not answer,
/// or the very process that served no longer answering. Down is still failing a minute after the
/// first failure without serving since. A job that keeps failing to start runs for a moment on every
/// try, so a try does not restart the minute; a crash launchd recovers from passes quietly, however
/// slowly the new process starts.
struct Watch {
    static let patience: TimeInterval = 60
    /// An install that stopped before its postinstall leaves its mark; after this it no longer counts.
    static let installLimit: TimeInterval = 30 * 60

    private(set) var failedAt: Date?
    private(set) var fault: Fault?
    private(set) var announced = false
    /// The node process last seen serving.
    private var servedBy: Int?
    private var last: Look?

    /// Is a mark made at `markedAt` an install still under way?
    static func installing(markedAt: Date?, now: Date) -> Bool {
        guard let markedAt else { return false }
        return now.timeIntervalSince(markedAt) < installLimit
    }

    /// Take a look: what to show, and a fault to announce now, once per failure.
    mutating func observe(_ look: Look, at now: Date) -> (health: Health, announce: Fault?) {
        let earlier = last
        last = look
        if look.ready == .serving {
            forget()
            servedBy = look.node.pid
            return (.serving, nil)
        }
        if look.installing {
            forget()
            servedBy = nil
            return (.installing, nil)
        }
        if let seen = evidence(look, since: earlier) {
            let since = failedAt ?? now
            failedAt = since
            fault = seen
            if !announced && now.timeIntervalSince(since) >= Watch.patience {
                announced = true
                return (.down(seen), seen)
            }
        }
        if announced, let fault { return (.down(fault), nil) }
        return (.starting, nil)
    }

    /// After a start, stop or restart someone asked for: what came before says nothing about now.
    mutating func reset() {
        forget()
        servedBy = nil
        last = nil
    }

    private mutating func forget() {
        failedAt = nil
        fault = nil
        announced = false
    }

    private func evidence(_ look: Look, since earlier: Look?) -> Fault? {
        if look.postgres.ended || earlier.map({ look.postgres.restarted(since: $0.postgres) }) == true {
            return .postgresStopped
        }
        if look.node.ended || earlier.map({ look.node.restarted(since: $0.node) }) == true {
            return .nodeStopped
        }
        if look.ready == .databaseUnreachable { return .databaseUnreachable }
        if look.ready == .silent, let pid = look.node.pid, pid == servedBy { return .notResponding }
        return nil
    }
}
