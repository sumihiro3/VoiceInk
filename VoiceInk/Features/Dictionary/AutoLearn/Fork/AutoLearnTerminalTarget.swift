import AppKit
import Foundation

/// 貼り付け先が Ghostty かどうかの判定。
enum AutoLearnTerminalTarget {
    static let ghosttyBundleIdentifier = "com.mitchellh.ghostty"

    /// bundle id が Ghostty のものなら true。
    static func isGhostty(bundleIdentifier: String?) -> Bool {
        bundleIdentifier == ghosttyBundleIdentifier
    }

    /// プロセス ID から bundle id を引く。終了済みなどで引けなければ nil。
    static func bundleIdentifier(processID: pid_t) -> String? {
        NSRunningApplication(processIdentifier: processID)?.bundleIdentifier
    }

    /// 貼り付けた文字列が入力欄の末尾にいちばん近い位置を、UTF-16 の範囲で返す。
    ///
    /// 選択範囲は使わない。Ghostty の選択範囲は端末で選択している範囲で、カーソルの位置ではないため。
    /// 重なる一致も数える。完全一致が無ければ、前後の空白と改行を除いた文字列で探す
    /// (VoiceInk は末尾に空白を足して貼り付けるが、Claude Code の画面には行末の空白が残らないため)。
    /// どちらも無ければ nil。
    static func pastedRangeNearestToEnd(of pastedText: String, in fieldText: String) -> NSRange? {
        if let exact = lastRange(of: pastedText, in: fieldText) { return exact }
        let core = pastedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard core != pastedText else { return nil }
        return lastRange(of: core, in: fieldText)
    }

    private static func lastRange(of value: String, in fieldText: String) -> NSRange? {
        let target = value as NSString
        guard target.length > 0 else { return nil }
        let field = fieldText as NSString
        guard field.length >= target.length else { return nil }
        let found = field.range(
            of: value,
            options: [.literal, .backwards],
            range: NSRange(location: 0, length: field.length)
        )
        return found.location == NSNotFound ? nil : found
    }
}

/// Ghostty 用の Auto Learn の上限と定数。
enum AutoLearnTerminalLimits {
    /// 端末の履歴は入力欄より桁違いに長いため、本家の 100_000 とは別の上限にする。
    /// 根拠: Ghostty の既定の scrollback-limit は 10,000,000 バイトで、1セル 8 バイト程度とみると
    /// 約 125 万セル。余裕を見て 1_500_000 とする(設定文書での既定値の確認は未了。実機で確かめる)。
    static let maximumFieldUTF16Length = 1_500_000
    static let pollIntervalNanoseconds: UInt64 = 1_000_000_000
}

/// アクセシビリティでの文字の読み取り設定。
struct AutoLearnAXTextReadOptions: Sendable, Equatable {
    var maximumFieldUTF16Length: Int
    var skipsStringForRange: Bool

    static let standard = AutoLearnAXTextReadOptions(
        maximumFieldUTF16Length: AutoLearnLimits.maximumFieldUTF16Length,
        skipsStringForRange: false
    )

    /// Ghostty の AXNumberOfCharacters は書記素数で UTF-16 の長さではない。
    /// string-for-range で読むと絵文字などがある履歴で末尾が欠けるため、AXValue の全文を使う。
    static let ghostty = AutoLearnAXTextReadOptions(
        maximumFieldUTF16Length: AutoLearnTerminalLimits.maximumFieldUTF16Length,
        skipsStringForRange: true
    )
}
