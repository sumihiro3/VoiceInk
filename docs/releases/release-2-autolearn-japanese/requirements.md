# release-2-autolearn-japanese 要件

- リリース識別子:release-2-autolearn-japanese(本家の辞書の自動登録「Auto Learn」の日本語対応と、語彙を Whisper に渡す処理)
- ステータス: 確定
- 作成日:2026-10-18
- 参照資料:docs/releases/release-1-whisper-partial-prototype/handoff.md(次のリリースの候補「辞書の自動登録」)、docs/ARCHITECTURE.md(規約)、CLAUDE.md、本家の Auto Learn(`VoiceInk/Features/Dictionary/AutoLearn/`)、whisper.cpp `0c7be69` の `src/whisper.cpp:7101`(初期プロンプトの上限)

## 背景と目的

Whisper(large-v3-turbo)で口述すると、固有の言葉や技術用語を誤る。例として「Claude Code と Codex、どちらがいいですか。」が「ロードコードとコーデックスどちらがいいですか。」になった。毎回、手で直している。直した結果を辞書に自動で登録し、次から正しく出るようにしたい。直すための手間(別の画面を開くなど)は増やさない。

本家には、この機能「Auto Learn Dictionary」がすでにあり、既定でオンになっている。貼り付けた先の入力欄を最大60秒見張って直しを拾い、AI(MacBook Pro では Gemini)の審査を通ったものを単語置換と語彙に登録する。しかし 2026-10-18 に MacBook Pro で調べたところ、一度も登録されていなかった。7アプリで同じ短い文を口述して直した結果は次のとおり。

| アプリ | 読み取り | 直しを拾う | 候補 | AI の審査 |
|---|---|---|---|---|
| Chrome / Slack / Claude デスクトップ / Obsidian | 成功 | 成功 | 各1件 | 4件とも時間切れ(`LLMKitError` code=8)。開始からちょうど7秒で失敗 |
| テキストエディット | 成功 | 成功 | 1件 | 2件(Chrome の分を含む)とも却下 |
| Ghostty | 成功 | 失敗(直した位置を特定できない) | — | — |
| VS Code のエディタ | 失敗(入力欄の中身が空で返る) | — | — | — |
| テキストエディットで41文字の文を直した | 成功 | 成功 | 0件 | — |

原因は3つ。

1. **長い日本語の文が候補にならない。** 直した箇所を、空白と ASCII の記号でしか区切らない(`CorrectionDiffEngine.swift` の `segments`)。そのため日本語の一文がまるごと1つの塊になり、32文字を超えると捨てられる(`AutoLearnTypes.swift:186`)
2. **審査の待ち時間が7秒しかない。** AI 整形と同じ制限時間を使っている(`AIService.swift:791`、`EnhancementRequestSettings.swift:6`)。審査は裏で動く処理なのに、Gemini の応答(約7秒)が間に合わない
3. **審査のルールが技術用語を却下する。** 審査の指示文に「ブランド・製品・技術は登録しない」とある(`AutoLearnAIReviewer.swift:431` からの `reviewPrompt`)。「Claude Code」「Codex」はこれに当たる

さらに、登録された語彙は Whisper に渡っていない。Whisper の初期プロンプトは固定の挨拶文だけ(`ModeRuntimeConfiguration.swift:16-21` → `WhisperPrompt.resolvedPrompt`。日本語は「こんにちは、お元気ですか？お会いできて嬉しいです。」)。語彙が使われるのは、AI 整形とクラウドのモデルだけ。

このリリースでは 1〜3 を直す。あわせて語彙を Whisper の初期プロンプトに入れ、認識の段階で正しく書かれやすくする。成功の基準は、Chrome などで「ロードコード」を「Claude Code」に直すと辞書に登録され、次に同じことを話したときに「Claude Code」と貼り付けられること。

