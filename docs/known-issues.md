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

## 解決済みログ

| ID | 内容 | 解決リリース |
| --- | --- | --- |
| F1 | 停止時に途中認識を待つ案が最終処理をブロックする。abort callback で中断し、disconnect / commit は認識の完了を待たない規約(ARCHITECTURE.md 3-4)にした | release-1-whisper-partial-prototype(FR-04 AC-6、FR-06 AC-1) |
| N1 | FR-04 AC-6 の120文字超過のテストが、重複した語でデータを作っていたため超過の分岐を通らず失敗した。語を重複しない値に直した | release-2-autolearn-japanese(FR-04 AC-6) |
| N2 | N1 のテスト1件の失敗で `make test` が通らなかった。N1 の修正後に `make test` が16件すべて成功 | release-2-autolearn-japanese(FR-06 AC-3) |
| N3 | `FORK-CHANGES.md` に `CLAUDE.md` と `docs/whisper-streaming-investigation.md` の release-2 の変更行が無かった。2行を追記した | release-2-autolearn-japanese(FR-08 AC-3) |

<!-- 解決した項目はバックログから削除せずこの表へ移動し、解決リリース(対応 FR 番号つき)を記録する -->
