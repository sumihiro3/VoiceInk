# release-2-autolearn-japanese 実機検証(e2e-verification)

MacBook Pro(M1 Pro)で口述して確かめるための手順。対象は requirements.md の FR-09 AC-1〜AC-7(FR-05 AC-6 の配布を含む)。署名・SSH・初回の権限の準備は [release-1 の e2e-verification.md](../release-1-whisper-partial-prototype/e2e-verification.md) の第1〜3・5節が済んでいる前提で、ここには複製しない。共通のテストケースは [docs/e2e-verification.md](../../e2e-verification.md)。

- **口述した文字列と、直した文字は、リポジトリに書かない。** この表のメモにも書かない。ログは `logs/`(`.gitignore` 済み)にだけ置く。残すのは件数・文字数・秒数・結果の種類だけ
- 「Mac mini で」と書いた場所で、コマンドを 1 ブロックずつ貼って実行する

## 0. 全体の流れ

| 順 | やること | 場所 |
| --- | --- | --- |
| 1 | 配る(`scripts/deploy-mbp.sh`)。ハッシュの一致を確かめる | Mac mini |
| 2 | VoiceInk の設定を確かめる | MacBook Pro |
| 3 | AC-1〜AC-7 を口述し、そのたびにログを取る | 両方 |
| 4 | 実施記録に書く | このファイル |

## 1. 配る(Mac mini で)

試したいブランチ(`release-2-autolearn-japanese`)にいることを確かめてから配る。MacBook Pro はログインした状態にしておく。

```bash
cd /opt/dev/VoiceInk && git status -sb | head -1
```

```bash
cd /opt/dev/VoiceInk && scripts/deploy-mbp.sh
```

`deployed <短縮コミット> to mbp` と出れば成功。この短縮コミットを実施記録に書く。スクリプトは、ビルドしたバイナリがこの実行中に作り直されたことと、配ったあとのハッシュが手元と一致することを自分で確かめ、食い違えば止まる。

手で確かめるとき(配ったバイナリが、手元のビルドと同じか):

```bash
cd /opt/dev/VoiceInk && shasum -a 256 .local-build/Build/Products/Release/VoiceInk.app/Contents/MacOS/VoiceInk
```

```bash
ssh mbp "shasum -a 256 /Applications/VoiceInk.app/Contents/MacOS/VoiceInk"
```

2 つの 64 桁が同じであること。署名の確認:

```bash
ssh mbp "codesign -dv --verbose=2 /Applications/VoiceInk.app" 2>&1 | grep Authority
```

`Authority=Apple Development: …` が出ること。

## 2. VoiceInk の設定(MacBook Pro で)

普段の設定のまま使う。変えない。

- Mode: Dictation、言語: 日本語、モデル: large-v3-turbo-q5_0、AI 整形: あり
- Auto Learn: オン、審査: Gemini、審査のタイミング: すぐ
- 途中経過(隠し設定 `WhisperStreamingEnabled`)は AC-7 で使う。release-1 の第6節の手順で入れる

## 3. 口述して、ログを取る

### ログの取り方(Mac mini で)

