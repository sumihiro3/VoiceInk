import Foundation
import OSLog

/// 審査が失敗したとき、`AutoLearnReviewRetryPolicy` の間隔で審査をやり直す。
///
/// 本家は失敗した候補を待ち行列に戻すだけで、次の直しが候補になるまでやり直さない。
/// 最後の口述の審査が失敗すると、候補がいつまでも残るため、ここで時間を置いてやり直す。
actor AutoLearnReviewRetryScheduler {
    static let shared = AutoLearnReviewRetryScheduler()

    private let logger = Logger(subsystem: "com.prakashjoshipax.voiceink", category: "AutoLearnReviewRetry")
    private var consecutiveFailures = 0
    private var retryTask: Task<Void, Never>?

    /// 審査の失敗を受け取り、やり直す種類の失敗なら `retry` を後で呼ぶ。
    func reviewDidFail(_ error: any Error, retry: @escaping @Sendable () async -> Void) {
        consecutiveFailures += 1
        let failure = AutoLearnReviewFailure.classify(error)
        let attempt = consecutiveFailures

        guard AutoLearnSettings.reviewSchedule == .immediately,
            let delay = AutoLearnReviewRetryPolicy.delay(for: failure, attempt: attempt)
        else {
            // 諦めたら回数を戻す。次に新しい候補の審査が失敗したとき、また1回目から間隔を空けてやり直す。
            consecutiveFailures = 0
            logger.notice(
                "Auto Learn review retry not scheduled kind=\(failure.logKind, privacy: .public) status=\(failure.statusCode, privacy: .public) attempt=\(attempt, privacy: .public)"
            )
            return
        }

        logger.notice(
            "Auto Learn review retry scheduled kind=\(failure.logKind, privacy: .public) status=\(failure.statusCode, privacy: .public) attempt=\(attempt, privacy: .public) delay=\(Int(delay), privacy: .public)s"
        )
        retryTask?.cancel()
        retryTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await retry()
        }
    }

    /// 審査が成功したら、失敗の回数を戻し、待っているやり直しを取り消す。
    func reviewDidSucceed() {
        consecutiveFailures = 0
        retryTask?.cancel()
        retryTask = nil
    }
}
