# release-1-whisper-partial-prototype 要件

- リリース識別子:release-1-whisper-partial-prototype(M1 前の準備 + CLAUDE.md のマイルストーン M1「表示だけの試作」)
- ステータス: 確定
- 作成日:2026-10-17
- 参照資料:CLAUDE.md(設計の要点・合格基準・未決事項)、docs/ARCHITECTURE.md(規約)、docs/whisper-streaming-investigation.md(調査メモ。差し込み案は⑦、食い違いは⑧、未決事項への提案は⑨、前提は⑩)、docs/fork-plan.md 手順2-2(配布スクリプトの原案)、docs/releases/release-0-whisper-investigation/handoff.md(前回の引き継ぎ)、docs/known-issues.md の F1、whisper.cpp のヘッダー `~/VoiceInk-Dependencies/whisper.cpp/include/whisper.h`(コミット `0c7be696371069e0baa2515ed7aa08d5a5473aa6`)

## 背景と目的

Whisper(large-v3-turbo)で口述すると、録音を止めるまで画面に1文字も出ない。話している途中で「ちゃんと拾えているか」が分からず、長く話すほど不安になる。CLAUDE.md の合格基準は「話し始めて2秒以内に文字が出る」で、今は録音停止まで0文字(10秒話せば10秒以上、何も出ない)。

このリリースでは、まず「1秒ごとに録音開始からの全音声を小さいモデルで認識し、そのまま録音画面に出す」試作(M1)を作り、MacBook Pro(M1 Pro)で、文字が出るまでの時間と1回の認識時間を初めて実測する。確定・未確定の区別(M2)、窓の切り詰め(M3)、無音対策(M4)、設定画面(M5)はやらない。

あわせて、その実測に必要な準備をする。

- whisper.cpp のコミットを固定する。今の Makefile は clone 済みなら `git pull` するので、framework を作り直すと別のコミットのコードに変わり、M1 で使う whisper.h の API がずれうる(調査メモ⑩)
- Mac mini でビルドしたアプリを MacBook Pro へ1コマンドで配る `scripts/deploy-mbp.sh` を作る。今は手で配るしかない

録音停止後の最終結果は従来どおり large-v3-turbo で全音声を処理し直したものだけを貼り付ける。途中経過は表示専用で、途中経過の処理が失敗しても遅れても、最終結果と貼り付けまでの時間に影響を出さない。

## スコープの確定(壁打ちでの決定事項)

| 論点 | 決定 |
| --- | --- |
| リリースの範囲 | M1 前の準備(whisper.cpp の固定、deploy-mbp.sh)と M1(表示だけの試作)を1つのリリースにする |
| 途中経過の有効化 | 開発用の隠し設定(UserDefaults の `WhisperStreamingEnabled`、既定 `false`)が `true` のときだけ、Whisper のモデルを Real-time 対応として扱う。既定のままなら、既存の Whisper の Mode の動作は何も変わらない(調査メモ⑧-7 の副作用を避ける)。画面での切り替えは M5 |
| 途中経過用モデル | 仮置きで `ggml-base`。隠し設定 `WhisperStreamingModelName`(既定 `ggml-base`)でモデル名を差し替えられる(small や large-v3-turbo-q5_0 との比較計測に使う)。CLAUDE.md の未決事項としては残し、M1 の計測で決める |
| 認識する音声の範囲 | 録音開始からの全音声(上限なし)。CLAUDE.md の M1 の定義どおり。長く話したときに認識時間がどう伸びるかを計測し、M3(25秒での切り詰め)の材料にする |
| 処理間隔 | 仮置きで1秒(固定)。CLAUDE.md の未決事項としては残す |
| 録音停止後の最終処理 | provider の `stopDisposition` を `.useBatchFallback` に固定し、Mode で選んだ Whisper モデル(large-v3-turbo)で WAV 全体を処理し直す。この方針は決定とし、CLAUDE.md の未決事項から決定事項へ移す |
| 停止時に進行中の途中認識(F1) | 待たない。whisper.cpp の abort callback で中断を指示し、中断の完了を待たずに `disconnect` から戻り、最終処理をすぐ始める。中断後や停止後に返ってきた結果は捨てる。ARCHITECTURE.md の規約に入れ、known-issues の F1 を解決済みにする |
| VAD | M4 で決める。このリリースでは途中経過用の認識で VAD を使わない(未決事項のまま) |
| deploy-mbp.sh の署名の確認 | ビルドしたアプリの署名が Apple Development でなければ、配布せずにエラーで止める。環境変数 `DEPLOY_ALLOW_ADHOC=1` を付けたときだけ ad-hoc 署名でも配る |
| whisper.cpp の固定先 | 調査時のコミット `0c7be696371069e0baa2515ed7aa08d5a5473aa6`(短縮 `0c7be69`)。clone 済みのものが別のコミットなら、そのコミットへ切り替えて framework を作り直す |
| 単体テスト | このリリースでは足さない(VoiceInkTests ターゲットはあるが中身のフォルダが無い)。純粋な処理が増える M2(文字単位の LocalAgreement)で、テストの仕組みと `make test` を足す |

