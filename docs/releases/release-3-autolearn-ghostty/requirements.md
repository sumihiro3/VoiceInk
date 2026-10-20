# release-3-autolearn-ghostty 要件

- リリース識別子:release-3-autolearn-ghostty(Ghostty で開いた Claude Code で、直しを辞書に自動で登録できるようにする。VS Code は調べて記録するだけ)
- ステータス: 確定
- 作成日:2026-10-19(同日の run-release のあと、36・67行目を FR-02 AC-3 の優先順位に合わせて直した。2026-10-20 の実機確認のあと、FR-02 の前書きと AC-3 を「入力欄 → 送った文の行 → 持っておいた直し」の順に改め、AC-7 を足した。理由はスコープの確定の表)
- 参照資料:docs/releases/release-2-autolearn-japanese/handoff.md(次のリリースの候補「Ghostty・VS Code で直しを拾う」)、docs/known-issues.md(B1・B2)、docs/releases/release-2-autolearn-japanese/requirements.md(7アプリでの実測の表)、docs/ARCHITECTURE.md(規約)、CLAUDE.md、本家の Auto Learn(`VoiceInk/Features/Dictionary/AutoLearn/`)

## 背景と目的

普段の口述先の多くは、Ghostty で開いた Claude Code の入力欄と、VS Code(エディタ・Claude Code 拡張の入力欄・統合ターミナル)。release-2 で、貼り付け先で直した語を辞書に自動で登録する機能(Auto Learn)が日本語で動くようになった。しかし、Chrome・Slack などでは登録されるのに、Ghostty と VS Code では1件も登録されない。2026-10-18 の実測(release-2 の要件書の表)は次のとおり。

| アプリ | 読み取り | 直しを拾う |
|---|---|---|
| Ghostty | 成功(画面の履歴全体、約5.6万文字が返る) | 失敗(直した位置を特定できない。既知課題 B1) |
| VS Code のエディタ | 失敗(入力欄の中身が0文字で返る。既知課題 B2) | — |

Ghostty で失敗する原因は、直した位置の探し方にある(`FinalSnapshotDiffEngine.swift` の `correctedPastedText` と `uniqueRange`)。貼り付けた文字の前後16文字を目印にし、その目印が入力欄の中にちょうど1か所だけあることを求める。ターミナルの履歴には同じプロンプトの行(Claude Code の入力欄の枠や `> `)が何度も出てくるので、目印が1か所に決まらない。

さらに、使い方の問題が2つある。

1. **直したらすぐ Enter で送る。** 本家は、直しを確定させる時点を「次の貼り付け」「次の録音開始」「入力欄からフォーカスが外れたとき」「貼り付けから60秒」のどれかにしている(`AutoLearnService.swift` の `pasteDidFinish`・`recordingDidStart`・`finalizeIfFocusLeft`・`finalizeAtDeadline`)。Enter で送ると、入力欄が空になり、Claude Code の応答が後ろに続く。確定させる時点では、直した文字は入力欄に残っていない
2. **Claude Code を長く使うと、履歴が読み取りの上限を超える。** 上限は10万文字(UTF-16、`AutoLearnTypes.swift` の `maximumFieldUTF16Length`)。超えると読み取り自体を捨てる(`AutoLearnAXTextReader.swift` の `textValue`・`markerSnapshot`、`AutoLearnAXRuntime.swift` の `finishSnapshot`)

このリリースでは Ghostty の3つの問題(位置の特定、Enter で送る使い方、長い履歴)を直す。成功の基準は、**MacBook Pro の Ghostty で開いた Claude Code に口述し、1語を直してすぐ Enter で送ると、その直しが審査に回り、辞書(単語置換と語彙)に登録されること。Claude Code の応答の文字は候補に入らないこと。**

VS Code の3か所は、どこで止まるかが実機でまだ分かっていない。このリリースでは、口述の中身を含まない調査用のログを入れ、実機で記録するだけにする。直すのは release-4 以降。

## スコープの確定(壁打ちでの決定事項)

