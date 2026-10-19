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
- release-3 での対応: Ghostty の判定(bundle identifier)、貼り付けた位置の近くだけを比べる Locator、1秒ごとに直しを拾う Tracker を `Fork/` に追加した。**実機確認待ち**(`docs/releases/release-3-autolearn-ghostty/e2e-verification.md` の AC-2〜AC-5 を参照)。確認が済むまで解決済みログへは移さない

### B2. VS Code のエディタで読み取れない

- severity: low（release-2 の実機確認 由来、起票日: 2026-10-18）
- 場所: `VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift`(アクセシビリティ経由の読み取り)
- 現象: VS Code のエディタでは、入力欄の中身が0文字で返る。直した文字を取れないため、候補が作られない。
- 対応方針: VS Code の設定 `editor.accessibilitySupport` を `on` にすると読める可能性があるが、未確認。確かめて、読めるなら手順を e2e-verification.md に足し、読めないなら対象外として記録する。
- release-3 での調査(仮): VS Code のエディタ・Claude Code 拡張の入力欄・統合ターミナルの3か所と `editor.accessibilitySupport`(`auto`・`on`)の6通りを、`docs/releases/release-3-autolearn-ghostty/e2e-verification.md` の AC-7 で調べる。調査用に `AutoLearnDiagnostics` のログ(読み取りの結果・方法・文字数・止まった段階)を出す。実測が出てから、この項目を書き直し、必要なら新しい項目を起票する

### B4. 登録した語が、次の口述で正しく出ないことがある(似た音の別の誤り方に単語置換が当たらない)

- severity: medium（release-2 の実機確認 FR-09 AC-3 由来、起票日: 2026-10-18。調査のあと high から下げた）
- 場所: `VoiceInk/Features/Dictionary/Workflows/WordReplacementService.swift`(単語置換の適用)、`VoiceInk/Infrastructure/Providers/Transcription/Whisper/Fork/WhisperVocabularyPrompt.swift`
- 現象: 2026-10-18 の実機確認(ビルド 52cfa5a)で、短い文を直して登録したあと、同じ文をもう一度話しても正しく出なかった。録音を同じ条件で認識し直して調べた結果(手順と数値は `docs/releases/release-2-autolearn-japanese/e2e-verification.md` 第 3-2 節):
  - 語彙を初期プロンプトに入れる処理は効いている。登録語の出現箇所11か所の正解数は、release-2 前の初期プロンプトで 0/11、release-2 の初期プロンプトで 6/11
  - 英字2語の製品名は、初期プロンプトの書き方9通りのほとんどで正しく出なかった。正しく出たのは、話した順に2語だけを並べたときだけで、並べ方にとても左右される
  - Whisper の誤り方は、同じ語でも話すたびに変わる(同じ録音なら3回とも同じ結果なので、`temperature` 0.2 によるばらつきではなく音声の違い)。1つの誤りから作った単語置換(完全一致)は、別の誤り方に当たらない
  - 1つの文で2か所を直せば候補は2件になる(コードで確認)。実機で1か所しか登録されなかったのは、1か所しか直されなかったため(貼り付け前の AI 整形がもう1か所を直していた可能性があるが、貼った文字はログに無いので未確認)
- 対応方針: release-3 の候補「案 B: 似た音のカタカナにも単語置換を当てる」。カタカナの元の表記と、1〜2文字だけ違う語にも置換を当てる。誤って当たる危険があるので、元の表記の長さ・違う文字数・カタカナだけに限るなどの条件を、release-2 の録音で実測して決める。それまでの間は、別の誤り方を直すたびに Auto Learn が同じ行き先の置換に元の表記を足すので、難しい語は2〜3回直すと出るようになる見込み(未確認)。あわせて「案 C: 審査のときに、ありそうな誤り方も元の表記として返させる」も比べる候補

### B5. 8,192 UTF-16 を超える長さ増加で後方アンカーを探索できない

- severity: low（review:bugs 由来、起票日: 2026-10-19）
- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnTerminalRevisionLocator.swift:57-79`
- 現象: 後方アンカー(貼り付けた文字の後ろの目印)の探索終端を、元の貼り付け範囲の末尾から 8,192 UTF-16 に固定している。一方、貼り付けは最大 12,000 文字、修正結果は元の長さの 2 倍 + 64 文字まで許容されている。長文に 8,192 文字を超える追加をする有効な修正では、後方アンカーが探索範囲の外へ移動して `afterAnchorNotFound` になり、候補が失われる。許容長の判定に到達する前の不整合である。
- 対応方針: 後方アンカーの探索終端を、許容する最大修正長を含むように算出する。または前方アンカーから最大許容修正長まで探索する。8,192 超の挿入を含む境界テストも追加する。

## 解決済みログ

| ID | 内容 | 解決リリース |
| --- | --- | --- |
| F1 | 停止時に途中認識を待つ案が最終処理をブロックする。abort callback で中断し、disconnect / commit は認識の完了を待たない規約(ARCHITECTURE.md 3-4)にした | release-1-whisper-partial-prototype(FR-04 AC-6、FR-06 AC-1) |
| N1 | FR-04 AC-6 の120文字超過のテストが、重複した語でデータを作っていたため超過の分岐を通らず失敗した。語を重複しない値に直した | release-2-autolearn-japanese(FR-04 AC-6) |
| N2 | N1 のテスト1件の失敗で `make test` が通らなかった。N1 の修正後に `make test` が16件すべて成功 | release-2-autolearn-japanese(FR-06 AC-3) |
| N3 | `FORK-CHANGES.md` に `CLAUDE.md` と `docs/whisper-streaming-investigation.md` の release-2 の変更行が無かった。2行を追記した | release-2-autolearn-japanese(FR-08 AC-3) |
| B3 | 審査が時間切れ(応答に30秒前後かかる)や Gemini の 503・429 で失敗し、次の直しまでやり直されなかった。待ち時間の既定を90秒にし、失敗したら30・60・120・240秒の間隔で自動でやり直すようにした(429 は `retryDelay` 以上待つ)。実機で時間切れからの自動のやり直しと成功を確認 | release-2-autolearn-japanese(FR-03 AC-1、FR-10) |
| A1 | 実機確認の手順書のログの欄名(`usedTrackedRevision`・`beforeAnchorMatches`・`reads=0`)が、実装が出す名前(`tracked`・`beforeAnchors`、Ghostty 以外では欄なし)と違った。手順書を実装に合わせた | release-3-autolearn-ghostty(FR-05 AC-1) |
| N4 | FR-01 AC-7 の作り物の履歴に入力欄の枠が1か所しか無く、前の目印が複数か所ある状況をテストしていなかった。履歴の各行に枠を付けて前の目印を13か所にし、目印の数が10以上で正しく直しを取れること、本家の処理ではこの履歴で取れないことをテストした。送った文は直した文にし、枠つきで残る場合も足した | release-3-autolearn-ghostty(FR-01 AC-7) |

<!-- 解決した項目はバックログから削除せずこの表へ移動し、解決リリース(対応 FR 番号つき)を記録する -->
