import XCTest
@testable import VoiceInk

final class WhisperVocabularyPromptTests: XCTestCase {
    private let base = "こんにちは、お元気ですか？お会いできて嬉しいです。"

    func testEmptyTermsReturnsBasePromptUnchanged() {
        XCTAssertEqual(WhisperVocabularyPrompt.compose(basePrompt: base, terms: []), base)
        XCTAssertEqual(WhisperVocabularyPrompt.compose(basePrompt: base, terms: [" ", ""]), base)
    }

    func testComposesTermsNewestFirst() {
        let result = WhisperVocabularyPrompt.compose(basePrompt: base, terms: ["Claude Code", "Codex"])
        XCTAssertEqual(result, base + "Claude Code、Codex。")
    }

    func testDuplicatesAppearOnce() {
        let result = WhisperVocabularyPrompt.compose(basePrompt: base, terms: ["Codex", " Codex ", "Claude Code", "Codex"])
        XCTAssertEqual(result, base + "Codex、Claude Code。")
    }

    func testOldTermsDroppedWhenOver120Characters() {
        let terms = (0..<30).map { i in String(repeating: "あ", count: 9) + String(i % 10) }
        let result = WhisperVocabularyPrompt.compose(basePrompt: "", terms: terms)
        XCTAssertLessThanOrEqual(result.count, WhisperVocabularyPrompt.maximumVocabularyCharacters)
        XCTAssertTrue(result.hasPrefix(terms[0]))
        XCTAssertFalse(result.contains(terms[29]))
        // 10文字の語が10語+「、」9個+「。」=110。11語目で121となり入らない
        XCTAssertEqual(result.count, 110)
    }
}
