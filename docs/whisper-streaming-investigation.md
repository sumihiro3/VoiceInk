# Whisper 途中経過表示の調査メモ

## 目的

録音中に Whisper(whisper.cpp)で途中経過を表示する「疑似リアルタイム処理」を足すために、既存の実装を読んで、差し込み位置と注意点をまとめる。この文書は調査結果であり、コードは変更していない。

- 調査日: 2026-10-17
- 対象ブランチ: `release-0-whisper-investigation`(main は本家 `9ce98ec` と同じ状態)
- 行番号について: `VoiceInk/...swift:行番号` はすべて調査時点のもの。本家の更新で動くので、使う前に開いて確かめる。
- この文書には口述内容(実際の認識結果)を書かない。

---

## ① StreamingTranscriptionService の役割とプロバイダの差し替え

### 役割

`StreamingTranscriptionService` は、録音中の音声を「プロバイダ」に流し、プロバイダから返るイベントを集めて最終テキストにする、共通の進行役である(`VoiceInk/Features/Recording/Streaming/StreamingTranscriptionService.swift:117`)。プロバイダとは、音声を受けて文字を返す部品のことで、クラウド系と FluidAudio(Mac 上で動く別系統のモデル)がある。

- 音声は `sendAudioChunk` で受ける(`:193`)。録音スレッドから呼ばれるので、いったん `AsyncStream` に積む。この入れ物は最大 2,048 個までで、あふれた分は捨てて数える(`:13` の `.bufferingOldest(2_048)`、`:195-196`)。
- 積んだ音声は送信ループがプロバイダへ順に渡す(`:338-355`)。
- プロバイダのイベントは別のタスクが読み続ける(`:370-429`)。

### プロバイダの契約

契約は `VoiceInk/Infrastructure/Providers/Transcription/Contracts/StreamingTranscriptionProvider.swift` にある。

| 項目 | 内容 | 場所 |
|---|---|---|
| イベント | `sessionStarted` / `partial(text:)` / `committed(text:)` / `error(Error)` の4種 | `:4-9` |
| 終わり方の指定 | `StreamingStopDisposition` は `finalizeStreaming`(ストリーミングの結果を使う)と `useBatchFallback`(WAV 全体を処理し直す)の2種 | `:12-15` |
| protocol のメソッド | `connect(model:language:)`、`sendAudioChunk(_:)`、`commit()`、`disconnect()` | `:50-59` |
| protocol のプロパティ | `stopDisposition`、`transcriptionEvents`、`finalizationEvents` | `:47`、`:62`、`:66` |
| 既定値 | `stopDisposition` は `.finalizeStreaming`、`finalizationEvents` は `nil` | `:70-71` |

音声の形式は「16bit・16kHz・モノラル・リトルエンディアンの PCM」と契約に書かれている(`:52`)。

イベントの意味は、サービス側の消費コードから読み取れる。

- `partial` は「いま聞こえている全文の暫定版」で、表示にだけ使う(`StreamingTranscriptionService.swift:400-419`)。
- `committed` は「確定した一区間」で、`committedSegments` に積み、最終テキストの材料になる(`:378-399`)。

### provider を選ぶ場所は一か所だけ

`createProvider(for:)`(`StreamingTranscriptionService.swift:307`)が唯一の選択点である。

1. `model.provider == .fluidAudio` なら、モデル名で3種に分ける(`:308-326`)。
   - Nemotron 系: `FluidAudioNemotronStreamingProvider`(`:309-311`)
   - Parakeet Unified 系: `FluidAudioUnifiedStreamingProvider`(`:313-318`)
   - それ以外: `FluidAudioStreamingProvider`(`:325`)
2. FluidAudio 以外は、クラウド側の登録簿から探す(`:327-328`)。見つからなければ `fatalError`(`:330`)。

`fatalError` は3か所ある。`:315` と `:321` は FluidAudioTranscriptionService が渡されていないとき、`:330` は未対応のプロバイダのときである。

> 要件の付録は「`.whisper` は `fatalError`」と書いていたが、正確には違う。`createProvider` に `.whisper` 専用の分岐は無い。Whisper のモデルが来ると、FluidAudio の分岐を素通りしてクラウドの guard(`:327`)に落ち、`:330` の `fatalError("Unsupported streaming provider…")` になる。

今は、そこへ Whisper が来ない作りになっている。

- Whisper のモデル(`TranscribeCppModel`)は `supportsStreaming` の既定値が `false`(`VoiceInk/Features/ModelLibrary/Models/TranscriptionModel.swift:65`)。
- Real-time の可否は `TranscriptionRealtimeSupport.isEnabled` が `supportsStreaming` から決める(`VoiceInk/Features/ModelLibrary/Models/TranscriptionRealtimeSupport.swift:4-6`、`:17-21`)。
- 判定結果は `ModeRuntimeConfiguration.swift:133` の `isRealtimeEnabled` に入り、`TranscriptionServiceRegistry.swift:82-84` の `shouldUseRealtimeTranscription` が返す。
- `fatalError` のメッセージ自身が「`shouldUseRealtimeTranscription()` を先に確かめること」と書いている(`StreamingTranscriptionService.swift:331`)。

したがって Whisper を足すなら、`supportsStreaming` を true にするだけでは足りず、`createProvider` に `.whisper` の分岐を同時に足さないと起動時に落ちる。この対の関係は⑦で扱う。

### FluidAudio の3種と、Whisper のお手本になる理由

| プロバイダ | 方式 | 場所 |
|---|---|---|
| `FluidAudioNemotronStreamingProvider` | モデル自身がストリーミング対応 | `.../FluidAudio/Streaming/FluidAudioNemotronStreamingProvider.swift` |
| `FluidAudioUnifiedStreamingProvider` | Parakeet Unified。音声が捨てられたときは batch に戻す(`StreamingTranscriptionService.swift:206-211`) | `.../FluidAudio/Streaming/FluidAudioUnifiedStreamingProvider.swift` |
| `FluidAudioStreamingProvider` | 「1秒ごとに溜めた音声を丸ごと認識し直し、前回と一致した部分を確定する」方式 | `.../FluidAudio/Streaming/FluidAudioStreamingProvider.swift` |

Whisper は「ストリーミング専用のモデルではなく、まとまった音声を一度に認識するモデル」なので、3番目の `FluidAudioStreamingProvider` が、CLAUDE.md の設計の要点(一定間隔で認識し、一致部分を確定する)とほぼ同じ形をしている。参考にできる点は次のとおり(以下、`FluidAudioStreamingProvider.swift` の行)。

- 音声を `audioBuffer` に溜め、ロックで守る(`:14-15`、`:82-87`)。
- 間隔(既定1秒、`WordAgreementEngine.swift:41` の `transcribeIntervalSeconds`)で認識ループを回す(`:121-136`)。
- 前の回が終わっていなければ、その回は飛ばす。`isTranscribing` が目印(`:27`、`:139`、`:149-150`)。
- 新しい音声が一定量たまるまで認識しない(`:146-147`)。
- 前後2回の結果で先頭から一致した単語を確定する `WordAgreementEngine`(`.../WordAgreementEngine.swift:57`、一致の判定は `:107`・`:222-235`)。
- 確定した位置より前の音声はバッファから切り捨てる(`:236-248`)。
- 確定した区間が少ないまま止めたら batch に戻す。確定が3区間未満なら `.useBatchFallback`(`:31`、`:35-41`)。
- 停止時に未確定の残りだけを最後に認識して、`committed` として出す(`:89-97`、`:257-294`)。

