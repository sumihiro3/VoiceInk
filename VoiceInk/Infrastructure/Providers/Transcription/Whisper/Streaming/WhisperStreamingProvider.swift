import Foundation
import os

/// 録音中に whisper.cpp で途中経過を出す provider(M1: 確定処理なし)。
///
/// 1秒ごとに録音開始からの全音声を途中経過専用の `WhisperContext` で認識し、結果を `.partial(text:)` で流す。
/// 録音停止後は常に batch で処理し直すため、`stopDisposition` は `.useBatchFallback` を返す。
/// 停止時は進行中の認識を待たずに戻り、context の解放は内部の後始末 Task が認識の終了後に行う。
final class WhisperStreamingProvider: StreamingTranscriptionProvider {

    private let logger = Logger(subsystem: "com.prakashjoshipax.voiceink", category: "WhisperStreamingProvider")
    private let modelsDirectory: URL?
    private var eventsContinuation: AsyncStream<StreamingTranscriptionEvent>.Continuation?

    private(set) var transcriptionEvents: AsyncStream<StreamingTranscriptionEvent>

    private let sampleRate: Double = 16_000.0
    private let intervalNanoseconds: UInt64 = 1_000_000_000
    private let minimumSamples = 16_000

    private var audioBuffer: [Float] = []
    private let bufferLock = NSLock()

    // stateLock で守る状態。lock の順序は stateLock → bufferLock に固定する。
    private let stateLock = NSLock()
    private var isStopped = false
    private var isTranscribing = false
    private var skippedCount = 0
    private var hasEmittedFirstPartial = false
    private var loopTask: Task<Void, Never>?
    private var passTask: Task<Void, Never>?
    private var context: WhisperContext?
    private var abortFlag: WhisperAbortFlag?
    private var language: String?
    private var connectedAt: Date?
    private var cleanupScheduled = false

    var stopDisposition: StreamingStopDisposition { .useBatchFallback }

    /// - Parameter modelsDirectory: Whisper モデル(`<名前>.bin`)の置き場。nil なら `connect` が失敗する。
    init(modelsDirectory: URL?) {
        self.modelsDirectory = modelsDirectory

        var continuation: AsyncStream<StreamingTranscriptionEvent>.Continuation!
        transcriptionEvents = AsyncStream { continuation = $0 }
        eventsContinuation = continuation
    }

    deinit {
        let (flag, loop) = stateLock.withLock { (abortFlag, loopTask) }
        flag?.abort()
        loop?.cancel()
        eventsContinuation?.finish()
    }

    func connect(model: any TranscriptionModel, language: String?) async throws {
        guard let modelsDirectory else {
            throw StreamingTranscriptionError.connectionFailed("Whisper models directory is not available")
        }
        let name = WhisperStreamingSettings.modelName
        let modelURL = modelsDirectory.appendingPathComponent("\(name).bin")
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            logger.error("Partial model file not found. model=\(name, privacy: .public)")
            throw StreamingTranscriptionError.connectionFailed("Whisper partial model not found: \(name)")
        }

        let loadStart = Date()
        let loadedContext = try await WhisperContext.createContext(path: modelURL.path)
        let loadElapsed = Date().timeIntervalSince(loadStart)
        logger.notice(
            "model=\(name, privacy: .public) loadElapsed=\(loadElapsed, format: .fixed(precision: 2), privacy: .public)s"
        )

        let normalizedLanguage: String? = {
            guard let language, !language.isEmpty, language != "auto" else { return nil }
            return language
        }()

        // 読み込み中に disconnect されたら、作った context は使わずに解放する。
        let started: Bool = stateLock.withLock {
            guard !isStopped else { return false }
            context = loadedContext
            abortFlag = WhisperAbortFlag()
            self.language = normalizedLanguage
            connectedAt = Date()
            eventsContinuation?.yield(.sessionStarted)
            loopTask = makeLoopTask()
            return true
        }

