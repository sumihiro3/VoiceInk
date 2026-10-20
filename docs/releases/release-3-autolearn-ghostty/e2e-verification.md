# release-3-autolearn-ghostty 実機確認

Ghostty で Auto Learn が直しを拾えること(既知課題 B1)と、VS Code の読み取りの調査(B2)を、MacBook Pro の実機で確かめる手順と記録。要件は `requirements.md` の FR-05 を参照。

## 前提

- `scripts/deploy-mbp.sh` で、このブランチのビルドを MacBook Pro に配れている(`deployed` と表示されたこと)
- VoiceInk の設定は普段のまま(Dictation モード、日本語、large-v3-turbo-q5_0、AI 整形あり、Auto Learn はオン・審査は Gemini・審査のタイミングは「すぐ」)
- 口述した文や直した語は、このファイルに書かない。書いてよいのは要件にある例文だけ。ログの値は数値・段階の文字列・アプリの識別子だけを写す

## ログの取り方

各手順の前に時刻を控え、手順のあとに Mac mini から次を実行する(`--last` は手順に要した時間に合わせて変える)。

```bash
ssh mbp "/usr/bin/log show --last 10m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND (category == \"AutoLearnDiagnostics\" OR category == \"AutoLearnCapture\" OR category == \"AutoLearn\" OR category == \"AutoLearnAIReview\")'" > logs/mbp-$(date +%H%M).log
```

`logs/` には口述内容が含まれ得る。`.gitignore` 済みで、コミットしない。

### 判定に使うログの欄

| 欄・文言 | カテゴリ | 見ること |
| --- | --- | --- |
| `pastedLength`・`matchedLength` | AutoLearnDiagnostics(貼り付けたとき) | 貼り付けた文字の長さと、入力欄で一致した長さ(UTF-16)。Ghostty で末尾の空白を除いて一致したときは `matchedLength` が短くなる |
| `fieldUTF16` | AutoLearnDiagnostics(貼り付けたとき) | 入力欄の文字数(UTF-16)。AC-5 では 100000 を超えるか |
| `finalUTF16` | AutoLearnDiagnostics(確定させるとき) | 確定させるときに読んだ入力欄の文字数(UTF-16) |
| `revision` | AutoLearnDiagnostics(確定させるとき) | 直しが取れたか(`found` / `none`) |
| `stage` | AutoLearnDiagnostics(確定させるとき) | 直しが取れなかったときに止まった段階 |
| `tracked` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1秒ごとの読み取りで取れた「最後に取れた直し」を使ったか(`yes` / `no`) |
| `reads` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1秒ごとの読み取りの回数 |
| `maxReadMs` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1回の読み取りにかかった時間の最大値(ミリ秒)。時間切れ(0.1秒・0.2秒)に収まるかの目安 |
| `beforeAnchors` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 前の目印が見つかった数 |
| `updates`・`lastUpdateAgeMs` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1秒ごとの読み取りで直しが変わった回数と、最後に変わってから確定までのミリ秒 |
| `originalUTF16`・`correctedUTF16` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 使った直しの、元の文と直した文の長さ。直し終わる前の状態を拾っていないかを見る |
| `finalStage`・`finalCorrectedUTF16` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 確定時の状態から直しを取り出したときの段階と、直した文の長さ(持っておいた直しを使ったときも調べる) |
| `Queued … candidate(s)` | AutoLearn | 候補がキューに入ったこと |
| `Auto Learn review completed` | AutoLearnAIReview | 審査が完了したこと |
| `pasted-range-invalid` など | AutoLearnCapture | 貼り付けた直後の読み取りが捨てられた理由 |

## 結果の表(AC-2〜AC-6・AC-9)

結果は「合格」「不合格」と、不合格なら止まった `stage` を書く。

| AC | 内容 | 結果 | 日付 | 備考(`fieldUTF16`・`stage`・`tracked`・`reads`・`maxReadMs`・`beforeAnchors`) |
| --- | --- | --- | --- | --- |
| AC-2 | Ghostty で Enter で送る | | | |
| AC-3 | 応答の文字が候補に入らない | | | |
| AC-4 | Ghostty で Enter で送らない | | | |
| AC-5 | 長い履歴(10万文字超) | | | |
| AC-6 | 他のアプリが変わらない(Chrome・テキストエディット) | | | |
| AC-9 | ログに口述の中身が出ない | | | |

## 手順

### AC-2: Ghostty で Enter で送る

1. Ghostty で Claude Code を開く
2. 入力欄に「Claude Code と Codex、どちらがいいですか。」を口述する
3. 誤って認識された語を1つ直し、すぐ Enter で送る
4. 応答が返るまで待ち、ログを取る
5. 確認:
   - `AutoLearnDiagnostics` の確定させる行で、直しが取れている(`stage` が止まった段階を示していない)
   - `Queued … candidate(s)` と `Auto Learn review completed` が出る
   - VoiceInk の設定の Dictionary に、直した語の単語置換か語彙が増えている
6. Enter の直前1秒未満に直した場合に拾えないことがあるかを、下の「実機で確かめる未解決事項」に記録する

### AC-3: 応答の文字が候補に入らない