## 機能要件

### FR-01: whisper.cpp のコミットを固定する(優先度: 必須)

- 場所: `Makefile`

`whisper` ターゲットを、決まったコミットの whisper.cpp だけを使う形に変える。`Makefile` は本家のファイルなので、変更は `whisper` ターゲットと変数1つの追加に限る(他のターゲットの整形し直しや並べ替えをしない)。

- AC-1: `Makefile` に変数 `WHISPER_CPP_COMMIT := 0c7be696371069e0baa2515ed7aa08d5a5473aa6` がある(`grep -n 'WHISPER_CPP_COMMIT' Makefile` で定義と使用箇所が出る)
- AC-2: `whisper` ターゲットから `git pull` が無くなっている(`grep -n 'git pull' Makefile` の出力が空)。clone 済みのときは、HEAD が `WHISPER_CPP_COMMIT` と違う場合だけ `git fetch` と `git checkout <WHISPER_CPP_COMMIT>` を行う
- AC-3: 新しく clone したときも、clone 後に `WHISPER_CPP_COMMIT` を checkout してから `./build-xcframework.sh` を実行する
- AC-4: clone 済みの HEAD が `WHISPER_CPP_COMMIT` と違っていたとき、framework(`build-apple/whisper.xcframework`)がすでにあっても作り直す。HEAD が一致していて framework があるときは、従来どおり作り直さずに飛ばす(今の Mac mini の状態=HEAD が `0c7be69` で framework あり、で `make setup` を実行すると「skipping build」相当の表示で終わる)
- AC-5: `make build` が通る

### FR-02: MacBook Pro への配布スクリプト `scripts/deploy-mbp.sh` を作る(優先度: 必須)

- 場所: `scripts/deploy-mbp.sh`(新規)

docs/fork-plan.md 手順2-2 の原案(ビルド → MacBook Pro のアプリを終了 → rsync でコピー → 起動)に、署名と接続の確認を足す。

