# FORK-CHANGES

本家(Beingpax/VoiceInk)からの変更点の記録。本家の更新を取り込むとき(`git rebase main`)の衝突解消に使う。

- 作業ブランチ:`feature/whisper-streaming`(main は本家と同じ状態に保つ)
- 目的:Whisper(whisper.cpp)で録音中に途中経過を表示する(詳細は CLAUDE.md、docs/fork-plan.md)

## 追加したファイル

| ファイル | 内容 | 理由 |
| --- | --- | --- |
| `CLAUDE.md` | フォークの方針、ビルド方法、設計の要点、マイルストーン、docs/development-workflow.md への参照 | Claude Code に作業の前提を渡すため |
| `docs/fork-plan.md` | フォーク改造の手順書(フォーク、配布、調査、設計、テスト) | 作業手順の正本 |
| `FORK-CHANGES.md` | このファイル | 本家との差分を追跡するため |
| `.claude/workflows/*.js`、`.claude/commands/*.md`、`.claude/config.schema.json` | claude-release-workflow のエンジン(テンプレートからの無改変コピー) | 開発を release-workflow(要件 → 実装 → 検査 → レビュー → PR)で進めるため。更新は `/update-release-workflow` で行い、手で編集しない |
| `.claude/workflow.config.json` | release-workflow のプロジェクト設定(検査コマンド、レビューの観点、同期先、自動化) | エンジンにプロジェクト固有の値を渡すため |
| `.claude/settings.json` | release-workflow が使う git・gh コマンドの許可 | 無人実行でコミット・release-* ブランチの push・PR 作成を通すため(ベースブランチへの push は許可しない) |
| `docs/development-workflow.md` | リリースサイクルとブランチ運用の説明 | release-workflow の運用ガイド |
| `docs/known-issues.md` | レビュー由来の既知の課題 | release-workflow が未対応の指摘を起票する先 |
| `docs/e2e-verification.md` | MacBook Pro での口述テストのケースと計測項目 | 実機でしか確かめられない受け入れ基準の手順 |
| `docs/whisper-streaming-investigation.md` | M0 の調査メモ。既存のリアルタイム処理・途中経過・最終処理・Whisper・音声バッファの調査と、差し込み案・食い違い・未決事項への提案 | M1 以降の実装の前提をそろえるため |
| `docs/ARCHITECTURE.md` | フォークの規約と、その根拠になる既存コードの場所 | M1 以降の実装とレビューが従う規約の正本にするため |
| `docs/releases/release-0-whisper-investigation/requirements.md` | release-0 の確定要件 | release-workflow の入力 |
| `scripts/deploy-mbp.sh` | `make local` でビルドし、MacBook Pro の /Applications/VoiceInk.app を置き換えて再起動する。接続確認・署名確認つき | 実機(MacBook Pro)へ配って動作確認するため(FR-02) |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift` | Whisper の途中経過用 provider。1秒周期で直近音声を認識し、停止時は await せず中断する | 録音中の途中経過表示(FR-04) |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingSettings.swift` | 途中経過の有効・無効、モデル名などの隠し設定のキーと既定値 | 設定キーを1か所に集めるため(FR-05) |
| `docs/releases/release-1-whisper-partial-prototype/requirements.md` | release-1 の確定要件 | release-workflow の入力 |
| `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md` | release-1 の実機検証の手順(署名・SSH・配布の準備を含む)と記録表 | 実機でしか確かめられない受け入れ基準の手順(FR-07) |
| `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnJapaneseSegmenter.swift` | 日本語の文を、ひらがな・カタカナ・漢字・記号の切れ目で区切る(「、」「。」は区切りの単位) | 空白のない日本語の文で、直した箇所を候補にできるようにするため(release-2 FR-01) |
| `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnForkReviewPrompt.swift` | 日本語向けの審査の指示文。返す JSON の形は本家と同じ | 言い回しだけの直しを却下し、誤認識の直しを登録するため(FR-02) |
| `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnReviewSettings.swift` | 審査の待ち時間(既定30秒、隠し設定 `AutoLearnReviewTimeoutSeconds`) | 本家の7秒では Gemini の応答が間に合わず時間切れになるため(FR-03) |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Fork/WhisperVocabularyPrompt.swift` | 辞書の語彙を、新しい登録順に「、」でつなぎ、120文字以内で Whisper の初期プロンプトに足す | 登録した語を次の口述から認識されやすくするため(FR-04) |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Fork/WhisperVocabularySource.swift` | ModelContainer を保持し、録音ごとに語彙を新しく読む | 語彙の追加・削除で変更通知が出ないため、毎回読んで次の録音から反映する(FR-04) |
| `Tests/VoiceInkTests/*.swift`(`CorrectionDiffEngineUpstreamTests`・`CorrectionDiffEngineJapaneseTests`・`AutoLearnForkReviewPromptTests`・`WhisperVocabularyPromptTests` ほか) | 日本語の区切り、指示文、初期プロンプトの組み立ての単体テスト | 本家の挙動を壊していないことと、日本語対応の動きを `make test` で確かめるため(FR-06) |
| `docs/releases/release-2-autolearn-japanese/requirements.md` | release-2 の確定要件 | release-workflow の入力 |
| `docs/releases/release-2-autolearn-japanese/e2e-verification.md` | release-2 の実機検証の手順(配布、ハッシュの確認、口述、ログの取り方)と記録表 | 実機でしか確かめられない受け入れ基準の手順(FR-09) |

## 変更した既存ファイル