試すたびに取る。`logs/` はコミットしない。

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category IN {\"AutoLearn\", \"AutoLearnAIReview\", \"AutoLearnCapture\", \"WhisperVocabularyPrompt\", \"CursorPaster\"}'" > logs/mbp-$(date +%H%M).log
```

全部(迷ったらこれ):

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\"'" > logs/mbp-all-$(date +%H%M).log
```

### ログで読む行

| 行 | 意味 | 使うケース |
| --- | --- | --- |
| `Queued … candidate(s)` | 直した箇所が候補になり、審査の待ち行列に入った | AC-1・AC-4 |
| `Auto Learn review completed` | 審査が終わった。結果の種類(`replacementAndVocabulary`・`replacementOnly`・`rejected` など)が続く | AC-1・AC-5 |
| `AI review failed` | 審査の時間切れ・失敗。**出ないこと** | AC-1 |
| `vocabularyTerms=… promptChars=…` | 初期プロンプトに入れた語彙の件数と文字数(カテゴリ `WhisperVocabularyPrompt`) | AC-3・AC-6 |

### 準備

AC-1 の前に、辞書(設定の Dictionary)の単語置換と語彙の件数を控える。直す語は、前回の登録と重ならないものを選ぶ。

### テストケース

各ケースのあとにログを取る。

- [ ] AC-1 短い文の登録(5アプリ)
  - アプリ: Chrome・テキストエディット・Slack・Claude デスクトップ・Obsidian(1アプリずつ)
  - 話す文: 「Claude Code と Codex、どちらがいいですか。」
  - 直し方: 貼り付けられた文の誤った語(例: 「ロードコード」)を手で「Claude Code」に直し、入力欄から離れる
  - 期待: ログに `Queued … candidate(s)` と `Auto Learn review completed` が出る。`AI review failed` が出ない。審査の結果が `replacementAndVocabulary` か `replacementOnly` で 1 件以上
- [ ] AC-2 辞書への登録
  - 手順: AC-1 のあと、VoiceInk の設定の Dictionary を開く
  - 期待: 直した語の単語置換(例: ロードコード → Claude Code)か語彙が、準備で控えた件数より増えている
- [ ] AC-3 次の口述への反映
  - 手順: AC-2 のあと、同じ文をもう一度口述する(30秒未満)
  - 期待: 「Claude Code」「Codex」と貼り付けられる。`WhisperVocabularyPrompt` のログに `vocabularyTerms=` が 1 以上で出る
- [ ] AC-4 長い文
  - アプリ: テキストエディット
  - 話す文: 「今日はメジャーリーグの移籍市場と、ナ・リーグのポスティングについて詳しく話しました。」
  - 直し方: 誤認識された語を手で直す
  - 期待: ログに `Queued … candidate(s)` が出る
- [ ] AC-5 却下の確認
  - 手順: 言い回しだけを直す(例: 「どちらがいいですか」を「どっちがいいですか」に直す)
  - 期待: 審査の結果が `rejected` になり、辞書が増えない
- [ ] AC-6 無音で語彙が出ないこと
  - 前提: 語彙が登録された状態
  - 手順: 何も話さずに 5 秒録音して止める
  - 期待: 貼り付けられた文字に語彙(Claude Code・Codex など)が含まれない。release-1 では、VAD を切ると話していない定型文が最後に足された。初期プロンプトの語が出るのと同じ現象なので、語彙を足して悪化していないかを見る
- [ ] AC-7 既存の動作
  - 手順: 隠し設定 `WhisperStreamingEnabled` をオンにして、短い文を口述する
  - 期待: 録音停止から貼り付けまでが今までどおり動く。途中経過の表示も release-1 と同じように出る

## 4. 実施記録

ビルドコミットは、第1節で `deployed <短縮コミット> to mbp` と出た値を書く。メモに口述内容と直した文字は書かない(件数・秒数・結果の種類のみ)。

| 実施日 | ビルドコミット | ケース | 結果 | メモ(数値のみ) |
| --- | --- | --- | --- | --- |
| | | 配布・ハッシュの一致(FR-05 AC-6) | | |
| | | AC-1 短い文の登録: Chrome | | |
| | | AC-1 短い文の登録: テキストエディット | | |
| | | AC-1 短い文の登録: Slack | | |
| | | AC-1 短い文の登録: Claude デスクトップ | | |
| | | AC-1 短い文の登録: Obsidian | | |
| | | AC-2 辞書への登録 | | |
| | | AC-3 次の口述への反映 | | |
| | | AC-4 長い文 | | |
| | | AC-5 却下の確認 | | |
| | | AC-6 無音で語彙が出ないこと | | |
| | | AC-7 既存の動作 | | |

## 5. 困ったとき

| 症状 | 原因と対処 |
| --- | --- |
| ログ取得で `zsh:log:1: too many arguments` と出る | `log` が zsh の組み込みを指す。`/usr/bin/log show …` と書く(上のコマンドは書き換え済み) |
| `deploy-mbp.sh` が「更新されていません」で止まる | `make local` が成果物を作り直していない。`.local-build/` の状態を確かめ、`make local` を単独で実行して原因を見る |
| `deploy-mbp.sh` が「ハッシュが一致しません」で止まる | rsync が途中で失敗した可能性。MacBook Pro のアプリを終了して配り直す |
| `AI review failed` が出る | 審査の待ち時間(隠し設定 `AutoLearnReviewTimeoutSeconds`、既定30秒)を延ばして試す。それでも出るならネットワークか Gemini の設定を見る |
| 候補が作られない(Ghostty・VS Code) | 既知の課題 B1・B2([known-issues.md](../../known-issues.md))。AC の対象アプリではない |