- AC-1: 実行権限が付いている(`test -x scripts/deploy-mbp.sh` が成功する)。先頭が `#!/bin/bash` と `set -euo pipefail`
- AC-2: 接続先は環境変数 `MBP_HOST`(既定 `mbp`)、配布先は `/Applications/VoiceInk.app`。`make local` でビルドしたあと、`~/Downloads/VoiceInk.app` を `rsync -a --delete` で配布先へコピーし、`ssh` で `open` する。最後に `deployed <短縮コミット> to <ホスト>` と表示する
- AC-3: ビルド前に `ssh -o BatchMode=yes -o ConnectTimeout=5 "$MBP_HOST" true` で接続を確かめ、つながらなければ、ビルドを始めずに「`~/.ssh/config` の Host 設定と鍵(docs/fork-plan.md 手順2-2)を確認する」旨のメッセージを出して終了コード 1 で終わる
- AC-4: ビルド後に `codesign -dv --verbose=2 ~/Downloads/VoiceInk.app` の出力に `Authority=Apple Development` が無ければ、配布せずに、ad-hoc 署名では MacBook Pro 側のマイクとアクセシビリティの許可が外れる旨のメッセージを出して終了コード 1 で終わる。`DEPLOY_ALLOW_ADHOC=1` のときだけ、警告を出して配布を続ける
- AC-5: MacBook Pro 側の VoiceInk の終了は `osascript -e 'quit app "VoiceInk"'` で行い、起動していなくても失敗にしない(`|| true`)
- AC-6: `bash -n scripts/deploy-mbp.sh` が通る。`shellcheck` が入っていれば `shellcheck scripts/deploy-mbp.sh` も警告なしで通る
- AC-7: 実機での配布(手動検証必須) — Mac mini で `scripts/deploy-mbp.sh` を実行すると、MacBook Pro の /Applications/VoiceInk.app が置き換わって起動し、`ssh mbp "codesign -dv --verbose=2 /Applications/VoiceInk.app" 2>&1 | grep Authority` に `Apple Development` が出る

### FR-03: 途中経過用の認識を WhisperContext に足す(優先度: 必須)

- 場所: `VoiceInk/Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift`

途中経過用のパラメータで認識し、結果の文字列まで1回の呼び出しで返すメソッドを `WhisperContext` に足す(ARCHITECTURE.md 3-1:一連の呼び出しを分割しない)。既存の `fullTranscribe(samples:)` と `getTranscription()` は変えない(録音後の処理に影響を出さないため)。

- AC-1: 新しいメソッドが、言語・初期プロンプト・音声を引数で受け取り、`whisper_full` と結果の読み出しを actor の1回の呼び出しの中で行って、文字列(または中断・失敗を表す値)を返す。actor の状態(`setLanguage` / `setPrompt` で設定した値)に頼らない
- AC-2: 新しいメソッドの `whisper_full_params` は `print_realtime = false`、`print_progress = false`、`print_timestamps = false`、`vad = false`、`no_context = true`。sampling は既存と同じ GREEDY(調査メモ⑧-6:認識結果を stderr に出さない)
- AC-3: `abort_callback` と `abort_callback_user_data` を設定し、actor の外から立てられる中断フラグ(ロックまたは atomic で守ったもの)を callback が読む。callback は actor を経由しない(`whisper_full` の実行中は actor がふさがっているため)
- AC-4: `git diff feature/whisper-streaming -- VoiceInk/Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift` で、既存の `fullTranscribe(samples:)` と `getTranscription()` の本体に変更が無い(行の追加は新しいメソッドとその補助だけ)

### FR-04: Whisper の途中経過プロバイダを作る(優先度: 必須)

- 場所: `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift`(新規)

`StreamingTranscriptionProvider` を実装する(ARCHITECTURE.md 2-1)。お手本は `FluidAudioStreamingProvider`(調査メモ①)。確定処理は持たず、毎回の認識結果を `partial(text:)` として流すだけにする。

