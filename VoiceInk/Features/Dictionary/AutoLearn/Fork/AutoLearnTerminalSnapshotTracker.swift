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
    /// 確定時に使った直しの出どころ。
    enum Source: String, Sendable {
        /// 確定させるときの入力欄(Enter で送らずに離れたとき)。
        case final
        /// Enter で送ったあと、履歴に残った送った文の行。
        case sentEcho = "sent-echo"
        /// 1秒ごとの読み取りで最後に取れた直し。
        case tracked
        case none
    }

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
        var source: Source = .none
        /// 入力欄が空のときに、送った文の行を調べた結果(ログ用)。
        var sentEcho: AutoLearnTerminalSentEcho.Result?
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

    /// 確定時に使う。定期読み取りを止め、次の順で直しを決める。
    ///
    /// 1. 確定させるときの入力欄から取れれば、それを使う(いちばん新しい状態)。
    /// 2. 入力欄が空(Enter で送った)なら、履歴に残った送った文の行を使う。送った文が元の文と
    ///    同じなら、直さずに送ったとみなして直しなしにする。
    /// 3. どちらでも決まらなければ、1秒ごとの読み取りで最後に取れた直しを使う。
    ///    1秒ごとの読み取りは Enter の直前の直しに間に合わないことがあるため、最後の手段にする。
    func resolve(finalFieldText: String?) -> Resolution {
        stop()
        var revision: AutoLearnRevision?
        var source = Source.none
        let finalProbe = finalFieldText.map { locate(finalFieldText: $0) }
        var sentEcho: AutoLearnTerminalSentEcho.Result?
        if let finalRevision = finalProbe?.revision {
            revision = finalRevision
            source = .final
        } else if let finalFieldText, finalProbe?.stage == .inputEmpty {
            let echo = AutoLearnTerminalSentEcho.locate(
                baselineFieldText: baselineFieldText,
                finalFieldText: finalFieldText,
                pastedRange: pastedRange,
                originalPastedText: originalPastedText
            )
            sentEcho = echo
            switch echo {
            case .revised(let original, let corrected):
                revision = AutoLearnRevision(original: original, corrected: corrected)
                source = .sentEcho
            case .unchanged:
                source = .sentEcho
            case .notFound:
                break
            }
        }
        if source == .none, let lastRevision {
            revision = lastRevision
            source = .tracked
        }
        let usedTracked = source == .tracked
        let finalOutcome = usedTracked ? nil : finalProbe
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
            finalProbe: finalProbe,
            source: source,
            sentEcho: sentEcho
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
