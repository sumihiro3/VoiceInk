import XCTest
@testable import VoiceInk

final class AutoLearnJapaneseSegmenterTests: XCTestCase {
    func testSplitsKatakanaParticleAndHiragana() {
        let text = "ロードコードとコーデックスどちらがいいですか。"
        XCTAssertEqual(
            AutoLearnJapaneseSegmenter.segmentTexts(in: text),
            ["ロードコード", "と", "コーデックス", "どちらがいいですか", "。"]
        )
        let segments = AutoLearnJapaneseSegmenter.segments(in: text)
        XCTAssertEqual(segments.map(\.isBoundary), [false, false, false, false, true])
    }

    func testMiddleDotKeepsKatakanaTogether() {
        XCTAssertEqual(
            AutoLearnJapaneseSegmenter.segmentTexts(in: "ナ・リーグのポスティング"),
            ["ナ・リーグ", "の", "ポスティング"]
        )
    }

    func testSplitsLatinFromJapanese() {
        XCTAssertEqual(
            AutoLearnJapaneseSegmenter.segmentTexts(in: "Claude CodeとCodexどちらがいいですか。"),
            ["Claude", "Code", "と", "Codex", "どちらがいいですか", "。"]
        )
    }

    func testCommaIsBoundaryUnit() {
        let text = "今日、明日"
        let segments = AutoLearnJapaneseSegmenter.segments(in: text)
        XCTAssertEqual(segments.map { String(text[$0.range]) }, ["今日", "、", "明日"])
        XCTAssertEqual(segments.map(\.isBoundary), [false, true, false])
    }

    func testContainsJapanese() {
        XCTAssertFalse(AutoLearnJapaneseSegmenter.containsJapanese("Pax is here, okay?"))
        XCTAssertTrue(AutoLearnJapaneseSegmenter.containsJapanese("Claude Codeを使う"))
        XCTAssertTrue(AutoLearnJapaneseSegmenter.containsJapanese("ナ・リーグ"))
    }
}
