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
- [ ] AC-3 語彙による認識の改善(2026-10-18 に書き直し。手順は第 3-2 節)
  - 手順: AC-1・AC-4 の録音を Mac mini で認識し直し、release-2 前後の初期プロンプトで登録語の正解数を比べる。あわせて、AC-2 のあとに同じ文をもう一度口述する(30秒未満。合否には使わない)
  - 期待: release-2 の初期プロンプトで、登録語の出現箇所の過半数が正しい表記で出て、release-2 前より多い
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

## 3-2. 語彙による認識の比較(AC-3)

アプリと同じ条件で、初期プロンプトだけを変えて録音を認識し直す。録音・モデル・結果は一時領域(`$TMPDIR`)に置き、リポジトリに入れない。

### 準備(Mac mini で)

whisper-cli を、アプリと同じ whisper.cpp のコミット(`0c7be69`)からビルドする。元のフォルダは変えない。

```bash
W=$TMPDIR/b4 && mkdir -p $W/wav $W/models && cmake -S ~/VoiceInk-Dependencies/whisper.cpp -B $W/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON && cmake --build $W/build --target whisper-cli -j 8
```

モデルと VAD のモデルを MacBook Pro から持ってくる。

```bash
W=$TMPDIR/b4 && scp "mbp:Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin" $W/models/ && scp mbp:/Applications/VoiceInk.app/Contents/Resources/ggml-silero-v5.1.2.bin $W/models/
```

録音は `~/Library/Application Support/com.prakashjoshipax.VoiceInk/Recordings/<ID>.wav` にある。ID はログの `Using batch fallback for … file=<ID>.wav` の行で分かる。比べたい録音を `$W/wav/` に `scp` する。

### 認識し直す

`PROMPT` に初期プロンプトを入れて実行する。空にすると初期プロンプトなし。設定はアプリの `LibWhisper.swift` の `fullTranscribe` に合わせてある(greedy、`best_of` 5、`temperature` 0.2、VAD のしきい値0.5・最短の発話250ms・最短の無音100ms・前後の余白30ms・重なり0.1)。

```bash
W=$TMPDIR/b4 && PROMPT="こんにちは、お元気ですか？お会いできて嬉しいです。" && for w in $W/wav/*.wav; do printf '%s\t' "$(basename $w)"; $W/build/bin/whisper-cli -m $W/models/ggml-large-v3-turbo-q5_0.bin -f "$w" -l ja -bs 1 -bo 5 -tp 0.2 -nt -np --vad -vm $W/models/ggml-silero-v5.1.2.bin -vt 0.5 -vspd 250 -vsd 100 -vp 30 -vo 0.1 ${PROMPT:+--prompt "$PROMPT"} 2>/dev/null | tr -d '\n'; echo; done
```

- **`-mc`(`--max-context`)は付けない。** `-mc 0` は初期プロンプトの枠を0にするので、プロンプトが捨てられる(`src/whisper.cpp:7101`、`:7285`)。アプリの `no_context = true` は whisper.cpp の既定値(`:6099`)で、whisper-cli も既定のまま同じになる
- release-2 の初期プロンプトは、挨拶文のあとに辞書の語彙を新しい順に「、」でつなぎ、最後に「。」を付けたもの。アプリのログ `vocabularyTerms=… promptChars=…` の文字数と合うことを確かめる

### 結果(2026-10-18、ビルド 52cfa5a、録音7本・各3回。「古い順」だけ1回)

同じ録音・同じプロンプトでは、3回とも同じ結果だった(`temperature` 0.2 でも、結果のばらつきは出なかった)。下の数は、録音7本に出てくる登録語の出現箇所11か所のうち、正しい表記で出た数。中黒の有無だけの違い(登録した表記に中黒があり、認識結果に無い)は正しいと数えた。

| 初期プロンプト | 正しく出た数 | メモ(数値のみ) |
| --- | --- | --- |
| なし | 2 / 11 | |
| (1) release-2 前(挨拶文だけ) | 0 / 11 | |
| (2) release-2(挨拶文+語彙8語、新しい順) | 6 / 11 | 8回目の録音は、アプリが貼り付けた結果と同じになった(比べ方がアプリと合っている) |
| (2) に、登録されていなかった1語を足したもの | 8 / 11 | |
| 語彙だけ(挨拶文なし) | 5 / 11 | |
| 語彙を文の形にしたもの(足した1語を含む) | 5 / 11 | |
| 語彙を古い順にしたもの | 7 / 11 | 1回だけ実行 |

- 判定: (2) は 6/11 で過半数、(1) の 0/11 より多い。AC-3 を満たした
- 英字2語の製品名(短い文の1語目)は、9通りのどの書き方でもほぼ正しく出なかった。正しく出たのは、話した順に2語だけを並べたときだけで、語順を逆にすると出なかった。並べ方にとても左右される(known-issues B4)
- 再口述(合否に使わない): AC-2 のあとに同じ文を話すと、`vocabularyTerms=8 promptChars=96` で、1語目は1回目と違う誤り方になり、2語目は登録されていなかったので直らなかった

## 3-3. 審査の失敗からのやり直し(FR-10 AC-8)

審査の待ち時間を一時的に1秒にして、わざと時間切れにする。やり直しの予約が出たら設定を消し、既定の90秒でやり直しが成功するのを見る。

```bash
ssh mbp "defaults write com.prakashjoshipax.VoiceInk AutoLearnReviewTimeoutSeconds -int 1"
```

