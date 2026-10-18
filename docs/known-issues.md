# 既知の課題（レビュー由来のバックログ）

VoiceInk フォーク(Whisper 途中経過表示) の差分レビュー（敵対的検証済み）・リリース前検査で検出され、当該リリースでは解消しないと判断した所見をここで一元管理する。解決済みの項目は下部の「解決済みログ」へ移動する。

## カテゴリ接頭辞

| 接頭辞 | 種別 |
| ------ | ---------------------------- |
| B | バグ（correctness） |
| P | パフォーマンス |
| A | アーキテクチャ／レイヤ境界 |
| S | セキュリティ |
| C | 並行処理(actor・MainActor・ロック・Task) |
| F | 最終処理の保護(録音停止後の最終処理・貼り付け) |
| D | 本家との差分(FORK-CHANGES.md・差し込みの最小化) |
| N | ツール警告などのノイズ |

<!-- プロジェクト固有カテゴリの追加例: | U | UX/UI改善要望(ユーザー起点) | -->

## 未解決（バックログ）

<!--
  記録形式(1 項目 = 1 つの H3):

  ### <ID>. <タイトル>

  - severity: <critical|high|medium|low>（<検出元> 由来、起票日: YYYY-MM-DD）
  - 場所: `<ファイルパス>`
  - 現象: <何が起きるか・実測や再現条件>
  - 対応方針: <どう直すか。未定なら「要壁打ち」>
-->

### P1. 録音ごとにモデルを同期的に読み込み、初回表示の2秒基準も計測から隠している

- severity: low（review:perf 由来、起票日: 2026-10-17）
- 場所: `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift:67-87`
- 現象: `connect` はセッションごとに `WhisperContext.createContext` でモデルを新規ロードし、その完了後に初めて周期 Task を開始する。そのため初回 partial(途中経過の最初の表示)は「モデルロード時間 + 1秒の待機 + 推論時間」後となり、「話し始めて2秒以内」という合格基準を破りやすい。さらに `connectedAt` はロード完了後に設定されるため、`firstPartialAfterConnect` はユーザーが実際に待ったモデルロード時間を除外し、E2E 計測でも退行を見逃す。短時間で停止した場合も、キャンセルできないロードが最終 batch(録音停止後の全音声処理)と資源を競合し得る。
- 対応方針: 途中経過用 context を録音開始前にプリロードして安全に再利用するライフサイクルを設ける。少なくとも初回遅延は録音・発話開始を基準に計測し、ロード中の停止ではロード完了を待たず最終処理と競合しない設計にする。

### B1. Ghostty で直した位置を特定できない

- severity: low（release-2 の実機確認 由来、起票日: 2026-10-18）
- 場所: `VoiceInk/Features/Dictionary/AutoLearn/FinalSnapshotDiffEngine.swift` の `correctedPastedText`
- 現象: Ghostty では、入力欄を読み取ると画面の履歴全体(約5.6万文字)が返る。貼り付けた文字の前後16文字を目印にして直した位置を探すが、履歴の中に同じ並びが複数あり、目印が一意に決まらない。そのため直した文字が取れず、候補が作られない。
- 対応方針: 要壁打ち(履歴の末尾だけを対象にする、目印を長くする、Ghostty は対象外にする、のどれかを実測して決める)

### B2. VS Code のエディタで読み取れない

- severity: low（release-2 の実機確認 由来、起票日: 2026-10-18）
- 場所: `VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift`(アクセシビリティ経由の読み取り)
- 現象: VS Code のエディタでは、入力欄の中身が0文字で返る。直した文字を取れないため、候補が作られない。
- 対応方針: VS Code の設定 `editor.accessibilitySupport` を `on` にすると読める可能性があるが、未確認。確かめて、読めるなら手順を e2e-verification.md に足し、読めないなら対象外として記録する。

### N1. 受け入れ基準 FR-04 AC-6 を満たしていない