| ファイル | 変更内容 | 理由 |
| --- | --- | --- |
| `.gitignore` | `logs/` を追加 | MacBook Pro から回収するログに口述内容が含まれるため、誤ってコミットしない |
| `.claude/workflow.config.json` | `conventionsDoc` を `CLAUDE.md` から `docs/ARCHITECTURE.md` に切り替え | 実装とレビューが規約文書を参照するように |
| `CLAUDE.md` | M0 を完了にし、調査メモへのリンクを追加 | M0 の完了を記録するため |
| `Makefile` | `whisper` ターゲットに `WHISPER_CPP_COMMIT` を追加し、固定コミットへの checkout と framework の作り直しを入れた | whisper.cpp のバージョンを固定し、ビルドを再現可能にするため(FR-01) |
| `VoiceInk/Infrastructure/Providers/Transcription/Whisper/LibWhisper.swift` | `WhisperContext` に `transcribePartial` と、中断フラグ・結果型の補助を追加(既存メソッドは無変更) | 途中経過用に、中断できる1回完結の認識を呼ぶため(FR-03) |
| `VoiceInk/Features/ModelLibrary/Models/TranscriptionRealtimeSupport.swift` | `isAvailable` に `.whisper` かつ `WhisperStreamingSettings.isEnabled` の条件を追加 | 既定では Whisper の Real-time を出さず、隠し設定で有効化するため(FR-05) |
| `VoiceInk/Features/Recording/Streaming/StreamingTranscriptionService.swift` | `init` に省略可能な `whisperModelsDirectory` を追加し、`createProvider` に `.whisper` 分岐を追加 | Whisper の provider を選べるようにするため(FR-05) |
| `VoiceInk/Features/Recording/Workflows/TranscriptionServiceRegistry.swift` | `createSession` で `modelsDirectory` を渡す | provider がモデルファイルを読めるようにするため(FR-05) |
| `docs/ARCHITECTURE.md` | 3-4「録音停止時に途中認識の完了を待たない」を追加し、1-4 の根拠を更新 | F1 の規約化と、`.whisper` 分岐追加への追従(FR-06) |
| `docs/known-issues.md` | F1 を解決済みログへ移動し、P1 を新規起票 | F1 を release-1 で解決したため。P1 は release-1 で見つかった未対応の課題の記録(FR-06) |
| `CLAUDE.md` | 録音停止後のやり直しの方針を「未決事項」から「決定事項」へ移動 | release-1 で `.useBatchFallback` に決めたため(FR-06) |
| `VoiceInk/Features/Dictionary/AutoLearn/CorrectionDiffEngine.swift` | 文を区切る呼び出しで、どちらかの文に日本語があれば `AutoLearnJapaneseSegmenter` を使う(数行と private の補助のみ) | 日本語の直しを候補にするため(FR-01、FR-07)。32文字の上限は変えない |
| `VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAIReviewer.swift` | `systemPrompt` を `AutoLearnForkReviewPrompt.text` に差し替え(本家の `reviewPrompt` は残す) | 日本語向けの審査にするため(FR-02、FR-07) |
| `VoiceInk/Features/Enhancement/State/AIService.swift` | `reviewAutoLearnCandidates` の `timeout` を `AutoLearnReviewSettings.timeout` に差し替え | 審査の時間切れを避けるため(FR-03、FR-07)。`EnhancementRequestSettings.timeout` の7秒は変えない |
| `VoiceInk/Features/Modes/State/ModeRuntimeConfiguration.swift` | Whisper の `requestContext` の prompt を `WhisperVocabularyPrompt.resolvedPrompt` に差し替え | 語彙を初期プロンプトに入れるため(FR-04、FR-07)。途中経過の provider は `prompt: nil` のまま |
| `VoiceInk/App/VoiceInk.swift` | `WhisperVocabularySource.register(container:)` を1行追加 | 語彙の取得元(ModelContainer)を起動時に渡すため(FR-04、FR-07) |
| `Makefile` | `test` ターゲットと `.PHONY` への追記(`VoiceInkTests` のみ、作業フォルダは `.test-build`) | 単体テストを `make test` で実行するため(FR-06) |
| `.gitignore` | `.test-build/` を追加 | テストの作業フォルダをコミットしないため |
| `scripts/deploy-mbp.sh` | 配るアプリを `.local-build/Build/Products/Release/VoiceInk.app` にし、バイナリの時刻の確認と配布後の `shasum -a 256` の比較を追加 | 古いビルドを配る事故を防ぎ、配った中身を確かめるため(FR-05) |
| `.claude/workflow.config.json` | `checks` に `test` を、`knownIssues.categoryMap` に `check:test` を追加 | `make test` を検査に含めるため(FR-06) |
| `docs/ARCHITECTURE.md` | 5章「Auto Learn のフォーク側の変更」を追加 | Auto Learn の変更の規約と根拠を残すため(FR-08) |
| `docs/known-issues.md` | B1(Ghostty)・B2(VS Code)を起票。実機確認の未達から B3(審査の失敗)・B4(似た音の別の誤り方に単語置換が当たらない。案 B を release-3 の候補として記録)を起票。受け入れ基準の照合で起票した N1〜N3 を直して解決済みログへ移動 | 実機確認で見つかった未対応の課題の記録(FR-08、FR-09) |
| `CLAUDE.md` | ビルドと動作確認に `make test` を追加し、`deploy-mbp.sh` と署名の確認の説明を `.local-build` のアプリに合わせた。決定事項に「辞書の自動登録の日本語対応もこのフォークで行う。途中経過 M2〜M6 は release-3 以降」を追加 | release-2 で配るアプリの場所が変わり、扱う範囲を決めたため(FR-05、FR-06、スコープの確定) |
| `docs/whisper-streaming-investigation.md` | initial_prompt の行に語彙を足すようになったことを追記し、`VoiceInk.swift` の行番号のずれと `deploy-mbp.sh` の変更を記録 | 調査メモの前提が release-2 の実装で変わったため(FR-04、FR-05) |
