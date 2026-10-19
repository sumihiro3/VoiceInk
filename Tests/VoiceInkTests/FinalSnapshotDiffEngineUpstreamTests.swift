import XCTest
@testable import VoiceInk

/// 本家の `FinalSnapshotDiffEngine` の動作を固定する(Ghostty 以外の経路)。
final class FinalSnapshotDiffEngineUpstreamTests: XCTestCase {
    private let before = "【前】"
    private let after = "【後】"
    private let pasted = "こんにちは世界"

    private func snapshot(
        baseline: String? = nil,
        final: String,
        original: String? = nil
    ) -> AutoLearnFieldSnapshot {
        let baselineText = baseline ?? before + pasted + after
        return AutoLearnFieldSnapshot(
            baselineFieldText: baselineText,
            finalFieldText: final,
            pastedRange: NSRange(
                location: (before as NSString).length,
                length: (pasted as NSString).length
            ),
            originalPastedText: original ?? pasted
        )
    }

    func testCorrectedWordReturnsNormalizedRevision() {
        let revision = FinalSnapshotDiffEngine.revision(
            from: snapshot(final: before + "こんにちわ世界" + after)
        )
        XCTAssertEqual(revision?.original, "こんにちは世界")
        XCTAssertEqual(revision?.corrected, "こんにちわ世界")
    }

    func testDuplicatedBeforeAnchorInFinalReturnsNil() {
        let final = before + "こんにちわ世界" + after + before
        XCTAssertNil(FinalSnapshotDiffEngine.revision(from: snapshot(final: final)))
    }

    func testUnchangedPastedTextReturnsNil() {
        let final = before + pasted + after + "追記"
        XCTAssertNil(FinalSnapshotDiffEngine.revision(from: snapshot(final: final)))
    }

    func testIdenticalBaselineAndFinalReturnsNil() {
        let text = before + pasted + after
        XCTAssertNil(FinalSnapshotDiffEngine.revision(from: snapshot(final: text)))
    }

    func testMismatchedBaselinePastedRangeReturnsNil() {
        let final = before + "こんにちわ世界" + after
        XCTAssertNil(
            FinalSnapshotDiffEngine.revision(
                from: snapshot(final: final, original: "別の文字列です")
            )
        )
    }
}
