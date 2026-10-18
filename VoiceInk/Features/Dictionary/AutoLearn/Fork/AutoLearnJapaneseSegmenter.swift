import Foundation

/// 日本語対応の区切りで得た1単位。`CorrectionDiffEngine` の `TextSegment` に写して使う。
struct AutoLearnJapaneseSegment: Equatable {
    /// 元の文字列の中での範囲。
    let range: Range<String.Index>
    /// 区切り記号そのものの単位なら true。文脈の範囲がここで止まる。
    let isBoundary: Bool
}

/// 空白のない日本語の文を、文字の種類の変わり目と記号で区切る。
///
/// 本家の `CorrectionDiffEngine.segments(in:)` は空白と記号でしか区切らないため、
/// 日本語の文全体が1語になってしまう。ここでは文字の種類(漢字・ひらがな・カタカナ・英数字)が
/// 変わる位置でも区切る。種類はコード範囲で決め、Unicode の script 属性は使わない。
enum AutoLearnJapaneseSegmenter {
    private enum Kind {
        case kanji, hiragana, katakana, alphanumeric, other
    }

    /// `CorrectionDiffEngine.structuralSeparators` と同じ文字。本家側が private のため複製している。
    private static let structuralSeparators: Set<Character> = [
        ",", "!", "?", ";", ":", "…", "(", ")", "[", "]", "{", "}", "\"", "“", "”",
    ]

    /// 日本語の文で区切りになる記号。
    private static let japaneseSeparators: Set<Character> = [
        "、", "。", "！", "？", "「", "」", "『", "』", "（", "）",
        "：", "；", "，", "．",
    ]

    /// ひらがな・カタカナ・漢字のいずれかを含むかを返す。
    /// - Parameter text: 判定する文字列。
    static func containsJapanese(_ text: String) -> Bool {
        text.unicodeScalars.contains { kind(of: $0) == .kanji || kind(of: $0) == .hiragana || kind(of: $0) == .katakana }
    }

    /// 文字列を単位に区切る。空白は単位に含めず、区切り記号は1文字で `isBoundary == true` の単位になる。
    /// - Parameter text: 区切る文字列。
    static func segments(in text: String) -> [AutoLearnJapaneseSegment] {
        var results: [AutoLearnJapaneseSegment] = []
        var start: String.Index?
        var currentKind: Kind?
        var index = text.startIndex

        func flush(upTo end: String.Index) {
            if let s = start {
                results.append(AutoLearnJapaneseSegment(range: s..<end, isBoundary: false))
            }
            start = nil
            currentKind = nil
        }

        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)

            if character.isWhitespace {
                flush(upTo: index)
            } else if isSeparator(at: index, in: text) {
                flush(upTo: index)
                results.append(AutoLearnJapaneseSegment(range: index..<next, isBoundary: true))
            } else {
                let scalar = character.unicodeScalars.first!
                let inherits = scalar == "\u{30FB}" || scalar == "\u{30FC}" || isApostrophe(character)
                if inherits {
                    if start == nil {
                        start = index
                        currentKind = scalar == "\u{30FC}" || scalar == "\u{30FB}" ? .katakana : .other
                    }
                } else {
                    let kind = kind(of: scalar)
                    if let current = currentKind, current != kind { flush(upTo: index) }
                    if start == nil { start = index }
                    currentKind = kind
                }
            }
            index = next
        }
        flush(upTo: text.endIndex)
        return results
    }

    /// テスト用。区切った単位を文字列で返す(区切り記号も含む)。
    static func segmentTexts(in text: String) -> [String] {
        segments(in: text).map { String(text[$0.range]) }
    }

    private static func isApostrophe(_ character: Character) -> Bool {
        character == "'" || character == "’" || character == "‘"
    }

    private static func isSeparator(at index: String.Index, in text: String) -> Bool {
        let character = text[index]
        if structuralSeparators.contains(character) || japaneseSeparators.contains(character) {
            return true
        }
        let next = text.index(after: index)
        if character == "." {
            return next == text.endIndex || text[next].isWhitespace
        }
        if isApostrophe(character) {
            guard index > text.startIndex, next < text.endIndex else { return true }
            return text[text.index(before: index)].isWhitespace || text[next].isWhitespace
        }
        return false
    }

    private static func kind(of scalar: Unicode.Scalar) -> Kind {
        switch scalar.value {
        case 0x3040...0x309F: return .hiragana
        case 0x30A0...0x30FF, 0x31F0...0x31FF, 0xFF66...0xFF9F: return .katakana
        case 0x3400...0x4DBF, 0x4E00...0x9FFF, 0x20000...0x2FA1F, 0x3005: return .kanji
        default:
            let props = scalar.properties
            if props.isAlphabetic || props.numericType != nil { return .alphanumeric }
            return .other
        }
    }
}
