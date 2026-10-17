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

## 変更した既存ファイル

| ファイル | 変更内容 | 理由 |
| --- | --- | --- |
| `.gitignore` | `logs/` を追加 | MacBook Pro から回収するログに口述内容が含まれるため、誤ってコミットしない |
