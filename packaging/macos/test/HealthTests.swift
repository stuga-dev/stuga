// The menu-bar apps' failure watch (app/Health.swift), look by look, on a clock the test moves.
// Built and run by health.test.mjs:
//   swiftc -parse-as-library app/Health.swift test/HealthTests.swift
import Foundation

@main
enum HealthTests {
    static var failed = 0

    static func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        print(ok ? "ok - \(name)" : "not ok - \(name) \(detail())")
        if !ok { failed += 1 }
    }

    static let postgres = Job(loaded: true, pid: 50, runs: 1)
    static let node = Job(loaded: true, pid: 100, runs: 1)

    static func look(_ ready: Ready, node: Job = node, postgres: Job = postgres, installing: Bool = false) -> Look {
        Look(ready: ready, node: node, postgres: postgres, installing: installing)
    }

    /// Looks `every` seconds apart for `seconds`; what each showed, and every announcement.
    struct Run {
        var watch = Watch()
        var now = Date(timeIntervalSince1970: 0)
        var health: [Health] = []
        var announced: [Fault] = []
        var announcedAt: [TimeInterval] = []

        mutating func see(_ look: Look, for seconds: TimeInterval = 0, every: TimeInterval = 5) {
            var elapsed: TimeInterval = 0
            repeat {
                let (shown, announce) = watch.observe(look, at: now)
                health.append(shown)
                if let announce {
                    announced.append(announce)
                    announcedAt.append(now.timeIntervalSince1970)
                }
                now += every
                elapsed += every
            } while elapsed <= seconds
        }

        var last: Health? { health.last }
    }

    static func main() {
        readyAnswers()
        launchctlPrint()
        slowStarts()
        hangs()
        crashes()
        database()
        restartsAndInstalls()
        exit(failed == 0 ? 0 : 1)
    }

    static func readyAnswers() {
        let body = { (json: String) in json.data(using: .utf8) }
        check("200 is serving", Ready(status: 200, body: body(#"{"ok":true}"#)) == .serving)
        for status in ["starting", "backing_up", "upgrading", "maintenance"] {
            check("503 saying \(status) is busy", Ready(status: 503, body: body(#"{"ok":false,"status":"\#(status)"}"#)) == .busy)
        }
        check("a bare 503 is the database", Ready(status: 503, body: body(#"{"ok":false}"#)) == .databaseUnreachable)
        check("no answer is silent", Ready(status: nil, body: nil) == .silent)
    }

    static func launchctlPrint() {
        // As `launchctl print` writes them: the job's fields one tab in, nested ones deeper.
        let running = "system/dev.stuga.node = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /bin/bash\n\tendpoints = {\n\t\tpid = 9\n\t}\n\truns = 3\n\tpid = 4242\n\tlast exit code = 1\n}\n"
        let ended = "system/dev.stuga.node = {\n\tstate = not running\n\truns = 2\n\tlast exit code = 1\n}\n"
        let never = "gui/501/dev.stuga.local.node = {\n\tstate = not running\n\truns = 0\n\tlast exit code = (never exited)\n}\n"
        check("a running job", Job(print: running) == Job(loaded: true, pid: 4242, runs: 3))
        check("a running job has not ended", !Job(print: running).ended)
        check("a job that ran and ended", Job(print: ended) == Job(loaded: true, pid: nil, runs: 2) && Job(print: ended).ended)
        check("a job not yet run has not ended", !Job(print: never).ended)
        check("a job not loaded has ended", Job(print: nil).ended)
        let runs = { (n: Int) in Job(loaded: true, pid: n > 0 ? 100 + n : nil, runs: n) }
        for (from, to, again) in [(0, 1, false), (0, 2, true), (1, 2, true), (3, 4, true), (1, 1, false), (2, 1, false)] {
            check("runs \(from) then \(to) is \(again ? "" : "not ")run again", runs(to).restarted(since: runs(from)) == again)
        }
        check("loaded again is not run again", !Job(loaded: true, pid: 7, runs: 2).restarted(since: Job()))
    }

    static func slowStarts() {
        let pending = Job(loaded: true, pid: nil, runs: 0)
        var first = Run()
        first.see(look(.silent, node: pending, postgres: pending))
        first.see(look(.silent, node: pending))
        first.see(look(.busy))
        check("a first run of Postgres and the node is no failure", first.watch.failedAt == nil && first.watch.fault == nil)

        var late = Run()
        late.see(look(.silent, node: pending))
        late.see(look(.busy), for: 10 * 60)
        late.see(look(.databaseUnreachable))
        check("ten minutes of starting, then a first bare 503, only starts the minute",
              late.announced.isEmpty && late.last == .starting && late.watch.failedAt != nil)
        late.see(look(.databaseUnreachable), for: 45)
        late.see(look(.serving))
        check("and serving within it announces nothing", late.announced.isEmpty && late.watch.failedAt == nil)
        late.see(look(.databaseUnreachable), for: 65)
        check("while a minute of it announces once", late.announced == [.databaseUnreachable])

        var run = Run()
        run.see(look(.silent, node: Job(loaded: true, pid: nil, runs: 0), postgres: Job(loaded: true, pid: nil, runs: 0)))
        run.see(look(.silent), for: 10 * 60)
        run.see(look(.busy), for: 10 * 60)
        check("a first start silent for ten minutes, then starting for ten, is starting throughout",
              run.health.allSatisfy { $0 == .starting } && run.announced.isEmpty, "\(run.announced)")
        run.see(look(.serving))
        check("and then it serves", run.last == .serving)
    }

    static func hangs() {
        var run = Run()
        run.see(look(.serving))
        run.see(look(.silent), for: 55)
        check("the process that served, silent for under a minute, is not announced", run.announced.isEmpty && run.last == .starting)
        run.see(look(.silent), for: 10)
        check("silent for a minute, it is announced once as not responding", run.announced == [.notResponding], "\(run.announced)")
        check("and shows as down", run.last == .down(.notResponding))
        run.see(look(.busy), for: 60)
        run.see(look(.silent), for: 120)
        check("it stays down, announced once, until it serves", run.last == .down(.notResponding) && run.announced.count == 1)

        run.see(look(.serving))
        check("serving clears it", run.last == .serving && run.watch.failedAt == nil)
        run.see(look(.silent), for: 30)
        run.see(look(.serving))
        check("a short silence that passes is never announced", run.announced.count == 1 && run.watch.failedAt == nil)
        run.see(look(.databaseUnreachable), for: 65)
        check("a new failure after serving is announced again", run.announced == [.notResponding, .databaseUnreachable], "\(run.announced)")
    }

    static func crashes() {
        var run = Run()
        run.see(look(.serving))
        let replaced = Job(loaded: true, pid: 200, runs: 2)
        run.see(look(.silent, node: replaced))
        check("a process run again is a failure", run.watch.failedAt != nil)
        run.see(look(.silent, node: replaced), for: 5 * 60)
        check("its successor starting slowly is not announced, nor taken for the one that served",
              run.announced.isEmpty && run.last == .starting, "\(run.announced)")
        run.see(look(.serving, node: replaced))
        check("and serving clears it", run.watch.failedAt == nil)

        // Each try runs for a moment, says it is starting, and exits; launchd tries again ten seconds on.
        var loop = Run()
        var runs = 1
        while loop.now.timeIntervalSince1970 < 180 {
            loop.see(look(.busy, node: Job(loaded: true, pid: 300 + runs, runs: runs)), every: 2)
            loop.see(look(.silent, node: Job(loaded: true, pid: nil, runs: runs)), for: 8, every: 3)
            runs += 1
        }
        check("a node that keeps failing to start is announced once, in about a minute",
              loop.announced == [.nodeStopped], "\(loop.announced)")
        check("its tries saying starting do not put that off", loop.announcedAt.first.map { $0 <= 75 } == true, "\(loop.announcedAt)")

        var gone = Run()
        gone.see(look(.silent, node: Job()), for: 65)
        check("a node not loaded is announced as stopped", gone.announced == [.nodeStopped])

        var postgres = Run()
        postgres.see(look(.silent, postgres: Job(loaded: true, pid: nil, runs: 4)), for: 65)
        check("Postgres ended is announced as the database stopping", postgres.announced == [.postgresStopped])
        var rerun = Run()
        rerun.see(look(.silent, postgres: Job(loaded: true, pid: 51, runs: 1)))
        rerun.see(look(.silent, postgres: Job(loaded: true, pid: 52, runs: 2)))
        check("Postgres run again between looks is a failure", rerun.watch.fault == .postgresStopped)
    }

    static func database() {
        var run = Run()
        run.see(look(.databaseUnreachable), for: 55)
        check("a bare 503 for under a minute is not announced", run.announced.isEmpty)
        run.see(look(.databaseUnreachable), for: 10)
        check("a bare 503 for a minute is announced once", run.announced == [.databaseUnreachable])
    }

    static func restartsAndInstalls() {
        // Hung, announced, then restarted by its owner: the local trial stops both jobs, which
        // resets the watch, and launchd runs new processes.
        var hung = Run()
        hung.see(look(.serving))
        hung.see(look(.silent), for: 65)
        check("a hung node is down", hung.last == .down(.notResponding))
        hung.see(look(.silent), for: 10 * 60)
        check("watching it longer keeps it down, not starting", hung.last == .down(.notResponding) && hung.announced.count == 1)
        hung.watch.reset()
        hung.see(look(.silent, node: Job(loaded: true, pid: nil, runs: 0)))
        hung.see(look(.silent, node: Job(loaded: true, pid: 200, runs: 1)), for: 10 * 60)
        check("its successor starting slowly after a restart is starting, not taken for it",
              hung.last == .starting && hung.announced.count == 1 && hung.watch.failedAt == nil)
        hung.see(look(.serving, node: Job(loaded: true, pid: 200, runs: 1)))
        hung.see(look(.silent, node: Job(loaded: true, pid: 200, runs: 1)), for: 65)
        check("once it serves, its own hang is announced", hung.announced == [.notResponding, .notResponding])

        var run = Run()
        run.see(look(.silent, node: Job(loaded: true, pid: nil, runs: 1)), for: 50)
        run.watch.reset()
        run.see(look(.silent, node: Job(loaded: true, pid: nil, runs: 1)), for: 30)
        check("a start, stop or restart someone asked for begins the minute again", run.announced.isEmpty)

        var install = Run()
        install.see(look(.serving))
        install.see(look(.silent, node: Job(), postgres: Job(), installing: true), for: 5 * 60)
        check("installing a package shows as installing and is never announced",
              install.announced.isEmpty && install.health.dropFirst().allSatisfy { $0 == .installing })
        install.see(look(.busy, node: Job(loaded: true, pid: 400, runs: 1)), for: 3 * 60)
        check("the new version backing up after it is starting, not a failure",
              install.announced.isEmpty && install.last == .starting && install.watch.failedAt == nil)

        let now = Date(timeIntervalSince1970: 10_000)
        check("a fresh mark is an install under way", Watch.installing(markedAt: now - 60, now: now))
        check("no mark is none", !Watch.installing(markedAt: nil, now: now))
        check("a mark an interrupted install left no longer counts", !Watch.installing(markedAt: now - 31 * 60, now: now))
        var stale = Run()
        stale.see(look(.silent, node: Job(), installing: Watch.installing(markedAt: now - 31 * 60, now: now)), for: 65)
        check("so Stuga left stopped by it is announced", stale.announced == [.nodeStopped])
        var serving = Run()
        serving.see(look(.serving, installing: true))
        check("a node serving is serving, whatever a mark says", serving.last == .serving)
    }
}
