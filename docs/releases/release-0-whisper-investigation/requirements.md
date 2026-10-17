# release-0-whisper-investigation 要件

- リリース識別子:release-0-whisper-investigation(CLAUDE.md のマイルストーン M0)
- ステータス: 確定
- 作成日:2026-10-17
- 参照資料:CLAUDE.md(方針・設計の要点・未決事項)、docs/fork-plan.md(手順3の調査項目、手順4の設計)、whisper.cpp のヘッダー `~/VoiceInk-Dependencies/whisper.cpp/include/whisper.h`(コミット `0c7be69`。`make build` が clone したもの)

## 背景と目的

録音中に Whisper の途中経過を出す改造(M1〜M6)を始める前に、既存の仕組みを知っておく必要がある。具体的には、リアルタイム処理がどう差し替わるか、途中経過がどう画面に届くか、録音後の最終処理がどう流れるか、Whisper と音声バッファがどう扱われているか。これを知らずに M1 を実装すると、既存のプロバイダ契約から外れたり、録音後の最終処理を壊したりしやすい。今の CLAUDE.md の設計(手順4)は、既存コードを読まずに書いたものでもある。

このリリースでは、既存コードを読んだ結果を調査メモにまとめる。あわせて、M1 以降の実装とレビューが従うフォークの規約文書を作る。**アプリのコードは変更しない。**

## スコープの確定(壁打ちでの決定事項)

| 論点 | 決定 |
| --- | --- |
| 成果物 | 調査メモ `docs/whisper-streaming-investigation.md` と、規約文書 `docs/ARCHITECTURE.md` |
| CLAUDE.md の未決事項4件 | 調査メモに提案と根拠を書くだけにする。CLAUDE.md の未決事項は書き換えない(人が PR を読んでから決め、M1 の要件で決定事項へ移す) |
| conventionsDoc | `docs/ARCHITECTURE.md` ができたら `.claude/workflow.config.json` の `conventionsDoc` をそちらに切り替える |
| whisper.cpp のコミット固定 | Makefile の変更になるので、このリリースではやらない。調査メモで M1 の前にやることとして書く |

## 機能要件

### FR-01: 調査メモ `docs/whisper-streaming-investigation.md` を作る(優先度: 必須)

- 場所: `docs/whisper-streaming-investigation.md`(新規)

docs/fork-plan.md 手順3の調査項目1〜7に加え、未決事項の判断に要る3章を書く。章立てと中身の材料は、下の「付録:調査で分かっていること」にある。付録はサブエージェントの調査結果なので、行番号がずれている可能性がある。**書く前に一次ファイルを読み直し、引用する `path:line` は実際のコードに合わせること。**

- AC-1: 次の10章の見出しがある:①StreamingTranscriptionService の役割とプロバイダの差し替え ②途中経過が録音画面に届くまで ③録音停止後の最終テキストと、整形・置換・AI 整形への接続点 ④Whisper の呼び出し方・モデルの読み込みと保持・スレッド ⑤モデルごとの Real-time 可否の定義 ⑥録音中の音声バッファの形式と取り出し方 ⑦Whisper のリアルタイムプロバイダを足すときに触る既存ファイルと、差し込みを最小にする案 ⑧設計(CLAUDE.md の設計の要点、fork-plan 手順4)との食い違い ⑨未決事項への提案 ⑩前提と注意
- AC-2: ①〜⑥の各章に、根拠になるコードの場所が `VoiceInk/...swift:行番号` の形で1つ以上ある。そこから無作為に5件選んで開くと、書かれている内容(関数名・型名・値)がその行にある
- AC-3: ②に、途中経過の流れが型・プロパティ・呼び出し順で書かれている。今の表示が確定と未確定を区別していない(1本の String で一色)ことが書かれている
- AC-4: ③に、ストリーミングの結果を最終テキストにする場合と、WAV 全体を batch で処理し直す場合の分岐条件(`stopDisposition`、起動失敗、`stopAndFinalize` の例外、タイムアウト)が書かれている。最終テキストが整形・置換・AI 整形に入る唯一の入口(`TranscriptionPipeline` の該当行)が書かれている
- AC-5: ④に、`whisper_full` に渡しているパラメータの表(sampling、threads、language、initial_prompt、print_realtime、no_context、single_segment、temperature、VAD 関連)がある。区間やトークンの時刻を今は読んでいないことが書かれている
- AC-6: ⑦に、「ファイル / 変更内容 / 理由 / 対応するマイルストーン」の表がある。新規ファイルと既存ファイルの変更を分けて書いてある
- AC-7: ⑧に、付録の「食い違い」の各項目(少なくとも9件)について、何が設計と違い、M1〜M6 のどこで扱うかが書かれている
- AC-8: ⑨に、CLAUDE.md の未決事項4件(途中経過用モデル、処理間隔と認識対象の上限、録音停止後のやり直し、VAD の方式)それぞれについて、提案・根拠・決めるための計測方法が書かれている。決めるのは人であることが明記されている
- AC-9: whisper.cpp の API(区間の時刻、トークンの時刻、単体 VAD、`carry_initial_prompt`)に触れる箇所は、`~/VoiceInk-Dependencies/whisper.cpp/include/whisper.h` の行番号とコミット `0c7be69` を添えている
- AC-10: 口述内容(実際の認識結果のテキスト)を含まない