ただし違いも2点ある。

- FluidAudio は単語ごとの開始・終了時刻(`TokenTiming`)を取れる前提で確定位置を決めている(`:202-205`)。Whisper で同じことをするには、whisper.cpp の区間の時刻を取り出す必要がある(④・⑦で扱う)。
- `WordAgreementEngine` は英語のような「空白区切りの単語」と SentencePiece の `▁` を前提にしている(`WordAgreementEngine.swift:163-218`)。日本語の確定処理は別に設計が要る(⑧・⑨で扱う)。

---

## ② 途中経過が録音画面に届くまで

### 流れの全体

録音が始まってから画面に文字が出るまでの順序は次のとおり。

1. `VoiceInkEngine` が録音を始める。録音ごとに `startID`(`UUID`)を作って `activeRecordingStartID` に入れる(`VoiceInk/Features/Recording/Workflows/VoiceInkEngine.swift:242-243`)。
2. 録音音声の受け口として `RealtimeAudioChunkGate`(`:8`)を作り、`recorder.onAudioChunk` につなぐ(`:255-256`)。これは「プロバイダが準備できるまで音声を一時的に溜める門」で、溜められる数は最大2,048個(`:16`)。
3. 録音が `.recording` に入った後(`:279`)、モードの設定から `isRealtimeEnabled` を見て(`:325`)、Real-time なら `serviceRegistry.createSession(for:onPartialTranscript:)` を呼ぶ(`:326-339`)。
4. `createSession` が `StreamingTranscriptionService` を作り、`onPartialTranscript` を渡す。それを `StreamingTranscriptionSession` で包んで返す(`VoiceInk/Features/Recording/Workflows/TranscriptionServiceRegistry.swift:63-76`)。
5. `session.prepare` がバックグラウンドで `startStreaming` を始め、音声を送るコールバックを返す(`.../TranscriptionSession.swift:68-116`)。返ってきたコールバックで門を開け、溜めた音声を流し込む(`VoiceInkEngine.swift:346-352`)。
6. プロバイダが `partial` / `committed` を出す。サービスのイベント消費タスクが受け取り、`onPartialTranscript` に文字列を渡す(`StreamingTranscriptionService.swift:378-419`)。
7. `onPartialTranscript` の中身は、`Task { @MainActor … }` でメインスレッドに移り、`self.partialTranscript = partial` と代入する(`VoiceInkEngine.swift:328-337`)。
8. `partialTranscript` は `@Published var`(`:97`)。SwiftUI がこれを読んでいる View を再描画する。
9. View は `RecorderStateProvider` 経由で読む(`VoiceInk/Features/Recording/State/RecorderStateProvider.swift:7`)。
   - ミニ録音画面: 表示の有無は `MiniRecorderView.swift:21-25`、読み取りは `:38`、描画は `:76` の `LiveTranscriptView(text:)`。
   - ノッチ録音画面: 表示の有無は `NotchRecorderView.swift:32`、読み取りは `:124`、描画は `:221` の `LiveTranscriptView(text:)`。
10. `LiveTranscriptView`(`VoiceInk/Features/Recording/Components/RecorderComponents.swift:305`)が `Text(text)` を1つ描く(`:311`)。

### 古い結果を捨てる仕組み

録音が終わった後や別の録音が始まった後に、遅れて届いた途中経過で画面が汚れないよう、次の3段で守っている。

- `onPartialTranscript` の中で `activeRecordingStartID == startID` かつ `recordingState == .recording` のときだけ代入する(`VoiceInkEngine.swift:330-335`)。録音が替わると `startID` が合わなくなる。
- サービス側でも、状態が `.streaming` のときだけ `onPartialTranscript` を呼ぶ(`StreamingTranscriptionService.swift:393`、`:406`)。
- `cancel()` と `cleanupStreaming()` で `onPartialTranscript = nil` にする(`:283`、`:493`)。
- 画面側は `partialTranscript = ""` で消す。録音の開始時・終了時・キャンセル時などで6か所ある(`VoiceInkEngine.swift:188`、`:227`、`:676`、`:680`、`:697`、`:726`)。

なお、`partial` の文字列の作り方にも決まりがある(`StreamingTranscriptionService.swift:406-418`)。サービスは確定済みの区間をつないだ文字列(`committedSegments`)を持っていて、プロバイダの `partial` がそれで始まっていればそのまま表示し、始まっていなければ「確定済み + 空白 + partial」にして表示する。`committed` が来た直後も、確定済みの全体で表示を更新する(`:393-395`)。

### 今の表示は「確定」と「未確定」を区別していない

- 画面に渡るのは `String` 1本だけ(`VoiceInkEngine.swift:97`、`RecorderStateProvider.swift:7`)。確定部分と未確定部分の境目の情報は、`StreamingTranscriptionService` の中で潰れて画面には届かない。
- 描画も `Text(text)` を `.foregroundColor(.white.opacity(0.8))` の一色で出すだけ(`RecorderComponents.swift:311-313`)。
- 空かどうかの判定(`MiniRecorderView.swift:25`、`NotchRecorderView.swift:32`)も、文字列が空かどうかしか見ない。

CLAUDE.md の設計の要点にある「確定(通常の文字)+未確定(薄い文字)」を実現するには、この1本の `String` を2つの値(確定・未確定)に変える必要がある。変更箇所は5か所にまとまる(⑦で一覧にする)。

### ShowLiveTranscript は表示を切り替えるだけ

`ShowLiveTranscript` は設定画面の「Live Text Display」のトグル(`VoiceInk/Features/Settings/Views/SettingsView.swift:224-226`)で、キー名は `VoiceInk/App/Configuration/AppDefaults.swift:12`、既定値は `true`(`:152`)。

- 読むのは View だけ(`MiniRecorderView.swift:10`、`:23`、`:37`、`NotchRecorderView.swift:10`、`:32`、`:123`)。
- 認識の処理(プロバイダ、サービス、`VoiceInkEngine`)はこの設定を見ない。オフでも、Real-time のモデルなら途中経過の認識は走り続け、表示だけが隠れる。
- 説明文は「Real-time のモデルのときに、録音中の文字を見せる」(`SettingsView.swift:226`)。

したがって「途中経過を認識するか」の設定は、これとは別に作る必要がある(M5 の範囲)。

---

## ③ 録音停止後の最終テキストと、整形・置換・AI 整形への接続点

### 録音停止から最終テキストまで

