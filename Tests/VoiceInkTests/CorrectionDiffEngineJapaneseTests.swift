import XCTest
@testable import VoiceInk

final class CorrectionDiffEngineJapaneseTests: XCTestCase {
    func testJapaneseSentenceWithoutSpacesYieldsCandidates() {
        let revision = AutoLearnRevision(
            original: "ロードコードとコーデックスどちらがいいですか。",
            corrected: "Claude CodeとCodexどちらがいいですか。"
        )
        let candidates = CorrectionDiffEngine.candidates(from: revision)

        XCTAssertGreaterThanOrEqual(candidates.count, 1)
        XCTAssertTrue(candidates.contains { $0.originalText.contains("ロードコード") })
        XCTAssertTrue(candidates.contains { $0.originalText.contains("コーデックス") })
    }

    func testLongJapaneseSentenceKeepsSnippetsWithin32Characters() {
        let revision = AutoLearnRevision(
            original: "今日はメジャーリーグの移籍の市場と、ナリーグのポスティングについて詳しく話をしました。",
            corrected: "今日はメジャーリーグの移籍市場と、ナ・リーグのポスティングについて詳しく話をしました。"
        )
        let candidates = CorrectionDiffEngine.candidates(from: revision)

        XCTAssertGreaterThanOrEqual(candidates.count, 1)
        for candidate in candidates {
            XCTAssertLessThanOrEqual(candidate.originalText.count, 32)
            XCTAssertLessThanOrEqual(candidate.correctedText.count, 32)
        }
    }
}
