// The local trial's Start/Stop item and how it stops Stuga (local-trial/Lifecycle.swift), against a
// stand-in for launchd. Built and run by health.test.mjs:
//   swiftc -parse-as-library app/Health.swift local-trial/Lifecycle.swift test/TrialTests.swift
import Foundation

/// launchd as stopping sees it: loaded jobs, and every call in order.
final class FakeJobs: JobControl {
    var loaded: Set<String> = ["node", "postgres"]
    var calls: [String] = []
    var watch = Watch() {
        didSet { if watch.failedAt == nil && oldValue.failedAt != nil { calls.append("watch forgets") } }
    }

    func bootout(_ label: String, timeout: TimeInterval) {
        calls.append("bootout \(label)")
        loaded.remove(label)
    }
}

/// A queue the test runs by hand, one block at a time.
final class Steps {
    var blocks: [() -> Void] = []
    var queue: Queue { { self.blocks.append($0) } }
    func runNext() { blocks.removeFirst()() }
}

/// A lifecycle over fake jobs, with work and main queues the test steps through.
struct Harness {
    let jobs = FakeJobs()
    let work = Steps()
    let main = Steps()
    let lifecycle: Lifecycle

    init() {
        lifecycle = Lifecycle(jobs: jobs, node: "node", postgres: "postgres", work: work.queue, main: main.queue)
    }
}

@main
enum TrialTests {
    static var failed = 0

    static func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        print(ok ? "ok - \(name)" : "not ok - \(name) \(detail())")
        if !ok { failed += 1 }
    }

    static func main() {
        check("running stops", Phase.running.action == .stop)
        check("starting stops", Phase.starting.action == .stop)
        check("stopped starts", Phase.stopped.action == .start)
        check("a failure restarts rather than starting what is still loaded",
              Phase.failed(heading: "Stuga is not responding", detail: nil).action == .restart)
        check("the menu says Restart then", Phase.failed(heading: "x", detail: nil).action?.title == "Restart")
        check("nothing while setting up or stopping", Phase.settingUp.action == nil && Phase.stopping.action == nil)

        // A node that served and then hung, announced: its job still loaded, its process still there.
        let jobs = FakeJobs()
        let node = Job(loaded: true, pid: 100, runs: 1), postgres = Job(loaded: true, pid: 50, runs: 1)
        var now = Date(timeIntervalSince1970: 0)
        _ = jobs.watch.observe(Look(ready: .serving, node: node, postgres: postgres), at: now)
        for _ in 0...13 {
            now += 5
            _ = jobs.watch.observe(Look(ready: .silent, node: node, postgres: postgres), at: now)
        }
        check("the hung node is down", jobs.watch.fault == .notResponding && jobs.watch.announced)
        jobs.calls = []

        stopJobs(jobs, node: "node", postgres: "postgres")
        check("restarting stops the node, then Postgres, then forgets what the watch saw",
              jobs.calls == ["bootout node", "bootout postgres", "watch forgets"], "\(jobs.calls)")
        check("so both jobs are gone, and the start that follows loads new ones", jobs.loaded.isEmpty)
        scheduling()
        exit(failed == 0 ? 0 : 1)
    }

    static func scheduling() {
        // A restart: stop, then start once stopped.
        var h = Harness()
        var starts = 0
        h.lifecycle.stop { starts += 1 }
        check("a restart is busy stopping", h.lifecycle.busy && h.lifecycle.phase == .stopping)
        h.work.runNext()
        h.main.runNext()
        check("with nothing after it, a restart starts once stopped",
              starts == 1 && !h.lifecycle.busy && h.lifecycle.phase == .stopped && h.jobs.loaded.isEmpty)

        // Quit while a restart is still stopping: both stops queued, then the restart's ends first.
        h = Harness()
        starts = 0
        var quit = false
        h.lifecycle.stop { starts += 1 }
        h.lifecycle.stop { quit = true }
        h.work.runNext()
        h.main.runNext()
        check("the restart's ending, overtaken by a quit, neither starts nor clears the quit's stop",
              starts == 0 && !quit && h.lifecycle.busy && h.lifecycle.phase == .stopping)
        h.work.runNext()
        h.main.runNext()
        check("the quit's stop ends it, with both jobs stopped",
              quit && starts == 0 && !h.lifecycle.busy && h.lifecycle.phase == .stopped && h.jobs.loaded.isEmpty)
        check("and nothing is left to run", h.work.blocks.isEmpty && h.main.blocks.isEmpty)

        // Quit after the restart has stopped both jobs, but before its ending has run.
        h = Harness()
        starts = 0
        quit = false
        h.lifecycle.stop { starts += 1 }
        h.work.runNext()
        h.lifecycle.stop { quit = true }
        h.main.runNext()
        check("a restart's ending already queued when a quit comes is moot",
              starts == 0 && !quit && h.lifecycle.busy && h.lifecycle.phase == .stopping)
        h.work.runNext()
        h.main.runNext()
        check("and the quit still ends", quit && starts == 0 && !h.lifecycle.busy && h.jobs.loaded.isEmpty)
    }
}