| 論点 | 決定 |
|---|---|
| このリリースで扱うもの | 既知課題 B1(Ghostty)と B2(VS Code)。B4(似た音の別の誤り方)と途中経過の表示の再開(M2〜M6)は扱わない |
| VS Code の扱い | エディタ・Claude Code 拡張の入力欄・統合ターミナルの3か所を、調べて記録するだけにする。事実が無いまま設計すると、実機で外れて作り直しになりやすい。直すのは release-4 以降 |
| 実機での事前確認 | 要件を書く前に MacBook Pro で確かめる案もあったが、ユーザーが外出先のため、先に要件にした。実機で確かめる AC はすべて手動検証必須にする。そのため run-release は draft PR で終わる見込み |
| 対象のターミナル | Ghostty だけ。ターミナル.app・iTerm2 などは対象外 |
| Enter で送る使い方 | ユーザーは直したらすぐ Enter で送る。Ghostty では、直しを確定させるまでの間、入力欄を1秒ごとに読み、直した文字が残っていた最後の状態を持っておく。確定させる時点では、入力欄 → 送った文の行 → 持っておいた直しの順に使う(下の「確定時の優先順」の行) |
| 長い履歴(10万文字超) | このリリースで直す。Ghostty では、貼り付けた位置の近く(履歴の末尾)だけを比べる。履歴の前のほうにある同じプロンプトの行も比べないので、B1 の対策にもなる |
| Ghostty 以外のアプリ | 動作を変えない。新しい探し方と1秒ごとの読み取りは、貼り付け先が Ghostty のときだけ使う |
| CLAUDE.md の更新 | 決定事項の「途中経過 M2〜M6 は release-3 以降に再開する」を「release-4 以降に再開する」に直し、「Ghostty で直しを拾う対応をこのフォークで行う(release-3 で決定)」を追記する |
| 確定時の優先順(2026-10-20 の実機確認のあと) | 実機の2回目・4回目で、持っておいた直しが Enter の直前の状態ではなかった(4回目は送った文に無い「ー」が残った候補になり、審査で却下)。最後の直しから Enter までが1秒ごとの読み取りに間に合わない(Ghostty 側も読み取り結果を500ミリ秒使い回す)。間隔を縮めても隙間は無くならない。一方、Enter で送ったあとの画面では入力欄が空になり(`finalStage=input-empty`)、送った文が履歴に残る。そこで順を「確定させるときの入力欄 → 入力欄が空なら履歴に残った送った文の行 → 持っておいた直し」に改める(FR-02 AC-3・AC-7) |
| 調査用のログ | release-2 では常設しなかった(スコープ外)。このリリースで、口述の中身を含まないもの(数値・理由・アプリの識別子だけ)を常設する。VS Code の調査と、Ghostty の実機確認で使うため |

## 機能要件

### FR-01: Ghostty で直した位置を特定する(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnTerminalRevisionLocator.swift`(新規)、`Tests/VoiceInkTests/AutoLearnTerminalRevisionLocatorTests.swift`(新規)

既知課題 B1 に対応する。貼り付けたときの入力欄の文字(baseline)・貼り付けた範囲・後で読んだ入力欄の文字(final)から、直したあとの文字を取り出す純粋な処理を作る。本家の `FinalSnapshotDiffEngine.revision(from:)` と同じ `AutoLearnFieldSnapshot` を受け取り、同じ `AutoLearnRevision?` を返す。

- AC-1: 目印(貼り付けた文字の前後の文字)が final の中に複数あっても、貼り付けた位置にいちばん近いものを使って位置を決める。本家のように「ちょうど1か所」は求めない
- AC-2: 比べるのは、貼り付けた位置の近く(baseline の貼り付けた位置より前の一定の文字数と、それより後ろ)だけ。比べる範囲の文字数は設計で決め、定数にする。baseline と final が10万文字(UTF-16)を超えていても、貼り付けた位置が末尾の近くにあれば位置を特定できる
- AC-3: 取り出した文字が、直した結果としてありえないほど長いとき(Enter で送ったあとに応答が続いた状態など)は、`nil` を返す。上限は貼り付けた文字の長さをもとに設計で決める
- AC-4: 入力欄が空になったとき(Enter で送ったあとの、空の入力欄)は、`nil` を返す。「貼り付けた文字を全部消した」という直しとして扱わない
- AC-5: 直していないとき(final で貼り付けた範囲の文字が変わっていない)は、`nil` を返す
- AC-6: 返す `AutoLearnRevision` の `original`・`corrected` は、本家と同じく `AutoLearnTextNormalizer.accessibilityComparable` を通した文字にする
- AC-7: `make test` で、次の作り物の入力を使うテストが通る:
  - (1) Claude Code の入力欄の枠と `> ` の行が履歴に10回以上出てくる baseline で、最後の入力欄に貼り付けた「ロードコードとコーデックスどちらがいいですか。」のうち「ロードコード」を「Claude Code」に直した final → `original` が貼り付けた文、`corrected` が直した文になる
  - (2) (1) と同じ形で、履歴の前に10万文字を超える文字を足したもの → (1) と同じ結果になる
  - (3) (1) のあと Enter で送った final(入力欄の位置に直した文が残り、その後ろに応答の文字と空の入力欄が続く)→ `nil`、または `corrected` に応答の文字を含まない
  - (4) 入力欄が空になった final → `nil`
  - (5) 直していない final → `nil`