1. 録音を止めると `partialTranscript = ""` にして状態を `.transcribing` にし、録音を止める(`VoiceInkEngine.swift:186-190`)。
2. 録音ファイル(WAV)があれば、保留状態の `Transcription` を作って保存し、`runPipeline(on:audioURL:…)` を呼ぶ(`:192-212`)。
3. `TranscriptionPipeline` が、セッションがあれば `session.transcribe(audioURL:)`、なければ `serviceRegistry.transcribe(audioURL:model:context:)` を呼ぶ(`VoiceInk/Features/Recording/Workflows/TranscriptionPipeline.swift:105-113`)。

最終テキストが整形・置換・AI 整形へ入る入口は、この `:105-113` の1か所だけである。ここで得た文字列が変数 `text` に入り、以降の処理はすべてこの `text` を加工する。Whisper の途中経過を追加しても、最終テキストをここへ渡す形を守れば、後ろの処理は無改造で済む。

### ストリーミングの結果を使う場合と、WAV 全体を batch で処理し直す場合

分岐は `StreamingTranscriptionSession.transcribe(audioURL:)`(`VoiceInk/Features/Recording/Workflows/TranscriptionSession.swift:118-173`)と `StreamingTranscriptionService.stopAndFinalize()`(`StreamingTranscriptionService.swift:201-278`)にある。

**batch に戻る(WAV 全体を `fallbackService.transcribe` に渡す。`TranscriptionSession.swift:164-172`)**

| 条件 | 場所 |
|---|---|
| 起動に失敗した(`startStreaming` が例外を投げ、`streamingFailed = true` になる) | `TranscriptionSession.swift:107-112`、`:130`、`:155-160` |
| `stopAndFinalize` が例外を投げた(接続前や状態が `.streaming` でないときの `notConnected`、`commit` の失敗など) | `StreamingTranscriptionService.swift:202-204`、`:243-252`。受ける側は `TranscriptionSession.swift:145-154` |
| プロバイダの `stopDisposition` が `.useBatchFallback` | `StreamingTranscriptionService.swift:213-218`。結果は `.requiresBatchFallback`(`TranscriptionSession.swift:142-144`) |
| Unified プロバイダで音声が捨てられた | `StreamingTranscriptionService.swift:206-211` |
| プロバイダが終端の確認(`finalizationEvents`)を持つのに、10秒以内に確認が来なかった | `:233-234`、`:257-263`、タイムアウトは `:477` |

**ストリーミングの結果を最終テキストにする(`.finalized(text:)`)**

- `stopDisposition` が `.finalizeStreaming`(既定値。`StreamingTranscriptionProvider.swift:70`)のとき。
- そのうえで、`commit()` を送り、確定の合図を待って(`StreamingTranscriptionService.swift:243-267`)、集めた確定区間をつないだ文字列を返す(`:463`、`:277`)。
- 受ける側は `TranscriptionSession.swift:137-141`。

**注意点(タイムアウトでは batch に戻らない場合がある)**

`finalizationEvents` を持たないプロバイダは、`waitForFinalCommit` で最長10秒待つ(`StreamingTranscriptionService.swift:432-464`、待ち時間は `:443`)。10秒たっても合図が来なければ、警告を出したうえで、それまでに集まった確定区間をつないで返す。集まっていなければ空文字になる(`:459-463`)。つまりこの経路のタイムアウトは batch に戻らず、`.finalized` のまま空または不完全な文字列を返しうる。

Whisper のプロバイダは `stopDisposition` を常に `.useBatchFallback` にする案(⑦)なので、この注意点には当たらない。録音停止時は必ず `:213-218` で batch に戻り、従来の WAV 全体の処理になる。これが CLAUDE.md の「途中経過の処理でエラーが出ても、録音後の最終処理は従来どおり動く」を守る最も単純な方法である。

どちらの場合も、サービスの後始末は `cleanupStreaming()`(`:492-505`)が行う。

### WAV の保存場所と形式

- 保存場所は `~/Library/Application Support/com.prakashjoshipax.VoiceInk/Recordings/`(`VoiceInkEngine.swift:145-148`)。ファイル名は `UUID().wav`(`:251-253`)。
- 形式は 16kHz・モノラル・PCM Int16(`VoiceInk/Infrastructure/Audio/CoreAudioRecorder.swift:464-466`)。契約の「16bit・16kHz・モノラル」(`StreamingTranscriptionProvider.swift:52`)と同じである。
- 録音の開始に失敗したときは、このファイルを削除する(`VoiceInkEngine.swift:411-413`)。文字起こしが終わった後に WAV を残すか消すかは、本調査では追っていない(未確認)。

### 最終テキストのその後(整形 → 置換 → AI 整形 → 貼り付け)

`TranscriptionPipeline.swift` の処理順は次のとおり。

| 順 | 処理 | 行 |
|---|---|---|
| 1 | 出力フィルタ `TranscriptionOutputFilter.filter`(`[]`・`()`・`{}` やタグ囲みを除く。`VoiceInk/Features/Recording/Processing/TranscriptionOutputFilter.swift:10`) | `TranscriptionPipeline.swift:114` |
| 2 | 前後の空白を除く | `:122` |
| 3 | トリガーワードによるモード選択 | `:124-128` |
| 4 | `ParagraphFormatter.format`(段落整形。設定が有効なときだけ) | `:138-140` |
| 5 | `WordReplacementService.shared.applyReplacements`(単語置換) | `:142` |
| 6 | `Transcription.text` に保存 | `:147` |
| 7 | `enhancementService.enhance`(AI 整形。設定が有効で、短文スキップに当たらないとき) | `:172-199` |
| 8 | `TranscriptionDelivery.deliver`(貼り付けなどの出力) | `:277-294` |

貼り付けの実体は `TranscriptionDelivery.paste`(`VoiceInk/Features/Recording/Workflows/TranscriptionDelivery.swift:167-175`)で、最終的に `CursorPaster.startPasteAtCursor` を呼ぶ。貼り付けられるのは、この流れを通った最終テキストだけで、途中経過(`partialTranscript`)は貼り付けに一切使われない(`partialTranscript` は表示専用で、`TranscriptionPipeline` からは参照されない)。

### ログの見本

`TranscriptionSession.swift` は、時間と文字数だけを `privacy: .public` で出している(`:102-104`、`:138-140`、`:169-171`)。口述内容は出さない。途中経過の計測ログも、この流儀(経過秒・音声の長さ・文字数のみ)に合わせる。ただし `:110` と `:149` はエラー内容を `.public` で出しているので、口述内容を含みうるエラーメッセージを足さないこと。

---

## ④ Whisper の呼び出し方・モデルの読み込みと保持・スレッド

whisper.cpp(Whisper を C/C++ で動かすライブラリ)を呼ぶ入口は、`VoiceInk/Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift` の `actor WhisperContext`(`:11`)だけである。コメントにあるとおり、whisper.cpp は複数スレッドから同時に触れないため、actor(同時に1つの処理しか通さない仕組み)で守っている(`:10`)。

### `whisper_full` に渡すパラメータ

以下は `fullTranscribe(samples:)`(`LibWhisper.swift:32`)が組み立てる値である。途中経過用に別の値を使いたいときは、この関数を変えずに、別の関数として足す方針(⑦)。