### FR-02: 規約文書 `docs/ARCHITECTURE.md` を作る(優先度: 必須)

- 場所: `docs/ARCHITECTURE.md`(新規)

M1 以降の実装とレビューが従う、フォークの規約をまとめる。CLAUDE.md の「作業の進め方」「設計の要点」と、FR-01 の調査で分かった既存コードの流儀を元にする。CLAUDE.md の手順を複製せず、規約(守ること)と、その根拠になる既存コードの場所を書く。

- AC-1: 次の規約が書かれている:途中経過は表示専用で、貼り付けるのは録音停止後の最終処理の結果だけ/途中経過の処理でエラーが出ても最終処理は従来どおり動く/前の回の認識が終わっていなければ次の回は飛ばす/Whisper 以外のモデル(Parakeet・Nemotron・クラウド)の動作を変えない/新しい処理は新しいファイルにまとめ、既存ファイルの変更は差し込みに必要な最小限にし、FORK-CHANGES.md に記録する
- AC-2: 既存の流儀として、プロバイダは `StreamingTranscriptionProvider` 契約に従うこと、ログは `Logger(subsystem: "com.prakashjoshipax.voiceink", category: <型名>)` を使い、口述内容を `privacy: .public` で出さないこと(秒数・文字数などの数値だけを public にする)が、根拠の `path:line` つきで書かれている
- AC-3: 並行処理の規約(`WhisperContext` への一連の呼び出しを分割しない、途中経過用と最終処理用で context を分ける、cancel・disconnect のあとに古い結果を流さない)が書かれている
- AC-4: 詳しい経緯は調査メモと CLAUDE.md を参照するよう、リンクがある

### FR-03: 結線(優先度: 必須)

- 場所: `.claude/workflow.config.json`、`CLAUDE.md`、`FORK-CHANGES.md`

- AC-1: `.claude/workflow.config.json` の `conventionsDoc` が `docs/ARCHITECTURE.md` になっている。`node -e 'JSON.parse(require("fs").readFileSync(".claude/workflow.config.json","utf8"))'` が通る
- AC-2: CLAUDE.md のマイルストーンで、M0 だけが `- [x]` になっている。調査メモへのリンクがある。CLAUDE.md の他の箇所(未決事項を含む)は変えていない
- AC-3: FORK-CHANGES.md の「追加したファイル」表に `docs/whisper-streaming-investigation.md` と `docs/ARCHITECTURE.md` と `docs/releases/release-0-whisper-investigation/requirements.md` が、ファイル・内容・理由の3列で載っている。「変更した既存ファイル」表には、`.claude/workflow.config.json` の conventionsDoc の切り替えが載っている

## 非機能要件

