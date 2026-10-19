import XCTest
@testable import VoiceInk

/// 確定させた結果から直しと段階を決める処理(FR-04 の結線)。
final class AutoLearnTerminalFinalizerTests: XCTestCase {
    private let before = "【前】"
    private let after = "【後】"
    private let pasted = "こんにちは世界"
    private let revision = AutoLearnRevision(original: "こんにちは世界", corrected: "こんにちわ世界")

    private func snapshot(final: String) -> AutoLearnFieldSnapshot {
        AutoLearnFieldSnapshot(
            baselineFieldText: before + pasted + after,
            finalFieldText: final,
            pastedRange: NSRange(
                location: (before as NSString).length,
                length: (pasted as NSString).length
            ),
            originalPastedText: pasted
        )
    }

    private func resolution(
        revision: AutoLearnRevision?,
        usedTracked: Bool,
        finalOutcome: AutoLearnTerminalRevisionLocator.Outcome?
    ) -> AutoLearnTerminalSnapshotTracker.Resolution {
        AutoLearnTerminalSnapshotTracker.Resolution(
            revision: revision,
            usedTrackedRevision: usedTracked,
            finalOutcome: finalOutcome,
            readCount: 5,
            failedReadCount: 1,
            skippedReadCount: 2,
            maximumReadMilliseconds: 42
        )
    }

    private func ghostty(
        _ resolution: AutoLearnTerminalSnapshotTracker.Resolution,
        stoppedStage: AutoLearnFinalizeStage? = nil
    ) -> AutoLearnFinishedObservation {
        AutoLearnFinishedObservation(
            snapshot: nil,
            bundleIdentifier: AutoLearnTerminalTarget.ghosttyBundleIdentifier,
            finalFieldText: nil,
            stoppedStage: stoppedStage,
            terminalResolution: resolution
        )
    }

    func testGhosttyTrackedRevisionIsUsedAndReportedAsRevised() {
        let decision = AutoLearnTerminalFinalizer.decide(
            ghostty(resolution(revision: revision, usedTracked: true, finalOutcome: nil))
        )
        XCTAssertEqual(decision.revision?.corrected, "こんにちわ世界")
        XCTAssertEqual(decision.stage, .revised)
        XCTAssertEqual(
            decision.terminal,
            AutoLearnTerminalDiagnosticFields(
                beforeAnchorMatches: 0, afterAnchorMatches: 0,
                reads: 5, failedReads: 1, skippedReads: 2,
                usedTrackedRevision: true, maxReadMs: 42
            )
        )
    }

    func testGhosttyFinalOutcomeStageAndAnchorCountsAreReported() {
        let outcome = AutoLearnTerminalRevisionLocator.Outcome(
            revision: nil, stage: .afterAnchorNotFound,
            beforeAnchorMatchCount: 3, afterAnchorMatchCount: 0
        )
        let decision = AutoLearnTerminalFinalizer.decide(
            ghostty(resolution(revision: nil, usedTracked: false, finalOutcome: outcome))
        )
        XCTAssertNil(decision.revision)
        XCTAssertEqual(decision.stage, .afterAnchorNotFound)
        XCTAssertEqual(decision.terminal?.beforeAnchorMatches, 3)
        XCTAssertEqual(decision.terminal?.usedTrackedRevision, false)
    }

    func testGhosttyRevisionFromFinalIsReportedAsRevised() {
        let outcome = AutoLearnTerminalRevisionLocator.Outcome(
            revision: revision, stage: .located,
            beforeAnchorMatchCount: 1, afterAnchorMatchCount: 1
        )
        let decision = AutoLearnTerminalFinalizer.decide(
            ghostty(resolution(revision: revision, usedTracked: false, finalOutcome: outcome))
        )
        XCTAssertEqual(decision.stage, .revised)
        XCTAssertNotNil(decision.revision)
    }

    func testGhosttyFinalReadFailedWithoutTrackedRevisionIsReadFailed() {
        let decision = AutoLearnTerminalFinalizer.decide(
            ghostty(
                resolution(revision: nil, usedTracked: false, finalOutcome: nil),
                stoppedStage: .readFailed
            )
        )
        XCTAssertNil(decision.revision)
        XCTAssertEqual(decision.stage, .readFailed)
        XCTAssertNotNil(decision.terminal)
    }

    func testOtherAppUsesUpstreamDiffEngine() {
        let observation = AutoLearnFinishedObservation(
            snapshot: snapshot(final: before + "こんにちわ世界" + after),
            bundleIdentifier: "com.apple.TextEdit",
            finalFieldText: before + "こんにちわ世界" + after,
            stoppedStage: nil,
            terminalResolution: nil
        )
        let decision = AutoLearnTerminalFinalizer.decide(observation)
        XCTAssertEqual(decision.revision?.original, "こんにちは世界")
        XCTAssertEqual(decision.revision?.corrected, "こんにちわ世界")
        XCTAssertEqual(decision.stage, .revised)
        XCTAssertNil(decision.terminal)
    }

    func testOtherAppUpstreamNilIsDiffEngineNil() {
        let final = before + "こんにちわ世界" + after + before
        let observation = AutoLearnFinishedObservation(
            snapshot: snapshot(final: final),
            bundleIdentifier: "com.apple.TextEdit",
            finalFieldText: final,
            stoppedStage: nil,
            terminalResolution: nil
        )
        let decision = AutoLearnTerminalFinalizer.decide(observation)
        XCTAssertNil(decision.revision)
        XCTAssertEqual(decision.stage, .diffEngineNil)
    }

    func testOtherAppStoppedStageIsKept() {
        let decision = AutoLearnTerminalFinalizer.decide(
            .stopped(.unchanged, bundleIdentifier: "com.apple.TextEdit", finalFieldText: "x")
        )
        XCTAssertNil(decision.revision)
        XCTAssertEqual(decision.stage, .unchanged)
        XCTAssertNil(decision.terminal)
    }

    func testEveryLocatorStageMapsToSameNamedFinalizeStageExceptLocated() {
        let stages: [AutoLearnTerminalRevisionLocator.Stage] = [
            .invalidBaseline, .beforeAnchorNotFound, .afterAnchorNotFound,
            .tooLong, .tooManyLineBreaks, .inputEmpty, .notRevised,
        ]
        for stage in stages {
            XCTAssertEqual(AutoLearnTerminalFinalizer.finalizeStage(for: stage).rawValue, stage.rawValue)
        }
        XCTAssertEqual(AutoLearnTerminalFinalizer.finalizeStage(for: .located), .revised)
    }
}
