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

    /// 実機の10回目: Enter のあと Claude Code が履歴を消して描き直し、先頭からの一致が無くなった。
    func testEchoIsFoundAfterScreenRedraw() {
        for style in styles {
            let filler = String(repeating: "古い出力の行です。\n", count: 200)
            let before = Fixture(style: style, leadingFiller: filler)
            let redrawn = Fixture(style: style)
            for final in [redrawn.sentFinal, redrawn.sentFramedFinal] {
                let probe = AutoLearnTerminalSentEcho.probe(
                    baselineFieldText: before.baseline, finalFieldText: final,
                    pastedRange: before.pastedRange, originalPastedText: Fixture.original
                )
                XCTAssertEqual(
                    probe.result,
                    .revised(original: Fixture.original, corrected: Fixture.corrected),
                    "\(style)"
                )
                XCTAssertEqual(probe.method, .promptLine, "\(style)")
                XCTAssertEqual(probe.commonPrefixUTF16, 0, "\(style)")
            }
        }
    }

    /// 画面の大きさが一定(見えている画面だけを読む)で、Enter で送ると上の行が画面の外へ出て、画面の文字が
    /// 貼り付けた長さほど減る。減り方では消したときと見分けられないが、送った文の行は新しい行なので見つける。
    func testEchoIsFoundOnFixedSizeScreen() {
        for style in styles {
            let fixture = Fixture(style: style)
            let history = fixture.history as NSString
            let tail = (fixture.sentFinal as NSString).substring(from: history.length)
            let baselineLength = (fixture.baseline as NSString).length
            let target = baselineLength - fixture.pastedRange.length
            let dropped = history.length + (tail as NSString).length - target
            XCTAssertGreaterThan(dropped, 0, "\(style)")
            let final = history.substring(from: dropped) + tail
            XCTAssertEqual(baselineLength - (final as NSString).length, fixture.pastedRange.length, "\(style)")

            let probe = AutoLearnTerminalSentEcho.probe(
                baselineFieldText: fixture.baseline, finalFieldText: final,
                pastedRange: fixture.pastedRange, originalPastedText: Fixture.original
            )
            XCTAssertEqual(
                probe.result,
                .revised(original: Fixture.original, corrected: Fixture.corrected),
                "\(style)"
            )
            XCTAssertEqual(probe.method, .promptLine, "\(style)")
            XCTAssertEqual(probe.promptLineWasOld, false, "\(style)")
        }
    }

    /// 応答が元の文を引用しても、プロンプトの記号で始まらない行は送った文とみなさない。
    func testQuotedReplyIsNotTakenAsEcho() {
        let filler = String(repeating: "古い出力の行です。\n", count: 200)
        let before = Fixture(leadingFiller: filler)
        let redrawn = Fixture()
        let rule = String(repeating: "─", count: 40)
        let final = redrawn.history + "> \(Fixture.corrected)\n\n⏺ 「\(Fixture.original)」ですね。\n\n"
            + "\(rule)\n> \n\(rule)\n"
        XCTAssertEqual(
            AutoLearnTerminalSentEcho.locate(
                baselineFieldText: before.baseline, finalFieldText: final,
                pastedRange: before.pastedRange, originalPastedText: Fixture.original
            ),
            .revised(original: Fixture.original, corrected: Fixture.corrected)
        )
    }

    /// いちばん新しい送った行が見分けられなければ、それより前の同じ文の行には進まない。
    func testOlderIdenticalLineIsNotUsedWhenLatestIsUnrecognized() {
        let filler = String(repeating: "古い出力の行です。\n", count: 200)
        let before = Fixture(leadingFiller: filler)
        let rule = String(repeating: "─", count: 40)
        let final = "> \(Fixture.original)\n\n⏺ 前の応答です。\n\n> [Pasted text #1]\n\n⏺ 応答です。\n\n"
            + "\(rule)\n> \n\(rule)\n"
        XCTAssertEqual(
            AutoLearnTerminalSentEcho.locate(
                baselineFieldText: before.baseline, finalFieldText: final,
                pastedRange: before.pastedRange, originalPastedText: Fixture.original
            ),
            .notFound
        )
    }

    /// 描き直されていなければ、入力欄に入力例の文が出ていても、先頭から比べる探し方で見つける。
    func testPlaceholderInInputFallsBackToCommonPrefix() {
        let fixture = Fixture()
        let rule = String(repeating: "─", count: 40)
        let final = fixture.history + "> \(Fixture.corrected)\n\n⏺ 了解しました。確認します。\n\n"
            + "\(rule)\n> Try \"refactor this function\"\n\(rule)\n  ? for shortcuts\n"
        let probe = AutoLearnTerminalSentEcho.probe(
            baselineFieldText: fixture.baseline, finalFieldText: final,
            pastedRange: fixture.pastedRange, originalPastedText: Fixture.original
        )
        XCTAssertEqual(probe.result, .revised(original: Fixture.original, corrected: Fixture.corrected))
        XCTAssertEqual(probe.method, .commonPrefix)
        XCTAssertEqual(probe.promptLineWasOld, false)
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

    func testProbeReportsCommonPrefixAndEchoLine() {
        let fixture = AutoLearnTerminalFixture()
        let final = fixture.sentFinal
        let probe = AutoLearnTerminalSentEcho.probe(
            baselineFieldText: fixture.baseline, finalFieldText: final,
            pastedRange: fixture.pastedRange, originalPastedText: Fixture.original
        )
        XCTAssertEqual(probe.result, .revised(original: Fixture.original, corrected: Fixture.corrected))
        XCTAssertEqual(probe.commonPrefixUTF16, (fixture.history as NSString).length)
        XCTAssertEqual(probe.echoLineLocation, (fixture.history as NSString).length)
        XCTAssertEqual(probe.echoLineUTF16, ("> \(Fixture.corrected)" as NSString).length)
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
