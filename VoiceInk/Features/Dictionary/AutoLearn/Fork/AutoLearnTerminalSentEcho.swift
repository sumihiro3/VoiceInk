import Foundation

/// Enter で送ったあとの Ghostty の画面から、送った文の行を取り出して直しを決める。
///
/// Claude Code は Enter で送ると入力欄を空にし、送った文を履歴に残す。1秒ごとの読み取りは
/// Enter の直前の直しに間に合わないことがあるので(実機の2回目・4回目)、送ったあとの画面に
/// 残った文を正とする。行頭の記号の形には依存しない。
enum AutoLearnTerminalSentEcho {
    enum Result: Equatable, Sendable {
        /// 送った文が元の文と違う。
        case revised(original: String, corrected: String)
        /// 送った文が元の文と同じ(直さずに送った)。
        case unchanged
        /// 送った文の行が見つからない、または元の文と似ていない。
        case notFound
    }

    /// 送った文の行の先頭から外す記号(プロンプトや枠)。
    static let promptPrefixCharacters: Set<Character> = [" ", "\t", "\u{00A0}", ">", "❯", "›", "»", "│", "|"]

    /// 元の文と送った文で、先頭と末尾の一致した文字数の合計がこれ未満なら、別の行とみなす。
    /// 元の文の長さの4分の1と2の大きいほう。
    static func minimumSharedCharacters(originalLength: Int) -> Int {
        max(2, originalLength / 4)
    }

    /// 貼り付けたときの画面と送ったあとの画面を先頭から比べ、最初に違う行を送った文の行とみなす。
    static func locate(
        baselineFieldText: String,
        finalFieldText: String,
        pastedRange: NSRange,
        originalPastedText: String
    ) -> Result {
        let baseline = Array(baselineFieldText.utf16)
        let final = Array(finalFieldText.utf16)
        let limit = min(baseline.count, final.count, NSMaxRange(pastedRange))
        var common = 0
        while common < limit, baseline[common] == final[common] { common += 1 }
        guard common + AutoLearnTerminalRevisionLocator.searchRadiusUTF16 >= pastedRange.location else {
            return .notFound
        }

        let finalText = finalFieldText as NSString
        var lineRange = finalText.lineRange(for: NSRange(location: min(common, finalText.length), length: 0))
        var echo = strippedPrompt(finalText.substring(with: lineRange))
        // 入力欄の枠が消えた位置に空行が入ることがあるので、空行は最大2行まで読み飛ばす。
        var skippedBlankLines = 0
        while echo.trimmingCharacters(in: .whitespaces).isEmpty, skippedBlankLines < 2,
            NSMaxRange(lineRange) < finalText.length
        {
            skippedBlankLines += 1
            lineRange = finalText.lineRange(for: NSRange(location: NSMaxRange(lineRange), length: 0))
            echo = strippedPrompt(finalText.substring(with: lineRange))
        }

        let original = AutoLearnTextNormalizer.accessibilityComparable(originalPastedText)
        let corrected = AutoLearnTextNormalizer.accessibilityComparable(echo)
        guard !original.isEmpty, !corrected.isEmpty else { return .notFound }

        let originalLength = (original as NSString).length
        let correctedLength = (corrected as NSString).length
        guard correctedLength <= originalLength * AutoLearnTerminalRevisionLocator.correctedLengthMultiplier
            + AutoLearnTerminalRevisionLocator.correctedLengthSlackUTF16
        else { return .notFound }

        guard sharedEdgeCharacters(original, corrected)
            >= minimumSharedCharacters(originalLength: original.count)
        else { return .notFound }

        if original == corrected { return .unchanged }
        return .revised(original: original, corrected: corrected)
    }

    private static func strippedPrompt(_ line: String) -> String {
        let withoutBreak = line.trimmingCharacters(in: .newlines)
        let body = withoutBreak.drop { promptPrefixCharacters.contains($0) }
        var text = String(body)
        while let last = text.last, promptPrefixCharacters.contains(last) { text.removeLast() }
        return text
    }

    /// 先頭から一致した文字数と、末尾から一致した文字数の合計(重ならない範囲で)。
    private static func sharedEdgeCharacters(_ lhs: String, _ rhs: String) -> Int {
        let a = Array(lhs)
        let b = Array(rhs)
        let maximum = min(a.count, b.count)
        var prefix = 0
        while prefix < maximum, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < maximum - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        return prefix + suffix
    }
}