- AC-1: `connect(model:language:)` で、隠し設定 `WhisperStreamingModelName`(既定 `ggml-base`)のモデルファイル `<モデル置き場>/<名前>.bin` から、途中経過専用の `WhisperContext` を作る。共有の `WhisperModelManager.whisperContext` には触らない(ARCHITECTURE.md 3-2)。ファイルが無い・読み込みに失敗したときは例外を投げる(これで既存の `streamingFailed` → batch の経路に乗り、録音と最終処理は従来どおり動く。ARCHITECTURE.md 1-2)
- AC-2: `sendAudioChunk(_:)` は、届いた PCM16 を `PCMAudioConverter.float32Samples(fromPCM16Data:)` で Float32 にしてロックで守った `[Float]` に追記するだけで、認識はしない(chunk は録音処理のスレッドから届くため。調査メモ⑥)
- AC-3: 1秒ごとの Task で、録音開始からの全音声を FR-03 のメソッドで認識する。前の回が終わっていなければその回は飛ばす(ARCHITECTURE.md 1-3)。音声が 16,000 サンプル(1秒)に満たないうちは認識しない(調査メモ⑧-9)
- AC-4: 認識結果が空でなければ `transcriptionEvents` に `.partial(text:)` を流す。`.committed` は流さない。`connect` が成功したら `.sessionStarted` を流す
- AC-5: `stopDisposition` は常に `.useBatchFallback` を返す(録音停止後は Mode のモデルで WAV 全体を処理し直す)
- AC-6: `disconnect()`(と `commit()`)は、FR-03 の中断フラグを立てて認識ループを止め、進行中の認識の完了を await せずに戻る。`disconnect` のあとは `transcriptionEvents` に何も流さない。中断後・停止後に返ってきた認識結果は捨てる(F1 の対応。ARCHITECTURE.md 3-3)
- AC-7: 途中経過専用の `WhisperContext` は、進行中の認識が終わってから解放する(`whisper_full` の実行中に `whisper_free` しない)。解放を待つのは provider 内部の後始末だけで、`disconnect` の呼び出し元は待たせない
- AC-8: 1回の認識ごとに、`Logger(subsystem: "com.prakashjoshipax.voiceink", category: "WhisperStreamingProvider")` で、認識時間・音声の長さ・文字数・飛ばした回の累計を数値だけ `.public` で出す(形式は `elapsed=0.42s audio=12.0s chars=35 skipped=3` のように `elapsed=…s audio=…s chars=… skipped=…`)。認識結果の文字列・プロンプトは `.public` で出さない(ARCHITECTURE.md 2-3)。最初の文字を流した回だけ、`connect` からの経過秒も出す(「2秒以内に文字が出る」の計測用)
- AC-9: 認識の失敗(FR-03 が失敗を返した回)はその回を捨ててログに数値だけ残し、ループは続ける。`.error` イベントで録音を止めない

### FR-05: 結線(優先度: 必須)

- 場所: `VoiceInk/Features/ModelLibrary/Models/TranscriptionRealtimeSupport.swift`、`VoiceInk/Features/Recording/Streaming/StreamingTranscriptionService.swift`、`VoiceInk/Features/Recording/Workflows/TranscriptionServiceRegistry.swift`、`VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingSettings.swift`(新規)

隠し設定のキーと既定値は新しいファイル `WhisperStreamingSettings.swift` にまとめ、既存ファイルからはそれを読むだけにする。既存ファイルの変更は差し込みに必要な行だけにする(ARCHITECTURE.md 1-5)。

- AC-1: `WhisperStreamingSettings.swift` に、`WhisperStreamingEnabled`(Bool、既定 `false`)と `WhisperStreamingModelName`(String、既定 `ggml-base`)のキー名と既定値の読み出しがある
- AC-2: `TranscriptionRealtimeSupport.isAvailable(for:)` は、`model.provider == .whisper` かつ `WhisperStreamingEnabled == true` のときに `true` を返す。それ以外は従来どおり `model.supportsStreaming` を返す。`WhisperStreamingEnabled` が `false`(既定)のとき、Whisper のモデルの `isAvailable` / `isEnabled` は従来どおり `false` になる(コード実査で確かめる)
- AC-3: `StreamingTranscriptionService.createProvider(for:)` に `model.provider == .whisper` の分岐が足され、`WhisperStreamingProvider` を返す。FluidAudio とクラウドの分岐の順序・条件は変えない(ARCHITECTURE.md 1-4)。Whisper の provider に必要な依存(モデル置き場の URL)は `init` の省略可能な引数として足し、既存の呼び出し元は変更なしでコンパイルが通る
- AC-4: `TranscriptionServiceRegistry.createSession` は、`model.provider == .whisper` のときだけ、モデル置き場(`modelsDirectory`)を `StreamingTranscriptionService` に渡す(`fluidAudioService` を渡している既存の行と同じ形)
- AC-5: `git diff --stat feature/whisper-streaming -- VoiceInk` に出るファイルが、FR-03・FR-04・FR-05 の「場所」に挙げたものだけである。`TranscriptionPipeline.swift`、`TranscriptionDelivery.swift`、`WhisperTranscriptionService.swift`、`ModelPrewarmService.swift`、`TranscriptionSession.swift`、`VoiceInkEngine.swift`、FluidAudio とクラウドの provider は変わっていない
- AC-6: `make build` が通る