### FR-02: Enter で送る前の状態を拾う(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnTerminalSnapshotTracker.swift`(新規)、`VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnTerminalSentEcho.swift`(新規、2026-10-20 に追加)、`Tests/VoiceInkTests/AutoLearnTerminalSnapshotTrackerTests.swift`(新規)、`Tests/VoiceInkTests/AutoLearnTerminalSentEchoTests.swift`(新規、2026-10-20 に追加)

貼り付け先が Ghostty のとき、直しを確定させるまでの間に入力欄を1秒ごとに読み、FR-01 で直しが取れた最後の状態を持っておく。確定させる時点では、確定させるときの入力欄 → 送った文の行 → 持っておいた直しの順に使う(AC-3・AC-7)。

- AC-1: 読み取りの間隔は1秒。読み取りを続けるのは、本家の見張りの間(貼り付けから最大60秒、次の貼り付け・次の録音開始・フォーカスが外れたときまで)だけ。見張りが終わったら、読み取りも止まる
- AC-2: 読むたびに FR-01 で直しを取り出し、取れたら(`nil` でなければ)それを「最後に取れた直し」として置き換える。取れなかった回は、前に持っていたものを消さない
- AC-3: 確定させる時点の入力欄から FR-01 で直しが取れれば、それを使う(Enter で送らずに離れたとき。いちばん新しい状態)。取れず、入力欄が空なら(Enter で送ったとき)、AC-7 の送った文の行を使う。どちらでも決まらなければ「最後に取れた直し」を使う。どれも無ければ候補を作らない(2026-10-20 に順を改めた。理由はスコープの確定の表)
- AC-4: 読み取りが失敗した回(アクセシビリティの時間切れ、文字が読めない)は、その回を飛ばして次の回を待つ。前の回の読み取りが終わっていなければ、その回は飛ばす(読み取りを重ねない)
- AC-5: 持っておく状態は、見張り中の1回の貼り付けにつき直し1つ分だけ。入力欄の文字の全文を何回分も持たない
- AC-6: `make test` で、読み取りの結果の並び(直す前 → 直した → Enter で送ったあと、など)を与えたときに、AC-2・AC-3 のとおりの直しを返すテストが通る。並びは FR-01 AC-7 の作り物の入力を使う。時刻と読み取りは差し替えられるようにし、テストで実際に1秒待たない
- AC-7: 送った文の行を取り出す。貼り付けたときの画面と確定させるときの画面を先頭から比べ、最初に違う行(空行は2行まで読み飛ばす)から行頭・行末のプロンプトや枠の記号を除いたものを送った文とする。元の文と、先頭と末尾の一致した文字数の合計が元の文の長さの4分の1(最低2)に満たないとき、または FR-01 AC-3 の長さの上限を超えるときは、送った文の行ではないとみなす。送った文が元の文と同じなら、直さずに送ったとみなし、「最後に取れた直し」も使わない。`make test` で、作り物の入力(直して送った・直さずに送った・送らずに消した・応答の行)と、実機の4回目を再現した入力(「Protopediaビデオメーカーを作りました。」を「ProtoPedia Video Makerを作りました。」と送った)のテストが通る

### FR-03: 調査用のログ(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnDiagnostics.swift`(新規)、`Tests/VoiceInkTests/AutoLearnDiagnosticsTests.swift`(新規)

VS Code の調査(FR-05)と Ghostty の実機確認(FR-05)で、どこで止まったかを確かめるためのログ。口述の中身を含めない。