調査中に、配布スクリプトの問題も見つかった。`~/Downloads/VoiceInk.app` は macOS の保護(App Management)で上書きできないことがある。そのとき `make local` は失敗を無視して終わり、`scripts/deploy-mbp.sh` は古いアプリを配ったのに「deployed」と表示した。これも直す。

## スコープの確定(壁打ちでの決定事項)

| 論点 | 決定 |
|---|---|
| このリリースで扱うもの | 途中経過の表示(M2〜M6)はいったん止め、辞書の自動登録を進める。途中経過は release-1 の状態のまま残し、壊さない |
| 直しを拾う方法 | 本家の Auto Learn(貼り付け先の入力欄を見張る方法)をそのまま使う。VoiceInk の中に直すための画面を作る案は、手間が増えるので採らない |
| 審査 | AI の審査は残す。日本語と技術用語に合わせた指示文をフォーク側で用意し、本家の指示文の代わりに使う。音が似ている直し(カタカナと英字の書き換え、似た音の漢字)は、技術用語・製品名・固有名詞でも登録する。言い回し・文法・意味の変更は今までどおり却下する |
| 審査の待ち時間 | AI 整形の制限時間(7秒)とは分け、審査専用の設定(既定30秒)にする。審査は裏で動くので、延ばしても使い勝手は悪くならない |
| 日本語の区切り | 「、」「。」などの日本語の記号と、文字の種類(漢字・ひらがな・カタカナ・英数字)が変わる位置でも区切る。直した語の周りだけを候補にする。32文字の上限(口述の中身を AI に長く送らないための制限)はゆるめない |
| 語彙を Whisper に渡す | 録音後の最終処理の初期プロンプトに、既存のプロンプトに続けて辞書の語彙を入れる。語彙が無ければ、今までと同じプロンプトになる |
| 配布スクリプト | `~/Downloads` を経由せず、ビルドしたフォルダ(`.local-build/`)から直接配る。配ったあと、手元と MacBook Pro のバイナリが一致することを確かめる |
| 単体テスト | このリリースで、テストの仕組みと `make test` を足す。日本語の区切りや指示文など、純粋な処理が中心になるため(release-1 では M2 で足す予定だった) |
| ターミナル(Ghostty)と VS Code | このリリースでは扱わない。known-issues に記録する |
| CLAUDE.md の更新 | 決定事項に「辞書の自動登録(本家の Auto Learn)の日本語対応もこのフォークで行う。途中経過の表示(M2〜M6)は release-3 以降に再開する」を追記する。ビルドと動作確認の署名の確認コマンドは、FR-05 で配るアプリが変わるため `.local-build/Build/Products/Release/VoiceInk.app` に直す |
| 本家との衝突 | 本家は Auto Learn を作り替え中(未マージのブランチ `codex/optional-ai-dictionary-review`、20ファイル)。本家のファイルへの変更は呼び出しを差し替える数行に限り、処理は新しいファイルに置く |

## 機能要件

### FR-01: 日本語の区切り(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnJapaneseSegmenter.swift`(新規)

日本語を含む文を、直した箇所の比較に使う単位に区切る、純粋な処理を作る。本家の `CorrectionDiffEngine` からの呼び出し(FR-07)で使う。

- AC-1: 区切りの位置は、空白、本家の区切り記号(`CorrectionDiffEngine.swift` の `structuralSeparators`)、日本語の記号(少なくとも「、」「。」「！」「？」「「」「」」「（」「）」)、文字の種類が変わる位置(漢字・ひらがな・カタカナ・英数字の間)。「・」と長音「ー」は区切らない(「ナ・リーグ」「コーデックス」を1語として扱うため)
- AC-2: 日本語の記号は、本家の区切り記号と同じく、それ自体が1つの区切りの単位になる
- AC-3: 日本語(ひらがな・カタカナ・漢字)を含まない文には使われない。英語の文の区切り方は本家のまま変わらない
- AC-4: `make test` で、次の入力の区切り結果を確かめるテストが通る:「ロードコードとコーデックスどちらがいいですか。」が「ロードコード / と / コーデックス / どちらがいいですか / 。」に分かれる。「ナ・リーグのポスティング」が「ナ・リーグ / の / ポスティング」に分かれる