| パラメータ | 値 | 根拠 path:line |
|---|---|---|
| sampling(単語の選び方) | `WHISPER_SAMPLING_GREEDY`(各時点で最も確からしい候補を選ぶ。Beam search は使わない) | `LibWhisper.swift:36` |
| n_threads(計算に使うスレッド数) | `max(1, min(8, CPU数 - 2))`。最大8、最小1 | `:35`、`:64`。CPU数は `ProcessInfo.processInfo.processorCount`(`:167-169`) |
| language | Mode で選んだ言語。`auto` のときは `nil`(自動判定) | `:38-47` |
| initial_prompt | `prompt` があるときだけ渡す。録音後の処理では `context.prompt ?? ""` を渡す | `:49-57`、呼び出し側 `WhisperTranscriptionService.swift:62` |
| print_realtime | `true`(whisper.cpp が認識結果を stderr に出す。詳しくは⑧) | `:59`。whisper.h は `print_realtime` に「avoid it, use callback instead」と注記(`whisper.h:501`、コミット `0c7be69`) |
| print_progress / print_special | `false` | `:60`、`:62` |
| print_timestamps | `true` | `:61` |
| translate | `false` | `:63` |
| offset_ms | `0` | `:65` |
| no_context | `true`(前の `whisper_full` の結果を文脈として持ち越さない) | `:66` |
| single_segment | `false`(複数の区間に分けてよい) | `:67` |
| temperature | `0.2` | `:68` |
| vad(発話区間の検出) | ユーザー設定 `IsVADEnabled` が `true` で、VAD モデルのパスがあるときだけ `true`。既定は `true` | `:73-76`、`:86-88`。既定値は `VoiceInk/App/Configuration/AppDefaults.swift:148` |
| VAD の細かい値 | threshold `0.50`、min_speech `250ms`、min_silence `100ms`、speech_pad `30ms`、samples_overlap `0.1`、max_speech_duration_s は `Float.greatestFiniteMagnitude`(上限なし) | `:78-85` |
| VAD モデル | アプリ同梱のリソースから `VADModelManager.shared.getModelPath()` で取得 | `:117-119` |
| flash_attn(Attention の計算を速くする Metal 向け設定) | `true`(シミュレータでは `use_gpu = false`) | `:126-132` |

`whisper_full` の呼び出しは `:92` の1か所で、失敗すると `false` を返し、呼び出し側が `VoiceInkEngineError.whisperCoreFailed` を投げる(`WhisperTranscriptionService.swift:65-70`)。

### 結果の読み取りは「テキストの連結」だけ

`getTranscription()`(`LibWhisper.swift:104-111`)は、`whisper_full_n_segments` で区間の数を取り、各区間の `whisper_full_get_segment_text` を順に連結して返すだけである。区間の開始・終了時刻(`whisper_full_get_segment_t0` など)も、トークンごとの時刻も読んでいない。

途中経過で「確定済みの区間の終わりで音声バッファを切る」(CLAUDE.md の設計の要点)ためには、区間の時刻を取る API が新しく必要になる。whisper.h には `whisper_full_get_segment_t0`(`whisper.h:640`)と `whisper_full_get_token_t0`(`whisper.h:675`)がある(コミット `0c7be69` で確認)。時刻の単位は、使う前に whisper.h のコメントで確かめること(ここでは未確認)。

### context(モデルを載せたメモリ)の枠は1つ

- アプリ全体で共有する context は `WhisperModelManager.whisperContext` の1つだけである。読み込みは `loadModel(_:)` で、冒頭に `guard whisperContext == nil else { return }` があり(`VoiceInk/Features/ModelLibrary/State/WhisperModelManager.swift:147-148`)、すでに載っていれば何もしない。2つ目のモデルを同時に載せる枠はない。
- 読み込みは録音開始後に非同期で行う。`VoiceInkEngine.swift:366-385` が `Task { @MainActor … }` の中で、Mode の現在のモデルが `.whisper` で、`whisperContext == nil` のときだけ `loadModel` を呼ぶ。つまり録音が始まった直後はまだ載っていないことがあり、途中経過の provider は「context が未準備」の状態を想定しなければならない(推測:読み込み完了を待つ処理は上の箇所には見当たらない。待ち方は M1 で決める)。
- 解放は `cleanupResources()`(`WhisperModelManager.swift:448-453`)で、`releaseResources()` を呼び(`LibWhisper.swift:150-156` で `whisper_free`)、`isModelLoaded = false` にする。`WhisperContext` が解放されるとき `deinit` でも `whisper_free` する(`LibWhisper.swift:26-30`)。
- 録音後の処理 `WhisperTranscriptionService.transcribe` は、共有 context が読み込み済みで同じモデル名ならそれを使う(`WhisperTranscriptionService.swift:27-34`)。違えば、モデルファイルから一時的な context を作り(`:36-49`)、終わったら解放する(`:76-80`)。
- そのため、途中経過用に別の小さいモデルを使うには、独自の `WhisperContext` を持つ必要がある。録音後の large-v3-turbo の context と合わせて、メモリを2つ分使う(メモリ量の計測は M1 以降)。`WhisperContext` は actor なので、途中経過の認識と録音後の認識を同じ context で同時に走らせることはできず、順番待ちになる。独立した context を持てば、互いに待たない。

### モデルの保存場所と大きさ

- 保存場所は `~/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/`(`VoiceInk/App/VoiceInk.swift:119-121`)。拡張子 `.bin` のファイルだけをモデルとして拾う(`WhisperModelManager.swift:131-138`)。ユーザーが取り込んだモデルも同じ一覧に入る。
- 一覧にある主なモデルと大きさ(`VoiceInk/Features/ModelLibrary/Models/TranscriptionModelRegistry.swift`):

| モデル名 | 大きさ | 行 |
|---|---|---|
| ggml-tiny / ggml-tiny.en | 75 MB | `:129-141` |
| ggml-base / ggml-base.en | 142 MB | `:149-161` |
| ggml-large-v2 / ggml-large-v3 | 2.9 GB | `:169-181` |
| ggml-large-v3-turbo | 1.5 GB | `:189-191` |
| ggml-large-v3-turbo-q5_0(量子化版。精度を少し落として小さくしたもの) | 547 MB | `:199-201` |

組み込みの一覧は上の8つだけで、small は無い(`TranscriptionModelRegistry.swift:128-207` を確認、2026-10-17 追記)。small を使うなら、`.bin` を取り込む機能(`WhisperModelManager.swift:458` の `importWhisperModel(from:)`)で入れる。途中経過用モデルの候補は⑨で扱う。

## ⑤ モデルごとの Real-time 可否の定義

「Real-time」(録音中に途中経過を出す)ができるかは、次の順でつながっている。

