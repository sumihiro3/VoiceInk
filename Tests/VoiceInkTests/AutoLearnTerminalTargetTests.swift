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