### FR-02: 日本語と技術用語に合わせた審査の指示文(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnForkReviewPrompt.swift`(新規)

本家の `reviewPrompt` の代わりに使う指示文を作る。返す JSON の形は本家と同じにして、本家の検証(`AutoLearnAIReviewer.swift` の応答の検証)をそのまま通す。

- AC-1: 返す形が本家と同じ。JSON の配列だけを返し、各要素は `candidateID`・`learningAction`・`incorrectTextToReplace`・`correctedVocabularyTerm` の4つ。`learningAction` は `addReplacementAndVocabulary`・`addReplacementOnly`・`addVocabularyOnly`・`rejectCorrection` のどれか(指示文の文字列に4つの名前がすべて含まれることをテストで確かめる)
- AC-2: 音が似ている直しなら、技術用語・製品名・サービス名・固有名詞(日本語・英語とも)を登録してよいと書かれている。カタカナと英字の書き換え(コーデックス → Codex)、似た音の語(ロードコード → Claude Code)、固有名詞の中の記号(ナリーグ → ナ・リーグ)を、登録する例として載せている
- AC-3: 次のものは今までどおり却下すると書かれている: 意味を変える直し、言い回し・文法・敬語・送り仮名・表記の好みの変更(例: 話をした → 話しました)、数字・日付、大文字小文字だけの変更。却下する例も日本語で載せている
- AC-4: 本家の指示文にある、人名の扱い(フルネームを1語として扱う)と、`incorrectTextToReplace` は候補の元の文にある文字列をそのまま使う、という決まりを残している
- AC-5: 本家の `reviewPrompt` の本文は消さない(本家を取り込むときの衝突を減らすため。使う側だけを差し替える)

補足: AI の返答を確かめる本家の処理(`AutoLearnAIReviewer.swift:235-323` の `validate` と `isGrounded`)は、文字の種類に依存しない。確かめるのは、語が候補の文にそのまま含まれるか、大文字小文字だけの違いでないか、半角の「,」を含まないか、の3つ。日本語の候補もそのまま通るので、この処理は変えない。

### FR-03: 審査の待ち時間を分ける(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/Fork/AutoLearnReviewSettings.swift`(新規)

- AC-1: 審査の待ち時間を UserDefaults のキー `AutoLearnReviewTimeoutSeconds` から読む。値が無い・0以下なら既定の30秒
- AC-2: AI 整形の待ち時間(`EnhancementRequestSettings.timeout`、既定7秒)は変えない。AI 整形の動作は変わらない

### FR-04: 語彙を Whisper の初期プロンプトに入れる(優先度: 必須)

- 場所: `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Fork/WhisperVocabularyPrompt.swift`(新規)

辞書の語彙(`VocabularyWord`)を、既存の初期プロンプトのあとに付け足した文字列を作る。

- AC-1: 語彙が0件なら、返す文字列は `WhisperPrompt.resolvedPrompt(for:)` の結果とまったく同じ
- AC-2: 語彙があるときは、既存のプロンプトのあとに、語彙を新しく登録した順に「、」でつないで足す(例:「こんにちは、お元気ですか？お会いできて嬉しいです。Claude Code、Codex。」)。重複した語は1回だけ入れる
- AC-3: 足す語彙の部分は120文字以内。超える分は古い語から入れない。根拠: whisper.cpp の初期プロンプトの上限は `n_text_ctx/2 - 1` = 223トークン(`src/whisper.cpp:7101`)。文字数とトークン数の関係は語によって違うため、上限に収まることは保証しない。超えた場合、whisper.cpp はプロンプトの末尾を残して先頭を切る(`src/whisper.cpp:7301` の `prompt_past1.end() - n_take1`)。語彙は末尾にあるので、切られるのは先頭の挨拶文になる
- AC-4: 作った初期プロンプトについて、語彙の数とプロンプトの文字数だけを `Logger(subsystem: "com.prakashjoshipax.voiceink", category: "WhisperVocabularyPrompt")` で `.public` に出す(形式 `vocabularyTerms=… promptChars=…`)。語彙やプロンプトの文字列は `.public` で出さない(ARCHITECTURE.md 2-3)
- AC-5: 語彙の追加・削除(手で追加した場合も、Auto Learn が登録した場合も)が、次の録音から反映される。アプリの再起動は要らない
- AC-6: `make test` で、AC-1〜AC-3 を確かめるテストが通る(語彙0件、重複、120文字を超えたとき)