| 段 | 内容 | 根拠 path:line |
|---|---|---|
| 1 | モデルが `supportsStreaming` を持つ。プロトコルの既定は `false` | `VoiceInk/Features/ModelLibrary/Models/TranscriptionModel.swift:53`、`:65` |
| 2 | FluidAudio のモデルと、一部のクラウドのモデルだけが `supportsStreaming: true` を指定している | `TranscriptionModel.swift:98`(`FluidAudioModel`)、`TranscriptionModelRegistry.swift:45` ほか、`Infrastructure/Providers/Transcription/Cloud/CartesiaProvider.swift:20` など |
| 3 | `WhisperModel` は `supportsStreaming` を持たないので、既定の `false` になる | `TranscriptionModel.swift:229-252` |
| 4 | `TranscriptionRealtimeSupport.isAvailable` は `model.supportsStreaming` をそのまま返す | `VoiceInk/Features/ModelLibrary/Models/TranscriptionRealtimeSupport.swift:4-6` |
| 5 | `isRequired`(Real-time が必須か)は、FluidAudio の一部モデルか、ストリーミング専用のクラウドのときだけ `true` | 同ファイル `:8-14` |
| 6 | `isEnabled` は「使えない → `false`」「必須 → `true`」「Mode の値があればそれ」「無ければ `true`」の順で決める | 同ファイル `:16-21` |
| 7 | 実行時の設定 `ModeRuntimeConfiguration` が、`isEnabled` に Mode の値を渡して `isRealtimeEnabled` を作る | `VoiceInk/Features/Modes/State/ModeRuntimeConfiguration.swift:132-135` |
| 8 | Mode の設定項目 `ModeConfig.isRealtimeTranscriptionEnabled` の既定値は `true`。保存済みの設定に値が無いときも `true` で読む | `VoiceInk/Features/Modes/State/ModeConfig.swift:53`、`:145-146` |
| 9 | 設定画面は、`isAvailable` が `true` のモデルを選んだときだけ「Real-time」のトグルを出す。`isRequired` なら無効化して `true` に固定する | `VoiceInk/Features/Modes/Views/ModeConfigFormView.swift:265-281` |
| 10 | モデルを切り替えたとき、トグルの値を `isAvailable` に合わせて更新する | `ModeConfigFormView.swift:222-229` |

つまり Whisper のモデルは今、段 3 で `supportsStreaming == false` なので、設定画面にトグルが出ず、`isRealtimeEnabled` も常に `false` になる。Whisper で途中経過を出すには、少なくとも次の2点を変える必要がある(詳細は⑦)。

1. Whisper のモデルが `supportsStreaming` を返すようにする(`TranscriptionModel.swift`)。
2. `StreamingTranscriptionService.createProvider` に Whisper の分岐を足す(`StreamingTranscriptionService.swift:307-335`)。

`isRealtimeTranscriptionEnabled` の既定値が `true` なので、段 1 を変えると、既存の Mode は何も操作しなくても Whisper で途中経過が動き始める。この副作用を避けるかどうかは人が決めること(⑨で提案する)。

`IsVADEnabled` は Real-time とは別の設定で、`AppDefaults.swift:148` が `true`、モデル設定画面は `@AppStorage("IsVADEnabled")` で読み書きする(`VoiceInk/Features/ModelLibrary/Views/ModelSettingsPanel.swift:258`)。

## ⑥ 録音中の音声バッファの形式と取り出し方

### 変換の流れと形式

録音の取り込み(`VoiceInk/Infrastructure/Audio/CoreAudioRecorder.swift`)は次のとおり。

1. マイクからの入力は Float32(小数)で、複数チャンネルのこともある。入力の描画コールバックはリアルタイム処理用なので、重い処理をせず、事前に確保したリングバッファ(96スロット。`:71`)へ書き込むだけにする。バッファがいっぱいなら捨てて数える(`:874-940` 付近、`droppedInputBuffersBackpressure` など)。
2. 別スレッド(`audioProcessingQueue`。`:67-68`)が `processQueuedInputBuffers` でスロットを取り出し(`:965-998`)、`convertAndWriteToFile`(`:1034`)を呼ぶ。
3. `convertAndWriteToFile` は、Float32 の全チャンネルを平均して mono にし、入力が16kHzでなければ線形補間で16kHzにし、`sample * 32767` を Int16 に丸める(`:1054-1096` 付近)。出力形式は16kHz・mono・PCM Int16(`:44`、`:464-466`)。
4. 変換後の Int16 を、まず WAV ファイルへ `ExtAudioFileWrite` で書く(`:1096-1102` 付近)。**その直後に**、同じバッファを `Data` にコピーして `onAudioChunk` に渡す(`:1111-1115`)。順序は「ファイルへ書く → chunk コールバック」である。

### スレッドと chunk の大きさ

- `onAudioChunk` は `audioProcessingQueue` の上で呼ばれる(`:83` のコメントに「called from the recorder processing queue」とある)。コールバックの中で重い処理をすると、WAV の書き込みが遅れる。provider は chunk を受け取って溜めるだけにして、認識は別の Task で行う。
- 1 chunk は、入力1回分(最大 `maxFramesPerRender = 4096` フレーム。`:70`)を16kHzに変換した長さである。16kHz なら最大 8,192 バイト(約0.26秒)、48kHz の入力なら約 2,730 バイト(約0.085秒)が上限になる(推測:`maxFramesPerRender` からの計算。実際の chunk の大きさは、デバイスのバッファ設定で変わるので、M1 で実測する)。
- `Recorder.onAudioChunk`(`VoiceInk/Features/Recording/Capture/Recorder.swift:29-30`)が設定されると、内部の `CoreAudioRecorder` に伝わる(`:71`、`:165`)。録音を止めるときは `nil` に戻す(`:54`、`:121`)。

### エンジン側の受け口(最大2,048個)

`VoiceInkEngine.swift` の `RealtimeAudioChunkGate`(`:8`)は、provider がまだ準備できていない間に届いた chunk を最大 `2_048` 個まで溜め(`:17`、`:23-29`)、準備ができたら `activate` でまとめて渡す(`:38` 付近)。上限を超えた分は捨てて数える。エンジンは `recorder.onAudioChunk = realtimeAudioGate.receive` で接続し(`:255-256`)、終了時に `nil` へ戻す(`:355`、`:360`)。provider 側のストリームも、同じ数(2,048)で古い順に残す設定である(`StreamingTranscriptionService.swift:13`)。

### provider 側で [Float] に溜める必要がある

- 録音中の WAV を読んで認識することはできない。`WhisperTranscriptionService.readAudioSamples` は先頭44バイトを飛ばして残りを読む(`WhisperTranscriptionService.swift:85-94`、飛ばす処理は `:87`)が、これは録音が終わった完全なファイルを前提にしている。録音中は書き込み中で(推測:ヘッダーのサイズ欄は録音終了時に確定すると考えられる。実機では未確認)、44バイトという固定値にも頼りたくない。
- そのため、途中経過の provider は `onAudioChunk` で届く Int16 を自分で受け取り、`PCMAudioConverter.float32Samples(fromPCM16Data:)` で Float32(-1.0〜1.0)に直して、`[Float]` に追記していく。この関数は、各 Int16 を `/ 32767.0` して範囲を `-1.0〜1.0` に収める(`VoiceInk/Infrastructure/Audio/PCMAudioConverter.swift:5-17`)。録音後の `readAudioSamples` と同じ式(`WhisperTranscriptionService.swift:90`)なので、録音後と途中経過で音の値が揃う。
- 25秒の上限(CLAUDE.md の設計の要点)に達したら、この `[Float]` の先頭側を捨てる。16kHz なので、1秒は16,000個の Float である。25秒分は400,000個(約1.6 MB)に収まる。