- AC-1: `Logger(subsystem: "com.prakashjoshipax.voiceink", category: "AutoLearnDiagnostics")` で出す
- AC-2: 貼り付けたときに1行出す。中身は、貼り付け先のアプリの識別子(bundle identifier)、読み取りの結果(成功、または本家の `rejectCapture` の理由の文字列)、読み取りの方法(`AutoLearnAXTextReading.source`)、入力欄の文字数(UTF-16)、貼り付けた範囲の位置と長さ、選択範囲が取れたかどうか
- AC-3: 直しを確定させるときに1行出す。中身は、アプリの識別子、確定させた理由(次の貼り付け・録音開始・フォーカス・60秒)、final の文字数、直しが取れたかどうか、取れなかったときに止まった段階(読み取りの失敗・目印が見つからない・長すぎる・入力欄が空・直していない、など)、Ghostty のときは前後の目印が見つかった数、読み取った回数、「最後に取れた直し」を使ったかどうか
- AC-4: 口述の中身(貼り付けた文字、入力欄の文字、直した文字、目印の文字)は、`.public` でも `.private` でも出さない。`.public` で出すのは、数値・真偽・理由や段階の決まった文字列・アプリの識別子だけ
- AC-5: 1秒ごとの読み取り(FR-02)では、1回ごとにログを出さない。回数を AC-3 の行にまとめる
- AC-6: `make test` で、AC-2・AC-3 の行の文字列を組み立てる処理に、口述の中身を含む入力を与えても、出力にその文字が含まれないことを確かめるテストが通る

### FR-04: 結線(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXRuntime.swift`、`VoiceInk/Features/Dictionary/AutoLearn/AutoLearnService.swift`、`VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAXTextReader.swift`、`VoiceInk/Features/Dictionary/AutoLearn/FinalSnapshotDiffEngine.swift`

FR-01〜FR-03 を本家の Auto Learn につなぐ。本家のファイルの変更は、呼び出しを差し込む行に限る(本家は Auto Learn を作り替え中で、取り込むときに衝突しやすいため)。

- AC-1: 貼り付け先が Ghostty かどうかは、貼り付け先のプロセスの bundle identifier が `com.mitchellh.ghostty` かどうかで決める(2026-10-19 に Mac mini の `/Applications/Ghostty.app` で確認)
- AC-2: Ghostty のときは、貼り付けた直後の読み取りで選択範囲から貼り付けた範囲が決まらず、貼り付けた文字が入力欄の中に複数か所あれば、末尾にいちばん近いものを貼り付けた範囲とする(本家は1か所のときだけ決め、複数なら `pasted-range-invalid` で捨てる。同じ文を同じ誤り方で2回口述すると履歴に2か所残るため)。Ghostty 以外のアプリでは本家のまま
- AC-3: Ghostty のときは、直した位置の特定に FR-01 を使い、FR-02 の1秒ごとの読み取りを動かす。Ghostty 以外のときは、本家の `FinalSnapshotDiffEngine` の処理をそのまま使い、1秒ごとの読み取りもしない
- AC-4: Ghostty のときは、入力欄の文字が10万文字(UTF-16)を超えても読み取りを捨てない。読み取る文字数の上限は設計で決める(Ghostty の既定の履歴の量を踏まえる)。Ghostty 以外のアプリの上限(`maximumFieldUTF16Length`)は変えない
- AC-5: FR-03 のログを、貼り付けたときと確定させるときに出す。ログは Ghostty 以外のアプリでも出す(VS Code の調査に使うため)
- AC-6: 本家のファイルの変更は、FR-01〜FR-03 を呼ぶ行と、そのための小さな補助(引数の受け渡しなど)だけ。本家の処理の並べ替え・書き直しはしない。変更した行は `FORK-CHANGES.md` の「変更した既存ファイル」表に記録する
- AC-7: `make test` の既存のテスト(release-2 の26件)がすべて通る。AC-2 の範囲の決め方(複数か所のとき末尾に近いもの)を、純粋な処理に切り出してテストする。本家の `FinalSnapshotDiffEngine` の動作(Ghostty 以外)を確かめるテストを1件以上足し、それも通る

### FR-05: 実機確認の手順と記録(優先度: 必須)

