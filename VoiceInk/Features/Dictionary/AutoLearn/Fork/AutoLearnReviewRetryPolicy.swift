import Foundation
import LLMkit

/// Auto Learn の AI 審査が失敗したときの種類。ログと再試行の判断に使う。
enum AutoLearnReviewFailure: Equatable, Sendable {
    case timeout
    case http(status: Int, message: String)
    case network
    case other

    /// 審査で投げられたエラーを種類に分ける。
    static func classify(_ error: any Error) -> AutoLearnReviewFailure {
        if let llmError = error as? LLMKitError {
            switch llmError {
            case .timeout:
                return .timeout
            case .httpError(let statusCode, let message):
                return .http(status: statusCode, message: message)
            case .networkError:
                return .network
            default:
                return .other
            }
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return nsError.code == NSURLErrorTimedOut ? .timeout : .network
        }
        return .other
    }

    /// ログに `.public` で出してよい種類の名前(口述の内容を含まない)。
    var logKind: String {
        switch self {
        case .timeout: return "timeout"
        case .http: return "http"
        case .network: return "network"
        case .other: return "other"
        }
    }

    /// HTTP の状態。HTTP 以外の失敗では 0。
    var statusCode: Int {
        if case .http(let status, _) = self { return status }
        return 0
    }
}

/// 審査の失敗から、次に自動でやり直すまでの秒数を決める。
///
/// LLMKit は 429・5xx を1秒・2秒後にやり直すだけなので、回数制限の最中だと同じ 429 が返る。
/// ここでは間隔を空けてやり直し、Gemini が応答に書いた待ち時間(`retryDelay`)があればそれ以上待つ。
enum AutoLearnReviewRetryPolicy {
    /// 自動でやり直す最大回数。超えたら、次の直しが候補になるまで待ち行列に残す(本家の動作)。
    static let maximumAttempts = 4
    /// 1回目のやり直しまでの秒数。2回目以降は倍にする。
    static let baseDelaySeconds: TimeInterval = 30
    /// やり直しまでの秒数の上限。
    static let maximumDelaySeconds: TimeInterval = 300

    private static let retryableStatusCodes: Set<Int> = [429, 500, 502, 503, 504]

    /// `attempt` 回目(1始まり)のやり直しまでの秒数。やり直さないときは nil。
    static func delay(for failure: AutoLearnReviewFailure, attempt: Int) -> TimeInterval? {
        guard (1...maximumAttempts).contains(attempt) else { return nil }

        var serverDelay: TimeInterval?
        switch failure {
        case .timeout, .network:
            break
        case .http(let status, let message):
            guard retryableStatusCodes.contains(status) else { return nil }
            serverDelay = serverRetryDelaySeconds(in: message).map { $0 + 1 }
        case .other:
            return nil
        }

        let backoff = baseDelaySeconds * pow(2, Double(attempt - 1))
        return min(max(backoff, serverDelay ?? 0), maximumDelaySeconds)
    }

    /// Gemini の 429 の応答本文にある `"retryDelay": "47s"` の秒数。見つからなければ nil。
    static func serverRetryDelaySeconds(in message: String) -> TimeInterval? {
        guard let regex = try? NSRegularExpression(pattern: #""retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s""#),
            let match = regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)),
            let range = Range(match.range(at: 1), in: message)
        else {
            return nil
        }
        return TimeInterval(message[range])
    }
}
