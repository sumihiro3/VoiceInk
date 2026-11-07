import XCTest
@testable import VoiceInk

final class AutoLearnTerminalTargetTests: XCTestCase {
    func testSingleMatch() {
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc", in: "xxabcyy")
        XCTAssertEqual(range, NSRange(location: 2, length: 3))
    }

    func testMultipleMatchesPicksLast() {
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc", in: "abc-abc-abc-z")
        XCTAssertEqual(range, NSRange(location: 8, length: 3))
    }

    func testNoMatch() {
        XCTAssertNil(AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc", in: "xyz"))
        XCTAssertNil(AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "", in: "xyz"))
        XCTAssertNil(AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc", in: "ab"))
    }

    func testOverlappingMatchesPicksLast() {
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "aa", in: "aaaa")
        XCTAssertEqual(range, NSRange(location: 2, length: 2))
        let overlap = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "aba", in: "ababa")
        XCTAssertEqual(overlap, NSRange(location: 2, length: 3))
    }

    func testUTF16OffsetsWithEmoji() {
        let history = "👨‍👩‍👧 履歴🎉\n> こんにちは"
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "こんにちは", in: history)
        let expected = (history as NSString).range(of: "こんにちは")
        XCTAssertEqual(range, expected)
        XCTAssertGreaterThan(range?.location ?? 0, history.count - 5)
    }

    func testTrailingSpaceDroppedByScreenStillMatches() {
        let screen = "> 前の文\n> ロードコードとコーデックスどちらがいいですか。\n────\n"
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(
            of: "ロードコードとコーデックスどちらがいいですか。 ", in: screen
        )
        XCTAssertEqual(range, (screen as NSString).range(of: "ロードコードとコーデックスどちらがいいですか。"))
    }

    func testLaterTrimmedMatchWinsOverEarlierExactMatchInHistory() {
        let screen = "> 送った文。 \n\n⏺ 応答\n────\n> 送った文。\n────\n"
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "送った文。 ", in: screen)
        XCTAssertEqual(range, (screen as NSString).range(of: "送った文。", options: .backwards))
    }

    func testExactMatchIsUsedAtTheSamePosition() {
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc ", in: "x abc ")
        XCTAssertEqual(range, NSRange(location: 2, length: 4))
    }

    func testLaterExactMatchWinsOverEarlierTrimmedMatch() {
        let range = AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: "abc ", in: "abc\nx abc y")
        XCTAssertEqual(range, NSRange(location: 6, length: 4))
    }

    func testWhitespaceOnlyPasteDoesNotMatch() {
        XCTAssertNil(AutoLearnTerminalTarget.pastedRangeNearestToEnd(of: " \n", in: "abc"))
    }

    func testIsGhostty() {
        XCTAssertTrue(AutoLearnTerminalTarget.isGhostty(bundleIdentifier: "com.mitchellh.ghostty"))
        XCTAssertFalse(AutoLearnTerminalTarget.isGhostty(bundleIdentifier: "com.apple.Terminal"))
        XCTAssertFalse(AutoLearnTerminalTarget.isGhostty(bundleIdentifier: nil))
    }

    func testReadOptions() {
        XCTAssertEqual(AutoLearnAXTextReadOptions.standard.maximumFieldUTF16Length, AutoLearnLimits.maximumFieldUTF16Length)
        XCTAssertFalse(AutoLearnAXTextReadOptions.standard.skipsStringForRange)
        XCTAssertEqual(AutoLearnAXTextReadOptions.ghostty.maximumFieldUTF16Length, 1_500_000)
        XCTAssertTrue(AutoLearnAXTextReadOptions.ghostty.skipsStringForRange)
    }
}