MacBook Pro で、直しが候補になる文を1つ口述して直す(例: Chrome の入力欄で、カタカナで出た製品名を英字に直す)。ログに `retry scheduled` が出たら、すぐに設定を消す。

```bash
ssh mbp "defaults delete com.prakashjoshipax.VoiceInk AutoLearnReviewTimeoutSeconds"
```

```bash
cd /opt/dev/VoiceInk && ssh mbp "/usr/bin/log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\" AND category IN {\"AutoLearn\", \"AutoLearnAIReview\", \"AutoLearnReviewRetry\"}'" > logs/mbp-retry-$(date +%H%M).log
```

期待: `Auto Learn AI review failed … code=8` → `retry scheduled kind=timeout status=0 attempt=1 delay=30s` → 30秒後に新しい口述なしで `Auto Learn review started` → `Auto Learn review completed`。

## 4. 実施記録

ビルドコミットは、第1節で `deployed <短縮コミット> to mbp` と出た値を書く。メモに口述内容と直した文字は書かない(件数・秒数・結果の種類のみ)。

| 実施日 | ビルドコミット | ケース | 結果 | メモ(数値のみ) |
| --- | --- | --- | --- | --- |
| 2026-10-18 | 52cfa5a | 配布・ハッシュの一致(FR-05 AC-6) | 満たした | `deploy-mbp.sh` が `deployed 52cfa5a to mbp`。手元と MacBook Pro の SHA-256 が一致(先頭 `febdf6020cf6b19f`)、Apple Development 署名で起動 |
| 2026-10-18 | 52cfa5a | AC-1 短い文の登録: Chrome | 一部未達 | 候補1件→審査で登録。ただし審査の失敗が全体で3回(時間切れ1回: 開始から30秒、code=3 が2回)。どれも自動で再審査され、最終的に全件が審査された |
| 2026-10-18 | 52cfa5a | AC-1 短い文の登録: テキストエディット | 候補あり | 候補1件→登録 |
| 2026-10-18 | 52cfa5a | AC-1 短い文の登録: Slack | 候補あり | 候補1件→登録 |
| 2026-10-18 | 52cfa5a | AC-1 短い文の登録: Claude デスクトップ | 候補あり | 候補2件→登録 |
| 2026-10-18 | 52cfa5a | AC-1 短い文の登録: Obsidian | 候補あり | 候補1件→登録 |
| 2026-10-18 | 52cfa5a | AC-2 辞書への登録 | 満たした | 単語置換 +8件、語彙 +8件(`Auto Learn apply completed` の合計: 2+4+2) |
| 2026-10-18 | 52cfa5a | AC-3 語彙による認識の改善 | 満たした | 第 3-2 節。登録語の正解数: release-2 前 0/11 → release-2 6/11。再口述(合否に使わない)は1語目が違う誤り方になり、正しく出なかった |
| 2026-10-18 | 52cfa5a | AC-4 長い文 | 満たした | 41文字の文で候補2件→2件とも登録 |
| 2026-10-18 | 52cfa5a | AC-5 却下の確認 | 満たした | `rejected=1`、`apply completed without dictionary changes` |
| 2026-10-18 | 52cfa5a | AC-6 無音で語彙が出ないこと | 満たした | 5秒の無音録音で `Batch fallback completed elapsed=0.043s chars=0`。貼られた文字なし |
| 2026-10-18 | 52cfa5a | AC-7 既存の動作 | 満たした | 9回とも途中経過が出た(最初の文字まで 1.84〜2.31秒)。停止後は batch fallback(0.04〜1.19秒)の結果が貼られた |
| 2026-10-18 | f8ab7de+未コミットの FR-10 | FR-10 AC-8 審査の失敗からのやり直し | 満たした | 第 3-3 節。1秒で時間切れ → `retry scheduled kind=timeout attempt=1 delay=30s` → 30秒後に新しい口述なしでやり直し → 6秒で成功、単語置換1件・語彙1件を登録。429・5xx のやり直しは単体テストのみで、実機では確かめていない |

## 5. 困ったとき

| 症状 | 原因と対処 |
| --- | --- |
| ログ取得で `zsh:log:1: too many arguments` と出る | `log` が zsh の組み込みを指す。`/usr/bin/log show …` と書く(上のコマンドは書き換え済み) |
| `deploy-mbp.sh` が「更新されていません」で止まる | `make local` が成果物を作り直していない。`.local-build/` の状態を確かめ、`make local` を単独で実行して原因を見る |
| `deploy-mbp.sh` が「ハッシュが一致しません」で止まる | rsync が途中で失敗した可能性。MacBook Pro のアプリを終了して配り直す |
| 認識し直しても初期プロンプトの違いで結果が変わらない | whisper-cli に `-mc 0` を付けていないか確かめる。付けると初期プロンプトが捨てられる(第 3-2 節) |
| `AI review failed` が出る | `AutoLearnReviewRetry` のログで種類と HTTP の状態を見る。時間切れ・429・5xx なら自動でやり直す(FR-10)。macOS の通信ログ(`process == "VoiceInk"` の CFNetwork の `response_status=`)でも状態が分かる。待ち時間は隠し設定 `AutoLearnReviewTimeoutSeconds`(既定90秒)で延ばせる |
| 候補が作られない(Ghostty・VS Code) | 既知の課題 B1・B2([known-issues.md](../../known-issues.md))。AC の対象アプリではない |
