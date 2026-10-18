import Foundation
import SwiftData
import os

/// Whisper の初期プロンプトに足す語彙の取得元。
///
/// 変更通知は使わず、呼ばれるたびに SwiftData を読む。理由は2つ。
/// - DictionaryService は語彙の追加・削除で通知を投稿しない。
/// - `requestContext` は同期かつ nonisolated で、キャッシュの無効化を待てない。
/// 読み出しは録音ごとに数回なので負担は小さく、手で足した語も Auto Learn の語も次の録音から反映される。
enum WhisperVocabularySource {
    private static let logger = Logger(
        subsystem: "com.prakashjoshipax.voiceink",
        category: "WhisperVocabularySource"
    )
    private static let container = OSAllocatedUnfairLock<ModelContainer?>(initialState: nil)

    /// アプリ起動時に ModelContainer を登録する。
    static func register(container newContainer: ModelContainer) {
        container.withLock { $0 = newContainer }
    }

    /// 登録済みの語彙を、新しい順で返す。未登録または取得に失敗したときは空の配列。
    nonisolated static func currentTerms() -> [String] {
        guard let modelContainer = container.withLock({ $0 }) else { return [] }
        let context = ModelContext(modelContainer)
        let descriptor = FetchDescriptor<VocabularyWord>(
            sortBy: [SortDescriptor(\.dateAdded, order: .reverse)]
        )
        do {
            return try context.fetch(descriptor).map(\.word)
        } catch {
            logger.error("vocabulary fetch failed: \(String(describing: error), privacy: .private)")
            return []
        }
    }
}
