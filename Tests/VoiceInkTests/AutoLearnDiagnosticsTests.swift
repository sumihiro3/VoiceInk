import XCTest
@testable import VoiceInk

final class AutoLearnDiagnosticsTests: XCTestCase {
    private let history = String(repeating: "履歴 ", count: 50) + "Claude Code と Codex、どちらがいいですか。ロードコード"
    private let forbidden = ["どちらがいいですか", "ロードコード", "Claude Code", "Codex"]

    func testCaptureLineContainsNoDictationContent() {
        let line = AutoLearnDiagnostics.captureLine(
            bundleIdentifier: "com.evil 口述 Claude Code",
            result: "pasted-range-invalid",
            readingSource: "native-value",
            fieldText: history,
            pastedRange: NSRange(location: 120, length: 5),
            selectionAvailable: false,
            pastedText: "ロードコード"
        )
        for word in forbidden { XCTAssertFalse(line.contains(word)) }
        XCTAssertTrue(line.contains("app=unknown"))
        XCTAssertTrue(line.contains("result=pasted-range-invalid"))
        XCTAssertTrue(line.contains("source=native-value"))
        XCTAssertTrue(line.contains("fieldUTF16=\((history as NSString).length)"))
        XCTAssertTrue(line.contains("pastedLocation=120"))
        XCTAssertTrue(line.contains("pastedLength=6"))
        XCTAssertTrue(line.contains("matchedLength=5"))
        XCTAssertTrue(line.contains("selection=no"))
    }

    func testCaptureLineHandlesMissingValues() {
        let line = AutoLearnDiagnostics.captureLine(
            bundleIdentifier: "com.mitchellh.ghostty",
            result: "captured 口述",
            readingSource: nil,
            fieldText: nil,
            pastedRange: nil,
            selectionAvailable: nil,
            pastedText: ""
        )
        XCTAssertTrue(line.contains("app=com.mitchellh.ghostty"))
        XCTAssertTrue(line.contains("result=unknown"))
        XCTAssertTrue(line.contains("source=none"))
        XCTAssertTrue(line.contains("fieldUTF16=none"))
        XCTAssertTrue(line.contains("matchedLength=none"))
        XCTAssertTrue(line.contains("selection=none"))
    }

    func testFinalizeLineWithoutTerminalFields() {
        let line = AutoLearnDiagnostics.finalizeLine(
            bundleIdentifier: "com.apple.TextEdit",
            reason: .nextPaste,
            finalFieldText: history,
            revisionFound: false,
            stage: .diffEngineNil,
            terminal: nil
        )
        for word in forbidden { XCTAssertFalse(line.contains(word)) }
        XCTAssertTrue(line.contains("reason=next-paste"))
        XCTAssertTrue(line.contains("revision=none"))
        XCTAssertTrue(line.contains("stage=diff-engine-nil"))
        XCTAssertFalse(line.contains("reads="))
    }

    func testFinalizeLineWithTerminalFields() {
        let fields = AutoLearnDiagnostics.TerminalFields(
            beforeAnchorMatches: 2, afterAnchorMatches: 1, reads: 30, failedReads: 3,
            skippedReads: 4, usedTrackedRevision: true, maxReadMs: 87
        )
        let line = AutoLearnDiagnostics.finalizeLine(
            bundleIdentifier: "com.mitchellh.ghostty",
            reason: .deadline,
            finalFieldText: history,
            revisionFound: true,
            stage: .revised,
            terminal: fields
        )
        XCTAssertTrue(line.contains("reason=deadline"))
        XCTAssertTrue(line.contains("revision=found"))
        XCTAssertTrue(line.contains("beforeAnchors=2"))
        XCTAssertTrue(line.contains("afterAnchors=1"))
        XCTAssertTrue(line.contains("reads=30"))
        XCTAssertTrue(line.contains("failedReads=3"))
        XCTAssertTrue(line.contains("skippedReads=4"))
        XCTAssertTrue(line.contains("tracked=yes"))
        XCTAssertTrue(line.contains("maxReadMs=87"))
    }

    func testReasonRawValues() {
        XCTAssertEqual(AutoLearnFinalizeReason.recordingStart.rawValue, "recording-start")
        XCTAssertEqual(AutoLearnFinalizeReason.focus.rawValue, "focus")
    }
}
