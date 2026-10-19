import XCTest
@testable import VoiceInk

final class AutoLearnTerminalSnapshotTrackerTests: XCTestCase {
    private final class FakeScheduler: AutoLearnTerminalPollScheduling {
        final class Handle: AutoLearnTerminalPollCancellation {
            var cancelled = false
            func cancel() { cancelled = true }
        }
        var handler: (() -> Void)?
        var handle: Handle?
        func scheduleRepeating(
            every interval: UInt64, _ handler: @escaping () -> Void
        ) -> AutoLearnTerminalPollCancellation {
            self.handler = handler
            let h = Handle()
            handle = h
            return h
        }
        func fire() {
            if handle?.cancelled == false { handler?() }
        }
    }

    private final class FakeReader {
        var results: [String?]
        var calls = 0
        var onRead: (() -> Void)?
        init(_ results: [String?]) { self.results = results }
        func read() -> String? {
            calls += 1
            onRead?()
            return results.isEmpty ? nil : results.removeFirst()
        }
    }

    private let fixture = AutoLearnTerminalFixture()

    private func makeTracker(
        reader: FakeReader, scheduler: FakeScheduler, now: @escaping () -> UInt64 = { 0 }
    ) -> AutoLearnTerminalSnapshotTracker {
        AutoLearnTerminalSnapshotTracker(
            baselineFieldText: fixture.baseline,
            pastedRange: fixture.pastedRange,
            originalPastedText: AutoLearnTerminalFixture.original,
            readFieldText: { reader.read() },
            scheduler: scheduler,
            interval: 1_000_000_000,
            now: now
        )
    }

    func testKeepsRevisionBeforeEnterWasPressed() {
        let reader = FakeReader([fixture.baseline, fixture.revisedFinal, fixture.sentFinal])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire()
        XCTAssertNil(tracker.lastRevision)
        scheduler.fire()
        XCTAssertNotNil(tracker.lastRevision)
        scheduler.fire()

        let resolution = tracker.resolve(finalFieldText: fixture.sentFinal)
        XCTAssertTrue(resolution.usedTrackedRevision)
        XCTAssertEqual(resolution.revision?.corrected, AutoLearnTerminalFixture.corrected)
        XCTAssertNil(resolution.finalOutcome)
        XCTAssertEqual(resolution.readCount, 3)
    }

    func testFailedReadsDoNotEraseRevision() {
        let reader = FakeReader([fixture.revisedFinal, nil, nil])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire(); scheduler.fire(); scheduler.fire()

        let resolution = tracker.resolve(finalFieldText: nil)
        XCTAssertNotNil(resolution.revision)
        XCTAssertEqual(resolution.readCount, 1)
        XCTAssertEqual(resolution.failedReadCount, 2)
    }

    func testFallsBackToFinalWhenNothingTracked() {
        let reader = FakeReader([nil])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire()

        let resolution = tracker.resolve(finalFieldText: fixture.revisedFinal)
        XCTAssertFalse(resolution.usedTrackedRevision)
        XCTAssertNotNil(resolution.revision)
        XCTAssertEqual(resolution.finalOutcome?.stage, .located)
    }

    func testNilWhenNeitherTrackedNorFinalHasRevision() {
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: FakeReader([fixture.baseline]), scheduler: scheduler)
        tracker.start()
        scheduler.fire()
        XCTAssertNil(tracker.resolve(finalFieldText: fixture.sentFinal).revision)

        let other = makeTracker(reader: FakeReader([]), scheduler: FakeScheduler())
        let resolution = other.resolve(finalFieldText: nil)
        XCTAssertNil(resolution.revision)
        XCTAssertNil(resolution.finalOutcome)
    }

    func testOverlappingTickIsSkipped() {
        let reader = FakeReader([fixture.baseline])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        reader.onRead = { tracker.tick() }
        tracker.tick()

        XCTAssertEqual(reader.calls, 1)
        XCTAssertEqual(tracker.skippedReadCount, 1)
        XCTAssertEqual(tracker.readCount, 1)
    }

    func testStopPreventsFurtherReads() {
        let reader = FakeReader([fixture.revisedFinal, fixture.revisedFinal])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        tracker.stop()
        tracker.stop()
        scheduler.fire()
        tracker.tick()
        XCTAssertEqual(reader.calls, 0)
        XCTAssertTrue(scheduler.handle?.cancelled ?? false)
    }

    func testResolveStopsPolling() {
        let reader = FakeReader([fixture.baseline])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        _ = tracker.resolve(finalFieldText: fixture.baseline)
        scheduler.fire()
        XCTAssertEqual(reader.calls, 0)
    }

    func testRecordsMaximumReadMilliseconds() {
        var clock: UInt64 = 0
        let durations: [UInt64] = [30_000_000, 120_000_000, 10_000_000]
        var index = 0
        var isStart = true
        let reader = FakeReader([fixture.baseline, fixture.baseline, fixture.baseline])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler) {
            if isStart {
                isStart = false
            } else {
                clock += durations[index]
                index += 1
                isStart = true
            }
            return clock
        }
        tracker.start()
        scheduler.fire(); scheduler.fire(); scheduler.fire()
        XCTAssertEqual(tracker.maximumReadMilliseconds, 120)
        XCTAssertEqual(tracker.readCount, 3)
    }
}
