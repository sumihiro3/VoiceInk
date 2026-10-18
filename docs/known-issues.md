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

### B3. 審査が時間切れや HTTP のエラーで失敗することがある

- severity: medium（release-2 の実機確認 FR-09 AC-1 由来、起票日: 2026-10-18）
- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnReviewSettings.swift`、`VoiceInk/Features/Enhancement/State/AIService.swift` の `reviewAutoLearnCandidates`
- 現象: 2026-10-18 の実機確認(ビルド 52cfa5a)で、9件の候補の審査中に `Auto Learn AI review failed` が3回出た。1回は開始からちょうど30秒で時間切れ(`LLMKitError` code=8)。2回は code=3(LLMKit のエラーの並びから HTTP のエラーと推測。ログに中身は出ない)。どれも次の審査で自動で再審査され、最終的に全件が審査された。code=3 は、同じ Gemini を使う AI 整形の呼び出しと近い時刻に出ている
- 対応方針: 要壁打ち(HTTP のステータスを数値だけログに出して原因を確かめる。AI 整形と重ならないよう審査を少し遅らせる、待ち時間を延ばす、などを実測して決める)

### B4. 登録した語が、次の口述で正しく出ないことがある

- severity: high（release-2 の実機確認 FR-09 AC-3 由来、起票日: 2026-10-18）
- 場所: `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Fork/WhisperVocabularyPrompt.swift`、`VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnForkReviewPrompt.swift`
- 現象: 2026-10-18 の実機確認(ビルド 52cfa5a)で、短い文を直して単語置換と語彙が登録されたあと(単語置換8件・語彙8件)、同じ文をもう一度口述しても正しく出なかった。(1) Whisper の誤り方が1回目と2回目で違い、1回目の誤りから作った単語置換が2回目の誤りに一致しなかった。(2) 語彙は初期プロンプトに入っていた(`vocabularyTerms=8 promptChars=96`)が、Whisper は登録した表記で書かなかった。AI 整形(語彙を渡している)でも直らなかった。(3) 1つの文で2か所を直したとき、審査を通って登録されたのは1か所だけだった
- 対応方針: 要壁打ち。MacBook Pro の録音(WAV)を使い、Mac mini で初期プロンプトの書き方(語彙の位置、挨拶文の有無、語の並べ方)を変えて認識を比べる。審査が直しを1か所しか返さない原因(候補のまとまり方か、AI の返し方か)も確かめる

## 解決済みログ

| ID | 内容 | 解決リリース |
| --- | --- | --- |
| F1 | 停止時に途中認識を待つ案が最終処理をブロックする。abort callback で中断し、disconnect / commit は認識の完了を待たない規約(ARCHITECTURE.md 3-4)にした | release-1-whisper-partial-prototype(FR-04 AC-6、FR-06 AC-1) |
| N1 | FR-04 AC-6 の120文字超過のテストが、重複した語でデータを作っていたため超過の分岐を通らず失敗した。語を重複しない値に直した | release-2-autolearn-japanese(FR-04 AC-6) |
| N2 | N1 のテスト1件の失敗で `make test` が通らなかった。N1 の修正後に `make test` が16件すべて成功 | release-2-autolearn-japanese(FR-06 AC-3) |
| N3 | `FORK-CHANGES.md` に `CLAUDE.md` と `docs/whisper-streaming-investigation.md` の release-2 の変更行が無かった。2行を追記した | release-2-autolearn-japanese(FR-08 AC-3) |

<!-- 解決した項目はバックログから削除せずこの表へ移動し、解決リリース(対応 FR 番号つき)を記録する -->