### FR-05: 配布スクリプトを直す(優先度: 必須)

- 場所: `scripts/deploy-mbp.sh`

CLAUDE.md の署名の確認コマンド(`codesign -dv --verbose=2 ~/Downloads/VoiceInk.app`)は、配るアプリの場所が変わるので、sync-docs で `.local-build/Build/Products/Release/VoiceInk.app` に直す。

- AC-1: 配るアプリは `.local-build/Build/Products/Release/VoiceInk.app`(`make local` がビルドする場所)。`~/Downloads/VoiceInk.app` は使わない
- AC-2: `make local` のあと、配るアプリのバイナリ(`Contents/MacOS/VoiceInk`)が、スクリプトを始めた時刻より新しいことを確かめる。古ければ、配らずに終了コード 1 で終わる
- AC-3: 署名の確認(`Authority=Apple Development`、`DEPLOY_ALLOW_ADHOC=1` の扱い)は、配るアプリに対して今までどおり行う
- AC-4: rsync のあと、手元と MacBook Pro のバイナリの `shasum -a 256` を比べる。一致したときだけ `deployed <短縮コミット> to <ホスト>` と表示する。違えば終了コード 1 で終わる
- AC-5: `bash -n scripts/deploy-mbp.sh` が通る。`shellcheck` が入っていれば警告なしで通る
- AC-6: 実機での配布(手動検証必須) — Mac mini で `scripts/deploy-mbp.sh` を実行すると、MacBook Pro の `/Applications/VoiceInk.app/Contents/MacOS/VoiceInk` のハッシュが `.local-build` のものと一致する

### FR-06: 単体テストの仕組み(優先度: 必須)

- 場所: `Tests/VoiceInkTests/`(新規)、`Makefile`、`.claude/workflow.config.json`

プロジェクトには単体テストのターゲット `VoiceInkTests`(フォルダ `Tests/VoiceInkTests` と同期する設定)が残っているが、フォルダが無い。

- AC-1: `Tests/VoiceInkTests/` に、FR-01・FR-02・FR-04 と、FR-07 で結線した `CorrectionDiffEngine.candidates` のテストがある
- AC-2: `CorrectionDiffEngine.candidates` のテストが次を確かめる:
  - 「ロードコードとコーデックスどちらがいいですか。」を「Claude CodeとCodexどちらがいいですか。」に直すと、候補が1件以上でき、「ロードコード」と「コーデックス」の直しがどれかの候補に含まれる
  - 「今日はメジャーリーグの移籍の市場と、ナリーグのポスティングについて詳しく話をしました。」の「移籍の市場」を「移籍市場」に、「ナリーグ」を「ナ・リーグ」に直すと、候補が1件以上でき、どの候補も元の文と直した文が32文字以内になる(今の本家では0件)
  - 英語の「Please email Prakash Joshi Pages today.」を「Pax」に直した候補が、本家と同じ「email Prakash Joshi Pages today → email Prakash Joshi Pax today」になる