- 場所: `docs/releases/release-3-autolearn-ghostty/e2e-verification.md`(新規)、`docs/known-issues.md`

前提: `scripts/deploy-mbp.sh` で MacBook Pro に配れていること。VoiceInk の設定は普段のまま(Dictation モード、日本語、large-v3-turbo-q5_0、AI 整形あり、Auto Learn はオンで審査は Gemini、審査のタイミングは「すぐ」)。ログは CLAUDE.md の計測ログの取得コマンドで取る。

- AC-1: `e2e-verification.md` に、AC-2〜AC-9 の手順、ログの取り方(`AutoLearnDiagnostics` と `AutoLearnCapture` のカテゴリで絞る `log show` のコマンド)、結果を書く表がある
- AC-2: Ghostty で Enter で送る(手動検証必須) — Ghostty で開いた Claude Code の入力欄に「Claude Code と Codex、どちらがいいですか。」を口述し、誤った語を1つ直して、すぐ Enter で送る。`AutoLearnDiagnostics` の確定させる行で直しが取れていて、ログに `Queued … candidate(s)` と `Auto Learn review completed` が出る。VoiceInk の設定の Dictionary に、直した語の単語置換か語彙が増えている
- AC-3: 応答の文字が候補に入らない(手動検証必須) — AC-2 の候補(VoiceInk の設定の審査の画面、または辞書に登録された語)に、Claude Code の応答の文字が含まれない
- AC-4: Ghostty で Enter で送らない(手動検証必須) — AC-2 と同じ口述と直しのあと、Enter で送らずに別のアプリへフォーカスを移す。AC-2 と同じように候補になる
- AC-5: 長い履歴(手動検証必須) — Ghostty の入力欄の文字数(`AutoLearnDiagnostics` の貼り付けたときの行)が10万を超える状態で AC-2 を行い、同じように候補になる。10万を超える状態が作れなかったときは、そのときの文字数を記録する
- AC-6: 他のアプリが変わらない(手動検証必須) — Chrome とテキストエディットで、release-2 の e2e-verification.md の AC-1 と同じ口述と直しを行い、今までどおり候補になる
- AC-7: VS Code の調査(手動検証必須) — VS Code のエディタ、Claude Code 拡張の入力欄、統合ターミナルの3か所で、設定 `editor.accessibilitySupport` が `auto`(既定)と `on` のそれぞれについて、口述して1語を直す。`AutoLearnDiagnostics` の2行(読み取りの結果・方法・文字数、止まった段階)を、場所と設定ごとに表に記録する
- AC-8: 既知課題の更新(手動検証必須) — AC-7 の結果をもとに、`docs/known-issues.md` の B2 を書き直し、Claude Code 拡張の入力欄と統合ターミナルで直しが拾えなかったときは、それぞれ新しい項目(B の連番)を起票する。各項目の現象には AC-7 の実測を、対応方針には release-4 での直し方の案を書く。AC-2〜AC-5 で B1 が解消したら、B1 を「解決済みログ」へ移す
- AC-9: ログに口述の中身が出ない(手動検証必須) — AC-2〜AC-7 で取ったログ全体を、口述した文の一部(「どちらがいいですか」)と直した語で検索し、`AutoLearnDiagnostics` の行に1件も出ない

## 非機能要件

- FR-01・FR-02・FR-03 は互いに独立に実装可能(どれも新しいファイル)。FR-04 はこの3つが揃ってから結線する。FR-05 は文書だけで、FR-04 の後に書く
- 1秒ごとの読み取り(FR-02)は Ghostty のときだけ、見張りの間だけ動かす。本家のアクセシビリティ用のキュー(`AutoLearnAXRuntime` の `queue`)で行い、メインスレッドで行わない。貼り付け・録音開始・録音停止後の最終処理を待たせない
- 口述の中身(貼り付けた文字、入力欄の文字、直した文字、候補、審査の結果の語)を `.public` のログ、リポジトリ内のファイル(`logs/` を除く)に出さない。`.public` にしてよいのは件数・文字数・秒数・真偽・理由や段階の決まった文字列・アプリの識別子だけ
- 審査で AI に送る文字の範囲を広げない。32文字の上限と、前後の文脈の量(本家は前後3単位)は変えない
- Ghostty 以外のアプリでの Auto Learn の動作(位置の特定、確定させる時点、読み取りの上限)は変えない
- AI 整形・単語置換の適用・貼り付けの経路は変えない。途中経過の表示(release-1)を壊さない。録音停止後の最終処理は Mode で選んだ Whisper モデルのまま
- entitlements と権限(マイク、アクセシビリティ)は追加しない。キー入力を見張る仕組み(イベントタップ、入力監視)は使わない(Enter を検知する代わりに1秒ごとに読む)
- 本家の文書(README.md、BUILDING.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md)と docs/fork-plan.md(凍結)を変えない
- `make check`・`make build`・`make test` が通る