### FR-06: 規約と記録の更新(優先度: 必須)

- 場所: `docs/ARCHITECTURE.md`、`docs/known-issues.md`、`FORK-CHANGES.md`、`docs/releases/release-1-whisper-partial-prototype/e2e-verification.md`(新規)

- AC-1: `docs/ARCHITECTURE.md` に「録音停止時に途中認識の完了を待たない」規約が、根拠(`StreamingTranscriptionService.swift` の `cleanupStreaming` が `provider.disconnect()` を await していること、F1)つきで足されている。中断は abort callback で指示し、中断後の結果は捨て、context の解放は provider 内部で認識の終了後に行うことが書かれている。既存の規約は弱めない
- AC-2: `docs/known-issues.md` の F1 がバックログから「解決済みログ」の表へ移り、解決リリースに `release-1-whisper-partial-prototype(FR-04 AC-6、FR-06 AC-1)` が書かれている
- AC-3: `FORK-CHANGES.md` の「追加したファイル」表に `scripts/deploy-mbp.sh`、`WhisperStreamingProvider.swift`、`WhisperStreamingSettings.swift`、このリリースの `requirements.md` と `e2e-verification.md` が、「変更した既存ファイル」表に `Makefile`、`LibWhisper.swift`、`TranscriptionRealtimeSupport.swift`、`StreamingTranscriptionService.swift`、`TranscriptionServiceRegistry.swift` が、ファイル・変更内容・理由の3列で載っている
- AC-4: `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md` に、FR-07 の手動検証の手順(隠し設定の入れ方、モデルの用意、ログの取り方)と、実施記録の表がある。手順のコマンドはそのまま貼って実行できる形(下の「用語」の `defaults write` の行を含む)

### FR-07: MacBook Pro での実機確認(優先度: 必須)

- 場所: `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md`

前提:FR-02 AC-7 で配布できていること、MacBook Pro に `ggml-base` と large-v3-turbo がダウンロード済みであること、隠し設定 `WhisperStreamingEnabled` を `true` にしてあること、Whisper(large-v3-turbo)の Mode の Real-time がオンであること。

- AC-1: 短い発話(手動検証必須) — 5秒程度の一文を話すと、録音画面に文字が出る。最初の文字が出るまでの秒数(FR-04 AC-8 のログ)を記録する。合格基準の2秒以内は目標として記録し、このリリースの合否にはしない(M1 は計測が目的)
- AC-2: 長い口述(手動検証必須) — 60秒以上話し続け、1回の認識時間と音声の長さをログから取り、5・10・20・30・60秒あたりの値を e2e-verification.md に記録する。アプリが固まらず、録音を止めれば貼り付けまで終わる
- AC-3: 最終結果(手動検証必須) — 録音停止後に貼り付けられる文字が、途中経過の表示ではなく large-v3-turbo の録音後処理の結果である(途中経過と違う表記が出ることを1回以上確かめる、または `TranscriptionSession` のログに batch fallback の行が出る)。録音停止から貼り付けまでの時間を、`WhisperStreamingEnabled` が `false` のときと比べて記録する
- AC-4: 途中で中止(手動検証必須) — 録音中に Esc で中止すると、途中経過の表示が消え、次の録音がすぐ始められる
- AC-5: 既定の動作(手動検証必須) — `WhisperStreamingEnabled` を消す(`defaults delete`)と、Whisper の Mode で途中経過が出ず、従来どおり録音停止後に貼り付けられる

## 非機能要件

