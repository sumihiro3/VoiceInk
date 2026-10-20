import Foundation
@testable import VoiceInk

/// Fake Claude Code terminal screens: repeated history, then an input frame.
struct AutoLearnTerminalFixture {
    enum Style { case plain, framed }

    static let original = "ロードコードとコーデックスどちらがいいですか。"
    static let corrected = "Claude Codeとコーデックスどちらがいいですか。"

    let style: Style
    let historyCount: Int
    let leadingFiller: String

    init(style: Style = .plain, historyCount: Int = 12, leadingFiller: String = "") {
        self.style = style
        self.historyCount = historyCount
        self.leadingFiller = leadingFiller
    }

    /// Each past prompt keeps its input frame, so the anchors around the paste repeat in the history.
    var history: String {
        leadingFiller + (0..<historyCount).map { index in
            let block = inputBlock("送った文\(index)です")
            return block.prefix + block.text + block.suffix + "\n⏺ 応答\(index)です。\n\n"
        }.joined()
    }

    private static let rule = String(repeating: "─", count: 40)

    private func inputBlock(_ text: String) -> (prefix: String, text: String, suffix: String) {
        switch style {
        case .plain:
            return ("\(Self.rule)\n> ", text, "\n\(Self.rule)\n  ? for shortcuts\n")
        case .framed:
            let pad = String(repeating: " ", count: max(1, 60 - (text as NSString).length))
            return (
                "╭\(Self.rule)╮\n│ > ", text,
                "\(pad)│\n╰\(Self.rule)╯\n  ? for shortcuts\n"
            )
        }
    }

    private func screen(_ text: String) -> (String, NSRange) {
        let block = inputBlock(text)
        let head = history + block.prefix
        let range = NSRange(location: (head as NSString).length, length: (text as NSString).length)
        return (head + block.text + block.suffix, range)
    }

    var baseline: String { screen(Self.original).0 }
    var pastedRange: NSRange { screen(Self.original).1 }

    func snapshot(final: String) -> AutoLearnFieldSnapshot {
        AutoLearnFieldSnapshot(
            baselineFieldText: baseline, finalFieldText: final,
            pastedRange: pastedRange, originalPastedText: Self.original
        )
    }

    var revisedFinal: String { screen(Self.corrected).0 }
    var unchangedFinal: String { baseline }
    var emptyInputFinal: String { screen("").0 }

    /// The corrected text was sent with Enter: it stays as plain history, followed by a reply and a new empty frame.
    var sentFinal: String {
        let block = inputBlock("")
        return history + "> \(Self.corrected)\n\n⏺ 了解しました。確認します。\n\n"
            + block.prefix + block.suffix
    }

    /// The original text was sent with Enter without any correction.
    var sentUncorrectedFinal: String {
        let block = inputBlock("")
        return history + "> \(Self.original)\n\n⏺ 了解しました。確認します。\n\n"
            + block.prefix + block.suffix
    }

    /// The input was cleared (for example with Esc) without sending: no echo, only an empty frame.
    var clearedFinal: String { emptyInputFinal }

    /// A mid-edit state: the first word is half typed.
    static let midEdit = "Claudeとコーデックスどちらがいいですか。"
    var midEditFinal: String { screen(Self.midEdit).0 }

    /// Same as `sentFinal`, but the sent text keeps its input frame where the input was.
    var sentFramedFinal: String {
        let sent = inputBlock(Self.corrected)
        let empty = inputBlock("")
        return history + sent.prefix + sent.text + sent.suffix
            + "\n⏺ 了解しました。確認します。\n\n" + empty.prefix + empty.suffix
    }
}

enum AutoLearnTerminalFixtures {
    /// More than 100,000 UTF-16 units of older output before the history.
    static let longFiller = String(repeating: "古い出力の行です。\n", count: 11_000)
}