## スコープ外

- VS Code(エディタ・Claude Code 拡張の入力欄・統合ターミナル)で直しを拾う対応(FR-05 AC-7・AC-8 で調べて記録するまで。直すのは release-4 以降)
- Ghostty 以外のターミナル(ターミナル.app・iTerm2 など)
- Claude Code が長い貼り付けを `[Pasted text #1 +N lines]` のようにまとめて表示する場合(貼り付けた文字が入力欄に無いので、読み取りの段階で `pasted-range-invalid` になる)
- 既知課題 B4(似た音の別の誤り方に単語置換を当てる)
- 途中経過の表示の続き(M2〜M6)、既知課題 P1、release-1 の未実施の手動検証4件
- 審査の画面や辞書の画面の変更
- キー入力の見張り(Enter の検知)

## 未解決事項

- **設計で確かめる**: Ghostty のアクセシビリティが、文字数(`AXNumberOfCharacters`)と範囲を指定した読み取り(`AXStringForRange`)に対応しているか。対応していれば、FR-04 AC-4 で末尾だけを読める(全文を毎秒読まずに済む)。対応していなければ全文を読んでから切り出す。どちらになるかで、FR-04 AC-4 の上限の値と、FR-02 の1回の読み取りの重さが決まる。Ghostty のソース(macOS 版のアクセシビリティの実装)で確かめる
- **設計で確かめる**: Enter で送ったあと、Claude Code は入力欄のあった位置に送った文を残し、その後ろに応答と新しい入力欄を描く。このとき final が「直しが取れる形」に見えてしまう並びがないか。FR-01 AC-3・AC-4 の判定(長すぎる・空)で足りるか、貼り付けた文字の後ろの文字(入力欄の下の枠など)が baseline と一致することも条件にするかを決めないと、FR-01 AC-7 (3) のテストが書けない
- **実機で確かめる**: Ghostty の読み取りが、アクセシビリティの時間切れ(貼り付けたときは0.1秒、その後は0.2秒。`AutoLearnTypes.swift` の `captureAccessibilityTimeoutSeconds`・`accessibilityTimeoutSeconds`)に収まるか。5.6万文字では収まっていた。10万文字を超えると収まらない可能性があり、そのときは FR-05 AC-5 が満たせない。FR-03 のログで文字数と結果を記録する
- **実機で確かめる**: Ghostty が、1行に収まらない長い文を折り返したとき、読み取った文字に改行を入れるか。入れるなら、長い口述は貼り付けた範囲が見つからず(`pasted-range-invalid`)候補にならない。このリリースでは直さず、FR-03 のログで起きるかを確かめ、起きたら既知課題に起票する
- **実機で確かめる**: Enter を押す直前の1秒未満に直した分は、FR-02 の1秒ごとの読み取りに間に合わず、拾えないことがある。実機で困るほど起きるかを FR-05 AC-2 で確かめる

## 用語

- Auto Learn:本家の、貼り付けた文字を人が直したら、その直しを辞書に自動で登録する機能
- 見張り:Auto Learn が、貼り付けたあと最大60秒、貼り付け先の入力欄を読める状態にしておくこと。次の貼り付け・次の録音開始・フォーカスが外れたとき・60秒のどれかで終わり、そのときに直しを確定させる
- 目印:直した位置を探すために使う、貼り付けた文字の前後の文字(本家は前後16文字)
- baseline / final:貼り付けた直後に読んだ入力欄の文字 / 直しを確定させるときに読んだ入力欄の文字
- 候補:直した箇所と、その前後の少しの文字の組。AI の審査に送られる

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-3-autolearn-ghostty", config: <.claude/workflow.config.json の内容>}})
```
