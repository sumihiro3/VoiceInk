import XCTest
@testable import VoiceInk

final class AutoLearnReviewRetryPolicyTests: XCTestCase {
    func testTimeoutIsRetriedWithBackoff() {
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 1), 30)
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 2), 60)
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 3), 120)
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 4), 240)
    }

    func testStopsAfterMaximumAttempts() {
        XCTAssertNil(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 5))
        XCTAssertNil(AutoLearnReviewRetryPolicy.delay(for: .timeout, attempt: 0))
    }

    func testRetryableHTTPStatuses() {
        for status in [429, 500, 502, 503, 504] {
            XCTAssertEqual(
                AutoLearnReviewRetryPolicy.delay(for: .http(status: status, message: ""), attempt: 1),
                30,
                "\(status)"
            )
        }
    }

    func testClientErrorsAreNotRetried() {
        for status in [400, 401, 403, 404] {
            XCTAssertNil(AutoLearnReviewRetryPolicy.delay(for: .http(status: status, message: ""), attempt: 1), "\(status)")
        }
        XCTAssertNil(AutoLearnReviewRetryPolicy.delay(for: .other, attempt: 1))
    }

    func testNetworkErrorIsRetried() {
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .network, attempt: 1), 30)
    }

    func testRetryDelayFromServerIsHonored() {
        let message = #"{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"47s"}]}}"#
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .http(status: 429, message: message), attempt: 1), 48)
    }

    func testRetryDelayShorterThanBackoffKeepsBackoff() {
        let message = #"{"retryDelay": "5s"}"#
        XCTAssertEqual(AutoLearnReviewRetryPolicy.delay(for: .http(status: 429, message: message), attempt: 2), 60)
    }

    func testDelayIsCapped() {
        let message = #"{"retryDelay":"3600s"}"#
        XCTAssertEqual(
            AutoLearnReviewRetryPolicy.delay(for: .http(status: 429, message: message), attempt: 1),
            AutoLearnReviewRetryPolicy.maximumDelaySeconds
        )
    }

    func testFractionalRetryDelayIsParsed() {
        XCTAssertEqual(AutoLearnReviewRetryPolicy.serverRetryDelaySeconds(in: #""retryDelay": "12.5s""#), 12.5)
        XCTAssertNil(AutoLearnReviewRetryPolicy.serverRetryDelaySeconds(in: "no delay here"))
    }

    func testDefaultTimeoutIsNinetySeconds() {
        XCTAssertEqual(AutoLearnReviewSettings.defaultTimeoutSeconds, 90)
    }
}