1. AC-2 の候補を、VoiceInk の設定の審査の画面、または辞書に登録された語で確かめる
2. Claude Code の応答の文字が1つも含まれていないこと

### AC-4: Ghostty で Enter で送らない

1. AC-2 と同じ口述と直しを行う
2. Enter で送らず、別のアプリへフォーカスを移す
3. ログを取り、AC-2 と同じ確認をする(確定させる理由はフォーカスになる)

### AC-5: 長い履歴

1. Ghostty の履歴を増やし、貼り付けたときの行の `fieldUTF16` が 100000 を超える状態にする
2. AC-2 を行い、同じように候補になること
3. 超える状態が作れなかったときは、そのときの `fieldUTF16` を備考に記録する
4. 超えたのに候補にならないときは `maxReadMs` と `stage` を記録する(時間切れの疑い)

### AC-6: 他のアプリが変わらない

1. Chrome とテキストエディットで、`docs/releases/release-2-autolearn-japanese/e2e-verification.md` の AC-1 と同じ口述と直しを行う
2. どちらも今までどおり候補になること
3. `AutoLearnDiagnostics` の行が出ていること(Ghostty 以外でも出す仕様)。このとき確定させる行に `reads` などの Ghostty 用の欄が付かないこと(1秒ごとの読み取りは Ghostty だけで、ほかのアプリではこの欄自体を出さない)

### AC-7: VS Code の調査

VS Code の3か所と、設定 `editor.accessibilitySupport` の `auto`(既定)・`on` の組み合わせ6通りで、口述して1語を直す。設定を変えたら VS Code を再読み込みする。各回のあと、貼り付けたときの行と確定させる行を表に写す。

| 場所 | accessibilitySupport | 読み取りの結果 | 読み取りの方法(`source`) | 入力欄の文字数 | 止まった段階(`stage`) |
| --- | --- | --- | --- | --- | --- |
| エディタ | auto | | | | |
| エディタ | on | | | | |
| Claude Code 拡張の入力欄 | auto | | | | |
| Claude Code 拡張の入力欄 | on | | | | |
| 統合ターミナル | auto | | | | |
| 統合ターミナル | on | | | | |

### AC-8: 既知課題の更新

1. AC-7 の結果をもとに、`docs/known-issues.md` の B2 を書き直す(現象に AC-7 の実測、対応方針に release-4 での直し方の案)
2. Claude Code 拡張の入力欄と統合ターミナルで直しが拾えなかったときは、それぞれ新しい項目(B の連番)を起票する
3. AC-2〜AC-5 で B1 が解消したら、B1 を「解決済みログ」へ移す
4. 新しい項目の起票と B1 の移動は、実機の結果が出てから行う。結果が出る前に起票しない(`known-issues.md` の B1・B2 は、いまは仮の記載)

### AC-9: ログに口述の中身が出ない

AC-2〜AC-7 で取ったログ全体を検索し、`AutoLearnDiagnostics` の行に1件も出ないことを確かめる。

```bash
grep -h "どちらがいいですか" logs/mbp-*.log | grep "AutoLearnDiagnostics"
```

直した語でも同じ検索をする(語はこのファイルに書かず、シェルの変数で渡す)。

```bash
WORD="<直した語>"; grep -h -F "$WORD" logs/mbp-*.log | grep "AutoLearnDiagnostics"
```

どちらも出力が空であれば合格。

## 実施記録

### 2026-10-20 1回目(ビルド e7d90a7)

- AC-2(Ghostty で Enter で送る): 不合格。貼り付けたときの行が `app=com.mitchellh.ghostty result=pasted-range-invalid source=native-value fieldUTF16=1134 pastedLocation=none pastedLength=29 selection=yes` で、見張りが始まらなかった(確定させる行も出ない)
- 原因: VoiceInk は貼り付ける文字の末尾に空白を足す(設定 `AppendTrailingSpace`、既定でオン。MacBook Pro も既定のまま)。Claude Code の画面には行末の空白が残らないため、Ghostty 用の探し方(完全一致だけ)で貼り付けた文字が見つからなかった。本家の探し方には、前後の空白を除いて探す処理(`uniqueBoundaryWhitespaceMatch`)がある
- 対応: 完全一致が無ければ、前後の空白と改行を除いた文字列で探す(`AutoLearnTerminalTarget.pastedRangeNearestToEnd`)。確かめるため、貼り付けたときの行に一致した長さ `matchedLength` を足した。2回目で `pastedLength` より `matchedLength` が1短く、`result=captured` になれば、原因の見立てが正しい

### 2026-10-20 2回目(ビルド bc5dd8e)