- severity: high（check:ac-check 由来、起票日: 2026-10-18）
- 場所: 該当なし（関連: `Tests/VoiceInkTests/WhisperVocabularyPromptTests.swift`）
- 現象: 受け入れ基準の照合で、FR-04 AC-6 を満たしていないと判定した。`make test`(`TEST_DERIVED_DATA` を scratchpad にして実行)で `WhisperVocabularyPromptTests.testOldTermsDroppedWhenOver120Characters` が失敗する(xcresult: 『WhisperVocabularyPromptTests.swift:27: XCTAssertFalse failed』)。原因はテストデータで、terms を `(0..<30)` の `i % 10` で作るため terms[10..29] は terms[0..9] の完全な重複になる。重複除外で吸収されて 120 文字超過の分岐に到達せず、terms[29]==terms[9] が結果に含まれる。実装ではなくテストの誤り。語彙0件・重複のテストは pass。
- 対応方針: テストの terms を重複しない値(例: 各 i で一意な文字列)にして、120 文字超過の分岐に到達させる。実装側の変更は不要と見られる。

### N2. 受け入れ基準 FR-06 AC-3 を満たしていない

- severity: high（check:ac-check 由来、起票日: 2026-10-18）
- 場所: 該当なし（関連: `Makefile`、`.gitignore`、`Tests/VoiceInkTests/WhisperVocabularyPromptTests.swift`）
- 現象: 受け入れ基準の照合で、FR-06 AC-3 を満たしていないと判定した。`Makefile` に test ターゲット(`-only-testing:VoiceInkTests`、`-derivedDataPath ${TEST_DERIVED_DATA:-.test-build}`)があり、`.gitignore` に `.test-build/` が追加され、実行は人の操作なしで約2分で終了する。`Makefile` の変更は test ターゲット追加と `.PHONY` 行への test 追記のみ。しかし `make test` は `WhisperVocabularyPromptTests` の1件失敗で『** TEST FAILED **』となり、make は exit 2(xcodebuild は exit 65)で終わるため、AC の「通る」を満たさない。なお release-check は config 変更前だったため `make test` を実行していない。
- 対応方針: N1 のテスト修正後に `make test` を再実行して pass を確認する。あわせて release-check の検証コマンドに `make test` を含めるか検討する(未検討、要壁打ち)。

### N3. 受け入れ基準 FR-08 AC-3 を満たしていない

- severity: high（check:ac-check 由来、起票日: 2026-10-18）
- 場所: `FORK-CHANGES.md`（関連: `CLAUDE.md`、`docs/whisper-streaming-investigation.md`）
- 現象: 受け入れ基準の照合で、FR-08 AC-3 を満たしていないと判定した。`FORK-CHANGES.md` には release-2 の新規ファイル(`Fork/` 5件、Tests、requirements、e2e)と変更ファイル(`CorrectionDiffEngine`・`AutoLearnAIReviewer`・`AIService`・`ModeRuntimeConfiguration`・`VoiceInk.swift`・`Makefile`・`.gitignore`・`deploy-mbp.sh`・`workflow.config.json`・`ARCHITECTURE`・`known-issues`)が3列(ファイル・変更内容・理由)で載っている。しかし作業ツリーの変更にある `CLAUDE.md` と `docs/whisper-streaming-investigation.md` の今回の変更行が無い(`CLAUDE.md` の行は release-1 の変更分のみ)。
- 対応方針: `FORK-CHANGES.md` に `CLAUDE.md` と `docs/whisper-streaming-investigation.md` の release-2 での変更行(ファイル・変更内容・理由)を追記する。

## 解決済みログ

| ID | 内容 | 解決リリース |
| --- | --- | --- |
| F1 | 停止時に途中認識を待つ案が最終処理をブロックする。abort callback で中断し、disconnect / commit は認識の完了を待たない規約(ARCHITECTURE.md 3-4)にした | release-1-whisper-partial-prototype(FR-04 AC-6、FR-06 AC-1) |

<!-- 解決した項目はバックログから削除せずこの表へ移動し、解決リリース(対応 FR 番号つき)を記録する -->
