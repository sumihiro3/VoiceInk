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

    /// 送った文の行の探し方(ログ用)。
    enum Method: String, Sendable {
        /// 画面の最後から上へ、いちばん新しいプロンプトの行を探した。
        case promptLine = "prompt-line"
        /// 貼り付けたときの画面と先頭から比べ、最初に違う行を使った。
        case commonPrefix = "common-prefix"
    }

    /// 送った文の行を調べた結果と、ログ用の位置・長さ(UTF-16)。口述の中身は持たない。
    struct Probe: Equatable, Sendable {
        let result: Result
        /// 貼り付けたときの画面と送ったあとの画面で、先頭から一致した長さ。
        let commonPrefixUTF16: Int
        /// 送った文とみなした行の先頭の位置。行を選ぶ前に止まったときは nil。
        let echoLineLocation: Int?
        /// 送った文とみなした行の長さ(プロンプトの記号を外す前)。
        let echoLineUTF16: Int?
        var method: Method?
        /// いちばん新しいプロンプトの行が、貼り付けたときにすでにあった行だったか(送らずに消した)。
        /// プロンプトの行を調べなかったときは nil。
        var promptLineWasOld: Bool?
    }

    /// プロンプトの行とみなす、行頭(空白と枠の記号を除いたあと)の記号。
    static let promptMarkers: Set<Character> = [">", "❯", "›", "»"]
    /// 画面の最後から上へプロンプトの行を探すときの、行の数の上限。
    static let maximumPromptSearchLines = 2_000

    /// 送った文の行を探し、元の文と比べる。
    static func locate(
        baselineFieldText: String,
        finalFieldText: String,
        pastedRange: NSRange,
        originalPastedText: String
    ) -> Result {
        probe(
            baselineFieldText: baselineFieldText, finalFieldText: finalFieldText,
            pastedRange: pastedRange, originalPastedText: originalPastedText
        ).result
    }

    /// `locate` と同じ判定をし、ログ用の位置と長さも返す。
    ///
    /// 1. 画面の最後から上へ、空でないいちばん新しいプロンプトの行を探す。Claude Code は送った文を
    ///    `> ` で始まる行として履歴に残し、新しい入力欄は空になる。描き直されても(実機の10回目)、
    ///    画面の大きさが一定でも(実機の12回目)、位置や長さに依存しない。
    ///    - その行が、貼り付けたときに貼り付けた行より前にすでにあった行なら、前に送った文なので、
    ///      送らずに入力欄を消したとみなす(`promptLineWasOld`)。
    ///    - 新しい行なら、送った文の行とみなす。見分けられなくても、それより前の行には進まない。
    /// 2. プロンプトの行が無いとき、または描き直されていないのにプロンプトの行で決まらないとき
    ///    (入力欄に入力例の文が出ているなど)は、貼り付けたときの画面と先頭から比べ、最初に違う行を使う。
    static func probe(
        baselineFieldText: String,
        finalFieldText: String,
        pastedRange: NSRange,
        originalPastedText: String
    ) -> Probe {
        let baseline = Array(baselineFieldText.utf16)
        let final = Array(finalFieldText.utf16)
        let limit = min(baseline.count, final.count, NSMaxRange(pastedRange))
        var common = 0
        while common < limit, baseline[common] == final[common] { common += 1 }

        let finalText = finalFieldText as NSString
        let shrink = baseline.count - final.count
        let slack = pastedRange.length + AutoLearnTerminalRevisionLocator.correctedLengthSlackUTF16
        let redrawn = shrink > slack
        // 新しいプロンプトの行を見たなら、先頭から比べる探し方に戻っても「消した」とはしない。
        var sawNewPromptLine = false
        if let lineRange = latestPromptLine(in: finalText) {
            if isLine(lineRange, of: finalText, inBaseline: baselineFieldText, before: pastedRange.location) {
                return Probe(
                    result: .notFound, commonPrefixUTF16: common, echoLineLocation: lineRange.location,
                    echoLineUTF16: (finalText.substring(with: lineRange)
                        .trimmingCharacters(in: .newlines) as NSString).length,
                    method: .promptLine, promptLineWasOld: true
                )
            }
            var probe = judge(
                lineRange: lineRange, in: finalText, common: common, originalPastedText: originalPastedText
            )
            probe.method = .promptLine
            probe.promptLineWasOld = false
            sawNewPromptLine = true
            // 入力欄に入力例の文が出ていると、いちばん新しいプロンプトの行がそれになる。描き直されて
            // いなければ、先頭から比べる探し方に戻す。描き直されていれば、先頭からの比較は意味が無い。
            if probe.result != .notFound || redrawn { return probe }
        } else if redrawn {
            return Probe(
                result: .notFound, commonPrefixUTF16: common, echoLineLocation: nil, echoLineUTF16: nil,
                method: .promptLine
            )
        }

        let wasOld: Bool? = sawNewPromptLine ? false : nil
        guard common + AutoLearnTerminalRevisionLocator.searchRadiusUTF16 >= pastedRange.location else {
            return Probe(
                result: .notFound, commonPrefixUTF16: common, echoLineLocation: nil, echoLineUTF16: nil,
                method: .commonPrefix, promptLineWasOld: wasOld
            )
        }

        var lineRange = finalText.lineRange(for: NSRange(location: min(common, finalText.length), length: 0))
        // 入力欄の枠が消えた位置に空行が入ることがあるので、空行は最大2行まで読み飛ばす。
        var skippedBlankLines = 0
        while strippedPrompt(finalText.substring(with: lineRange)).trimmingCharacters(in: .whitespaces).isEmpty,
            skippedBlankLines < 2, NSMaxRange(lineRange) < finalText.length
        {
            skippedBlankLines += 1
            lineRange = finalText.lineRange(for: NSRange(location: NSMaxRange(lineRange), length: 0))
        }
        var probe = judge(
            lineRange: lineRange, in: finalText, common: common, originalPastedText: originalPastedText
        )
        probe.method = .commonPrefix
        probe.promptLineWasOld = wasOld
        return probe
    }

    /// 選んだ行を送った文とみなせるか、元の文と比べて決める。
    private static func judge(
        lineRange: NSRange, in finalText: NSString, common: Int, originalPastedText: String
    ) -> Probe {
        let line = finalText.substring(with: lineRange)
        let lineLength = (line.trimmingCharacters(in: .newlines) as NSString).length
        func finish(_ result: Result) -> Probe {
            Probe(
                result: result, commonPrefixUTF16: common,
                echoLineLocation: lineRange.location, echoLineUTF16: lineLength
            )
        }

        let original = AutoLearnTextNormalizer.accessibilityComparable(originalPastedText)
        let corrected = AutoLearnTextNormalizer.accessibilityComparable(strippedPrompt(line))
        guard !original.isEmpty, !corrected.isEmpty else { return finish(.notFound) }

        let originalLength = (original as NSString).length
        let correctedLength = (corrected as NSString).length
        guard correctedLength <= originalLength * AutoLearnTerminalRevisionLocator.correctedLengthMultiplier
            + AutoLearnTerminalRevisionLocator.correctedLengthSlackUTF16
        else { return finish(.notFound) }

        guard sharedEdgeCharacters(original, corrected)
            >= minimumSharedCharacters(originalLength: original.count)
        else { return finish(.notFound) }

        if original == corrected { return finish(.unchanged) }
        return finish(.revised(original: original, corrected: corrected))
    }

    /// `lineRange` の行が、貼り付けたときの画面の、貼り付けた行より前に同じ行としてあったか。
    private static func isLine(
        _ lineRange: NSRange, of finalText: NSString, inBaseline baselineFieldText: String, before location: Int
    ) -> Bool {
        let baseline = baselineFieldText as NSString
        let pasteLineStart = baseline.lineRange(for: NSRange(location: min(location, baseline.length), length: 0)).location
        let line = finalText.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, pasteLineStart > 0 else { return false }
        let earlier = baseline.substring(to: pasteLineStart)
        return earlier.split(separator: "\n", omittingEmptySubsequences: true).contains {
            $0.trimmingCharacters(in: .whitespacesAndNewlines) == line
        }
    }

    /// 画面の最後から上へ、本文が空でないいちばん新しいプロンプトの行を探す。空の入力欄は読み飛ばす。
    private static func latestPromptLine(in text: NSString) -> NSRange? {
        var end = text.length
        var visited = 0
        while end > 0, visited < maximumPromptSearchLines {
            let range = text.lineRange(for: NSRange(location: end - 1, length: 0))
            visited += 1
            let line = text.substring(with: range)
            let head = line.drop { [" ", "\t", "\u{00A0}", "│", "|"].contains($0) }
            if let marker = head.first, promptMarkers.contains(marker) {
                if !strippedPrompt(line).trimmingCharacters(in: .whitespaces).isEmpty { return range }
            }
            end = range.location
        }
        return nil
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
