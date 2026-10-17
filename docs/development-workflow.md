# VoiceInk フォーク(Whisper 途中経過表示) 開発ワークフロー

VoiceInk フォーク(Whisper 途中経過表示) は claude-release-workflow テンプレートを採用し、Claude Code の Workflow tool（dynamic workflows）によるリリースサイクルで開発する。エンジン（`.claude/workflows/`・`.claude/commands/`）はテンプレートからの無改変コピーであり、プロジェクト固有の設定はすべて `.claude/workflow.config.json` に置く。

1 サイクルは「要件を `docs/releases/{release}/requirements.md` に確定させ、同名のリリースブランチを作成してから実装に入り、レビュー・ドキュメント同期・検査を経てコミットし、PR で `feature/whisper-streaming` へ合流する」流れで、要件確定なしに実装へ進まないこと・`feature/whisper-streaming` への直接 push はしないことを原則とする。

## リリースサイクル

| # | ステップ | 実体 |
| --- | --- | --- |
| 1 | 要件壁打ち＋リリースブランチ作成 | `/refine-requirements` → requirements.md 確定＋`release-N` ブランチ作成 |
| 2〜7 | 実装→レビュー→起票→doc 同期→検査→コミット→PR | `config.automation.pipeline: "auto"` なら要件確定後に `run-release` が自動起動し無人実行。`"ask"` なら都度確認 |
| 8 | 解説レポート | run 完了後に /explain-release が HTML 解説を生成し、人が確認すべきポイントをハイライトする。マージ前にここを起点にレビューする |

run-release を使わない場合の段階実行: `implement-feature` → `review-changes` → `sync-docs` → `release-check` → `/logical-commits` → push・PR 作成。

## run-release の品質ゲート

| ゲート | 判定 | 失敗時 |
| --- | --- | --- |
| Gate 0（preflight） | 作業ツリークリーン・ブランチ一致・requirements「ステータス: 確定」・configVersion 整合 | 何も変更せず停止＋通知 |
| Gate 0.5（実装完了性） | 報告された変更ファイルが git diff に実在（捏造疑い検出） | 1 回リトライ → critical 相当 |
| Gate 1（機械判定） | config.checks 全件 exit code 0（結果欠落・数不一致も failed） | 修正ループ → 収束不能なら起票＋severity 分岐 |
| Gate 2（レビュー判定） | 敵対的検証済み所見の severity（block/fixOnce/backlogOnly は config で定義） | 修正ループ → 同上 |

- 修正ループの上限・エージェント起動数上限は `config.automation` で定義する
- PR 分岐: critical 残存→PR を作らず停止／high 残存・手動検証必須 AC 残存→draft PR／それ以外→通常 PR。マージは常に人間が行う
- **エンジン自己変更のリリース**（`.claude/workflows/*.js` 自身を変更する場合）は、無人実行中に未検証の新エンジンコードをネスト呼び出しが実行する自己変更ハザードがあるため、run-release を使わず段階実行で行う
- **Gate 2 のレビュー実行**: `config.codexReview.enabled` が true の場合、`review-changes` は準備フェーズで OpenAI Codex CLI（Claude Code プラグイン `codex@<marketplace>`）の利用可否を 1 回検出し、利用可能なら各レビュー次元の一次生成を adversarial-review へ委譲する（未コミット変更があれば working-tree 差分、base より先行したコミットも併存すれば --base 比較との 2 コマンド併用、クリーンなら --base 比較）。Codex 未導入・未認証・呼び出し失敗など理由を問わず自動的に通常の自力レビューへフォールバックするため、Codex が使えない環境（他の開発者のマシン・CI 等）でも壊れずに同じ結果契約（confirmed/unverifiable/dimensionsRun）を返す。委譲は全差分レビュー（`diffPathScope` が未指定）のときのみ対象になる

## 用語(PR 本文・既知課題・文書で使う言い方)

上の品質ゲートの名前などはワークフローの内部の言い方。PR 本文・既知課題・同期する文書では、次の右の列の言い方を使う(エンジンが書く文章も機械検査で揃える)。

| エンジンの内部の言い方 | PR 本文・既知課題・文書で使う言い方 |
| --- | --- |
| 残存 | 修正されずに残った |
| 収束不能・収束しない | 同じ失敗が繰り返されたので自動修正を打ち切った |
| Gate 0 | 開始前の事前検査 |
| Gate 0.5 | 実装結果と実際の差分の突き合わせ |
| Gate 1 | 検査と修正の繰り返し |
| Gate 2 | レビューと修正の繰り返し |
| 失敗署名 | 失敗の中身(検査名と失敗箇所) |
| 周 | (レビューの)回 |
| ラウンド | (レビューの)回 |
| 修正体・修正エージェント | 自動修正 |
| 検証体・検証エージェント | 指摘の裏取り |
| block / fixOnce / backlogOnly | 必ず直す指摘 / 1 回だけ直す指摘 / 起票だけする指摘 |
| 戻り値のフィールド名 | その中身を表す日本語(例: 修正されずに残った指摘) |

## リリース前検査

| キー | コマンド | 内容 |
| --- | --- | --- |
| check | `make check` | ビルド環境の確認(git・xcodebuild・swift があるか) |
| build | `make build` | Debug ビルド(初回は whisper.cpp の clone と xcframework のビルドから始まる) |

## リリースブランチの運用

- **作成タイミング**: 要件壁打ちでリリース識別子（`release-N-slug`）が確定した時点。実装に入る前に必ず作成する
- **命名**: `release-<連番>-<ケバブケースの短い主題>`。requirements.md を置くディレクトリ名と完全一致させる
- **採番**: 番号は「着手した順」。tooling / docs のみのイテレーションも同じ連番で数える（プロダクトの semver とは独立）
- **作成元**: 最新化した `feature/whisper-streaming`
- **合流**: PR で `feature/whisper-streaming` へ合流する（直接 push しない）。マージ後、ローカルを最新化しリリースブランチを削除する

## known-issues の運用規約

- **場所**: `docs/known-issues.md`。レビュー由来のバックログをリリースをまたいで一元管理する
- **記録契機**: 主に差分レビューで検出され、当該リリースでは解消しないと判断した所見（run-release では自動起票される）
- **構成**: 「未解決（バックログ）」（カテゴリ接頭辞つき ID・severity・場所・現象・対応方針）と「解決済みログ」（テーブル）の 2 部構成。解決した項目は削除せず解決済みログへ移動し、解決リリースを記録する
- カテゴリ接頭辞と所見種別の対応は `config.knownIssues.categoryMap` が正。カテゴリの拡張はカテゴリ表への行追加と config への追記をセットで行う

## e2e-verification（実機手動検証）の位置づけ

自動テストで固定できない項目だけを対象にした手動チェックリスト。requirements.md の AC に「(手動検証必須)」と付記された項目が対象になる。`docs/releases/{release}/requirements.md` と同じディレクトリに `e2e-verification.md` として置き、実施のたびに記録表へ追記する。

<!-- ここから下はプロジェクト固有の節を追記する(例: 特殊な検査の背景、ブランチ運用の例外、リリース経緯のメモ) -->
