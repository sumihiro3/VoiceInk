# フォークの規約(ARCHITECTURE)

Whisper の途中経過表示(`feature/whisper-streaming`)を実装・レビューするときに従う規約。
作業の進め方・ビルド手順・マイルストーンは [CLAUDE.md](../CLAUDE.md) が正で、ここには複製しない。
既存コードの調査結果(どこに何があるか)は [whisper-streaming-investigation.md](whisper-streaming-investigation.md) にある。

各規約は「規約(守ること)」と「根拠(既存コードの path:line、または CLAUDE.md の節)」の組で書く。
パスは `VoiceInk/` 配下(リポジトリルートからの相対)。行番号はこの文書を書いた時点のもので、コードが動いたら根拠を取り直す。

## 1. 最終結果と処理の分離(AC-1)

### 1-1. 途中経過は表示専用。貼り付けるのは録音停止後の最終処理の結果だけ

- 規約: 途中経過の文字を貼り付け・整形・履歴の入力にしない。最終テキストは従来の経路だけで作る。
- 根拠: `Features/Recording/Workflows/TranscriptionPipeline.swift:105-113` が最終テキストの唯一の入口で、`session.transcribe` か `serviceRegistry.transcribe` の結果だけが `text` に入る。直後の `:114` で `TranscriptionOutputFilter.filter(text)` に渡る。CLAUDE.md「設計の要点」(貼り付けるのは最終結果だけ)。

### 1-2. 途中経過でエラーが出ても、最終処理は従来どおり動く

- 規約: 途中経過の起動失敗・実行中の例外は握りつぶさず、ログに出したうえで録音後の全音声処理(batch)へ戻す。途中経過の失敗で録音や貼り付けを止めない。
- 根拠: `Features/Recording/Workflows/TranscriptionSession.swift:107-111`(起動失敗時に `streamingFailed = true` にして batch へ戻す)、`:145-154`(停止時の例外で `streamingService.cancel()` して batch へ)、`:142-143`(`.requiresBatchFallback`)、`:164-172`(batch fallback の実行)。契約側は `Infrastructure/Providers/Transcription/Contracts/StreamingTranscriptionProvider.swift:12-15` の `useBatchFallback`。CLAUDE.md「作業の進め方」。

### 1-3. 前の回の認識が終わっていなければ、その回は飛ばす(処理を重ねない)

- 規約: 認識中を示すフラグを持ち、立っていたら次の周期は何もせず戻る。待ち行列にためない。
- 根拠: `Infrastructure/Providers/Transcription/FluidAudio/Streaming/FluidAudioStreamingProvider.swift:139`(`guard !isTranscribing else { return }`)、`:149-150`(`isTranscribing = true` と `defer` での解除)。CLAUDE.md「設計の要点」。

### 1-4. Whisper 以外のモデルの動作を変えない

- 規約: Parakeet・Nemotron・クラウドの provider 選択と挙動はそのまま。Whisper 用の分岐は `createProvider` に足すだけで、既存の分岐の順序・条件を書き換えない。
- 根拠: `Features/Recording/Streaming/StreamingTranscriptionService.swift:310-341` の `createProvider(for:)` が provider を選ぶ唯一の場所。FluidAudio の Nemotron / Unified / 通常が `:311-329`、`.whisper` が `:330-332`、クラウドが `:333-340`。`.whisper` の分岐は `WhisperStreamingSettings.isEnabled` による可否判定(`TranscriptionRealtimeSupport.isAvailable`)とセットで追加済み(FluidAudio 分岐の後、クラウドの guard の前)。Real-time の可否判定を通ったモデルだけがここに来る前提を崩さない(分岐と可否判定は必ずセットで変える)。

### 1-5. 新しい処理は新しいファイル。既存ファイルの変更は最小限で、FORK-CHANGES.md に記録する

- 規約: 新規の型・処理は新しいファイルにまとめる。既存ファイルは差し込みに必要な行だけ変える。ファイルを追加・変更したら、同じ作業の中で `FORK-CHANGES.md` に「ファイル・内容・理由」を追記する。
- 根拠: CLAUDE.md「作業の進め方」(新しい処理は新しいファイルに / FORK-CHANGES.md に追記)。差し込み先の候補は調査メモの差し込み案を参照。

## 2. プロバイダとログ(AC-2)

### 2-1. プロバイダは StreamingTranscriptionProvider の契約に従う

- 規約: Whisper の途中経過も `StreamingTranscriptionProvider` を実装して差し込む。契約を変えない。
  - `connect(model:language:)` / `sendAudioChunk(_:)`(16bit・16kHz・モノラル・リトルエンディアンの PCM) / `commit()` / `disconnect()` / `transcriptionEvents`
  - 録音停止後に全音声を処理し直す方針なので、`stopDisposition` は `.useBatchFallback` を返す。
- 根拠: `Infrastructure/Providers/Transcription/Contracts/StreamingTranscriptionProvider.swift:45-67`(プロトコル本体)、`:12-15`(`StreamingStopDisposition`)、`:4-9`(イベント型)、`:69-72`(既定値は `.finalizeStreaming`)。停止時の分岐は `Features/Recording/Workflows/TranscriptionSession.swift:142-143`。CLAUDE.md「設計の要点」(停止後は全音声を Mode のモデルで処理し直す)。