- FR-01・FR-02(ビルドと配布の系列)と FR-03〜FR-05(アプリの系列)は独立に実装可能
- 途中経過の処理は録音停止から貼り付けまでの時間を伸ばさない。停止時に進行中の認識を待たない(FR-04 AC-6)
- 口述内容(認識結果の文字列)を `.public` のログ、リポジトリ内のファイル(`logs/` を除く)、外部へ出さない。`logs/` はコミットしない
- entitlements と権限(マイク、アクセシビリティ)は追加しない
- Whisper 以外のモデル(Parakeet・Nemotron・クラウド)の動作を変えない。`WhisperStreamingEnabled` が既定の `false` のとき、Whisper のモデルの動作も変えない
- 本家の文書(README.md、BUILDING.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md)と docs/fork-plan.md(凍結)を変えない
- `make check` と `make build` が通る

## スコープ外

- 確定・未確定の区別と表示の型の変更(M2)。このリリースの表示は既存の `LiveTranscriptView` の一色のまま
- 文字単位の LocalAgreement と単体テストの仕組み・`make test`(M2)
- 25秒での窓の切り詰め、区間・トークンの時刻の API(M3)
- VAD による無音時の認識の省略(M4)
- 設定画面への項目追加(途中経過の有効・無効、モデル、間隔。M5)。このリリースは隠し設定だけ
- 初期プロンプトで文脈をつなぐ処理(M3)。このリリースの途中経過の認識では初期プロンプトに Mode の語彙(`context.prompt`)を渡すかどうかは設計で決めてよいが、確定済みの末尾を渡す処理は作らない
- Mac mini の Apple Development 証明書の取得と、`mbp` への SSH 設定(人が手で行う。下の未解決事項)
- 普段使いと開発版を別アプリに分けるビルド(当面は置き換えで運用する。CLAUDE.md の決定事項)

## 未解決事項

- **人の作業が必要**:2026-10-17 時点で、Mac mini では `security find-identity -v -p codesigning` が `0 valid identities found`、`ssh mbp` が `Could not resolve hostname mbp`(`~/.ssh/config` に `Host mbp` が無い)。この2つがそろわないと、FR-02 AC-7 の配布と FR-07 の手動検証はすべて実施できない(FR-02 AC-4 の決定どおり、ad-hoc 署名では配布しない)。手順は docs/fork-plan.md 手順2(署名)と手順2-2(SSH)。run-release は手動検証が未実施のまま draft PR になる
- **設計で確かめる**:abort callback で中断したときの `whisper_full` の戻り値(whisper.cpp `0c7be69` の `src/whisper.cpp` には負の戻り値が複数ある)。中断と失敗をどう見分けるかを決めないと、FR-03 AC-1 の戻り値の型と FR-04 AC-9 のログの区別が書けない
- **設計で確かめる**:途中経過用モデルの読み込みにかかる時間。読み込み中に届いた音声は溜めておき、読み込み後の最初の回で認識する(FR-04 AC-2・AC-3)。`connect` が読み込み完了まで戻らない形でよいか(`TranscriptionSession.prepare` がバックグラウンドで待ち、その間の音声は `RealtimeAudioChunkGate` が最大 2,048 個まで溜める。調査メモ②⑥)を確かめないと、FR-04 AC-1 の読み込みの置き場所が決まらない

## 用語

- 途中経過:録音中に画面に出す、暫定の認識結果。貼り付けには使わない
- 最終処理:録音停止後に、Mode で選んだ Whisper モデルで WAV 全体を認識し直し、整形・置換・AI 整形を経て貼り付ける従来の流れ
- 隠し設定:設定画面に出ない UserDefaults の値。MacBook Pro で次のように入れる(アプリの再起動後に効く):

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingEnabled -bool true
```

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingModelName -string ggml-base
```

- batch fallback:録音停止時に、ストリーミングの結果を使わず WAV 全体を処理し直す既存の経路(`StreamingStopDisposition.useBatchFallback`)

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-1-whisper-partial-prototype", config: <.claude/workflow.config.json の内容>}})
```
