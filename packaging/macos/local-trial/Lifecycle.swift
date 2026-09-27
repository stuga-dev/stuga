// What the local trial's Start/Stop item does, and how it stops Stuga: apart from main.swift so
// test/TrialTests.swift can run them against a stand-in for launchd.
import Foundation

enum Phase: Equatable {
    case stopped, settingUp, starting, running, stopping
    case failed(heading: String, detail: String?)

    var failed: Bool {
        if case .failed = self { return true }
        return false
    }

    /// The menu's one action for starting and stopping; nil while setting up or stopping.
    var action: Action? {
        switch self {
        case .running, .starting: return .stop
        case .stopped: return .start
        // A failure can leave both jobs loaded and the node hung: only stopping them clears it.
        case .failed: return .restart
        case .settingUp, .stopping: return nil
        }
    }
}

enum Action {
    case start, stop, restart

    var title: String {
        switch self {
        case .start: return "Start"
        case .stop: return "Stop"
        case .restart: return "Restart"
        }
    }
}

/// The launchd jobs as stopping needs them.
protocol JobControl: AnyObject {
    func bootout(_ label: String, timeout: TimeInterval)
    var watch: Watch { get set }
}

/// Stop the node, then Postgres, and only then forget what the watch saw: the processes it saw are
/// gone, so whatever runs next is judged afresh, never before.
func stopJobs(_ jobs: JobControl, node: String, postgres: String) {
    // The node first: it holds connections a Postgres shutdown would otherwise cut.
    jobs.bootout(node, timeout: 90)
    jobs.bootout(postgres, timeout: 330)
    jobs.watch.reset()
}

typealias Queue = (@escaping () -> Void) -> Void

/// The trial's starts and stops. Each runs on a serial `work` queue and ends back on `main`; each
/// is an attempt, and a later one makes an earlier one's ending moot. So a stop that a restart began
/// never clears a newer stop or quit, nor starts what they stopped, and a start still waiting for
/// the node gives up.
final class Lifecycle {
    let jobs: JobControl
    let node: String
    let postgres: String
    let work: Queue
    let main: Queue

    /// A start or stop is under way; the poll leaves the phase alone meanwhile.
    var busy = false
    var phase: Phase = .stopped {
        didSet { changed(oldValue) }
    }
    /// Called on each change of phase with the one before.
    var changed: (Phase) -> Void = { _ in }

    // Read on `work`, so behind a lock.
    private let lock = NSLock()
    private var attempts = 0

    init(jobs: JobControl, node: String, postgres: String, work: @escaping Queue, main: @escaping Queue) {
        self.jobs = jobs
        self.node = node
        self.postgres = postgres
        self.work = work
        self.main = main
    }

    /// The latest attempt.
    var attempt: Int {
        lock.lock()
        defer { lock.unlock() }
        return attempts
    }

    func begin() -> Int {
        lock.lock()
        defer { lock.unlock() }
        attempts += 1
        return attempts
    }

    /// `change` on `main`, unless a later start or stop has begun since `mine`.
    func finish(_ mine: Int, _ change: @escaping () -> Void) {
        main { if self.attempt == mine { change() } }
    }

    /// Stop both jobs, then `done` on `main`, unless a later start or stop has begun by then; that
    /// one's own ending clears `busy`.
    func stop(then done: (() -> Void)?) {
        busy = true
        let mine = begin()
        phase = .stopping
        work {
            stopJobs(self.jobs, node: self.node, postgres: self.postgres)
            self.finish(mine) {
                self.busy = false
                self.phase = .stopped
                done?()
            }
        }
    }
}
