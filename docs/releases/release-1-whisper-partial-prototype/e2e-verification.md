# release-1-whisper-partial-prototype 実機検証(e2e-verification)

MacBook Pro(M1 Pro)で口述して確かめるための、準備から記録までの手順。**このファイルだけ見れば最後まで進められる**ように、署名・SSH・配布の準備も含めて書いてある。対象は requirements.md の FR-02 AC-7 と FR-07 AC-1〜AC-5。

- M1 は計測が目的。「話し始めて2秒以内」は目標として記録し、合否にはしない
- **口述した文字列は記録しない。** ログにも、この表のメモにも、認識結果や口述内容を書かない。残すのは秒数・文字数・回数などの数値だけ
- 「Mac mini で」「MacBook Pro で」と書いた場所で実行する。コマンドは 1 ブロックずつ貼って実行する

## 0. 全体の流れ

| 順 | やること | 場所 | 一度だけ |
| --- | --- | --- | --- |
| 1 | Apple Development 証明書を作る | Mac mini | ○ |
| 2 | リモートログインをオンにし、ホスト名を調べる | MacBook Pro | ○ |
| 3 | SSH の鍵と `Host mbp` を設定する | Mac mini | ○ |
| 4 | ビルドして配る(`scripts/deploy-mbp.sh`) | Mac mini | 毎回 |
| 5 | 初回だけ権限を許可する | MacBook Pro | ○ |
| 6 | 隠し設定を入れる | Mac mini | ○ |
| 7 | モデルを用意し、Mode を設定する | MacBook Pro | ○ |
| 8 | 口述して、ログを取る | 両方 | 毎回 |
| 9 | 実施記録に書く | このファイル | 毎回 |

## 1. Apple Development 証明書を作る(Mac mini で)

有料の Apple Developer Program は要らない。無料の Apple ID で作れる。毎回同じ証明書で署名すれば、配り直しても MacBook Pro 側のマイクとアクセシビリティの許可が外れにくい(ad-hoc 署名だと配るたびに許可し直しになるので、`deploy-mbp.sh` は ad-hoc では配らない)。

1. Xcode → Settings → Accounts で「+」→ Apple ID を追加する
2. 追加したアカウントの「(Personal Team)」を選び、Manage Certificates… →「+」→ Apple Development
3. 確認する

```bash
security find-identity -v -p codesigning
```

`Apple Development: <名前> (...)` が **1 件**出れば完了。