- AC-3: `Makefile` に `test` ターゲットがあり、`make test` で `VoiceInkTests` を実行して通る。ビルドの作業フォルダは `make build` と別にする(`-derivedDataPath .test-build`。リリース前の検査は `make build` と並べて実行するので、同じフォルダだと衝突する)。`.test-build/` は `.gitignore` に足す。人の操作(権限の許可の画面など)を待たずに終わる。`Makefile` と `.gitignore` は本家のファイルなので、変更は `test` ターゲットとその1行の追加だけにする(既存のターゲットの整形し直しや並べ替えをしない)
- AC-4: `.claude/workflow.config.json` の `checks` に `{"key": "test", "cmd": "make test", "cwd": "."}` が加わり、`knownIssues.categoryMap` に `"check:test": "B"` が加わる(run-release は起動時に読んだ config を使うので、効くのは次のリリースから)

### FR-07: 結線(優先度: 必須)

- 場所: `VoiceInk/Features/Dictionary/AutoLearn/CorrectionDiffEngine.swift`、`VoiceInk/Features/Dictionary/AutoLearn/AutoLearnAIReviewer.swift`、`VoiceInk/Features/Enhancement/State/AIService.swift`、`VoiceInk/Features/Modes/State/ModeRuntimeConfiguration.swift`(語彙を読み込むために、アプリ起動時の登録が要るなら `VoiceInk/App/VoiceInk.swift` も)

本家のファイルの変更は、FR-01〜FR-04 の処理を呼ぶための差し替えだけにする(ARCHITECTURE.md 1-5)。

- AC-1: `CorrectionDiffEngine` の区切りは、直す前の文と直したあとの文のどちらかに日本語が含まれるとき、両方の文を FR-01 で区切る(片方だけ別の区切り方にすると、比べる単位がずれるため)。どちらにも日本語が無いときは、両方とも本家の処理で区切る
- AC-2: `AutoLearnAIReviewer` が AI に送る指示文が FR-02 のものになる(`systemPrompt: Self.reviewPrompt` の参照の差し替え)
- AC-3: `AIService.reviewAutoLearnCandidates` の待ち時間が FR-03 の値になる。同じファイルのほかの関数の待ち時間は変えない
- AC-4: `TranscriptionRuntimeConfiguration.requestContext` の初期プロンプトが、Whisper のとき FR-04 のものになる。Whisper 以外(Parakeet・Nemotron・クラウド)は今までどおり `nil`
- AC-5: 途中経過の provider(`WhisperStreamingProvider`)の初期プロンプトは変えない(今までどおり `nil`)
- AC-6: `git diff --stat feature/whisper-streaming -- VoiceInk` に出る既存ファイルが、この FR の「場所」に挙げたものだけ。それぞれの変更は差し替えに必要な行だけ
- AC-7: `make build` が通る

### FR-08: 規約と記録の更新(優先度: 必須)

- 場所: `docs/ARCHITECTURE.md`、`docs/known-issues.md`、`FORK-CHANGES.md`、`docs/releases/release-2-autolearn-japanese/e2e-verification.md`(新規)

- AC-1: `docs/ARCHITECTURE.md` に、Auto Learn をフォークで変えるときの規約がある。(1) 処理は `Fork/` の新しいファイルに置き、本家のファイルは呼び出しの差し替えだけにする、(2) 直した文字・候補・審査の結果の文字列を `.public` でログに出さない、(3) 32文字の上限をゆるめない。それぞれに根拠を付ける。既存の規約は弱めない
- AC-2: `docs/known-issues.md` のバックログに、次の2件が、ファイルの記録形式(`### <ID>. <タイトル>` と severity・場所・現象・対応方針)で実測つきで載っている。ID は B の連番(B1・B2)、severity は low。(1) Ghostty で直した位置を特定できない(画面の履歴全体 約5.6万文字が返り、前後16文字の目印が一意に決まらない。`FinalSnapshotDiffEngine.swift` の `correctedPastedText`)、(2) VS Code のエディタで読み取れない(入力欄の中身が0文字で返る。`editor.accessibilitySupport` を `on` にすると読める可能性があるが未確認)
- AC-3: `FORK-CHANGES.md` に、このリリースで追加・変更したファイルが、ファイル・変更内容・理由の3列で載っている
- AC-4: `e2e-verification.md` に、FR-09 の手順(アプリ・話す文・直し方・ログの取り方)と実施記録の表がある。コマンドはそのまま貼って実行できる形。ログの取り方は CLAUDE.md の計測ログのコマンド(`/usr/bin/log show`)を使い、カテゴリ `AutoLearn`・`AutoLearnAIReview`・`AutoLearnCapture`・`WhisperVocabularyPrompt`・`CursorPaster` を対象にする