### 音量の取り方(VAD の代わりの候補)

- 録音中のメーターは、入力の描画コールバックの中で `calculateMeters`(`CoreAudioRecorder.swift:889-916`)が計算する。入力 Float32 の RMS(二乗平均の平方根)とピークを dB に直し、`averagePower` と `peakPower` に、ロックなしの atomic で書く(`:47-58`)。
- 読む側は `Recorder.audioMeterSnapshot()`(`Recorder.swift:187`)で、-60dB 以下を0、0dB を1として正規化する(`:195-215` 付近)。録音画面のメーターが使っている(`NotchRecorderView.swift:199`、`MiniRecorderView.swift:59`)。
- 注意点は、このメーターは変換前の入力に対するもので、「今この瞬間」の値しか持たないことである。M4 で「10秒の無音で文字が出ない」を音量のしきい値で実現する場合は、provider が受け取った chunk から自分で RMS を計算するほうが、時刻のずれがなく確実である(提案。whisper.cpp 内蔵の VAD との比較は⑨)。

## ⑦ Whisper のリアルタイムプロバイダを足すときに触る既存ファイルと、差し込みを最小にする案

方針は「新しい処理は新しいファイルにまとめ、既存ファイルは差し込みに必要な最小限だけ触る」(CLAUDE.md)。既存の `fullTranscribe` と、録音後の batch 処理(`WhisperTranscriptionService`)は変えない。

### 新規ファイル

| ファイル | 内容 | 理由 | マイルストーン |
|---|---|---|---|
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift`(置き場所は案) | `StreamingTranscriptionProvider` を実装する。独自の `WhisperContext` を持ち、`connect` でモデルを自分で読み込む。`onAudioChunk` で届く Int16 を `[Float]` に溜め、1秒ごとの Task で認識する。前の回が終わっていなければ、その回は飛ばす。`stopDisposition` は `.useBatchFallback` に固定する | 最終処理を既存の batch に任せられ、「途中経過でエラーが出ても録音後は従来どおり」(CLAUDE.md)を最も単純に守れる(③)。お手本は `FluidAudioStreamingProvider`(①) | M1(M3・M4 で窓の切り詰めと無音判定を同じファイルに足す) |
| 文字単位の LocalAgreement(例: `CharacterAgreementEngine.swift`) | 連続2回の結果で、先頭から一致した文字数を確定にする。日本語では空白区切りが使えないため(⑧-1) | `WordAgreementEngine` は空白区切りの単語が前提で、日本語ではほぼ確定しない。provider から切り離すと、音声なしで単体テストできる | M2 |

### 既存ファイルの変更(差し込み)

| ファイル | 変更内容 | 理由 | マイルストーン |
|---|---|---|---|
| `VoiceInk/Features/ModelLibrary/Models/TranscriptionModel.swift`(`WhisperModel` は `:229-252`) | Whisper のモデルが `supportsStreaming` を返すようにする。ただし常に true ではなく、後述の移行方針(⑧-7)と合わせて決める | 今は既定値 `false`(`:65`)で、設定画面にトグルが出ず `isRealtimeEnabled` も常に false(⑤) | M1 |
| `VoiceInk/Features/Recording/Streaming/StreamingTranscriptionService.swift:307-335` | `createProvider` に `.whisper` の分岐を足す。`init`(`:134`)にも Whisper 用の依存を受け取る引数を足す | 分岐が無いと、Whisper は FluidAudio の分岐を素通りしてクラウドの guard から `:330` の `fatalError` に落ちる(①)。`supportsStreaming` の変更と必ず同時に入れる | M1 |
| `VoiceInk/Features/Recording/Workflows/TranscriptionServiceRegistry.swift:63-76` | `createSession` で `StreamingTranscriptionService` を作るとき、`model.provider == .whisper` なら `WhisperModelProvider`(モデルの置き場所と共有 context を知っている窓口。`WhisperModelProvider.swift:7`)を渡す。`fluidAudioService` を渡している `:71` と同じ形 | provider はモデルのパスなどを自分で知る必要がある。FluidAudio の前例に合わせる | M1 |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift` | 途中経過用のパラメータで認識する関数と、区間・トークンの時刻を返す関数を足す。`fullTranscribe`(`:32`)と `getTranscription`(`:104`)は変えない。途中経過用では `print_realtime` を `false` にする(⑧-6) | 区間の時刻を今は読んでいない(④)。録音後の処理に影響を出さないため、別の関数にする | M1(時刻の API は M3) |

### M2 で表示の型を変える5か所

画面に渡るのが `String` 1本のため(②)、確定と未確定を分けるには次の5か所で型を変える。最小にする案は、`partialTranscript: String` はそのまま残し、確定部分と未確定部分を持つ値を別に足して、`ShowLiveTranscript` の View だけがそれを読む形にすること。こうすると、他のプロバイダ(FluidAudio、クラウド)の表示は変わらない。

| ファイル | 変更内容 | 理由 |
|---|---|---|
| `VoiceInk/Features/Recording/Workflows/VoiceInkEngine.swift:97`、`:328-336` | `@Published var partialTranscript` の隣に、確定・未確定の2つの値を足す。`onPartialTranscript` のクロージャで両方を代入する | 画面への入口 |
| `VoiceInk/Features/Recording/State/RecorderStateProvider.swift:7` | プロトコルに新しい値を足す | View は `RecorderStateProvider` 経由で読む |
| `VoiceInk/Features/Recording/Components/RecorderComponents.swift:305` | `LiveTranscriptView` が「確定(通常の文字)+未確定(薄い文字)」を描けるようにする | 現状は `Text(text)` 一色(`:311-313`) |
| `VoiceInk/Features/Recording/Views/MiniRecorderView.swift:25`、`:76` | 空判定と `LiveTranscriptView` の呼び出しを新しい値に合わせる | 表示側 |
| `VoiceInk/Features/Recording/Views/NotchRecorderView.swift:32`、`:221` | 同上 | 表示側 |

なお、`StreamingTranscriptionService` の `onPartialTranscript` は `(String) -> Void` で、確定と未確定の境目を潰して1本の文字列にして渡している(②)。M2 ではここを通す経路も必要になる(`StreamingTranscriptionService.swift:393-419`)。この点は5か所の外にあり、見落としやすいので、M2 の着手時に最初に確かめる。

### M5 で触るファイル(Mode の設定)

途中経過の有効・無効、途中経過用モデル、処理間隔を Mode ごとに持たせる。

| ファイル | 変更内容 |
|---|---|
| `VoiceInk/Features/Modes/State/ModeConfig.swift` | 設定項目を足す。保存済みの設定に値が無いときの既定値を決める(`:145-146` の `decodeIfPresent` と同じ形) |
| `VoiceInk/Features/Modes/State/ModeConfigDraft.swift` | 編集中の下書きに同じ項目を足す(`:14`、`:72`、`:183`、`:208` と同じ4点セット) |
| `VoiceInk/Features/Modes/Views/ModeConfigFormView.swift:265-281` | 設定画面に項目を足す |
| `VoiceInk/Features/Modes/State/ModeRuntimeConfiguration.swift:132-135` | 実行時の設定に値を渡す |

