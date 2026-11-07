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
| `source` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 使った直しの出どころ。`final`(確定させるときの入力欄)・`sent-echo`(Enter で送ったあとの送った文の行)・`tracked`(1秒ごとの読み取りで最後に取れた直し)・`none` |
| `baselineUTF16`・`commonPrefixUTF16`・`echoLineOffset`・`echoLineUTF16` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 貼り付けたときの画面の長さ、送ったあとの画面と先頭から一致した長さ、送った文とみなした行の貼り付けた位置からのずれと長さ。送った文の行が見つからないときに、画面が描き直されたのか(`commonPrefixUTF16` が小さい)、行を見分けられないのかを区別する |
| `echoMethod` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 送った文の行の探し方。`prompt-line`(画面の最後から上へプロンプトの行を探した)・`common-prefix`(貼り付けたときの画面と先頭から比べた) |
| `sentEcho` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 入力欄が空のときに送った文の行を調べた結果。`revised`・`unchanged`(直さずに送った)・`not-found` |
| `Queued … candidate(s)` | AutoLearn | 候補がキューに入ったこと |
| `Auto Learn review completed` | AutoLearnAIReview | 審査が完了したこと |
| `pasted-range-invalid` など | AutoLearnCapture | 貼り付けた直後の読み取りが捨てられた理由 |

## 結果の表(AC-2〜AC-6・AC-9)

結果は「合格」「不合格」と、不合格なら止まった `stage` を書く。

| AC | 内容 | 結果 | 日付 | 備考(`fieldUTF16`・`stage`・`tracked`・`reads`・`maxReadMs`・`beforeAnchors`) |
| --- | --- | --- | --- | --- |
| AC-2 | Ghostty で Enter で送る | 合格(5回目。`source=tracked` だったので、4acc162 で `source=sent-echo` を再確認する) | 2026-11-07 | `fieldUTF16=126990`・`stage=revised`・`tracked=yes`・`reads=17`・`maxReadMs=8`・`beforeAnchors=2` |
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
- 対応: 確定時の順を「確定させるときの入力欄 → 入力欄が空なら履歴に残った送った文の行 → 持っておいた直し」に改めた(FR-02 AC-3・AC-7)。確定させる行に `source`・`sentEcho` を足した。次の確認では `source=sent-echo sentEcho=revised` と、送った文の長さに合う `correctedUTF16` が出れば、この対応が効いている

### 2026-11-07 5回目(ビルド 1dd8ce1)

- 1度目の試行(09:10〜09:11): 録音2回は取り消され(`Streaming cancelled`)、3回目は Chrome に貼り付けられた。Ghostty の行が無く、確認にならなかった
- 口述: 「オートペティアビデオメーカーを作ったよ」(Whisper の結果、20文字+末尾の空白)。「ProtoPedia Video Maker」に直して Enter で送った
- 貼り付けたとき: `result=captured fieldUTF16=126990 pastedLocation=126969 pastedLength=21 matchedLength=21`。履歴が10万文字を超えていても、入力欄の位置で取れた。貼り付けた文字が画面の文字の最後にある(126969 + 21 = 126990)
- 確定させるとき: `reason=focus finalUTF16=127112 revision=found stage=revised beforeAnchors=2 afterAnchors=0 reads=17 tracked=yes maxReadMs=8 updates=9 lastUpdateAgeMs=5956 originalUTF16=20 correctedUTF16=28 finalStage=too-long source=tracked sentEcho=none`
- 候補(待ち行列の中身): 元「オートペティアビデオメーカーを作ったよ」→ 直した後「ProtoPedia Video Makerを作ったよ」。4回目のような直しの途中の文字は残っていない(最後の直しから確定まで約6秒あった)
- 審査: Gemini(`gemini-3.8-flash`)は5回とも90秒の時間切れ(`LLMKitError code=8`)で、やり直しの上限に達した(09:30:32)。審査のモデルを Anthropic に変えると、すぐに審査が始まり(09:32:20、ログの `model=claude-sonnet-5-5`。設定はその後 `claude-haiku-5-5`)、2秒で完了した。結果は `replacementAndVocabulary=1 rejected=0`
- 辞書: 単語置換「オートペティアビデオメーカー → ProtoPedia Video Maker」と、語彙「ProtoPedia Video Maker」が増えた
- 判定: AC-2 は合格(辞書が増えた)。ただし送った文の行は使われていない(`source=tracked`)。今回は持っておいた直しが正しかっただけで、4回目と同じ取りこぼしが起こりうる。下の対応を入れたビルドで、`source=sent-echo` をもう一度確かめる
- 原因: 貼り付けた文字の後ろに文字が無いため、後ろの目印が無い(`afterAnchors=0`)。Enter で送ったあとの確定では、前の目印から画面の最後(送った文・応答・新しい入力欄)までを切り出すので `too-long` になった。送った文の行は、入力欄が空(`input-empty`)のときだけ調べる作りだった
- 対応: 確定させるときに直しが取れず、入力欄が元の文のまま(`not-revised`)でもなければ、送った文の行を調べる(FR-02 AC-3)。実機の5回目の並びを再現したテスト `testSentEchoIsUsedWhenPasteWasAtEndOfScreen` を足した(直す前の条件では失敗し、直したあとは通ることを確かめた)
- AC-5 の材料: 12.7万文字の履歴で、貼り付けたときの読み取りが取れ、1秒ごとの読み取りは最大8ミリ秒