### FR-09: MacBook Pro での実機確認(優先度: 必須)

- 場所: `docs/releases/release-2-autolearn-japanese/e2e-verification.md`

前提: FR-05 AC-6 で配布できていること。VoiceInk の設定は普段のまま(Dictation モード、日本語、large-v3-turbo-q5_0、AI 整形あり、Auto Learn はオンで審査は Gemini、審査のタイミングは「すぐ」)。

- AC-1: 短い文の登録(手動検証必須) — Chrome・テキストエディット・Slack・Claude デスクトップ・Obsidian の5つで、「Claude Code と Codex、どちらがいいですか。」を口述し、誤った語を手で直して入力欄から離れる。ログに `Queued … candidate(s)` と `Auto Learn review completed` が出て、時間切れ(`AI review failed`)が出ない。審査の結果、`replacementAndVocabulary` か `replacementOnly` が1件以上になる
- AC-2: 辞書への登録(手動検証必須) — AC-1 のあと、VoiceInk の設定の Dictionary に、直した語の単語置換(例: ロードコード → Claude Code)か語彙が増えている
- AC-3: 次の口述への反映(手動検証必須) — AC-2 のあと、同じ文をもう一度口述すると、「Claude Code」「Codex」と貼り付けられる。`WhisperVocabularyPrompt` のログに `vocabularyTerms=` が1以上で出る
- AC-4: 長い文(手動検証必須) — テキストエディットで「今日はメジャーリーグの移籍市場と、ナ・リーグのポスティングについて詳しく話しました。」を口述し、誤った語を直すと、ログに `Queued … candidate(s)` が出る
- AC-5: 却下の確認(手動検証必須) — 言い回しだけを直したとき(例:「どちらがいいですか」を「どっちがいいですか」に直す)は、審査の結果が `rejected` になり、辞書が増えない
- AC-6: 無音で語彙が出ないこと(手動検証必須) — 語彙が登録された状態で、何も話さずに5秒録音して止める。貼り付けられた文字に語彙(Claude Code・Codex など)が含まれない。release-1 では、VAD を切ると話していない定型文が最後に足された。初期プロンプトの語が出てしまうのと同じ現象なので、語彙を足したことで悪化していないかを確かめる
- AC-7: 既存の動作(手動検証必須) — 録音停止から貼り付けまでの流れが今までどおり動く。途中経過の表示(隠し設定 `WhisperStreamingEnabled` がオン)も release-1 と同じように出る

## 非機能要件

- FR-05(配布スクリプト)とアプリの系列(FR-01〜FR-04、FR-07)は独立に実装可能。FR-01〜FR-04 も互いに独立に実装可能(どれも新しいファイル)
- 口述の中身(貼り付けた文字、直した文字、候補、審査の結果の語、語彙、初期プロンプト)を `.public` のログ、リポジトリ内のファイル(`logs/` を除く)に出さない。`.public` にしてよいのは件数・文字数・秒数・理由の文字列だけ
- 審査で AI に送る文字の範囲を広げない。32文字の上限と、前後の文脈の量(本家は前後3単位)は、本家の制限より長くしない
- 本家のファイルの変更は、呼び出しの差し替えに必要な行だけ(本家が Auto Learn を作り替え中で、取り込むときに衝突しやすいため)
- AI 整形・単語置換の適用・貼り付けの経路は変えない。英語の文に対する Auto Learn の動作も変えない
- 途中経過の表示(release-1)を壊さない。録音停止後の最終処理は Mode で選んだ Whisper モデルのまま
- entitlements と権限(マイク、アクセシビリティ)は追加しない
- 本家の文書(README.md、BUILDING.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md)と docs/fork-plan.md(凍結)を変えない
- `make check`・`make build`・`make test` が通る