`0 valid identities found` なのに、`-v` を外した `security find-identity -p codesigning` には証明書が出る場合は、発行元の中間証明書(Apple Worldwide Developer Relations の G3)がキーチェーンに無い。Apple の公式ページ(https://www.apple.com/certificateauthority/)の G3 を入れてから、もう一度確かめる。

```bash
curl -fLo ~/Downloads/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
```

```bash
security import ~/Downloads/AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db
```

2 件以上あると `make local` はどれを使うか決められずに ad-hoc 署名になる。そのときは、使う証明書の SHA を `LOCAL_CODESIGN_IDENTITY=<SHA>` で指定して実行する。

## 2. リモートログインをオンにし、ホスト名を調べる(MacBook Pro で)

1. システム設定 → 一般 → 共有 →「リモートログイン」をオンにする
2. ホスト名とユーザー名を調べる

```bash
scutil --get LocalHostName
```

```bash
whoami
```

1 つ目の出力に `.local` を付けたものが、次の節の `HostName` になる(例: 出力が `Sumihiros-MacBook-Pro` なら `Sumihiros-MacBook-Pro.local`)。2 つ目の出力が `User` になる。

## 3. SSH の鍵と `Host mbp` を設定する(Mac mini で)

1. MacBook Pro 用の鍵を作る(パスフレーズは空でよい。空でない場合は ssh-agent に登録する)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_mbp -C "mac-mini to mbp"
```

2. `~/.ssh/config` の末尾に次を足す。`HostName` と `User` は第2節で調べた値に置き換える

```
Host mbp
    HostName Sumihiros-MacBook-Pro.local
    User sumihiro
    IdentityFile ~/.ssh/id_ed25519_mbp
    IdentitiesOnly yes
```

3. 公開鍵を MacBook Pro に登録する(このときだけ MacBook Pro のログインパスワードを聞かれる)

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_mbp.pub mbp
```

4. パスワードなしで入れることを確かめる

```bash
ssh -o BatchMode=yes mbp 'sw_vers -productVersion && sysctl hw.memsize'
```

macOS のバージョンとメモリ容量が出れば完了。

## 4. ビルドして配る(Mac mini で)

試したいコードのブランチにいることを確かめてから配る。配布先は MacBook Pro の /Applications/VoiceInk.app で、普段使いの VoiceInk を置き換える(設定と履歴は引き継がれる)。MacBook Pro はログインした状態にしておく(ログアウト中はアプリを起動できない)。

```bash
cd /opt/dev/VoiceInk && git status -sb | head -1
```

```bash
scripts/deploy-mbp.sh
```

最後に `deployed <短縮コミット> to mbp` と出れば成功。この短縮コミットを実施記録に書く。

配れたかの確認(FR-02 AC-7):

```bash
ssh mbp "codesign -dv --verbose=2 /Applications/VoiceInk.app" 2>&1 | grep Authority
```

`Authority=Apple Development: …` が出ること。

## 5. 初回だけ権限を許可する(MacBook Pro で)

署名が本家の配布版と違うので、最初の 1 回は許可し直しになる。

1. VoiceInk が出す案内に従って、マイクとアクセシビリティを許可する
2. 案内が出ないときは、システム設定 → プライバシーとセキュリティ → マイク / アクセシビリティで VoiceInk をオンにする(古い VoiceInk の項目が残っていたら、いったん「−」で消してから追加し直す)
3. 許可したら VoiceInk を終了して起動し直す

## 6. 隠し設定を入れる(Mac mini で)

設定画面は M5 まで無いので、`defaults` で入れる。ドメインは `com.prakashjoshipax.VoiceInk`。

途中経過を有効にする:

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingEnabled -bool true
```

途中経過用モデルを指定する(既定も `ggml-base` なので、比べるときだけ変える):

```bash
ssh mbp defaults write com.prakashjoshipax.VoiceInk WhisperStreamingModelName -string ggml-base
```

確認:

```bash
ssh mbp defaults read com.prakashjoshipax.VoiceInk WhisperStreamingEnabled
```

`1` と出れば有効。

設定を変えたら、アプリを再起動する:

```bash
ssh mbp "osascript -e 'quit app \"VoiceInk\"'"
```

```bash
ssh mbp open /Applications/VoiceInk.app
```

既定に戻す(AC-5 で使う。キーが無いときは無効として扱われる):

```bash
ssh mbp defaults delete com.prakashjoshipax.VoiceInk WhisperStreamingEnabled
```

## 7. モデルを用意し、Mode を設定する(MacBook Pro で)

1. VoiceInk のモデル画面から、Base(`ggml-base`)と large-v3-turbo をダウンロードする
2. Mac mini から、ファイルがあるか確かめる

```bash
ssh mbp 'ls -lh "$HOME/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels"'
```

`ggml-base.bin` と `ggml-large-v3-turbo.bin` が出ること。`ggml-base.bin` が無いと途中経過は始まらず、従来どおり録音停止後の処理だけになる。

3. VoiceInk の Mode で、モデルに large-v3-turbo を選び、Real-time をオンにする。トグルは、第6節で有効にして再起動したあとだけ出る

## 8. 口述して、ログを取る

### ログの取り方(Mac mini で)

試すたびに取る。`logs/` は `.gitignore` 済みで、コミットしない。

途中経過の処理:

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category == \"WhisperStreamingProvider\"'" > logs/mbp-stream-$(date +%H%M).log
```

録音停止後の処理:

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category == \"StreamingTranscriptionSession\"'" > logs/mbp-session-$(date +%H%M).log
```

全部(迷ったらこれ):

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\"'" > logs/mbp-$(date +%H%M).log
```

### ログで読む行

| 行 | 意味 | 使うケース |
| --- | --- | --- |
| `model=ggml-base loadElapsed=…s` | 途中経過用モデルの読み込みにかかった秒数 | AC-1 |
| `firstPartialAfterConnect=…s` | 読み込みが終わってから最初の文字を出すまでの秒数 | AC-1 |
| `elapsed=…s audio=…s chars=… skipped=…` | 1回の認識時間、そのときの音声の長さ、文字数、飛ばした回の累計 | AC-2 |
| `Streaming provider requested full batch transcription` | 録音停止後に、全音声を処理し直す経路へ入った | AC-3 |
| `Batch fallback completed elapsed=…s` | 録音停止後の処理にかかった秒数 | AC-3 |
| `Partial model file not found.` / `Failed to start streaming, will fall back to batch` | 途中経過が始まらなかった(モデルが無いなど)。録音後の処理は従来どおり動く | 困ったとき |

**最初の文字が出るまでの秒数は、`loadElapsed` と `firstPartialAfterConnect` を足した値で記録する。** `firstPartialAfterConnect` だけだと、モデルを読み込む時間が入らない(既知課題 P1)。

### テストケース

前提: 第4〜7節が済み、アプリを再起動してあること。各ケースのあとにログを取る。

- [ ] AC-1 短い発話:5秒程度の一文を話す
  - 手順: 録音を始め、すぐ一文を話し、止める
  - 期待: 録音画面に文字が出る。`loadElapsed + firstPartialAfterConnect` の秒数を記録する(2秒以内は目標で、合否にはしない)
- [ ] AC-2 長い口述:60秒以上話し続ける
  - 手順: 60秒以上話し続けて止める。`elapsed` と `audio` の行から、audio が 5・10・20・30・60 秒前後のものを第9節の表に写す
  - 期待: アプリが固まらない。録音を止めれば貼り付けまで終わる
- [ ] AC-3 最終結果:録音停止後に貼り付けられる文字
  - 手順: 途中経過の表示と、貼り付けられた文字を見比べる。`Batch fallback completed elapsed=…s` を、`WhisperStreamingEnabled` が有効なときと、消して再起動したとき(第6節)で 3 回ずつ取り、第9節の表に書く
  - 期待: 貼り付けられるのは large-v3-turbo の録音後処理の結果。途中経過と違う表記が 1 回以上出る、または `Streaming provider requested full batch transcription` の行が出る
- [ ] AC-4 途中で中止:録音中に Esc で中止する
  - 手順: 話している途中で Esc を押し、すぐ次の録音を始める
  - 期待: 途中経過の表示が消える。次の録音がすぐ始められる
- [ ] AC-5 既定の動作:隠し設定を消す
  - 手順: 第6節の `defaults delete` を実行し、アプリを再起動して Whisper の Mode で話す
  - 期待: 途中経過が出ず、従来どおり録音停止後に貼り付けられる

## 9. 実施記録

ビルドコミットは、第4節で `deployed <短縮コミット> to mbp` と出た値を書く。メモに口述内容は書かない。

### ケースごとの結果

| 実施日 | ビルドコミット | ケース | 結果 | メモ(数値のみ) |
| --- | --- | --- | --- | --- |
| 2026-10-18 | 744a2c4 | FR-02 AC-7 配布 | 済 | MacBook Pro の /Applications/VoiceInk.app が `Authority=Apple Development: Sumihiro Kagawa (4K335MC9VG)` で置き換わった |
| 2026-10-18 | 744a2c4 | AC-1 短い発話 | 計測済 | 画面に文字が出た。最初の文字まで(読み込み + その後): base は 1.31〜2.76 秒、中央値 約 1.6 秒(8 回中 6 回が 2 秒以内)。large-v3-turbo-q5_0 は 3.07 秒と 3.59 秒(2 回とも 2 秒超) |
| 2026-10-18 | 744a2c4 | AC-2 長い口述 | 一部 | 最長は約 30 秒(q5_0)。60 秒以上は未実施。下の表 |
| 2026-10-18 | 744a2c4 | AC-3 最終結果 | 済(比較は未実施) | 10 回すべてで `Streaming provider requested full batch transcription` の行が出て、録音停止後の処理(Mode のモデル: Large v3 Turbo (Quantized))の結果が貼り付けられた。途中経過と違う表記が出ることも目視で確認。途中経過なしとの時間比較は未実施 |
| | | AC-4 途中で中止 | 未実施 | |
| | | AC-5 既定の動作 | 未実施 | |

### 長い口述の認識時間(AC-2)

途中経過用モデルごとの、1 回の認識時間(elapsed)とそのときの音声の長さ(audio)。

| モデル | audio (s) | elapsed (s) | skipped(累計) | メモ |
| --- | --- | --- | --- | --- |
| ggml-base | 1.2〜2.9 | 0.11〜1.23 | 0〜1 | 15 回。ほとんどは 0.1〜0.3 秒 |
| ggml-base | 3.3〜6.9 | 0.12〜1.63 | 0〜1 | 29 回。1 秒を超えた回のあとに 1 回飛ばした |
| ggml-base | 7.2〜10.0 | 0.24〜0.85 | 0〜1 | 14 回。処理間隔(1 秒)を超え続けていない |
| ggml-large-v3-turbo-q5_0 | 2.1〜2.6 | 1.06〜1.07 | 1 | 2 回。2 秒の音声でも約 1 秒かかる |
| ggml-large-v3-turbo-q5_0 | 4.1〜6.7 | 1.02〜4.19 | 2〜5 | 3 回。4.19 秒は 1 回だけの外れ値 |
| ggml-large-v3-turbo-q5_0 | 8.8〜11.4 | 1.12〜1.26 | 4〜7 | 4 回 |
| ggml-large-v3-turbo-q5_0 | 13.6〜19.9 | 1.21〜1.36 | 8〜11 | 4 回 |
| ggml-large-v3-turbo-q5_0 | 22.0〜28.3 | 1.44〜1.65 | 12〜15 | 4 回。処理間隔を超え続け、1 回おきに飛ばしている |
| (未実施) | 60 | | | |

読み込み時間(`loadElapsed`)は、base が 0.12〜0.58 秒、q5_0 が 0.99〜1.50 秒。録音ごとに読み込んでいる(既知課題 P1)。

### 録音停止後の処理時間(AC-3)

`Batch fallback completed elapsed=…s` の値。Mode のモデルは Large v3 Turbo (Quantized)。

| 回 | 途中経過あり (s) | 途中経過なし (s) | メモ |
| --- | --- | --- | --- |
| 1〜8 | 0.95〜1.90 | 未実施 | 途中経過用モデルは base。音声は 10 秒以下 |
| 9 | 1.25 | 未実施 | 途中経過用モデルは q5_0。音声は約 11 秒 |
| 10 | 1.72 | 未実施 | 途中経過用モデルは q5_0。音声は約 30 秒 |
| 中央値 | 1.17 | 未実施 | |

どの回も、録音停止と同じ秒に処理が始まっていた(途中の認識の完了を待った形跡はない)。

### モデルの精度の比較(Mac mini での再認識)

MacBook Pro の録音を Mac mini にコピーし、whisper.cpp `0c7be69` の whisper-cli で認識し直した(日本語指定、greedy、temperature 0.2)。値は、話した人が用意した正解の文との文字単位の誤りの割合。正解の文と認識結果は記録しない。2 段落目は、読み上げ時の言い換えも誤りに数えているので多めに出る。

| 設定 | 短い発話(約 10〜12 秒) | 長い口述(約 32 秒) |
| --- | --- | --- |
| ggml-base(途中経過と同じ設定) | 53〜70% | 未計測 |
| large-v3-turbo-q5_0・VAD あり | 5% | 29% |
| large-v3-turbo-q5_0・VAD なし | 5〜7% | 37〜38% |
| large-v3-turbo(量子化なし)・VAD あり | 5% | 29% |
| large-v3-turbo(量子化なし)・VAD なし | 2% | 38% |
| アプリが貼り付けた結果(q5_0・VAD あり) | 12% | 28% |

- 量子化のあり・なしで、長い口述の誤りの箇所は同じだった。Mode のモデルは q5_0 のままでよいと判断した(2026-10-18)
- VAD なしでは、話していない定型文が最後に足された。VAD は有効のままにする
- 初期プロンプト(日本語の既定文)のあり・なしでは、ほとんど差がなかった

## 10. 困ったとき

| 症状 | 原因と対処 |
| --- | --- |
| `deploy-mbp.sh` が「SSH 接続できません」で止まる | 第2・3節を見直す。`ssh -v mbp true` で、どこで失敗しているか分かる。MacBook Pro がスリープしていると名前を引けないことがある |
| `deploy-mbp.sh` が「ad-hoc 署名では…」で止まる | 第1節の証明書が無い、2 件以上ある、または中間証明書 G3 が無い。`security find-identity -v -p codesigning` で確かめ、第1節の手順で直す |
| ログ取得で `zsh:log:1: too many arguments` と出る | MacBook Pro の zsh では `log` が組み込みコマンド(ログイン監視用)を指す。`ssh mbp "log show …"` ではなく `ssh mbp "/usr/bin/log show …"` と書く(第8節のコマンドは書き換え済み) |
| 起動時に「開けません」と出る | `ssh mbp xattr -dr com.apple.quarantine /Applications/VoiceInk.app` を実行してから開き直す |
| 配り直すたびに権限を聞かれる | ad-hoc 署名で配った(`DEPLOY_ALLOW_ADHOC=1` を付けた)。第1節の証明書で配り直す |
| 途中経過が出ない | 第6節の確認で `1` が出るか、アプリを再起動したか、Mode の Real-time がオンか、`ggml-base.bin` があるかを順に見る。ログに `Partial model file not found.` があればモデルが無い |
| 途中経過だけ止めたい | 第6節の `defaults delete` をして再起動する。録音後の処理は従来と同じに戻る |