### 2-2. ログは Logger を決まった形で使う

- 規約: `Logger(subsystem: "com.prakashjoshipax.voiceink", category: "<型名>")`。`print` や別の subsystem を使わない。
- 根拠: `Features/Recording/Capture/Recorder.swift:10`(category `Recorder`)、`App/Lifecycle/ModelPrewarmService.swift:12`(category `ModelPrewarm`)、`Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift:18`(category `WhisperContext`)。

### 2-3. 口述内容を `privacy: .public` で出さない

- 規約: 認識したテキスト、プロンプト、ファイル内容は `.public` にしない(既定の private のまま)。`.public` にしてよいのは秒数・文字数・回数などの数値と、モデル名のような口述に由来しない文字列だけ。1回の認識時間とそのときの音声の長さは `elapsed=…s` の形で出す。
- 根拠: `Features/Recording/Workflows/TranscriptionSession.swift:103`(`elapsed=…s` を `.public`)、`:138-140` と `:169-171`(`elapsed=…s chars=…`)が見本。口述内容は `logs/` と同じ扱いで、ログにもコミットにも入れない(CLAUDE.md「作業の進め方」)。

## 3. 並行処理(AC-3)

### 3-1. WhisperContext への一連の呼び出しを分割しない

- 規約: `setLanguage` / `setPrompt` / `fullTranscribe` / 結果の読み出しは、1つの認識について連続して呼ぶ。間に別の認識の呼び出しが割り込む形にしない(割り込むと言語・プロンプトが他の回のものになり、結果の読み出しも別の回のものになる)。複数の呼び出しを束ねる必要があれば、`WhisperContext` 側に1回の呼び出しで完結する新しいメソッドを足す。既存の `fullTranscribe` は変えない。
- 根拠: `Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift:10-11`(「同時に複数スレッドから触らない」というコメントと `actor WhisperContext`)、`:13-17`(言語・プロンプト・VAD パスを actor が状態として持つ)、`:32`(`fullTranscribe(samples:)`)。actor は1つの呼び出しの途中で別の呼び出しを受け付けうるため、複数の await をまたぐ手順は保護されない。

### 3-2. 途中経過用と最終処理用で context を分ける

- 規約: 途中経過用の `WhisperContext` は専用に作り、最終処理が使うものと共有しない。これで、途中経過の認識中に録音が止まっても、最終処理が待たされたり設定を上書きされたりしない。
- 根拠: `Features/ModelLibrary/State/WhisperModelManager.swift:147-148`(`loadModel` は `guard whisperContext == nil` で、読み込み済みの context は1つだけ=枠が1つ)、`:154-158`(その1つに言語・プロンプトを設定する)。この枠は最終処理が使うため、途中経過用は別に確保する。

### 3-3. cancel・disconnect のあとに古い結果を流さない

- 規約: 途中経過を UI に反映する直前に、(1) その録音の `startID` が現在のものと一致し、(2) `recordingState == .recording` であることを確認する。録音が止まった・取り消された・次の録音が始まったあとに届いた結果は捨てる。provider 側も `disconnect` / cancel 後はイベントを出さない。
- 根拠: `Features/Recording/Workflows/VoiceInkEngine.swift:242-243`(録音ごとに `startID` を作り `activeRecordingStartID` に保持)、`:328-336`(`onPartialTranscript` の中で `activeRecordingStartID == startID` と `recordingState == .recording` を確認してから `partialTranscript` に代入)。

### 3-4. 録音停止時に途中認識の完了を待たない

- 規約: 停止・取り消しのときは、abort callback で進行中の認識の中断を指示する。provider の `disconnect` / `commit` は進行中の認識を await せずにすぐ戻る。中断後・停止後に返ってきた結果は捨て、イベントを流さない。途中経過専用 context の解放は、provider 内部の後始末で認識の終了後に行う(`whisper_full` の実行中に `whisper_free` しない)。
- 根拠: `Features/Recording/Streaming/StreamingTranscriptionService.swift:216-220`(`stopAndFinalize` の `.useBatchFallback` 分岐は `cleanupStreaming()` を await してから `.requiresBatchFallback` を返す)と `:507`(`cleanupStreaming()` の `await provider?.disconnect()`)。呼び出し元が `disconnect` の完了を待つため、provider が認識の完了を待つと、その時間が録音停止から貼り付けまでの遅延にそのまま加算される([known-issues.md](known-issues.md) の F1)。実装は `Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift:215`(`shutdown` は停止フラグ→中断→ループの cancel→イベント終了の順で await せず戻る)と `:237` 付近(切り離した後始末 Task が認識の終了を待ってから解放する)、`Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift:136-140`(`transcribePartial` が `abort_callback` を設定する)。

## 4. 関連文書(AC-4)

- 調査メモ: [whisper-streaming-investigation.md](whisper-streaming-investigation.md)(既存のリアルタイム処理の読み解きと、差し込み位置の案)
- 作業の進め方・設計の要点・マイルストーン: [CLAUDE.md](../CLAUDE.md)
- 変更記録: [FORK-CHANGES.md](../FORK-CHANGES.md)
