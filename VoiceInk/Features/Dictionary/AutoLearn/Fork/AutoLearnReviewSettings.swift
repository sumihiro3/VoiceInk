import Foundation

/// Auto Learn の AI 審査の待ち時間の設定。
/// 審査は学習候補を判定する別系統の呼び出しなので、整形用の `EnhancementRequestSettings`(既定7秒)とは別に持つ。
enum AutoLearnReviewSettings {
    /// UserDefaults のキー。値は秒数(整数)。
    static let timeoutKey = "AutoLearnReviewTimeoutSeconds"
    /// 値が未設定、または0以下のときに使う秒数。
    /// 2026-10-18 の実機確認で、Gemini 3.8 Flash の審査は30.2秒かかって成功した例と、30秒で時間切れになった例があった。
    static let defaultTimeoutSeconds = 90

    /// 審査の待ち時間(秒)。未設定または0以下なら `defaultTimeoutSeconds`。
    static var timeout: TimeInterval {
        let configuredTimeout = UserDefaults.standard.integer(forKey: timeoutKey)
        return TimeInterval(configuredTimeout > 0 ? configuredTimeout : defaultTimeoutSeconds)
    }
}
