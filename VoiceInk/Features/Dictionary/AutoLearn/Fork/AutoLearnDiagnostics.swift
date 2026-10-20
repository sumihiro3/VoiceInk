import Foundation
import os

/// 直しの確定を起こした理由。
enum AutoLearnFinalizeReason: String, Sendable {
    case nextPaste = "next-paste"
    case recordingStart = "recording-start"
    case focus
    case deadline
}

/// 確定の処理がどの段階で止まったか(または直しが見つかったか)。
enum AutoLearnFinalizeStage: String, Sendable {
    case revised
    case sessionMissing = "session-missing"
    case readFailed = "read-failed"
    case fieldTooLarge = "field-too-large"
    case unchanged
    case invalidBaseline = "invalid-baseline"
    case beforeAnchorNotFound = "before-anchor-not-found"
    case afterAnchorNotFound = "after-anchor-not-found"
    case tooLong = "too-long"
    case tooManyLineBreaks = "too-many-line-breaks"
    case inputEmpty = "input-empty"
    case notRevised = "not-revised"
    /// Ghostty 以外で、本家の処理が nil を返した。
    case diffEngineNil = "diff-engine-nil"
}

/// Ghostty 用の確定時の調査項目。数値と真偽だけを持つ。
struct AutoLearnTerminalDiagnosticFields: Equatable, Sendable {
    var beforeAnchorMatches: Int
    var afterAnchorMatches: Int
    var reads: Int
    var failedReads: Int
    var skippedReads: Int
    var usedTrackedRevision: Bool
    var maxReadMs: Int
    var revisionUpdates = 0
    var lastUpdateAgeMs: Int?
    var originalUTF16: Int?
    var correctedUTF16: Int?
    var finalStage: String?
    var finalCorrectedUTF16: Int?
}

/// 口述の中身を含まない調査用ログ。長さ・位置・理由・アプリの識別子だけを出す。
enum AutoLearnDiagnostics {
    private static let logger = Logger(subsystem: "com.prakashjoshipax.voiceink", category: "AutoLearnDiagnostics")

    typealias TerminalFields = AutoLearnTerminalDiagnosticFields

    /// 貼り付けを捕まえた結果の1行を組み立てる。生の材料は長さの計算だけに使う。
    static func captureLine(
        bundleIdentifier: String?,
        result: String,
        readingSource: String?,
        fieldText: String?,
        pastedRange: NSRange?,
        selectionAvailable: Bool?,
        pastedText: String
    ) -> String {
        let fieldLength = fieldText.map { String(($0 as NSString).length) } ?? "none"
        let location = pastedRange.map { String($0.location) } ?? "none"
        let matchedLength = pastedRange.map { String($0.length) } ?? "none"
        let selection = selectionAvailable.map { $0 ? "yes" : "no" } ?? "none"
        return [
            "app=\(sanitizedIdentifier(bundleIdentifier))",
            "result=\(sanitizedToken(result))",
            "source=\(readingSource.map(sanitizedToken) ?? "none")",
            "fieldUTF16=\(fieldLength)",
            "pastedLocation=\(location)",
            "pastedLength=\((pastedText as NSString).length)",
            "matchedLength=\(matchedLength)",
            "selection=\(selection)",
        ].joined(separator: " ")
    }

    /// 確定の結果の1行を組み立てる。
    static func finalizeLine(
        bundleIdentifier: String?,
        reason: AutoLearnFinalizeReason,
        finalFieldText: String?,
        revisionFound: Bool,
        stage: AutoLearnFinalizeStage,
        terminal: TerminalFields?
    ) -> String {
        let fieldLength = finalFieldText.map { String(($0 as NSString).length) } ?? "none"
        var parts = [
            "app=\(sanitizedIdentifier(bundleIdentifier))",
            "reason=\(reason.rawValue)",
            "finalUTF16=\(fieldLength)",
            "revision=\(revisionFound ? "found" : "none")",
            "stage=\(stage.rawValue)",
        ]
        if let terminal {
            parts += [
                "beforeAnchors=\(terminal.beforeAnchorMatches)",
                "afterAnchors=\(terminal.afterAnchorMatches)",
                "reads=\(terminal.reads)",
                "failedReads=\(terminal.failedReads)",
                "skippedReads=\(terminal.skippedReads)",
                "tracked=\(terminal.usedTrackedRevision ? "yes" : "no")",
                "maxReadMs=\(terminal.maxReadMs)",
                "updates=\(terminal.revisionUpdates)",
                "lastUpdateAgeMs=\(terminal.lastUpdateAgeMs.map(String.init) ?? "none")",
                "originalUTF16=\(terminal.originalUTF16.map(String.init) ?? "none")",
                "correctedUTF16=\(terminal.correctedUTF16.map(String.init) ?? "none")",
                "finalStage=\(terminal.finalStage.map(sanitizedToken) ?? "none")",
                "finalCorrectedUTF16=\(terminal.finalCorrectedUTF16.map(String.init) ?? "none")",
            ]
        }
        return parts.joined(separator: " ")
    }

    /// 貼り付けを捕まえた結果をログに出す。
    static func logCapture(
        bundleIdentifier: String?,
        result: String,
        readingSource: String?,
        fieldText: String?,
        pastedRange: NSRange?,
        selectionAvailable: Bool?,
        pastedText: String
    ) {
        let line = captureLine(
            bundleIdentifier: bundleIdentifier,
            result: result,
            readingSource: readingSource,
            fieldText: fieldText,
            pastedRange: pastedRange,
            selectionAvailable: selectionAvailable,
            pastedText: pastedText
        )
        logger.info("Capture \(line, privacy: .public)")
    }

    /// 確定の結果をログに出す。
    static func logFinalize(
        bundleIdentifier: String?,
        reason: AutoLearnFinalizeReason,
        finalFieldText: String?,
        revisionFound: Bool,
        stage: AutoLearnFinalizeStage,
        terminal: TerminalFields?
    ) {
        let line = finalizeLine(
            bundleIdentifier: bundleIdentifier,
            reason: reason,
            finalFieldText: finalFieldText,
            revisionFound: revisionFound,
            stage: stage,
            terminal: terminal
        )
        logger.info("Finalize \(line, privacy: .public)")
    }

    private static func sanitizedIdentifier(_ value: String?) -> String {
        guard let value, !value.isEmpty, value.utf8.count <= 128,
              value.unicodeScalars.allSatisfy({ identifierScalars.contains($0) }) else { return "unknown" }
        return value
    }

    private static func sanitizedToken(_ value: String) -> String {
        guard !value.isEmpty, value.utf8.count <= 64,
              value.unicodeScalars.allSatisfy({ tokenScalars.contains($0) }) else { return "unknown" }
        return value
    }

    private static let identifierScalars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    private static let tokenScalars = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
}
