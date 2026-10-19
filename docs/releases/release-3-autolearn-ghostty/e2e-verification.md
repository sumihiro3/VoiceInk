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
| `fieldUTF16` | AutoLearnDiagnostics(貼り付けたとき) | 入力欄の文字数(UTF-16)。AC-5 では 100000 を超えるか |
| `finalUTF16` | AutoLearnDiagnostics(確定させるとき) | 確定させるときに読んだ入力欄の文字数(UTF-16) |
| `revision` | AutoLearnDiagnostics(確定させるとき) | 直しが取れたか(`found` / `none`) |
| `stage` | AutoLearnDiagnostics(確定させるとき) | 直しが取れなかったときに止まった段階 |
| `tracked` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1秒ごとの読み取りで取れた「最後に取れた直し」を使ったか(`yes` / `no`) |
| `reads` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1秒ごとの読み取りの回数 |
| `maxReadMs` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 1回の読み取りにかかった時間の最大値(ミリ秒)。時間切れ(0.1秒・0.2秒)に収まるかの目安 |
| `beforeAnchors` | AutoLearnDiagnostics(確定させるとき、Ghostty だけ) | 前の目印が見つかった数 |
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

## 実機で確かめる未解決事項

| 項目 | 確かめ方 | 結果 | 日付 |
| --- | --- | --- | --- |
| 読み取りが時間切れ(貼り付け時 0.1秒、以降 0.2秒)に収まるか | `maxReadMs` と、貼り付けたときの行の読み取りの結果。5.6万文字では収まっていた。10万文字超での値を記録する | | |
| 長い文を折り返したとき、読み取った文字に改行が入るか | 1行に収まらない長さの口述をし、貼り付けたときの行が `pasted-range-invalid` になるか確かめる。起きたら既知課題に起票する(このリリースでは直さない) | | |
| Enter の直前1秒未満の直しを拾えないことが、困るほど起きるか | AC-2 で、直した直後に Enter を押して確かめる。`tracked` と `stage` を見る | | |
