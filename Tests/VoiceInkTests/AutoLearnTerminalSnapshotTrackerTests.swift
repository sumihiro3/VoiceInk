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
        XCTAssertEqual(resolution.source, .sentEcho)
        XCTAssertFalse(resolution.usedTrackedRevision)
        XCTAssertEqual(resolution.revision?.corrected, AutoLearnTerminalFixture.corrected)
        XCTAssertEqual(resolution.readCount, 3)

        let placeholder = makeTracker(
            reader: FakeReader([fixture.revisedFinal]), scheduler: scheduler
        )
        placeholder.start()
        scheduler.fire()
        let fallback = placeholder.resolve(finalFieldText: fixture.sentPlaceholderFinal)
        XCTAssertEqual(fallback.sentEcho, .notFound)
        XCTAssertEqual(fallback.source, .tracked)
        XCTAssertTrue(fallback.usedTrackedRevision)
        XCTAssertNil(fallback.finalOutcome)
        XCTAssertEqual(fallback.revision?.corrected, AutoLearnTerminalFixture.corrected)
    }

    /// 実機の8回目: 入力欄の文を消して送らなかった。消している途中の状態を候補にしない。
    func testClearedWithoutSendingIgnoresTrackedRevision() {
        let deleting = fixture.revisedFinal.replacingOccurrences(
            of: AutoLearnTerminalFixture.corrected, with: "Claude"
        )
        let reader = FakeReader([deleting])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire()
        XCTAssertNotNil(tracker.lastRevision)

        let resolution = tracker.resolve(finalFieldText: fixture.clearedFinal)
        XCTAssertEqual(resolution.finalProbe?.stage, .inputEmpty)
        XCTAssertEqual(resolution.sentEcho, .notFound)
        XCTAssertEqual(resolution.source, .none)
        XCTAssertFalse(resolution.usedTrackedRevision)
        XCTAssertNil(resolution.revision)
    }

    func testFinalInputWinsOverTrackedMidEdit() {
        let reader = FakeReader([fixture.midEditFinal])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire()
        XCTAssertNotNil(tracker.lastRevision)

        let resolution = tracker.resolve(finalFieldText: fixture.revisedFinal)
        XCTAssertEqual(resolution.source, .final)
        XCTAssertEqual(resolution.revision?.corrected, AutoLearnTerminalFixture.corrected)
    }

    func testSentWithoutCorrectionIgnoresTrackedRevision() {
        let reader = FakeReader([fixture.midEditFinal])
        let scheduler = FakeScheduler()
        let tracker = makeTracker(reader: reader, scheduler: scheduler)
        tracker.start()
        scheduler.fire()

        let resolution = tracker.resolve(finalFieldText: fixture.sentUncorrectedFinal)
        XCTAssertEqual(resolution.source, .sentEcho)
        XCTAssertEqual(resolution.sentEcho, .unchanged)
        XCTAssertNil(resolution.revision)
    }

    /// 実機の5回目: 貼り付けた文字が画面の最後にあり、後ろの目印が無い。Enter で送ったあとの
    /// 確定では、前の目印から画面の最後(応答と新しい入力欄)までを切り出すので too-long になる。
    func testSentEchoIsUsedWhenPasteWasAtEndOfScreen() {
        let original = "オートペティアビデオメーカーを作ったよ"
        let corrected = "ProtoPedia Video Makerを作ったよ"
        let rule = String(repeating: "─", count: 80)
        let history = "> 前の質問です\n\n⏺ 前の応答です。\n\n\(rule)\n"
        let baseline = history + "> \(original)"
        let range = (baseline as NSString).range(of: original)
        let midEdit = history + "> ProtoPedia Video Makerーを作ったよ"
        let reply = String(repeating: "いいですね。作り方を説明します。\n", count: 8)
        // 実機の beforeAnchors=2 に合わせ、送った文の行の前と新しい入力欄の前に同じ目印がある。
        let final = history + "> \(corrected)\n\n⏺ \(reply)\n\(rule)\n> "

        let reader = FakeReader([midEdit])
        let scheduler = FakeScheduler()
        let tracker = AutoLearnTerminalSnapshotTracker(
            baselineFieldText: baseline,
            pastedRange: range,
            originalPastedText: original,
            readFieldText: { reader.read() },
            scheduler: scheduler,
            interval: 1_000_000_000,
            now: { 0 }
        )
        tracker.start()
        scheduler.fire()
        XCTAssertNotNil(tracker.lastRevision)

        let resolution = tracker.resolve(finalFieldText: final)
        XCTAssertEqual(resolution.finalProbe?.stage, .tooLong)
        XCTAssertEqual(resolution.source, .sentEcho)
        XCTAssertEqual(resolution.sentEcho, .revised(original: original, corrected: corrected))
        XCTAssertEqual(resolution.revision?.corrected, corrected)
    }

    func testCountsRevisionUpdatesAndAgeAndProbesFinal() {
        let midEdit = fixture.revisedFinal.replacingOccurrences(of: "Claude Code", with: "Claude")
        let reader = FakeReader([fixture.revisedFinal, fixture.revisedFinal, midEdit])
        let scheduler = FakeScheduler()
        var clock: UInt64 = 0
        let tracker = makeTracker(reader: reader, scheduler: scheduler, now: { clock })
        tracker.start()
        scheduler.fire()
        clock = 1_000_000_000
        scheduler.fire()
        clock = 2_000_000_000
        scheduler.fire()
        clock = 2_600_000_000

        let resolution = tracker.resolve(finalFieldText: fixture.sentFinal)
        XCTAssertEqual(resolution.revisionUpdates, 2)
        XCTAssertEqual(resolution.lastRevisionAgeMilliseconds, 600)
        XCTAssertEqual(resolution.finalProbe?.stage, .inputEmpty)
        XCTAssertEqual(resolution.source, .sentEcho)
        XCTAssertEqual(resolution.revision?.corrected, AutoLearnTerminalFixture.corrected)
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
        XCTAssertNil(tracker.resolve(finalFieldText: fixture.sentUncorrectedFinal).revision)

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
