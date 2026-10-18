# release-1-whisper-partial-prototype の引き継ぎ

- PR: https://github.com/sumihiro3/VoiceInk/pull/2(2026-10-18 にマージ。最初は draft で作られた。手動検証が未実施だったためで、実機での計測を記録してから ready にしてマージした)
- 書いた日: 2026-10-18(/close-release)

M1 前の準備(whisper.cpp を `0c7be69` に固定、`scripts/deploy-mbp.sh`)と、M1「表示だけの試作」のリリース。隠し設定 `WhisperStreamingEnabled` を true にすると、録音中に 1 秒ごとに全音声を途中経過用モデルで認識して録音画面に出す。録音停止後は従来どおり Mode のモデルで全音声を処理し直した結果だけを貼り付ける。MacBook Pro で動作と計測を確かめ、CLAUDE.md の M1 を完了にした。

## 残っている既知課題

1 件(`docs/known-issues.md`)。

- **P1**(low)録音ごとにモデルを読み込み、最初の文字が出るまでの計測からも読み込み時間が抜けている — `VoiceInk/Infrastructure/Providers/Transcription/Whisper/Streaming/WhisperStreamingProvider.swift:56-87`
  - `connect` が録音のたびに途中経過用モデルを読み込む。実測の読み込み時間は base で 0.12〜0.58 秒、large-v3-turbo-q5_0 で 0.99〜1.50 秒。ログの `firstPartialAfterConnect` は読み込み後から数えるので、利用者が待った時間より短く出る(手順書では `loadElapsed` と足して記録している)

## 要件書について人の判断が要る点

該当なし

## 満たしていない受け入れ基準

該当なし(自動で確かめた受け入れ基準はすべて満たした)

## 手動検証が未実施の受け入れ基準

手順は `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md`(第8節がテストケース、第9節が実施記録)。

- FR-07 AC-2: 60 秒以上の口述。今回の最長は約 30 秒(q5_0)
- FR-07 AC-3: 停止後の処理時間を、途中経過なし(隠し設定を消して再起動)と比べること。途中経過ありの 10 回は中央値 1.17 秒で記録済み
- FR-07 AC-4: 録音中に Esc で中止し、すぐ次の録音が始められること
- FR-07 AC-5: 隠し設定を消すと、従来どおり途中経過が出ないこと

## 次のリリースの候補

- **辞書の自動登録(ユーザーの希望)**: 貼り付けた文字を人が直したら、その直しを辞書に自動で登録したい。本家の辞書機能(単語置換 `WordReplacementService`、語彙を初期プロンプトに入れる仕組みなど)と何が違うかを確かめながら作りたい。出どころは実地で分かったこと(録音停止後の結果でも「移籍市場」「ナ・リーグ」「ポスティング」などの固有の言葉を誤った。モデルを量子化なしにしても同じ箇所を誤った)
- **途中経過用モデルを決める**: base は速い(1 回 0.1〜0.4 秒)が誤りが多い(Mac mini での再認識で誤りの割合 53〜70%)。q5_0 は正確(5〜29%)だが 1 回 1.0〜1.65 秒かかり、1 秒の処理間隔を超え続ける。2 秒の音声でも約 1 秒かかるので、M3 の 25 秒での切り詰めでは解決しない見込み。候補は whisper.cpp の `audio_ctx` で処理する枠を狭める、small を取り込んで比べる、処理間隔を 2 秒にする。出どころは CLAUDE.md の未決事項と今回の計測
- **P1 の対応**: 途中経過用モデルを録音前に読み込んでおき、最初の文字が出るまでを縮める(q5_0 では 3.1〜3.6 秒のうち 1.0〜1.5 秒が読み込み)。出どころは既知課題 P1
- **M2 確定処理と単体テスト**: 文字単位の LocalAgreement で確定・未確定を分けて表示する。あわせて単体テストの仕組みと `make test` を足し、`WhisperStreamingProvider` の `tick`(回を飛ばす判定)と `shutdown`(停止の順序)もテスト対象にする。出どころは CLAUDE.md のマイルストーンと、このリリースの要件のスコープ外
- **未実施の手動検証 4 件**: 上の「手動検証が未実施の受け入れ基準」。次のリリースの実機確認と一緒に済ませるのがよい

## 実地で分かったこと

- 辞書登録機能がほしい。貼り付けた内容を直したら、その直しが自動で辞書に登録されるようにしたい。本家の機能との違いを確認しながら作りたい(ユーザーの回答)
- Mode のモデルは large-v3-turbo の量子化版(q5_0)でよい。同じ録音を Mac mini で認識し直したところ、量子化なしと誤りの箇所が同じだった(CLAUDE.md の決定事項に記録済み)
- VAD は有効のままにする。切ると、話していない定型文が最後に足された
- Mac mini で無料の Apple ID の Apple Development 証明書を作ったとき、中間証明書(Apple Worldwide Developer Relations の G3)が無く、`security find-identity -v` が 0 件になった。G3 を入れて解決した(手順書の第1節に記載)
- MacBook Pro の zsh では `log` が組み込みコマンドを指すので、`ssh mbp "log show …"` は失敗する。`/usr/bin/log` と書く(CLAUDE.md と手順書は直した。凍結文書の `docs/fork-plan.md:104` は古い書き方のまま)

## 参考

- 解説レポート: `${TMPDIR}/claude-release-workflow/VoiceInk/release-1-whisper-partial-prototype/report.html`(OS の一時領域にあるので、数日で消えうる)
- このリリースで解決した既知課題: F1(停止時に途中認識を待たない。ARCHITECTURE.md 3-4 に規約化)
- 実機検証の手順と計測値: `docs/releases/release-1-whisper-partial-prototype/e2e-verification.md`
- モデル比較に使った録音・モデル・whisper-cli は、このセッションの一時領域にだけ置いた(リポジトリには入れていない)
