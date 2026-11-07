import XCTest
@testable import VoiceInk

final class AutoLearnTerminalRevisionLocatorTests: XCTestCase {
    private typealias Fixture = AutoLearnTerminalFixture
    private let styles: [Fixture.Style] = [.plain, .framed]

    func testRepeatedFramesStillLocateRevision() {
        for style in styles {
            let fixture = Fixture(style: style)
            let outcome = AutoLearnTerminalRevisionLocator.locate(
                fixture.snapshot(final: fixture.revisedFinal)
            )
            XCTAssertEqual(outcome.stage, .located, "\(style)")
            XCTAssertEqual(outcome.revision?.original, Fixture.original)
            XCTAssertEqual(outcome.revision?.corrected, Fixture.corrected)
        }
    }

    func testBeforeAnchorWithMultipleMatchesPicksNearest() {
        for style in styles {
            let fixture = Fixture(style: style)
            let baseline = fixture.baseline as NSString
            let anchor = baseline.substring(
                with: NSRange(location: fixture.pastedRange.location - 16, length: 16)
            )
            XCTAssertGreaterThanOrEqual(fixture.baseline.components(separatedBy: anchor).count - 1, 10, "\(style)")

            let outcome = AutoLearnTerminalRevisionLocator.locate(
                fixture.snapshot(final: fixture.revisedFinal)
            )
            XCTAssertGreaterThanOrEqual(outcome.beforeAnchorMatchCount, 10, "\(style)")
            XCTAssertEqual(outcome.revision?.original, Fixture.original)
            XCTAssertEqual(outcome.revision?.corrected, Fixture.corrected)
        }
    }

    func testUpstreamEngineCannotLocateRepeatedFrames() {
        for style in styles {
            let fixture = Fixture(style: style)
            XCTAssertNil(FinalSnapshotDiffEngine.revision(from: fixture.snapshot(final: fixture.revisedFinal)))
        }
    }

    func testVeryLongHistoryIsHandledWithinSearchRadius() {
        for style in styles {
            let fixture = Fixture(style: style, leadingFiller: AutoLearnTerminalFixtures.longFiller)
            XCTAssertGreaterThan((fixture.baseline as NSString).length, 100_000)
            let revision = AutoLearnTerminalRevisionLocator.revision(
                from: fixture.snapshot(final: fixture.revisedFinal)
            )
            XCTAssertEqual(revision?.corrected, Fixture.corrected)
        }
    }

    func testSentTextDoesNotLeakReply() {
        for style in styles {
            let fixture = Fixture(style: style)
            for final in [fixture.sentFinal, fixture.sentFramedFinal] {
                let revision = AutoLearnTerminalRevisionLocator.revision(
                    from: fixture.snapshot(final: final)
                )
                if let revision {
                    XCTAssertFalse(revision.corrected.contains("⏺"), "\(style)")
                    XCTAssertFalse(revision.corrected.contains("了解しました"), "\(style)")
                }
            }
        }
    }

    func testEmptyInputIsNil() {
        for style in styles {
            let fixture = Fixture(style: style)
            let outcome = AutoLearnTerminalRevisionLocator.locate(
                fixture.snapshot(final: fixture.emptyInputFinal)
            )
            XCTAssertNil(outcome.revision)
            XCTAssertEqual(outcome.stage, .inputEmpty)
        }
    }

    func testUnchangedInputIsNil() {
        for style in styles {
            let fixture = Fixture(style: style)
            let outcome = AutoLearnTerminalRevisionLocator.locate(
                fixture.snapshot(final: fixture.unchangedFinal)
            )
            XCTAssertNil(outcome.revision)
            XCTAssertEqual(outcome.stage, .notRevised)
        }
    }

    func testInvalidBaselineStages() {
        let fixture = Fixture()
        let badRange = AutoLearnFieldSnapshot(
            baselineFieldText: fixture.baseline, finalFieldText: fixture.revisedFinal,
            pastedRange: NSRange(location: 0, length: fixture.baseline.utf16.count + 1),
            originalPastedText: Fixture.original
        )
        XCTAssertEqual(AutoLearnTerminalRevisionLocator.locate(badRange).stage, .invalidBaseline)

        let mismatch = AutoLearnFieldSnapshot(
            baselineFieldText: fixture.baseline, finalFieldText: fixture.revisedFinal,
            pastedRange: fixture.pastedRange, originalPastedText: "別の文章です。"
        )
        XCTAssertEqual(AutoLearnTerminalRevisionLocator.locate(mismatch).stage, .invalidBaseline)
    }

    func testAnchorNotFoundStages() {
        let fixture = Fixture()
        let noBefore = AutoLearnTerminalRevisionLocator.locate(fixture.snapshot(final: "まったく別の画面"))
        XCTAssertEqual(noBefore.stage, .beforeAnchorNotFound)
        XCTAssertEqual(noBefore.beforeAnchorMatchCount, 0)

        let block = fixture.baseline as NSString
        let cut = fixture.pastedRange.location
        let truncated = block.substring(to: cut) + Fixture.corrected
        let noAfter = AutoLearnTerminalRevisionLocator.locate(fixture.snapshot(final: truncated))
        XCTAssertEqual(noAfter.stage, .afterAnchorNotFound)
        XCTAssertGreaterThan(noAfter.beforeAnchorMatchCount, 0)
        XCTAssertEqual(noAfter.afterAnchorMatchCount, 0)
    }

    func testTooLongAndTooManyLineBreaks() {
        let fixture = Fixture()
        let head = (fixture.baseline as NSString).substring(to: fixture.pastedRange.location)
        let tail = (fixture.baseline as NSString).substring(from: NSMaxRange(fixture.pastedRange))

        let long = head + String(repeating: "あ", count: 400) + tail
        XCTAssertEqual(
            AutoLearnTerminalRevisionLocator.locate(fixture.snapshot(final: long)).stage, .tooLong
        )

        let broken = head + "あ\nい\nう\nえ" + tail
        XCTAssertEqual(
            AutoLearnTerminalRevisionLocator.locate(fixture.snapshot(final: broken)).stage,
            .tooManyLineBreaks
        )
    }

    func testSurrogatePairsAtAnchorEdgesAreNotSplit() {
        let before = String(repeating: "😀", count: 20)
        let after = String(repeating: "😀", count: 20)
        let baseline = before + "ロードコード" + after
        let range = NSRange(location: (before as NSString).length, length: ("ロードコード" as NSString).length)
        let snapshot = AutoLearnFieldSnapshot(
            baselineFieldText: baseline,
            finalFieldText: before + "Claude Code" + after,
            pastedRange: range, originalPastedText: "ロードコード"
        )
        let outcome = AutoLearnTerminalRevisionLocator.locate(snapshot)
        XCTAssertEqual(outcome.revision?.corrected, "Claude Code")
    }
}