- アプリのコード、プロジェクト、ビルド設定を変えない:`git diff --stat feature/whisper-streaming -- VoiceInk VoiceInkRefineXPC Shared Tests VoiceInk.xcodeproj Makefile LocalBuild.xcconfig` の出力が空
- 本家の文書(README.md、BUILDING.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md)と docs/fork-plan.md(凍結)を変えない
- `make check` と `make build` が通る(コードを変えないので、従来どおり通ることの確認)
- 文章は日本語。CLAUDE.md・fork-plan.md と同じく平易な言葉で書き、用語は初出で言い換える

## スコープ外

- アプリのコードの変更(M1 以降)
- Makefile での whisper.cpp のコミット固定(M1 の前に別途)
- `scripts/deploy-mbp.sh` の作成(fork-plan 手順2-2。M1 の前に別途)
- CLAUDE.md の未決事項の決定
- MacBook Pro での計測

## 未解決事項

- なし(未決事項4件はこのリリースでは提案だけ。人が決めるまで M1 の要件は書けない)

## 用語

- 途中経過:録音中に画面に出す、仮の認識結果。貼り付けない
- 最終処理:録音停止後に、録音全体を Mode で選んだ Whisper モデルで処理し直し、整形・置換・AI 整形を経て貼り付けるまで
- batch:録音を止めてから WAV ファイル全体をまとめて認識すること
- LocalAgreement:連続した2回の認識結果で、先頭から一致した部分を「確定」とする方法

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-0-whisper-investigation", config: <.claude/workflow.config.json の内容>}})
```

---

## 付録:調査で分かっていること(FR-01・FR-02 の材料)

2026-10-17 にプランモードで調べた結果。Explore サブエージェント3本の報告に、要点を自分で確認したものと、whisper.h の確認を加えた。**行番号はずれている可能性があるので、一次ファイルで確かめてから使うこと。** パスは `VoiceInk/` 配下。

### ① StreamingTranscriptionService とプロバイダの差し替え

- 契約:`Infrastructure/Providers/Transcription/Contracts/StreamingTranscriptionProvider.swift`
  - イベント `StreamingTranscriptionEvent`(sessionStarted / partial(text:) / committed(text:) / error)
  - `StreamingStopDisposition`(finalizeStreaming / useBatchFallback)
  - protocol は connect(model:language:) / sendAudioChunk(Data)(PCM16・16kHz・mono・LE)/ commit() / disconnect() / transcriptionEvents / finalizationEvents(既定 nil)/ stopDisposition(既定 .finalizeStreaming)
- `Features/Recording/Streaming/StreamingTranscriptionService.swift`(`@MainActor`)
  - startStreaming → createProvider → connect → 送信ループとイベント消費を開始
  - sendAudioChunk は nonisolated で、AsyncStream(`.bufferingOldest(2_048)`)に積む
  - **provider を選ぶのは `createProvider(for:)`(:307-335 付近)の1か所だけ。** FluidAudio(Nemotron / Unified / その他)とクラウドだけを扱い、`.whisper` は `fatalError` になる
- FluidAudio の3種:Nemotron(本物のストリーミング)、Unified(chunk ごとに処理)、`FluidAudioStreamingProvider`(1秒ごとに認識し直す方式。**Whisper のお手本**:1秒ループ、前の回が終わっていなければ飛ばす `isTranscribing`、確定済み区間で trim、確定セグメントが3未満なら `.useBatchFallback`)
- セッション:`Features/Recording/Workflows/TranscriptionServiceRegistry.swift` の `createSession`。realtime なら `StreamingTranscriptionSession`(fallback は `service(for: model.provider)`)、それ以外は `FileTranscriptionSession`

### ② 途中経過が録音画面に届くまで

provider の `.partial` / `.committed` → `StreamingTranscriptionService.startEventConsumer`(committed を結合して1本の String に)→ `onPartialTranscript`(`VoiceInkEngine.swift` の createSession 呼び出し付近。startID と recordingState で古い結果を捨てる)→ `@Published var partialTranscript: String`(`VoiceInkEngine.swift:97` 付近)→ `RecorderStateProvider`(`Features/Recording/State/RecorderStateProvider.swift`)→ `MiniRecorderView` / `NotchRecorderView` → `LiveTranscriptView`(`Features/Recording/Components/RecorderComponents.swift:305-337` 付近。白 0.8 の一色)。

- 確定・未確定は区別していない。分けるには onPartialTranscript の型、partialTranscript、RecorderStateProvider、LiveTranscriptView、Mini/Notch の isEmpty 判定の5か所を変える
- Live Text Display は `ShowLiveTranscript`(`App/Configuration/AppDefaults.swift`)。表示を切り替えるだけで、ストリーミングの開始には関係しない

### ③ 録音停止後の最終テキスト

- `StreamingTranscriptionSession.transcribe`(`Features/Recording/Workflows/TranscriptionSession.swift:118-173` 付近)が stopAndFinalize の結果で分岐する。`.finalized` ならストリーミングの結果を使い、`.requiresBatchFallback`・例外・起動失敗なら WAV 全体を fallbackService で処理する
- batch に戻る:起動失敗、stopAndFinalize の例外、`stopDisposition == .useBatchFallback`、finalizationEvents が10秒来ない、Unified で chunk を捨てた。戻らない:録音中の `.error`(ログだけ)、送信失敗(ログだけ)、waitForFinalCommit の10秒タイムアウト(その時点の結果で finalized)
- 最終テキストの入口は `TranscriptionPipeline.swift:105-113` 付近だけ。その後、出力フィルタ(:114)→ 整形(ParagraphFormatter)→ 置換(WordReplacementService)→ AI 整形(enhance)→ TranscriptionDelivery(貼り付け)
- WAV は `<AppSupport>/com.prakashjoshipax.VoiceInk/Recordings/<UUID>.wav`(16kHz・mono・Int16)

### ④ Whisper の呼び出し方

- `Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift`:`actor WhisperContext`。createContext(path:) で `whisper_init_from_file_with_params`(flash_attn = true)
- `fullTranscribe(samples:)` のパラメータ:GREEDY、threads = max(1, min(8, cpu-2))、language(auto は nil)、initial_prompt、print_realtime = true、print_timestamps = true、no_context = true、single_segment = false、temperature = 0.2、VAD は `IsVADEnabled` のときだけ(threshold 0.5 ほか)
- `getTranscription()` は区間のテキストを連結するだけ。区間・トークンの時刻は読んでいない
- `WhisperTranscriptionService.swift`:読み込み済みの context が同じモデルなら再利用し、違えば一時的な context を作って使い終わったら解放する。WAV は44バイトのヘッダーを飛ばして読む
- `Features/ModelLibrary/State/WhisperModelManager.swift`:context の枠は1つ(`guard whisperContext == nil`)。録音開始後に非同期で読み込み、パイプラインが終わるたびに cleanupResources で解放する
- モデルは `~/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/<name>.bin`。base は約0.5GB、large-v3-turbo は約1.8GB。context は複数同時に持てる
- ログは `Logger(subsystem: "com.prakashjoshipax.voiceink", category: <型名>)`。時間ログの例は `TranscriptionSession.swift` の elapsed= の行

### ⑤ Real-time 可否

- `TranscriptionModel.supportsStreaming`(既定 false。Whisper は既定のまま)、`Features/ModelLibrary/Models/TranscriptionRealtimeSupport.swift`(isAvailable / isRequired / isEnabled)
- `ModeRuntimeConfiguration.swift` で isRealtimeEnabled を決める。Mode の値は `ModeConfig.isRealtimeTranscriptionEnabled`(既定 true)。トグルは `ModeConfigFormView.swift` の realtimeToggle(isAvailable のときだけ表示)

### ⑥ 音声バッファ

- `Infrastructure/Audio/CoreAudioRecorder.swift`:デバイスの Float32 を mono に平均し、16kHz に線形補間して Int16 にし(`convertAndWriteToFile`)、WAV に書いた後で同じバッファを `onAudioChunk(Data)` に渡す。スレッドは `audioProcessingQueue`。chunk の大きさはデバイスのバッファ次第
- `VoiceInkEngine.swift` の `RealtimeAudioChunkGate`:セッションの準備ができるまで chunk を最大2048個溜め、まとめて流す
- 録音中の WAV はヘッダーが確定していないので読めない。provider 側で `[Float]` に溜める(`PCMAudioConverter.float32Samples(fromPCM16Data:)`)
- 音量は `calculateMeters`(render スレッド)と `Recorder.audioMeterSnapshot()`

### ⑦ 差し込み方の案

- 新規:`WhisperStreamingProvider.swift`(独自の WhisperContext を持つ、1秒ループ、前の回が終わっていなければ飛ばす、`stopDisposition = .useBatchFallback` 固定で最終処理は既存の batch に任せる)
- 既存:`TranscriptionModel.swift`(Whisper の supportsStreaming)、`StreamingTranscriptionService.swift`(`.whisper` 分岐と依存の受け渡し)、`TranscriptionServiceRegistry.swift`(WhisperModelProvider を渡す)、`LibWhisper.swift`(途中経過用のパラメータと、区間・トークンの時刻を返す API を追加。既存の fullTranscribe は変えない)
- M2:表示の型を変える5か所。M5:ModeConfig / ModeConfigDraft / ModeConfigFormView / ModeRuntimeConfiguration

### ⑧ 設計との食い違い

1. `WordAgreementEngine`(FluidAudio 用)は空白区切りで、文末は `. ! ? ;` だけ。日本語ではほぼ確定しない → 文字単位の LocalAgreement を新しく書く
2. 確定・未確定を分けて表示するには型の変更が要る(②の5か所)
3. 区間の時刻を読んでいない → `whisper_full_get_segment_t0/t1` などを足す。内蔵 VAD がオンだと `whisper_full_get_token_data().t0/t1` は VAD 後の時刻になり、`whisper_full_get_token_t0/t1` は元の時刻に戻る(whisper.h)
4. モデルの枠が1つ → 途中経過用の context は provider が持つ
5. Whisper のモデル読み込み(録音開始後の非同期)と `session.prepare` が競合する → provider の connect で自分で読み込む
6. `print_realtime = true` のままだと1秒ごとに stderr があふれる
7. `isRealtimeTranscriptionEnabled` の既定値が true → Whisper を realtime 対応にすると、既存の Whisper の Mode で黙って有効になる。移行か、Whisper 専用のキーが要る
8. 停止時に途中経過の処理が残っていると、最終処理と CPU・GPU を取り合う → commit / disconnect で処理中の回を待つ
9. 1秒未満の音声 → 無音で埋めるか、16,000サンプル溜まるまで待つ(FluidAudioStreamingProvider に無音で埋める例がある)
10. 内蔵 VAD は `whisper_full` の中で動くので、回を飛ばす判定には使えない

### ⑨ 未決事項への提案(決めるのは人)

- 録音停止後:`.useBatchFallback` で既存の WAV 全体の処理にそのまま流せる。batch 側の変更は0 → large-v3-turbo でやり直す
- 途中経過用モデル:base から始める(large-v3-turbo と同時に載る)。M1 の計測で small と比べる
- VAD:whisper.cpp の単体 VAD API(`whisper_vad_init_from_file_with_params`、`whisper_vad_detect_speech_no_reset`、`whisper_vad_segments_from_probs` など。同梱の `ggml-silero-v5.1.2.bin` を再利用)。予備に音量のしきい値
- 処理間隔1秒・上限25秒:FluidAudio と同じ値。M1 の計測(1回の認識時間と音声の長さ)で決める。文脈は initial_prompt と carry_initial_prompt でつなぐ

### ⑩ 前提と注意

- whisper.h は `~/VoiceInk-Dependencies/whisper.cpp`(コミット `0c7be69`、2026-10-12)で確認した。Makefile はコミットを固定せずに HEAD を取るので、M1 の前に固定する
- Mac mini で `make build` を通すには cmake と Metal Toolchain が必要だった(2026-10-17 に導入)