### 2026-11-07 6回目・7回目(ビルド 06af4bf)

- 口述はどちらも「ProToPedia Video Makerを作りました。」(29文字+末尾の空白)。「ProTo」を「Proto」に直した(大文字・小文字だけの直し)
- 6回目(09:39、貼り付け先は Ghostty の zsh のプロンプト。Enter で文がコマンドとして実行され、次の行に `zsh: command not found: ProtoPedia` が出た): `fieldUTF16=108 pastedLocation=78 pastedLength=30 matchedLength=30`、確定は `finalStage=too-many-line-breaks source=sent-echo sentEcho=revised originalUTF16=29 correctedUTF16=64`。送った文の行を使う処理は動いたが、取った文が64文字で、正しい29文字より35文字長い。29 + 1 + 34(`zsh: command not found: ProtoPedia` の長さ)= 64 なので、読み取った文字では、送った文とコマンドの出力が1行に並んでいたと見ている(未確認)。審査は `rejected=1`
- 7回目(09:42、貼り付け先は Ghostty の Claude Code): `fieldUTF16=3013 pastedLocation=2446 pastedLength=30 matchedLength=29`、確定は `reason=focus finalUTF16=3013 stage=revised beforeAnchors=1 afterAnchors=1 tracked=no maxReadMs=5 originalUTF16=29 correctedUTF16=29 finalStage=revised source=final`。確定させるときの入力欄から、正しい長さの直しが取れた。画面の文字数が貼り付けたときと同じなので、Enter で送る前にフォーカスが外れて確定したと見ている(AC-4 の形)。審査は `rejected=1`
- 却下の理由: 審査の指示文(本家)に「大文字・小文字だけの直しは却下する」(`AutoLearnAIReviewer.swift` の "Reject case-only changes")とあり、どちらも大文字・小文字だけの直しだった。取り出しの不具合ではない
- 判定: Claude Code では、Enter で送ったとき(5回目の後の直し、`source=sent-echo` は Claude Code では未確認)と送らずに離れたとき(7回目、`source=final`)の取り出しが動いている。shell のプロンプトは対象外(要件の範囲は Claude Code)。6回目の現象は既知課題に起票する

### 2026-11-07 8回目・9回目(ビルド 06af4bf、Claude Code)

- 8回目(09:45): 口述(28文字)を貼り付けたあと、入力欄の文を消して、次の録音を始めた(ユーザーの確認)。確定は `reason=recording-start finalUTF16=2984`(貼り付けたときの3012より28短い)`finalStage=input-empty sentEcho=not-found source=tracked originalUTF16=28 correctedUTF16=7`。送った文の行が無いのは正しいが、持っておいた直しとして、消している途中の状態(7文字)が候補になった。審査は `rejected=1` で、辞書は変わらなかった
- 9回目(09:46): 「…封入した状態で、さ3cmを超えるもの…」(61文字)の「さ」を「高さ」に直し、Enter で送らずに離れた(ユーザーの確認)。確定は `reason=focus source=final originalUTF16=61 correctedUTF16=62`。取り出しは正しい。候補はできなかった。本家の差分の処理(`CorrectionDiffEngine`)は、共通する前後を外したあと元の側が空になる直し(文字を足すだけ)を候補にしないため。本家の作りで、Ghostty の取り出しの不具合ではない
- 見えた問題: 入力欄を消して送らなかったときに、持っておいた直しへ戻ると、消している途中の状態を候補にしてしまう。今回は審査が却下したが、審査に頼る形になっている
- 対応: 送った文の行が見つからず(`sentEcho=not-found`)、確定させるときの画面の文字数が貼り付けたときを超えていなければ、送らずに消したとみなして、持っておいた直しを使わない(FR-02 AC-3)。テスト `testClearedWithoutSendingIgnoresTrackedRevision` を足した(直す前は失敗、直したあとは通る)。送ったが履歴に送った文が出ない場合(`sentPlaceholderFinal`)は、今までどおり持っておいた直しを使う
- 未確認のまま: Claude Code で Enter で送ったときに、送った文の行から直しを取ること(`source=sent-echo`)

### 2026-11-07 10回目・11回目(ビルド c2160c5、Claude Code)

