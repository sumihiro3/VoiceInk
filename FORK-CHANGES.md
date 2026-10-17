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
| `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md` | release-1 の実機検証の手順と記録表 | 実機でしか確かめられない受け入れ基準の手順(FR-07) |

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
