# release-2-autolearn-japanese の引き継ぎ

- PR: https://github.com/sumihiro3/VoiceInk/pull/3(2026-10-18 にマージ。手動検証が終わるまで draft だった。実機確認のあとに、受け入れ基準の書き直しと修正を足してからマージした)
- 書いた日: 2026-10-18(/close-release)

途中経過の表示(M2〜M6)をいったん止めて、本家の辞書の自動登録「Auto Learn」を日本語で動くようにしたリリース。貼り付け先で直した語が、単語置換と語彙に登録される。登録した語彙は Whisper の初期プロンプトにも入る。

- 日本語の長い文でも、直した語の周りだけが候補になる(「、」「。」や文字の種類の変わり目で区切る)
- 審査の指示文を日本語・技術用語向けに替えた。待ち時間は90秒にし、失敗したら間を空けて自動でやり直す
- 配布スクリプトは `.local-build/` から直接配り、ハッシュで確かめる
- `make test` を足した(26件)

## 残っている既知課題

3 件(`docs/known-issues.md`)。このリリースで起票した。P1(途中経過用モデルの読み込み)は前のリリースから残っている。

- **B1**(low)Ghostty で直した位置を特定できない — `VoiceInk/Features/Dictionary/AutoLearn/FinalSnapshotDiffEngine.swift` の `correctedPastedText`
  - 入力欄を読むと画面の履歴全体(約5.6万文字)が返る。貼り付けた文字の前後16文字を目印に位置を探すが、同じプロンプトの行が何度も出てくるので、位置が1つに決まらない
- **B2**(low)VS Code のエディタで読み取れない — `VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift`
  - 入力欄の中身が0文字で返る。VS Code の設定 `editor.accessibilitySupport` を `on` にすると読める可能性があるが、確かめていない
- **B4**(medium)登録した語が、次の口述で正しく出ないことがある — `VoiceInk/Features/Dictionary/Workflows/WordReplacementService.swift`(単語置換の適用)
  - Whisper の誤り方は話すたびに変わる(1回目「ロードコード」、2回目「クロールコード」)。単語置換は完全一致なので、別の誤り方には当たらない
  - 語彙を初期プロンプトに入れる処理は効いている(登録語11か所の正解数が、release-2 前 0/11 → release-2 6/11)。ただし英字2語の製品名は、書き方にとても左右され、ほぼ出ない

## 要件書について人の判断が要る点

該当なし。実機確認のあとに要件書を3か所直した(FR-09 AC-3 の書き直し、FR-03 の既定値を30秒→90秒、FR-10 の追加)。理由は要件書の「スコープの確定」の表にある。

## 満たしていない受け入れ基準

- FR-09 AC-1(一部未達): 5アプリとも直した語が候補になって登録されたが、審査の失敗(時間切れ1回、Gemini の 503・429 が2回)が出た。FR-10 を足したあとは、失敗しても自動でやり直す。ただし Gemini 側の遅さや回数制限による失敗そのものは、これからも起こりうる

## 手動検証が未実施の受け入れ基準

該当なし。手順と記録は `docs/releases/release-2-autolearn-japanese/e2e-verification.md`(第3-2節が語彙の比較、第3-3節が審査のやり直し、第4節が実施記録)。

- 補足: FR-10 の 429・5xx のやり直しは、単体テストで確かめただけ。実機では、時間切れからのやり直しだけを確かめた

## 次のリリースの候補

- **Ghostty・VS Code で直しを拾う(ユーザーの希望)**: 既知課題 B1・B2。普段の口述先にターミナル(Claude Code)と VS Code のエディタが含まれる。まず VS Code の `editor.accessibilitySupport: on` で読めるかを実機で確かめる。Ghostty は、履歴の末尾だけを対象にする・目印を長くする、などを release-2 の調査用ログの方法で実測して決める
- **似た音の別の誤り方にも単語置換を当てる(案 B)**: 既知課題 B4。カタカナで1〜2文字だけ違う語にも当てる。誤って当たらないよう、長さ・違う文字数の条件を release-2 の録音で実測して決める。あわせて、審査で「ありそうな誤り方」も元の表記として返させる案 C と比べる
- **途中経過の表示を再開する**: CLAUDE.md のマイルストーン M2〜M6 と既知課題 P1。release-3 以降に再開する、と決めて止めている(CLAUDE.md の決定事項)
- **release-1 の未実施の手動検証4件**: release-1 の handoff のとおり(60秒以上の口述、停止後の時間の比較、Esc での中止、隠し設定を消したときの動作)。途中経過を再開するリリースで一緒に済ませる

## 実地で分かったこと

- 次にやりたいのは Ghostty・VS Code への対応(ユーザーの回答)
- Gemini 3.8 Flash の審査は、応答に30秒前後かかることがある。口述が続くと、AI 整形の呼び出しと重なって 503・429 が返る(macOS の通信ログ: `process == "VoiceInk"` の CFNetwork の行に `response_status=` が出る)
- このセッションの Bash からは `~/Downloads/VoiceInk.app` を上書きできない(macOS の App Management の保護)。`make local` はコピーの失敗を無視して終わる。配布スクリプトは `.local-build/` から配るように直した
- whisper-cli で認識し直すとき、`-mc 0` を付けると初期プロンプトが捨てられる。アプリの `no_context = true` は whisper.cpp の既定値なので、何も付けなくてよい
- アプリの Whisper の設定(`temperature` 0.2、`best_of` 5)でも、同じ録音なら3回とも同じ結果になる。結果の違いは音声の違いから来る
- 辞書の中身は、MacBook Pro の `~/Library/Application Support/com.prakashjoshipax.VoiceInk/dictionary.store`(SQLite)を `sqlite3 -readonly` で読める(テーブル `ZWORDREPLACEMENT`・`ZVOCABULARYWORD`)

## 参考

- 解説レポート: `$TMPDIR/claude-release-workflow/VoiceInk/release-2-autolearn-japanese/report.html`(コミット d665818 時点の内容。OS の一時領域にあるので、数日で消えうる)
- このリリースで解決した既知課題: N1・N2・N3(受け入れ基準の照合で起票し、同じリリースで直した)、B3(審査の失敗。FR-10 で対応)
- 調査で使った録音・モデル・whisper-cli・調査用ログのパッチは、このセッションの一時領域にだけ置いた(リポジトリには入れていない)。作り直す手順は e2e-verification.md の第3-2節