- 貼り付けたとき: `result=captured source=native-value fieldUTF16=1338 pastedLocation=902 pastedLength=29 matchedLength=28 selection=yes`。末尾の空白を除いて一致した(1回目の原因の見立てどおり)
- 確定させるとき: `reason=focus finalUTF16=1528 revision=found stage=revised reads=9 failedReads=0 skippedReads=0 tracked=yes maxReadMs=9`。1秒ごとの読み取りで取れた直しを使った。1回の読み取りは最大9ミリ秒で、時間切れ(0.1秒・0.2秒)より十分短い
- 候補: `Queued 1 Auto Learn candidate(s)`
- 審査: 1回目は90秒で時間切れ(`LLMKitError code=8`)。30秒後に自動でやり直し(`retry scheduled kind=timeout attempt=1 delay=30s`)、やり直しは73秒で完了したが、結果は `rejected=1`。辞書は増えなかった
- 貼り付けた文字は Whisper の段階で「Claude Code」が正しく出ていた(release-2 の語彙の効果)
- 気づいた点: `tracked=yes` のとき、確定させる行の `beforeAnchors`・`afterAnchors` は 0 になる(確定時の状態を調べないため)。目印の数は、持っておいた直しを取ったときの値ではない
- 判定: AC-2 は不合格(辞書が増えていない)。直したのは「コーデックス → Codex」で、Enter で送ったあと別のアプリへ移った(ユーザーの回答)。この直しは審査の指示文が登録する例に挙げているもので、却下は不自然
- 見立て: 1秒ごとの読み取りが、直し終わる前の状態(「Codex」を打ち終える前など)を「最後に取れた直し」として持ち、送る前の直しを優先する FR-02 AC-3 の作りにより、それが候補になった。候補の中身はログにも保存先にも残らないため未確認
- 対応: 確かめるため、確定させる行に `updates`・`lastUpdateAgeMs`・`originalUTF16`・`correctedUTF16`・`finalStage`・`finalCorrectedUTF16` を足した(口述の中身は出さない)。直し終わっていれば `correctedUTF16=27`

### 2026-10-20 3回目(ビルド dcd8f1a)

- 貼り付けた文字は「Claude CodeとCodexどちらがいいですか。」+ 末尾の空白で、Whisper が最初から「Codex」と正しく出していた(直す語が無い)。この回は AC-2 の確認になっていない
- 貼り付けたとき: `result=captured fieldUTF16=1540 pastedLocation=575 pastedLength=28 matchedLength=28`。入力欄ではなく、2回目に Enter で送った同じ文(履歴に末尾の空白つきで残っていた)に完全一致した
- 確定させるとき: `stage=not-revised updates=0 tracked=no finalStage=not-revised`。履歴の行は変わらないので、直しは取れない
- 原因: 完全一致を、空白を除いた一致より優先していた。入力欄には行末の空白が残らないため、入力欄より前にある履歴の行を選んだ
- 対応: 完全一致と空白を除いた一致のうち、末尾に近いほうを選ぶ(同じ位置なら完全一致)
- 次の確認: Whisper が誤る語を含む文で行う(「Codex」は語彙の効果で正しく出るようになった)

### 2026-10-20 4回目(ビルド 4247608)

- 口述: 「Protopediaビデオメーカーを作りました。」(Whisper の結果、24文字+末尾の空白)。「Protopedia」を「ProtoPedia」、「ビデオメーカー」を「Video Maker」に直して、すぐ Enter で送った
- 貼り付けたとき: `result=captured fieldUTF16=1740 pastedLocation=1308 pastedLength=25 matchedLength=24`。入力欄の位置で、末尾の空白を除いて一致した(3回目の不具合は直った)
- 確定させるとき: `reason=focus revision=found stage=revised reads=16 tracked=yes maxReadMs=5 updates=8 lastUpdateAgeMs=2056 originalUTF16=24 correctedUTF16=30 finalStage=input-empty`。Enter で送ったあとの状態からは直しが取れず(`input-empty`)、送る前に持っておいた直しを使った
- 候補(待ち行列の中身): 元「Protopediaビデオメーカーを作りました」→ 直した後「ProtoPedia Video Makerーを作りました」。「Maker」の後ろに「ー」が残っている
- ユーザーの確認: 送った文に「ー」は残っていない。持っておいた直しは、送る直前の状態ではなかった
- 審査: Gemini の 503 が3回と時間切れが1回で、4回目のやり直し(18:04)で完了。結果は `rejected=1`、辞書は増えなかった
- 判定: AC-2 は不合格
- 見立て: 最後の直し(「ー」を消す)から Enter までが短く、1秒ごとの読み取り(Ghostty 側の読み取り結果は500ミリ秒の使い回しがある)に間に合わなかった。2回目の却下も同じ原因と見る。読み取りの間隔を縮めても、この隙間は無くならない

## 実機で確かめる未解決事項

| 項目 | 確かめ方 | 結果 | 日付 |
| --- | --- | --- | --- |
| 読み取りが時間切れ(貼り付け時 0.1秒、以降 0.2秒)に収まるか | `maxReadMs` と、貼り付けたときの行の読み取りの結果。5.6万文字では収まっていた。10万文字超での値を記録する | | |
| 長い文を折り返したとき、読み取った文字に改行が入るか | 1行に収まらない長さの口述をし、貼り付けたときの行が `pasted-range-invalid` になるか確かめる。起きたら既知課題に起票する(このリリースでは直さない) | | |
| Enter の直前1秒未満の直しを拾えないことが、困るほど起きるか | AC-2 で、直した直後に Enter を押して確かめる。`tracked` と `stage` を見る | | |
