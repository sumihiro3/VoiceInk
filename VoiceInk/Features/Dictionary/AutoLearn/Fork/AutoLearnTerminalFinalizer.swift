import ApplicationServices
import Foundation

/// 見張りを確定させたときに runtime が返す材料。
///
/// 本家の `finishSnapshot` は snapshot か nil だけを返していたが、FR-03 のログのために
/// 止まった段階と、Ghostty のときは定期読み取りの判定もあわせて持ち回る。
struct AutoLearnFinishedObservation: Sendable {
    let snapshot: AutoLearnFieldSnapshot?
    let bundleIdentifier: String?
    /// ログで文字数を出すためだけに使う。中身はログに出さない。
    let finalFieldText: String?
    let stoppedStage: AutoLearnFinalizeStage?
    let terminalResolution: AutoLearnTerminalSnapshotTracker.Resolution?

    init(
        snapshot: AutoLearnFieldSnapshot?,
        bundleIdentifier: String?,
        finalFieldText: String?,
        stoppedStage: AutoLearnFinalizeStage?,
        terminalResolution: AutoLearnTerminalSnapshotTracker.Resolution?
    ) {
        self.snapshot = snapshot
        self.bundleIdentifier = bundleIdentifier
        self.finalFieldText = finalFieldText
        self.stoppedStage = stoppedStage
        self.terminalResolution = terminalResolution
    }

    /// 本家の `return nil` に当たる、直しの材料が無い結果。
    static func stopped(
        _ stage: AutoLearnFinalizeStage,
        bundleIdentifier: String?,
        finalFieldText: String? = nil
    ) -> AutoLearnFinishedObservation {
        AutoLearnFinishedObservation(
            snapshot: nil,
            bundleIdentifier: bundleIdentifier,
            finalFieldText: finalFieldText,
            stoppedStage: stage,
            terminalResolution: nil
        )
    }
}

/// 確定させた結果から直しを決め、確定のログを1行出す。
enum AutoLearnTerminalFinalizer {
    /// Ghostty のときは定期読み取りの判定を、それ以外は本家の `FinalSnapshotDiffEngine` を使う。
    static func revision(
        for observation: AutoLearnFinishedObservation,
        reason: AutoLearnFinalizeReason
    ) -> AutoLearnRevision? {
        let decision = decide(observation)
        AutoLearnDiagnostics.logFinalize(
            bundleIdentifier: observation.bundleIdentifier,
            reason: reason,
            finalFieldText: observation.finalFieldText,
            revisionFound: decision.revision != nil,
            stage: decision.stage,
            terminal: decision.terminal
        )
        return decision.revision
    }

    struct Decision {
        let revision: AutoLearnRevision?
        let stage: AutoLearnFinalizeStage
        let terminal: AutoLearnTerminalDiagnosticFields?
    }

    /// ログを出さずに直しと段階を決める(テスト用に分けている)。
    static func decide(_ observation: AutoLearnFinishedObservation) -> Decision {
        if let resolution = observation.terminalResolution {
            let stage: AutoLearnFinalizeStage
            if resolution.revision != nil {
                stage = .revised
            } else if let outcome = resolution.finalOutcome {
                stage = finalizeStage(for: outcome.stage)
            } else {
                stage = observation.stoppedStage ?? .readFailed
            }
            return Decision(
                revision: resolution.revision,
                stage: stage,
                terminal: AutoLearnTerminalDiagnosticFields(
                    beforeAnchorMatches: (resolution.finalOutcome ?? resolution.finalProbe)?.beforeAnchorMatchCount ?? 0,
                    afterAnchorMatches: (resolution.finalOutcome ?? resolution.finalProbe)?.afterAnchorMatchCount ?? 0,
                    reads: resolution.readCount,
                    failedReads: resolution.failedReadCount,
                    skippedReads: resolution.skippedReadCount,
                    usedTrackedRevision: resolution.usedTrackedRevision,
                    maxReadMs: resolution.maximumReadMilliseconds,
                    revisionUpdates: resolution.revisionUpdates,
                    lastUpdateAgeMs: resolution.lastRevisionAgeMilliseconds,
                    originalUTF16: resolution.revision.map { ($0.original as NSString).length },
                    correctedUTF16: resolution.revision.map { ($0.corrected as NSString).length },
                    finalStage: resolution.finalProbe.map { finalizeStage(for: $0.stage).rawValue },
                    finalCorrectedUTF16: resolution.finalProbe?.revision.map { ($0.corrected as NSString).length },
                    source: resolution.source.rawValue,
                    sentEcho: resolution.sentEcho.map(sentEchoLabel)
                )
            )
        }

        guard let snapshot = observation.snapshot else {
            return Decision(
                revision: nil,
                stage: observation.stoppedStage ?? .readFailed,
                terminal: nil
            )
        }
        let revision = FinalSnapshotDiffEngine.revision(from: snapshot)
        return Decision(
            revision: revision,
            stage: revision == nil ? .diffEngineNil : .revised,
            terminal: nil
        )
    }

