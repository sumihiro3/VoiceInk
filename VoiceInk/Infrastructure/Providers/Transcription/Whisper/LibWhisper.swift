import Foundation
import os

#if canImport(whisper)
    import whisper
#else
    #error("Unable to import whisper module. Please check your project configuration.")
#endif

// Meet Whisper C++ constraint: Don't access from more than one thread at a time.
actor WhisperContext {
    private var context: OpaquePointer?
    private var language: String?
    private var languageCString: [CChar]?
    private var prompt: String?
    private var promptCString: [CChar]?
    private var vadModelPath: String?
    private let logger = Logger(subsystem: "com.prakashjoshipax.voiceink", category: "WhisperContext")

    private init() {}

    init(context: OpaquePointer) {
        self.context = context
    }

    deinit {
        if let context = context {
            whisper_free(context)
        }
    }

    func fullTranscribe(samples: [Float]) -> Bool {
        guard let context = context else { return false }

        let maxThreads = max(1, min(8, cpuCount() - 2))
        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)

        let selectedLanguage = language ?? "auto"
        if selectedLanguage != "auto" {
            languageCString = Array(selectedLanguage.utf8CString)
            params.language = languageCString?.withUnsafeBufferPointer { ptr in
                ptr.baseAddress
            }
        } else {
            languageCString = nil
            params.language = nil
        }

        if prompt != nil {
            promptCString = Array(prompt!.utf8CString)
            params.initial_prompt = promptCString?.withUnsafeBufferPointer { ptr in
                ptr.baseAddress
            }
        } else {
            promptCString = nil
            params.initial_prompt = nil
        }

        params.print_realtime = true
        params.print_progress = false
        params.print_timestamps = true
        params.print_special = false
        params.translate = false
        params.n_threads = Int32(maxThreads)
        params.offset_ms = 0
        params.no_context = true
        params.single_segment = false
        params.temperature = 0.2

        whisper_reset_timings(context)

        // Configure VAD if enabled by user and model is available
        let isVADEnabled = UserDefaults.standard.bool(forKey: "IsVADEnabled")
        if isVADEnabled, let vadModelPath = self.vadModelPath {
            params.vad = true
            params.vad_model_path = (vadModelPath as NSString).utf8String

            var vadParams = whisper_vad_default_params()
            vadParams.threshold = 0.50
            vadParams.min_speech_duration_ms = 250
            vadParams.min_silence_duration_ms = 100
            vadParams.max_speech_duration_s = Float.greatestFiniteMagnitude
            vadParams.speech_pad_ms = 30
            vadParams.samples_overlap = 0.1
            params.vad_params = vadParams
        } else {
            params.vad = false
        }

        var success = true
        samples.withUnsafeBufferPointer { samplesBuffer in
            if whisper_full(context, params, samplesBuffer.baseAddress, Int32(samplesBuffer.count)) != 0 {
                logger.error("❌ Failed to run whisper_full. VAD enabled: \(params.vad, privacy: .public)")
                success = false
            }
        }

        languageCString = nil
        promptCString = nil

        return success
    }

    func getTranscription() -> String {
        guard let context = context else { return "" }
        var transcription = ""
        for i in 0..<whisper_full_n_segments(context) {
            transcription += String(cString: whisper_full_get_segment_text(context, i))
        }
        return transcription
    }

    /// 録音中の途中経過用に認識する。actor の状態(language / prompt など)は使わず、引数だけで完結する。
    /// 中断か失敗かは whisper_full の戻り値(どちらも負値になりうる)ではなく `abortFlag` で判定する。
    func transcribePartial(
        samples: [Float],
        language: String?,
        prompt: String?,
        abortFlag: WhisperAbortFlag
    ) -> WhisperPartialTranscriptionResult {
        guard let context = context else { return .failed(code: -1) }
        if abortFlag.isAborted { return .aborted }

        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.translate = false
        params.vad = false
        params.no_context = true
        params.single_segment = false
        params.temperature = 0.2
        params.offset_ms = 0
        params.n_threads = Int32(max(1, min(8, cpuCount() - 2)))
        params.abort_callback = { userData in
            guard let userData else { return false }
            return Unmanaged<WhisperAbortFlag>.fromOpaque(userData).takeUnretainedValue().isAborted
        }
        params.abort_callback_user_data = Unmanaged.passUnretained(abortFlag).toOpaque()

        let effectiveLanguage: String? = {
            guard let language, !language.isEmpty, language != "auto" else { return nil }
            return language
        }()

        let code: Int32 = withExtendedLifetime(abortFlag) {
            withOptionalCString(effectiveLanguage) { languagePtr in
                withOptionalCString(prompt) { promptPtr in
                    params.language = languagePtr
                    params.initial_prompt = promptPtr
                    return samples.withUnsafeBufferPointer { buffer in
                        whisper_full(context, params, buffer.baseAddress, Int32(buffer.count))
                    }
                }
            }
        }

        if abortFlag.isAborted { return .aborted }
        if code != 0 {
            logger.error("Partial whisper_full failed. code: \(code, privacy: .public)")
            return .failed(code: code)
        }

        var text = ""
        for i in 0..<whisper_full_n_segments(context) {
            text += String(cString: whisper_full_get_segment_text(context, i))
        }
        return .success(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func createContext(path: String) async throws -> WhisperContext {
        let whisperContext = WhisperContext()
        try await whisperContext.initializeModel(path: path)

        // Load VAD model from bundle resources
        let vadModelPath = await VADModelManager.shared.getModelPath()
        await whisperContext.setVADModelPath(vadModelPath)

        return whisperContext
    }

    private func initializeModel(path: String) throws {
        var params = whisper_context_default_params()
        #if targetEnvironment(simulator)
            params.use_gpu = false
            logger.info("Running on the simulator, using CPU")
        #else
            params.flash_attn = true  // Enable flash attention for Metal
            logger.info("Flash attention enabled for Metal")
        #endif

        let context = whisper_init_from_file_with_params(path, params)
        if let context {
            self.context = context
        } else {
            logger.error("❌ Couldn't load model at \(path, privacy: .public)")
            throw VoiceInkEngineError.modelLoadFailed
        }
    }

    private func setVADModelPath(_ path: String?) {
        self.vadModelPath = path
        if path != nil {
            logger.info("VAD model loaded from bundle resources")
        }
    }

    func releaseResources() {
        if let context = context {
            whisper_free(context)
            self.context = nil
        }
        languageCString = nil
    }

    func setPrompt(_ prompt: String?) {
        self.prompt = prompt
    }

    func setLanguage(_ language: String?) {
        self.language = language
    }
}

fileprivate func cpuCount() -> Int {
    ProcessInfo.processInfo.processorCount
}

/// 実行中の `transcribePartial` を actor の外から中断するためのフラグ。
final class WhisperAbortFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var aborted = false

    /// 中断を要求する。以後 `isAborted` は true を返し続ける。
    func abort() {
        lock.lock()
        aborted = true
        lock.unlock()
    }

    /// 中断が要求済みか。whisper.cpp の abort_callback から別スレッドで読まれる。
    var isAborted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return aborted
    }
}

/// 途中経過用認識の結果。
enum WhisperPartialTranscriptionResult {
    case success(String)
    case aborted
    case failed(code: Int32)
}

fileprivate func withOptionalCString<R>(_ string: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
    guard let string else { return body(nil) }
    return string.withCString { body($0) }
}
