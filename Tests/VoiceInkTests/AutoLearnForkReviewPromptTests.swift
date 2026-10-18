import XCTest
@testable import VoiceInk

final class AutoLearnForkReviewPromptTests: XCTestCase {
    func testContainsOutputFieldNames() {
        for name in ["candidateID", "learningAction", "incorrectTextToReplace", "correctedVocabularyTerm"] {
            XCTAssertTrue(AutoLearnForkReviewPrompt.text.contains(name), name)
        }
    }

    func testContainsAllLearningActions() {
        for name in ["addReplacementAndVocabulary", "addReplacementOnly", "addVocabularyOnly", "rejectCorrection"] {
            XCTAssertTrue(AutoLearnForkReviewPrompt.text.contains(name), name)
        }
    }

    func testContainsRegistrationExamples() {
        for example in ["コーデックス", "Codex", "ロードコード", "Claude Code", "ナ・リーグ"] {
            XCTAssertTrue(AutoLearnForkReviewPrompt.text.contains(example), example)
        }
    }

    func testContainsRejectionExample() {
        XCTAssertTrue(AutoLearnForkReviewPrompt.text.contains("話しました"))
    }
}
