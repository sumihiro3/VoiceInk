import Foundation

/// Locates the user's correction inside a terminal (Ghostty) screen text.
///
/// The terminal exposes its whole scrollback as one string, so the upstream
/// "anchor must appear exactly once" rule fails once the same input frame
/// appears more than once. This locator instead searches only near the
/// original paste position and picks the closest anchor.
enum AutoLearnTerminalRevisionLocator {
    static let anchorUTF16Length = 16
    static let maximumAnchorUTF16Length = 64
    static let searchRadiusUTF16 = 8_192
    static let correctedLengthSlackUTF16 = 64
    static let correctedLengthMultiplier = 2
    static let allowedExtraLineBreaks = 1

    enum Stage: String, Sendable {
        case located
        case invalidBaseline = "invalid-baseline"
        case beforeAnchorNotFound = "before-anchor-not-found"
        case afterAnchorNotFound = "after-anchor-not-found"
        case tooLong = "too-long"
        case tooManyLineBreaks = "too-many-line-breaks"
        case inputEmpty = "input-empty"
        case notRevised = "not-revised"
    }

    struct Outcome: Sendable {
        let revision: AutoLearnRevision?
        let stage: Stage
        let beforeAnchorMatchCount: Int
        let afterAnchorMatchCount: Int
    }

    /// Returns the correction made to the pasted text, or nil when none can be determined safely.
    static func revision(from snapshot: AutoLearnFieldSnapshot) -> AutoLearnRevision? {
        locate(snapshot).revision
    }

    /// Same as `revision(from:)`, but also reports where the search stopped (for diagnostics).
    static func locate(_ snapshot: AutoLearnFieldSnapshot) -> Outcome {
        let baseline = snapshot.baselineFieldText as NSString
        let final = snapshot.finalFieldText as NSString
        let range = snapshot.pastedRange

        func stop(_ stage: Stage, _ before: Int = 0, _ after: Int = 0) -> Outcome {
            Outcome(
                revision: nil, stage: stage,
                beforeAnchorMatchCount: before, afterAnchorMatchCount: after
            )
        }

        guard isValid(range, inUTF16Length: baseline.length),
            baseline.substring(with: range).utf16.elementsEqual(snapshot.originalPastedText.utf16)
        else { return stop(.invalidBaseline) }

        let searchStart = max(0, range.location - searchRadiusUTF16)
        let searchEnd = min(final.length, NSMaxRange(range) + searchRadiusUTF16)

        var leftBoundary = 0
        var beforeCount = 0
        if range.location > 0 {
            let anchor = beforeAnchor(in: baseline, location: range.location)
            guard searchStart < searchEnd else { return stop(.beforeAnchorNotFound) }
            let matches = matchRanges(of: anchor, in: final, from: searchStart, to: searchEnd)
            beforeCount = matches.count
            guard let best = matches.min(by: {
                abs(NSMaxRange($0) - range.location) < abs(NSMaxRange($1) - range.location)
            }) else { return stop(.beforeAnchorNotFound) }
            leftBoundary = NSMaxRange(best)
        }

        var rightBoundary = max(leftBoundary, searchEnd)
        var afterCount = 0
        if let anchor = afterAnchor(in: baseline, from: NSMaxRange(range)) {
            let matches = matchRanges(
                of: anchor, in: final, from: leftBoundary, to: max(leftBoundary, searchEnd)
            )
            afterCount = matches.count
            guard let first = matches.first else {
                return stop(.afterAnchorNotFound, beforeCount, 0)
            }
            rightBoundary = first.location
        }

        let extracted = final.substring(
            with: NSRange(location: leftBoundary, length: rightBoundary - leftBoundary)
        )
        let trimmed = trimTrailingWhitespace(extracted)
        let pastedLength = (snapshot.originalPastedText as NSString).length

        if (trimmed as NSString).length
            > pastedLength * correctedLengthMultiplier + correctedLengthSlackUTF16 {
            return stop(.tooLong, beforeCount, afterCount)
        }
        if lineBreakCount(in: trimmed)
            > lineBreakCount(in: snapshot.originalPastedText) + allowedExtraLineBreaks {
            return stop(.tooManyLineBreaks, beforeCount, afterCount)
        }

        let normalizedCorrected = AutoLearnTextNormalizer.accessibilityComparable(extracted)
        if normalizedCorrected.isEmpty { return stop(.inputEmpty, beforeCount, afterCount) }

        let normalizedOriginal = AutoLearnTextNormalizer.accessibilityComparable(
            snapshot.originalPastedText
        )
        if normalizedOriginal.utf16.elementsEqual(normalizedCorrected.utf16) {
            return stop(.notRevised, beforeCount, afterCount)
        }
        return Outcome(
            revision: AutoLearnRevision(original: normalizedOriginal, corrected: normalizedCorrected),
            stage: .located,
            beforeAnchorMatchCount: beforeCount,
            afterAnchorMatchCount: afterCount
        )
    }

    private static func beforeAnchor(in text: NSString, location: Int) -> String {
        var length = min(anchorUTF16Length, location)
        let limit = min(maximumAnchorUTF16Length, location)
        while length < limit,
            isBlank(slice(text, start: location - length, end: location))
        {
            length += 1
        }
        return slice(text, start: location - length, end: location)
    }

    private static func afterAnchor(in text: NSString, from location: Int) -> String? {
        var start = location
        while start < text.length, [0x20, 0x09].contains(text.character(at: start)) {
            start += 1
        }
        guard start < text.length else { return nil }
        var length = min(anchorUTF16Length, text.length - start)
        let limit = min(maximumAnchorUTF16Length, text.length - start)
        while length < limit,
            isBlank(slice(text, start: start, end: start + length))
        {
            length += 1
        }
        let anchor = slice(text, start: start, end: start + length)
        return anchor.isEmpty ? nil : anchor
    }

    /// Slices by UTF-16 offsets without splitting a surrogate pair.
    private static func slice(_ text: NSString, start: Int, end: Int) -> String {
        var s = start
        var e = end
        if s < e, UTF16.isTrailSurrogate(text.character(at: s)) { s += 1 }
        if e > s, UTF16.isLeadSurrogate(text.character(at: e - 1)) { e -= 1 }
        guard s < e else { return "" }
        return text.substring(with: NSRange(location: s, length: e - s))
    }

    private static func matchRanges(
        of anchor: String, in text: NSString, from start: Int, to end: Int
    ) -> [NSRange] {
        guard !anchor.isEmpty, start < end else { return [] }
        var result: [NSRange] = []
        var next = start
        while next < end {
            let found = text.range(
                of: anchor, options: .literal,
                range: NSRange(location: next, length: end - next)
            )
            if found.location == NSNotFound { break }
            result.append(found)
            next = found.location + 1
        }
        return result
    }

    private static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func trimTrailingWhitespace(_ value: String) -> String {
        var scalars = Substring(value).unicodeScalars
        while let last = scalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
            scalars.removeLast()
        }
        return String(scalars)
    }

    private static func lineBreakCount(in value: String) -> Int {
        value.utf16.reduce(0) { $0 + ($1 == 0x0A ? 1 : 0) }
    }

    private static func isValid(_ range: NSRange, inUTF16Length length: Int) -> Bool {
        range.location != NSNotFound
            && range.location >= 0
            && range.length >= 0
            && range.location <= length
            && range.length <= length - range.location
    }
}