    /// Ghostty の1秒ごとの読み取りを始める。
    ///
    /// `queue` は AutoLearnAXRuntime の serial queue を渡す。読み取りも確定もこの queue 上で動くので、
    /// tracker の状態に排他は要らない。メインスレッドでは読まない。
    static func startGhosttyTracker(
        reader: AutoLearnAXTextReader,
        targetElement: AXUIElement,
        baselineFieldText: String,
        pastedRange: NSRange,
        pastedText: String,
        queue: DispatchQueue
    ) -> AutoLearnTerminalSnapshotTracker {
        let tracker = AutoLearnTerminalSnapshotTracker(
            baselineFieldText: baselineFieldText,
            pastedRange: pastedRange,
            originalPastedText: pastedText,
            readFieldText: { reader.textValue(from: targetElement, options: .ghostty)?.text },
            scheduler: DispatchQueueTerminalPollScheduler(queue: queue)
        )
        tracker.start()
        return tracker
    }

    /// Ghostty の見張りを確定させる。runtime の queue 上で呼ぶ。
    ///
    /// 本家と違い、上限超えや baseline と同じでも早く戻らない。Enter で送ったあとは final から
    /// 直しが取れないため、final が読めなくても最後に取れた直しを使えるようにする。
    static func finishGhosttyObservation(
        tracker: AutoLearnTerminalSnapshotTracker,
        reader: AutoLearnAXTextReader,
        targetElement: AXUIElement,
        baselineFieldText: String,
        pastedRange: NSRange,
        pastedText: String,
        bundleIdentifier: String?
    ) -> AutoLearnFinishedObservation {
        tracker.stop()
        let finalFieldText = reader.textValue(from: targetElement, options: .ghostty)?.text
        let resolution = tracker.resolve(finalFieldText: finalFieldText)
        return AutoLearnFinishedObservation(
            snapshot: finalFieldText.map {
                AutoLearnFieldSnapshot(
                    baselineFieldText: baselineFieldText,
                    finalFieldText: $0,
                    pastedRange: pastedRange,
                    originalPastedText: pastedText
                )
            },
            bundleIdentifier: bundleIdentifier,
            finalFieldText: finalFieldText,
            stoppedStage: finalFieldText == nil ? .readFailed : nil,
            terminalResolution: resolution
        )
    }

    /// 送った文の行を調べた結果を、ログ用の決まった文字列にする(中身は出さない)。
    static func sentEchoLabel(_ result: AutoLearnTerminalSentEcho.Result) -> String {
        switch result {
        case .revised: return "revised"
        case .unchanged: return "unchanged"
        case .notFound: return "not-found"
        }
    }

    /// Locator の段階を確定ログの段階に変える。`located` だけ名前が違う。
    static func finalizeStage(
        for stage: AutoLearnTerminalRevisionLocator.Stage
    ) -> AutoLearnFinalizeStage {
        switch stage {
        case .located: return .revised
        case .invalidBaseline: return .invalidBaseline
        case .beforeAnchorNotFound: return .beforeAnchorNotFound
        case .afterAnchorNotFound: return .afterAnchorNotFound
        case .tooLong: return .tooLong
        case .tooManyLineBreaks: return .tooManyLineBreaks
        case .inputEmpty: return .inputEmpty
        case .notRevised: return .notRevised
        }
    }
}