## スコープ外

- ターミナル(Ghostty など)で直した位置を特定する対応(known-issues に記録する)
- VS Code のエディタで読み取る対応(known-issues に記録する)
- 途中経過の表示の続き(M2〜M6)、既知課題 P1(途中経過用モデルの読み込み)、release-1 の未実施の手動検証4件、途中経過用モデルの決定
- 途中経過の認識に語彙を渡すこと
- AI を使わない審査(本家の未マージのブランチにある Apple の自然言語処理を使う審査)
- 審査の画面(手動の審査パネル)や辞書の画面の変更
- Auto Learn の調査用ログを常設すること(今回の調査で使ったログはコミットしていない)
- `Makefile` の `local` ターゲットが、`~/Downloads` へのコピーの失敗を無視する問題(本家のファイルのため。FR-05 で配布側を `~/Downloads` に依存しない形にして回避する)

## 未解決事項

- **設計で確かめる**: 単体テストのターゲットはアプリを親にして動く設定(`TEST_HOST`)。`make test` の実行で、アプリの起動や署名に何が要るかを確かめないと、FR-06 AC-3 の `test` ターゲットの中身(xcodebuild の引数、Debug と Release のどちらを使うか)が書けない
- **設計で確かめる**: `requestContext` は同期の計算プロパティで、語彙は SwiftData(辞書の保存先)にある。語彙をどう読み込んでおくか(起動時に読み、変更の通知で更新する、など)を決めないと、FR-04 AC-5 と FR-07 AC-4 が作れない。辞書の変更の通知は `.wordReplacementsDidChange`(`AppNotifications.swift:22`)があるが、語彙の追加でも出るかは確認が要る
- **設計で確かめる**: `CorrectionDiffEngine` は前後3単位を文脈として候補に付ける。日本語を細かく区切ったとき、文脈を含めて32文字に収まるか。収まらないときに文脈を減らすかどうかを決めないと、FR-06 AC-2 の長い文のテストが通らない可能性がある
- **設計で確かめる**: 本家の whisper.cpp の呼び出しは `carry_initial_prompt` を使わない(既定の false)。そのため初期プロンプトが効くのは、主に最初の30秒の区間になる。30秒を超える口述では、後半の語彙の効きが弱いことがある。FR-09 AC-3 は30秒未満の文で確かめる
- **実機で確かめる**: 新しい指示文で Gemini が実際に登録を返すか(FR-09 AC-1)。返さないときは指示文を直す

## 用語

- Auto Learn:本家の、貼り付けた文字を人が直したら、その直しを辞書に自動で登録する機能。設定の Dictionary の「Auto-Learn Dictionary」
- 単語置換:認識結果の文字を、別の文字に置き換える辞書の項目(例: ロードコード → Claude Code)。録音後の処理で、AI 整形の前に適用される
- 語彙:辞書に登録した言葉の一覧。今までは AI 整形とクラウドのモデルにだけ渡していた。このリリースから Whisper の初期プロンプトにも入れる
- 候補:直した箇所と、その前後の少しの文字の組。AI の審査に送られる
- 審査:候補を辞書に登録してよいかを AI が判断すること
- 初期プロンプト:Whisper に認識の前に渡す文字列。ここにある言葉は、認識結果に出やすくなる

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-2-autolearn-japanese", config: <.claude/workflow.config.json の内容>}})
```
