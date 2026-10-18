import Foundation

/// Whisper 途中経過表示の隠し設定。UI は持たず、`defaults write` で切り替える(M5 で設定画面へ移す)。
enum WhisperStreamingSettings {
    /// 途中経過表示の有効・無効を保存する UserDefaults キー。
    static let enabledKey = "WhisperStreamingEnabled"
    /// 途中経過用モデル名(拡張子なし)を保存する UserDefaults キー。
    static let modelNameKey = "WhisperStreamingModelName"
    /// モデル名が未設定のときに使うモデル名。
    static let defaultModelName = "ggml-base"

    /// 途中経過表示が有効か。未設定なら false。
    static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: enabledKey)
    }

    /// 途中経過用モデル名。未設定または空白だけなら `defaultModelName`。
    static var modelName: String {
        let name = UserDefaults.standard.string(forKey: modelNameKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else { return defaultModelName }
        return name
    }
}
