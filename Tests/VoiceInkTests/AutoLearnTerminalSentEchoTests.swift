import XCTest
@testable import VoiceInk

final class AutoLearnTerminalSentEchoTests: XCTestCase {
    private typealias Fixture = AutoLearnTerminalFixture
    private let styles: [Fixture.Style] = [.plain, .framed]

    private func echo(_ fixture: Fixture, final: String) -> AutoLearnTerminalSentEcho.Result {
        AutoLearnTerminalSentEcho.locate(
            baselineFieldText: fixture.baseline,
            finalFieldText: final,
            pastedRange: fixture.pastedRange,
            originalPastedText: Fixture.original
        )
    }

    func testSentCorrectedTextIsRead() {
        for style in styles {
            let fixture = Fixture(style: style)
            for final in [fixture.sentFinal, fixture.sentFramedFinal] {
                XCTAssertEqual(
                    echo(fixture, final: final),
                    .revised(original: Fixture.original, corrected: Fixture.corrected),
                    "\(style)"
                )
            }
        }
    }

    func testSentWithoutCorrectionIsUnchanged() {
        for style in styles {
            let fixture = Fixture(style: style)
            XCTAssertEqual(echo(fixture, final: fixture.sentUncorrectedFinal), .unchanged, "\(style)")
        }
    }

    func testClearedInputHasNoEcho() {
        for style in styles {
            let fixture = Fixture(style: style)
            XCTAssertEqual(echo(fixture, final: fixture.clearedFinal), .notFound, "\(style)")
        }
    }

    func testReplyLineIsNotTakenAsEcho() {
        let fixture = Fixture()
        let head = (fixture.baseline as NSString).substring(to: fixture.pastedRange.location - 2)
        let final = head + "⏺ まったく関係のない応答の文章です。\n"
        XCTAssertEqual(echo(fixture, final: final), .notFound)
    }

    func testBlankLineBeforeEchoIsSkipped() {
        let fixture = Fixture()
        let rule = String(repeating: "─", count: 40)
        let final = fixture.history + "\n> \(Fixture.corrected)\n\n⏺ 応答\n\n\(rule)\n> \n\(rule)\n"
        XCTAssertEqual(
            echo(fixture, final: final),
            .revised(original: Fixture.original, corrected: Fixture.corrected)
        )
    }

    func testRealCaseFromDeviceRun4() {
        let original = "Protopediaビデオメーカーを作りました。"
        let rule = String(repeating: "─", count: 80)
        let history = "> 前の質問です\n\n⏺ 前の応答です。\n\n"
        let baseline = history + "\(rule)\n> \(original)\n\(rule)\n  ? for shortcuts\n"
        let range = (baseline as NSString).range(of: original)
        let final = history + "> ProtoPedia Video Makerを作りました。\n\n⏺ いいですね。\n\n\(rule)\n> \n\(rule)\n"
        let result = AutoLearnTerminalSentEcho.locate(
            baselineFieldText: baseline, finalFieldText: final,
            pastedRange: range, originalPastedText: original
        )
        XCTAssertEqual(
            result,
            .revised(original: original, corrected: "ProtoPedia Video Makerを作りました。")
        )
    }
}