- 10回目(10:03): 「次はCloude CodeでEnterで送ったときに、…」(51文字)を直して Enter で送った。画面の見た目は変わらなかった(ユーザーの確認)。確定は `reason=deadline finalUTF16=949`(貼り付けたときの3035から2086減った)`finalStage=input-empty updates=0 sentEcho=not-found source=none`。候補なし
- 11回目(10:04): 19文字の口述を直して送らずに離れた。`source=final` で直しが取れ、候補2件は審査で却下された
- 見立て(10回目): 画面の見た目が同じなのに読み取った文字が3分の1以下になったので、Claude Code が履歴を消して画面全体を描き直したと見ている(未確認)。描き直されると、貼り付けたときの画面と先頭から比べる送った文の行の探し方は使えない。`updates=0` は、直しから Enter までが1秒の読み取りより短かったことを示す(ログからの推定。ユーザーは未回答)
- 見えた問題: c2160c5 の「画面の文字が増えていなければ消したとみなす」は、描き直しで画面が大きく減ったときにも当てはまり、持っておいた直しがあれば捨ててしまう(10回目は持っておいた直しが無かったので影響なし)
- 対応: 消したとみなすのを、画面の減り方が 0 以上で貼り付けた長さ + 64 以下のときに限った(8回目は28、10回目は2086)。テスト `testRedrawnScreenStillUsesTrackedRevision` を足した(前の条件では失敗し、直したあとは通る)。確定させる行に `baselineUTF16`・`commonPrefixUTF16`・`echoLineOffset`・`echoLineUTF16` を足し、送った文の行が見つからないときに、描き直しか行を見分けられないかを区別できるようにした
- 残る課題: 描き直されたあとの画面で送った文の行を探す方法。入力欄の位置から上へ、元の文に似た最も近い行を探す案を相談する
- 対応(ユーザーの了承のあと、ビルド 98ed50a): 画面が増えた・描き直されたときは、画面の最後から上へ、本文が空でないいちばん新しいプロンプトの行(`>` などで始まる行)を送った文の行とする(FR-02 AC-7)。描き直されていないのに決まらないときは、先頭から比べる探し方に戻す。確定させる行に `echoMethod`(`prompt-line`・`common-prefix`)を足した。Ink(Claude Code の画面を描くライブラリ)は、出力が端末の高さを超えると履歴を消して描き直すという報告がある(Claude Code の issue #2479 など。公式の資料ではない)

### 2026-11-07 12回目・13回目(ビルド 58e5017、Claude Code)

- 12回目(12:03): 「隣の町に着いた。…」(22文字)。合っていたので入力欄から消した(ユーザーの確認)。確定は `reason=recording-start baselineUTF16=971 finalUTF16=949`(ちょうど貼り付けた長さ22だけ減った)`updates=0 sentEcho=not-found echoMethod=common-prefix source=none`。候補なしで正しい
- 13回目(12:04): 「円と縦の看板がある。 これが武器屋。…」(40文字)を「剣と盾の看板がある。これが武器屋だ。…」に直した(ユーザーの確認)。確定は `reason=focus baselineUTF16=989 finalUTF16=990 source=final originalUTF16=40 correctedUTF16=41`。入力欄から正しい長さの直しが取れ、候補2件になった。審査は `rejected=1` が2件。審査の指示文(本家)は、普通の語の聞き違い(汎用の音声認識が直すべきもの)を登録しないので、その判断と見ている
- 気づいた点: 10:03 から、画面の文字数が 950〜990 ほどでほぼ一定になった(それより前は履歴とともに 3013 → 3035 と増えていた)。Claude Code が固定の大きさの別の画面に描くモードに切り替わり、見えている画面だけが読み取られていると見ている(未確認)。この場合、Enter で送っても画面の文字は貼り付けた長さほど減るので、減り方で「送った」と「消した」を見分ける判定は当てにならない。Enter で送ったときの確認は、この画面のモードではまだ

## 実機で確かめる未解決事項

| 項目 | 確かめ方 | 結果 | 日付 |
| --- | --- | --- | --- |
| 読み取りが時間切れ(貼り付け時 0.1秒、以降 0.2秒)に収まるか | `maxReadMs` と、貼り付けたときの行の読み取りの結果。5.6万文字では収まっていた。10万文字超での値を記録する | 収まった。12.7万文字(`fieldUTF16=126990`)で貼り付けたときの読み取りが取れ、`maxReadMs=8` | 2026-11-07 |
| 長い文を折り返したとき、読み取った文字に改行が入るか | 1行に収まらない長さの口述をし、貼り付けたときの行が `pasted-range-invalid` になるか確かめる。起きたら既知課題に起票する(このリリースでは直さない) | | |
| Enter の直前1秒未満の直しを拾えないことが、困るほど起きるか | AC-2 で、直した直後に Enter を押して確かめる。`tracked` と `stage` を見る | | |
