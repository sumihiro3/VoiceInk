# release-1-whisper-partial-prototype 実機検証(e2e-verification)

MacBook Pro(M1 Pro)で口述して確かめる手順と実施記録。対象は requirements.md の FR-07 AC-1〜AC-5。共通のテストケースは `docs/e2e-verification.md`、合格基準の正本は CLAUDE.md の「合格基準(暫定)」。M1 は計測が目的なので、「話し始めて2秒以内」は目標値として記録し、合否にはしない。

**口述した文字列は記録しない。** ログにも、この表のメモにも、認識結果や口述内容を書かない。残すのは秒数・文字数・回数などの数値だけ。

## 1. 前提(未整備のものがある)

次がそろわないと、この手順は実施できない。2026-10-17 時点では、2と3が未整備(requirements.md の未解決事項。人が手で行う)。

1. FR-02 AC-7 の配布ができている(`scripts/deploy-mbp.sh` で MacBook Pro の /Applications/VoiceInk.app が置き換わっている)
2. Mac mini に Apple Development 証明書がある(`security find-identity -v -p codesigning` が 1 件以上を返す)。ad-hoc 署名では配布しない。手順は docs/fork-plan.md の手順2
3. Mac mini の `~/.ssh/config` に `Host mbp` がある(`ssh mbp true` が通る)。手順は docs/fork-plan.md の手順2-2

確認:

```bash
security find-identity -v -p codesigning
```

```bash
ssh mbp true && echo ok
```

## 2. 隠し設定

設定画面は M5 まで無いので、`defaults` で入れる。ドメインは `com.prakashjoshipax.VoiceInk`。Mac mini から 1 行ずつ実行する。

途中経過を有効にする:

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingEnabled -bool true
```

途中経過用モデルを指定する(既定も `ggml-base`):

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingModelName -string ggml-base
```

確認:

```bash
ssh mbp defaults read com.prakashjoshipax.VoiceInk WhisperStreamingEnabled
```

```bash
ssh mbp defaults read com.prakashjoshipax.VoiceInk WhisperStreamingModelName
```

既定に戻す(FR-07 AC-5 で使う。キーが無いときは `false` 扱い):

```bash
ssh mbp defaults delete com.prakashjoshipax.VoiceInk WhisperStreamingEnabled
```

```bash
ssh mbp defaults delete com.prakashjoshipax.VoiceInk WhisperStreamingModelName
```

設定を変えたらアプリを再起動する:

```bash
ssh mbp "osascript -e 'quit app \"VoiceInk\"'"
```

```bash
ssh mbp open /Applications/VoiceInk.app
```

## 3. モデルの用意

1. MacBook Pro の VoiceInk のモデル画面から、`ggml-base`(Base)と large-v3-turbo をダウンロードする
2. 置き場所にファイルがあるか確認する。置き場所は `~/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels`(`VoiceInk/App/VoiceInk.swift` で `modelsDirectory` を作っている箇所)。途中経過プロバイダは `<置き場所>/<WhisperStreamingModelName>.bin` を読む

```bash
ssh mbp 'ls -lh "$HOME/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels"'
```

`ggml-base.bin` と `ggml-large-v3-turbo.bin` が出ること。`ggml-base.bin` が無いと途中経過は始まらず、従来どおり録音停止後の処理だけになる(ログに `Failed to start streaming, will fall back to batch` が出る)。

3. VoiceInk の Mode で、モデルに large-v3-turbo を選び、Real-time をオンにする(`WhisperStreamingEnabled` が `true` で再起動済みのときだけ、Whisper のモデルでトグルが出る)

## 4. ログの取り方

試すたびに、Mac mini から取る。`logs/` には口述内容が含まれうるので、`.gitignore` 済みであることを確かめ、コミットしない。

全体(CLAUDE.md の標準コマンド):

```bash
ssh mbp "log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\"'" > logs/mbp-$(date +%H%M).log
```

途中経過プロバイダだけ:

```bash
ssh mbp "log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category == \"WhisperStreamingProvider\"'" > logs/mbp-stream-$(date +%H%M).log
```

読む行:

- `elapsed=…s audio=…s chars=… skipped=…`(FR-04 AC-8)。1回の認識時間(elapsed)、そのときの音声の長さ(audio)、文字数、飛ばした回の累計(skipped)
- 最初の文字を流した回に出る、`connect` からの経過秒の行(「最初の文字が出るまで」の値)
- `TranscriptionSession` 側の batch fallback の行(`Streaming provider requested full batch transcription` と `Using batch fallback for …`。category は `StreamingTranscriptionSession`)

```bash
ssh mbp "log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category == \"StreamingTranscriptionSession\"'" > logs/mbp-session-$(date +%H%M).log
```

## 5. テストケース

前提: 第2・3節が済み、アプリを再起動してあること。各ケースのあとにログを取る。

- [ ] AC-1 短い発話:5秒程度の一文を話す
  - 手順: 録音を始め、すぐ一文を話し、止める。ログから最初の文字が出るまでの秒数を読む
  - 期待: 録音画面に文字が出る。秒数を記録する。2秒以内は目標値で、合否にはしない
- [ ] AC-2 長い口述:60秒以上話し続ける
  - 手順: 60秒以上話し続けて止める。ログの `elapsed` と `audio` から、audio が 5・10・20・30・60 秒前後の行を第6節の表に写す
  - 期待: アプリが固まらない。録音を止めれば貼り付けまで終わる
- [ ] AC-3 最終結果:録音停止後に貼り付けられる文字
  - 手順: 途中経過の表示と、貼り付けられた文字を見比べる。セッションのログに batch fallback の行があるか見る。停止から貼り付けまでの時間を、`WhisperStreamingEnabled` を `true` と `false`(第2節の `defaults delete` のあと再起動)で各 3 回ずつ計り、第6節の表に書く
  - 期待: 貼り付けられるのは large-v3-turbo の録音後処理の結果。途中経過と違う表記が 1 回以上出る、または batch fallback の行が出る
- [ ] AC-4 途中で中止:録音中に Esc で中止する
  - 手順: 話している途中で Esc を押し、すぐ次の録音を始める
  - 期待: 途中経過の表示が消える。次の録音がすぐ始められる
- [ ] AC-5 既定の動作:`WhisperStreamingEnabled` を消す
  - 手順: 第2節の `defaults delete` を実行し、アプリを再起動して Whisper の Mode で話す
  - 期待: 途中経過が出ず、従来どおり録音停止後に貼り付けられる

## 6. 実施記録

実施日・ビルドコミットは `git rev-parse --short HEAD`(配布したビルドの元)を書く。メモに口述内容は書かない。

### ケースごとの結果

| 実施日 | ビルドコミット | ケース | 結果 | メモ(数値のみ) |
| --- | --- | --- | --- | --- |
| | | AC-1 短い発話 | | 最初の文字まで __ 秒 |
| | | AC-2 長い口述 | | |
| | | AC-3 最終結果 | | |
| | | AC-4 途中で中止 | | |
| | | AC-5 既定の動作 | | |

### 長い口述の認識時間(AC-2)

| 音声の長さ(目安) | audio (s) | elapsed (s) | skipped(累計) | メモ |
| --- | --- | --- | --- | --- |
| 5 秒 | | | | |
| 10 秒 | | | | |
| 20 秒 | | | | |
| 30 秒 | | | | |
| 60 秒 | | | | |

### 録音停止から貼り付けまでの時間(AC-3)

| 回 | WhisperStreamingEnabled = true (s) | WhisperStreamingEnabled = false (s) | メモ |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 中央値 | | | |
