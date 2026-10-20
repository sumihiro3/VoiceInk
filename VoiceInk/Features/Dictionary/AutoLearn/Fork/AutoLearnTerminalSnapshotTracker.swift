import Foundation

/// 繰り返し実行を止めるためのハンドル。
protocol AutoLearnTerminalPollCancellation: AnyObject {
    func cancel()
}

/// 一定間隔の繰り返し実行の差し替え口(テストでは時間を待たずに発火させる)。
protocol AutoLearnTerminalPollScheduling {
    /// `interval`(ns)ごとに `handler` を呼ぶ。止めるには返したハンドルの `cancel()` を呼ぶ。
    func scheduleRepeating(
        every interval: UInt64, _ handler: @escaping () -> Void
    ) -> AutoLearnTerminalPollCancellation
}

/// `DispatchSourceTimer` を、渡された serial queue 上で動かす本番用のスケジューラ。
struct DispatchQueueTerminalPollScheduler: AutoLearnTerminalPollScheduling {
    let queue: DispatchQueue

    private final class TimerCancellation: AutoLearnTerminalPollCancellation {
        private let timer: DispatchSourceTimer
        init(_ timer: DispatchSourceTimer) { self.timer = timer }
        func cancel() { timer.cancel() }
    }

    func scheduleRepeating(
        every interval: UInt64, _ handler: @escaping () -> Void
    ) -> AutoLearnTerminalPollCancellation {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(
            deadline: .now() + .nanoseconds(Int(clamping: interval)),
            repeating: .nanoseconds(Int(clamping: interval)),
            leeway: .milliseconds(50)
        )
        timer.setEventHandler(handler: handler)
        timer.resume()
        return TimerCancellation(timer)
    }
}

/// Ghostty の画面を一定間隔で読み、「最後に取れた直し」を1つだけ保持する。
///
/// Enter で送ると入力欄が空になり、確定時の final からは直しが取れなくなる。
/// 送る前に見えていた直しをここで覚えておく。
///
/// `@unchecked Sendable` の理由: 状態はすべて AutoLearnAXRuntime の serial queue 上だけで
/// 触る約束で、自前の排他は持たない。
final class AutoLearnTerminalSnapshotTracker: @unchecked Sendable {
    struct Resolution: Sendable {
        let revision: AutoLearnRevision?
        let usedTrackedRevision: Bool
        /// final を見て取り出したときの段階。追跡済みの直しを使った場合は nil。
        let finalOutcome: AutoLearnTerminalRevisionLocator.Outcome?
        let readCount: Int
        let failedReadCount: Int
        let skippedReadCount: Int
        let maximumReadMilliseconds: Int
        /// 読み取りで取れた直しが前回と変わった回数。
        var revisionUpdates = 0
        /// 最後に直しが変わってから確定までのミリ秒。直しが一度も取れていなければ nil。
        var lastRevisionAgeMilliseconds: Int?
        /// 追跡済みの直しを使ったかどうかに関係なく、final を調べた結果(ログ用)。
        var finalProbe: AutoLearnTerminalRevisionLocator.Outcome?
    }

    private let baselineFieldText: String
    private let pastedRange: NSRange
    private let originalPastedText: String
    private let readFieldText: () -> String?
    private let scheduler: AutoLearnTerminalPollScheduling
    private let interval: UInt64
    private let now: () -> UInt64

    private var cancellation: AutoLearnTerminalPollCancellation?
    private var isStopped = false
    private var isReading = false
    private(set) var lastRevision: AutoLearnRevision?
    private(set) var readCount = 0
    private(set) var failedReadCount = 0
    private(set) var skippedReadCount = 0
    private(set) var maximumReadMilliseconds = 0
    private(set) var revisionUpdates = 0
    private var lastRevisionChangedAt: UInt64?

    init(
        baselineFieldText: String,
        pastedRange: NSRange,
        originalPastedText: String,
        readFieldText: @escaping () -> String?,
        scheduler: AutoLearnTerminalPollScheduling,
        interval: UInt64 = AutoLearnTerminalLimits.pollIntervalNanoseconds,
        now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) {
        self.baselineFieldText = baselineFieldText
        self.pastedRange = pastedRange
        self.originalPastedText = originalPastedText
        self.readFieldText = readFieldText
        self.scheduler = scheduler
        self.interval = interval
        self.now = now
    }

    /// 定期読み取りを始める。止めたあと、または開始済みなら何もしない。
    func start() {
        guard !isStopped, cancellation == nil else { return }
        cancellation = scheduler.scheduleRepeating(every: interval) { [weak self] in
            self?.tick()
        }
    }

    /// 定期読み取りを止める。何度呼んでもよい。止めたあとは tick しない。
    func stop() {
        isStopped = true
        cancellation?.cancel()
        cancellation = nil
    }

    /// 1回分の読み取り。前の回が終わっていなければ飛ばす。
    func tick() {
        guard !isStopped else { return }
        if isReading {
            skippedReadCount += 1
            return
        }
        isReading = true
        defer { isReading = false }

        let startedAt = now()
        let text = readFieldText()
        let finishedAt = now()
        let elapsed = finishedAt >= startedAt ? finishedAt - startedAt : 0
        maximumReadMilliseconds = max(maximumReadMilliseconds, Int(elapsed / 1_000_000))

        guard let text else {
            failedReadCount += 1
            return
        }
        readCount += 1
        if let revision = locate(finalFieldText: text).revision {
            if revision.original != lastRevision?.original || revision.corrected != lastRevision?.corrected {
                revisionUpdates += 1
                lastRevisionChangedAt = finishedAt
            }
            lastRevision = revision
        }
    }

    /// 確定時に使う。定期読み取りを止め、追跡済みの直しを優先し、無ければ final から取り出す。
    func resolve(finalFieldText: String?) -> Resolution {
        stop()
        var revision = lastRevision
        var usedTracked = false
        var finalOutcome: AutoLearnTerminalRevisionLocator.Outcome?
        let finalProbe = finalFieldText.map { locate(finalFieldText: $0) }
        if revision != nil {
            usedTracked = true
        } else if let finalProbe {
            finalOutcome = finalProbe
            revision = finalProbe.revision
        }
        let resolvedAt = now()
        let ageMilliseconds = lastRevisionChangedAt.map {
            resolvedAt >= $0 ? Int((resolvedAt - $0) / 1_000_000) : 0
        }
        return Resolution(
            revision: revision,
            usedTrackedRevision: usedTracked,
            finalOutcome: finalOutcome,
            readCount: readCount,
            failedReadCount: failedReadCount,
            skippedReadCount: skippedReadCount,
            maximumReadMilliseconds: maximumReadMilliseconds,
            revisionUpdates: revisionUpdates,
            lastRevisionAgeMilliseconds: ageMilliseconds,
            finalProbe: finalProbe
        )
    }

    private func locate(finalFieldText: String) -> AutoLearnTerminalRevisionLocator.Outcome {
        AutoLearnTerminalRevisionLocator.locate(
            AutoLearnFieldSnapshot(
                baselineFieldText: baselineFieldText,
                finalFieldText: finalFieldText,
                pastedRange: pastedRange,
                originalPastedText: originalPastedText
            )
        )
    }
}
