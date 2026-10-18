import Foundation
import os

/// 登録済みの語彙を Whisper の初期プロンプトへ足す処理。
enum WhisperVocabularyPrompt {
    private static let logger = Logger(
        subsystem: "com.prakashjoshipax.voiceink",
        category: "WhisperVocabularyPrompt"
    )

    /// 語彙として足す部分(「、」と「。」を含む)の文字数の上限。
    static let maximumVocabularyCharacters = 120

    /// 基本のプロンプトに語彙を足したプロンプトを作る。
    /// - Parameters:
    ///   - basePrompt: 言語ごとの従来のプロンプト。
    ///   - terms: 語彙。新しく登録した順で渡す。
    /// - Returns: 足す語が0件なら basePrompt のまま。1件以上なら区切りを入れずに「語、語。」を連結した文字列。
    nonisolated static func compose(basePrompt: String, terms: [String]) -> String {
        composeWithCount(basePrompt: basePrompt, terms: terms).prompt
    }

    /// 言語に合う従来のプロンプトに、現在の語彙を足して返す。
    /// - Parameter language: 言語コード。
    nonisolated static func resolvedPrompt(for language: String?) -> String {
        let base = WhisperPrompt.resolvedPrompt(for: language)
        let result = composeWithCount(basePrompt: base, terms: WhisperVocabularySource.currentTerms())
        logger.info(
            "vocabularyTerms=\(result.count, privacy: .public) promptChars=\(result.prompt.count, privacy: .public)"
        )
        return result.prompt
    }

    private nonisolated static func composeWithCount(
        basePrompt: String,
        terms: [String]
    ) -> (prompt: String, count: Int) {
        var seen = Set<String>()
        var accepted: [String] = []
        for raw in terms {
            let term = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !term.isEmpty, seen.insert(term).inserted else { continue }
            let candidate = accepted + [term]
            if (candidate.joined(separator: "、") + "。").count > maximumVocabularyCharacters {
                break
            }
            accepted = candidate
        }
        guard !accepted.isEmpty else { return (basePrompt, 0) }
        return (basePrompt + accepted.joined(separator: "、") + "。", accepted.count)
    }
}