### 差し込みを最小にするための方針

- provider は1ファイルに閉じ込め、`WhisperContext`(actor)は provider が自分で持つ。共有 context(`WhisperModelManager.whisperContext`)には触らない(④、⑧-4)。
- 最終処理は触らない。`TranscriptionPipeline.swift:105-113` の入口に、従来どおり WAV 全体の結果が入る(③)。
- `ModelPrewarmService`、`WhisperTranscriptionService`、`TranscriptionPipeline`、`TranscriptionDelivery` は変更しない。
- 既存ファイルを変えたら、`FORK-CHANGES.md` に「ファイル・変更内容・理由」を追記する(CLAUDE.md)。

## ⑧ 設計(CLAUDE.md の設計の要点、fork-plan 手順4)との食い違い

「設計」は CLAUDE.md の「設計の要点」と `docs/fork-plan.md` の手順4を指す。以下は、設計どおりに作ろうとすると既存のコードと食い違う点で、10件ある。

| # | 設計では | 実際のコードでは | 扱うマイルストーン |
|---|---|---|---|
| 1 | 連続した2回の結果で先頭から一致した部分を確定とする(LocalAgreement) | 既存の `WordAgreementEngine` は空白区切りの単語と SentencePiece の `▁` が前提(`WordAgreementEngine.swift:163-218`)。文末判定も `. ! ? ;` だけで、日本語ではほぼ確定しない。 | M2: 文字単位の LocalAgreement を新しく書く(⑦) |
| 2 | 表示は「確定(通常の文字)+未確定(薄い文字)」 | 画面に渡るのは `String` 1本で、描画も一色(`VoiceInkEngine.swift:97`、`RecorderComponents.swift:311-313`)。境目は `StreamingTranscriptionService` の中で潰れる(②) | M2: 5か所の型変更(⑦) |
| 3 | 確定済み区間の終わり(Whisper の区間の時刻)で音声バッファを切る | 区間の時刻を読んでいない。`getTranscription()` は文字をつなぐだけ(`LibWhisper.swift:104-111`)。時刻の取り方に注意点がある(下記) | M3: `whisper_full_get_segment_t0/t1`、`whisper_full_get_token_t0/t1` を返す API を足す |
| 4 | 途中経過用に別モデルを使う(base など) | モデルを載せる context の枠は共有の1つで、読み込み済みなら再読み込みしない(`WhisperModelManager.swift:147-148`)。actor なので同じ context では同時に走らせられない(`LibWhisper.swift:10`) | M1: provider が独自の `WhisperContext` を持つ |
| 5 | 話し始めて2秒以内に文字が出る | Whisper のモデル読み込みは録音開始後に非同期で始まり(`VoiceInkEngine.swift:366-385`)、`session.prepare` もバックグラウンドで動く(`TranscriptionSession.swift:68-116`)。読み込み完了を待つ処理は見当たらない(推測:④で確認した範囲) | M1: provider の `connect` で自分で読み込み、読み込み中に届いた音声は溜める。合格基準の2秒は M1 の計測で確かめる |
| 6 | 録音後の処理が従来どおり動き、ログは計測だけ出す | `print_realtime = true`(`LibWhisper.swift:59`)のままだと、whisper.cpp が認識結果を stderr に出す。whisper.h も避けるよう注記している(`whisper.h:501`)。1秒ごとに出ると stderr があふれ、口述内容が `log show` などに混ざりうる(推測:出力先の詳細は未確認) | M1: 途中経過用のパラメータでは `print_realtime = false`。M6: ログの整理 |
| 7 | 途中経過の有効・無効は Mode の設定で選ぶ(M5) | `isRealtimeTranscriptionEnabled` の既定値は `true`(`ModeConfig.swift:53`、`:145-146`)。Whisper を Real-time 対応にすると、既存の Whisper の Mode が、何も操作しなくても黙って有効になる(⑤) | M1 では環境を限って動かす(開発用)。M5 で Whisper 専用のキーを足す、または既存 Mode は無効のまま移行する。決めるのは人 |
| 8 | 録音停止後は全音声を large-v3-turbo で処理し直す | 停止時に途中経過の認識が走っていると、最終処理と CPU・GPU を取り合い、停止後の応答が遅くなる。`stopDisposition = .useBatchFallback` なら batch に戻る(`StreamingTranscriptionService.swift:213-218`)が、その前に処理中の回を待つか止める必要がある | M1: `commit` / `disconnect` で処理中の回を取り消す、または待つ。計測は M6 |
| 9 | 直近の音声を認識する | Whisper は 1 秒未満の音声で結果が不安定(推測:根拠は①で見た `FluidAudioStreamingProvider` が `minimumAudioSamples` を設けていること)。`FluidAudioStreamingProvider` は新しい音声が一定量たまるまで認識せず(`:146-147`)、短い音声は無音で埋める例がある(`:191-192`、`:280`) | M1: 16,000 サンプル溜まるまで待つ。無音で埋めるかは M1 の計測で比べる |
| 10 | 発話区間の検出(VAD)で、発話がなければ認識しない | 既存の VAD(`vad.enabled`、`LibWhisper.swift:73-88`)は `whisper_full` の中で動く。回を飛ばす判定には使えない(認識の呼び出しを始めた後でしか働かない) | M4: 単体の VAD API か音量のしきい値で、認識を呼ぶ前に判定する(⑨) |

### 補足

**付録の「`.whisper` は `fatalError`」の書き方について。** `createProvider` に `.whisper` 専用の分岐は無い。Whisper のモデルは FluidAudio の分岐(`:308`)を素通りし、クラウドの guard(`:327-328`)に落ちて `:330` の `fatalError("Unsupported streaming provider…")` になる。結果は同じ「落ちる」だが、足すべきなのは「`fatalError` を置き換える」ではなく「`.whisper` の分岐を新しく足す」こと。

**#3 の時刻の注意点(`whisper.h`、コミット `0c7be69`)。** `whisper_full_get_token_data()` が返す `token_data` の `t0` / `t1` は、`whisper.h:142-143` に「start time of the token」「end time of the token」とだけ書かれている。`whisper_full_get_token_t0/t1` のコメント(`whisper.h:670-674`)には、次のとおり書かれている。

- 単位は centisecond(1/100秒)(`:670`)
- VAD が有効なとき、`whisper_full_get_token_t0/t1` は元の音声の時間軸に戻された値になる(`:670-672`)
- 一方、`token_data` の `t0` / `t1` は VAD で処理された後の時間軸のまま(`:673`)
- VAD が無効なら、どちらも同じ生の値(`:673-674`)

