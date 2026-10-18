import XCTest
@testable import VoiceInk

/// 本家のコードだけで通る回帰テスト。テスト基盤（make test）の確認を、フォーク側の新しいコードと切り離すために置く。
final class CorrectionDiffEngineUpstreamTests: XCTestCase {
    func testEnglishPaxCorrectionYieldsSingleCandidate() {
        let revision = AutoLearnRevision(
            original: "Please email Prakash Joshi Pages today.",
            corrected: "Please email Prakash Joshi Pax today."
        )

        let candidates = CorrectionDiffEngine.candidates(from: revision)

        XCTAssertEqual(
            candidates,
            [
                DetectedCorrectionCandidate(
                    originalText: "email Prakash Joshi Pages today",
                    correctedText: "email Prakash Joshi Pax today"
                )
            ]
        )
    }
}