        guard started else {
            Task { await loadedContext.releaseResources() }
            throw CancellationError()
        }
    }

    func sendAudioChunk(_ data: Data) async throws {
        let samples = PCMAudioConverter.float32Samples(fromPCM16Data: data)
        bufferLock.withLock {
            audioBuffer.append(contentsOf: samples)
        }
    }

    func commit() async throws {
        shutdown()
    }

    func disconnect() async {
        shutdown()
    }

    // MARK: - Private

    private func makeLoopTask() -> Task<Void, Never> {
        let interval = intervalNanoseconds
        return Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: interval)
                } catch {
                    break
                }
                guard let self else { break }
                self.tick()
            }
        }
    }

    private func tick() {
        stateLock.withLock {
            guard !isStopped else { return }
            guard !isTranscribing else {
                skippedCount += 1
                return
            }
            guard let context, let abortFlag else { return }

            let samples: [Float]? = bufferLock.withLock {
                audioBuffer.count >= minimumSamples ? audioBuffer : nil
            }
            guard let samples else { return }

            isTranscribing = true
            let language = self.language
            passTask = Task { [weak self] in
                let start = Date()
                let result = await context.transcribePartial(
                    samples: samples,
                    language: language,
                    prompt: nil,
                    abortFlag: abortFlag
                )
                let elapsed = Date().timeIntervalSince(start)
                self?.handlePassResult(result, elapsed: elapsed, sampleCount: samples.count)
            }
        }
    }

    private func handlePassResult(_ result: WhisperPartialTranscriptionResult, elapsed: TimeInterval, sampleCount: Int) {
        let audioSeconds = Double(sampleCount) / sampleRate
        let (stopped, skipped) = stateLock.withLock { () -> (Bool, Int) in
            isTranscribing = false
            return (isStopped, skippedCount)
        }

        if stopped {
            logger.notice(
                "discarded after stop elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s"
            )
            return
        }

        switch result {
        case .success(let text):
            guard !text.isEmpty else {
                logger.notice(
                    "elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s chars=0 skipped=\(skipped, privacy: .public)"
                )
                return
            }
            // isStopped の確認と yield を同じ lock 内で行い、shutdown 後に流さないようにする。
            let firstPartialDelay: TimeInterval?? = stateLock.withLock {
                guard !isStopped else { return nil }
                eventsContinuation?.yield(.partial(text: text))
                guard !hasEmittedFirstPartial else { return .some(nil) }
                hasEmittedFirstPartial = true
                return .some(connectedAt.map { Date().timeIntervalSince($0) })
            }
            guard let firstPartialDelay else {
                logger.notice(
                    "discarded after stop elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s"
                )
                return
            }
            logger.notice(
                "elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s chars=\(text.count, privacy: .public) skipped=\(skipped, privacy: .public)"
            )
            if let delay = firstPartialDelay {
                logger.notice(
                    "firstPartialAfterConnect=\(delay, format: .fixed(precision: 2), privacy: .public)s"
                )
            }
        case .aborted:
            logger.notice(
                "aborted elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s"
            )
        case .failed(let code):
            logger.error(
                "failed code=\(code, privacy: .public) elapsed=\(elapsed, format: .fixed(precision: 2), privacy: .public)s audio=\(audioSeconds, format: .fixed(precision: 1), privacy: .public)s skipped=\(skipped, privacy: .public)"
            )
        }
    }

    /// 停止処理。何度呼ばれてもよく、進行中の認識を await せずに戻る。
    private func shutdown() {
        let (loop, pass, ownedContext, flag, shouldScheduleCleanup) = stateLock.withLock {
            () -> (Task<Void, Never>?, Task<Void, Never>?, WhisperContext?, WhisperAbortFlag?, Bool) in
            isStopped = true
            let taken = (loopTask, passTask, context, abortFlag)
            loopTask = nil
            passTask = nil
            context = nil
            let schedule = !cleanupScheduled
            cleanupScheduled = true
            return (taken.0, taken.1, taken.2, taken.3, schedule)
        }

        flag?.abort()
        loop?.cancel()
        eventsContinuation?.finish()
        bufferLock.withLock {
            audioBuffer = []
        }

        guard shouldScheduleCleanup else { return }
        // whisper_full の実行中に whisper_free しないよう、pass の終了を待ってから解放する。
        Task.detached {
            _ = await loop?.value
            _ = await pass?.value
            await ownedContext?.releaseResources()
        }
    }
}