つまり、内蔵 VAD をオンにしたまま確定済み区間で音声を切るときは、`token_data` の `t0/t1` を使うと、元の音声とずれた位置で切ってしまう。`whisper_full_get_token_t0/t1` を使うこと。区間の時刻 `whisper_full_get_segment_t0`(`whisper.h:640`)のコメント(`:639`)は「start and end time of the specified segment」とだけで、VAD との関係や単位は書かれていない(単位は token 側と同じと推測。M3 の前に実機で確かめる)。

## ⑨ 未決事項への提案

**決めるのは人である。** 以下は提案で、決定ではない。CLAUDE.md の「未決事項」は、このリリース(release-0)では書き換えない。M1 の計測結果を見て、人が決めたうえで、別のリリースで CLAUDE.md の「決定事項」に移す。

### 1. 途中経過用モデル(base / small / large-v3-turbo の量子化版)

| 項目 | 内容 |
|---|---|
| 提案 | base(142 MB)から始める。M1 の計測で small と比べる |
| 根拠 | 録音後の large-v3-turbo(1.5 GB)と同時にメモリへ載せることになる(④)。軽いほうが、1回の認識時間が処理間隔(1秒)を超えにくい。合格基準「60秒以上話し続けても、1回の認識時間が処理間隔を超え続けない」(CLAUDE.md)を最優先にする。組み込みの一覧は tiny、base(と .en 版)、large-v2、large-v3、large-v3-turbo、その量子化版(q5_0)で、small は無い。比べるなら取り込みで入れる(④) |
| 決めるための計測 | MacBook Pro(M1 Pro)で、同じ口述(内容は記録しない)に対し、モデルごとに(a) 1回の認識時間と音声の長さ(os_log、CLAUDE.md の設計の要点)、(b) 話し始めてから最初の文字が出るまでの時間、(c) 最終結果との一致の程度、(d) メモリ使用量を取る。(a) が 1 秒を超え続けるモデルは外す |

### 2. 処理間隔と認識対象の上限

| 項目 | 内容 |
|---|---|
| 提案 | 初期値は CLAUDE.md の設計どおり、処理間隔1秒・上限25秒。FluidAudio も間隔は1秒(`WordAgreementEngine.swift:41`)で揃う |
| 根拠 | Whisper は 30 秒の窓で動く。25秒に収めると余裕がある(推測:窓の長さは whisper.cpp の一般的な仕様による。このリポジトリでは未確認)。認識を重ねない(前の回が終わっていなければ飛ばす)ので、長すぎる間隔は表示の遅れ、短すぎる間隔は飛ばされる回が増えるだけになる |
| 決めるための計測 | 1回の認識時間と音声の長さの関係を、音声が 5・10・15・20・25 秒のときで取る。認識時間が間隔を超える長さがあれば、上限を下げるか間隔を伸ばす。文脈は `initial_prompt` と `carry_initial_prompt`(`whisper.h:528`、コミット `0c7be69`)でつなぐ案がある。ただし `carry_initial_prompt` は「前の文章への条件づけが弱まることがある」とコメントされている(`:528`)ので、使う・使わないでも比べる |

### 3. 録音停止後のやり直し(large-v3-turbo でやり直すか、確定済みの途中経過を使うか)

| 項目 | 内容 |
|---|---|
| 提案 | `stopDisposition = .useBatchFallback` で、既存の WAV 全体の処理に流し、large-v3-turbo でやり直す |
| 根拠 | batch 側の変更が0になる。「貼り付けるのはこの結果だけ」「最終結果が、従来の録音後処理と同等の表記になる」(CLAUDE.md の合格基準)を、最も確実に満たす。途中経過の処理が失敗しても、最終処理に影響しない(③) |
| 決めるための計測 | 録音停止から貼り付けまでの時間を、途中経過あり・なしで比べる(待ち時間が増えないこと)。確定済みの途中経過を使う案は、品質が劣るうえ、日本語の確定処理(⑧-1)の出来に最終結果が左右されるため、提案しない |

### 4. VAD の方式(whisper.cpp 内蔵か、音量のしきい値か)

| 項目 | 内容 |
|---|---|
| 提案 | whisper.cpp の単体 VAD API を使う。アプリ同梱の `ggml-silero-v5.1.2.bin`(`LibWhisper.swift:117-119` で使っている VAD モデル)を再利用する。予備として音量(RMS)のしきい値を用意する |
| 根拠 | 既存の VAD は `whisper_full` の中で動くため、回を飛ばす判定に使えない(⑧-10)。単体の API は `whisper.h` の次の行にある(コミット `0c7be69`):`whisper_vad_init_from_file_with_params`(`:711`)、`whisper_vad_detect_speech_no_reset`(`:721`。ストリーミング用に LSTM の状態を保ったまま呼べる。発話の区切りでは `whisper_vad_reset_state` を呼ぶ)、`whisper_vad_segments_from_probs`(`:734`)。音量のしきい値は、実装は簡単だが、小さい声や環境音に弱い |
| 決めるための計測 | 「10秒の無音で文字が出ない」(合格基準)を、(a) 静かな部屋、(b) 空調やキーボード音のある環境で試し、無音時に認識が呼ばれた回数を数える。話し始めの取りこぼし(最初の一語が欠けないか)も比べる。VAD モデルを provider が別に読み込むときのメモリと時間も測る |

## ⑩ 前提と注意

- `whisper.h` の行番号は、`~/VoiceInk-Dependencies/whisper.cpp` のコミット `0c7be69`(2026-10-12)で確かめたもの(`carry_initial_prompt` は `:528`、`whisper_full_get_segment_t0` は `:640`、`whisper_full_get_token_t0` は `:675`、`whisper_vad_init_from_file_with_params` は `:711`、`whisper_vad_detect_speech_no_reset` は `:721`、`whisper_vad_segments_from_probs` は `:734`)。
- `Makefile` の `whisper` ターゲットは、whisper.cpp をコミットを固定せずに clone する(`Makefile:29-40`)。ビルドのたびに HEAD が変わりうるので、**M1 の前にコミットを固定すること**(`0c7be69` を候補とする)。API の差(`whisper.h` の関数名や引数)で、後からビルドが壊れるのを防ぐため。
- `scripts/deploy-mbp.sh` は、まだリポジトリに無い(`scripts/` には `release.sh` と `setup-release-notarization.sh` だけがある)。手順は `docs/fork-plan.md` の「手順2-2」(`:86`)にある。**M1 の前に作ること**。動作確認は MacBook Pro で行う(CLAUDE.md)ので、これが無いと M1 の合格基準を確かめられない。
- Mac mini で `make build` を通すには、cmake と Metal Toolchain が必要だった(2026-10-17 に導入済み)。別のマシンで開発するときは、先に `make check` で確かめる。
- この文書の `VoiceInk/...swift:行番号` は調査時点(2026-10-17)のもの。本家(`upstream`)の更新で動くので、使う前に開いて確かめる。
- 「推測:」と書いた箇所は、一次ファイルで確認できていない。M1 の前後で実機・コードで確かめる。
- この文書は調査結果であり、アプリのコードは変更していない。口述内容(実際の認識結果)は書いていない。計測ログにも口述内容は含めない(`logs/` は `.gitignore` 済みで、コミットしない)。
