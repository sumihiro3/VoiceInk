# release-0-whisper-investigation の引き継ぎ

- PR: https://github.com/sumihiro3/VoiceInk/pull/1(2026-10-17 にマージ。draft ではない)
- 書いた日: 2026-10-17(/close-release)

M0(調査)のリリース。成果物は調査メモ `docs/whisper-streaming-investigation.md` と、以後のマイルストーンが守る規約 `docs/ARCHITECTURE.md`。アプリのコードは変えていない。受け入れ基準は17件すべて満たし、`make check`・`make build` も通っている。

## 残っている既知課題

1件(`docs/known-issues.md`)。

- **F1**(low)停止時に途中認識を待つ案が最終処理をブロックする — `docs/whisper-streaming-investigation.md:391`
  - 調査メモは、録音停止時に進行中の途中認識を「取り消す、または待つ」としている。だが最終処理(WAV 全体のやり直し)は `stopAndFinalize` が返ってから始まるので、「待つ」を選ぶと、25秒近い音声の認識中に停止したとき、その待ち時間が停止から貼り付けまでの遅延にそのまま足される
  - 対応方針: 「待つ」を選択肢から外す。whisper.cpp の abort callback などで途中認識を中断し、中断できなくても完了を待たずに古いセッションとして無効化して、最終処理をすぐ始める。M1 で停止の経路を実装するときに、ARCHITECTURE.md の規約に入れる

## 要件書について人の判断が要る点

該当なし

## 満たしていない受け入れ基準

該当なし

## 手動検証が未実施の受け入れ基準

該当なし

## 次のリリースの候補

- **M1 前の準備(次にやる。実地で選んだもの)**: Makefile で whisper.cpp を調査時のコミット `0c7be69` に固定する。`scripts/deploy-mbp.sh` を作る(`make local` でビルドし、MacBook Pro の /Applications/VoiceInk.app を置き換えて再起動)。どちらも release-0 のスコープ外に挙げた項目。いまの Makefile は whisper.cpp を最新で clone するだけで、`scripts/` には release.sh と setup-release-notarization.sh しか無い。手順は `docs/fork-plan.md` の手順2-2
- **M1 表示だけの試作**: CLAUDE.md の未決事項4件が決まらないと要件が書けない。調査メモ⑨の提案(途中経過用モデルは base、処理間隔1秒・上限25秒、停止後は `.useBatchFallback` で large-v3-turbo がやり直す、VAD は whisper.cpp 単体 API)を仮置きし、M1 の計測で決める進め方がある。M1 前の準備が済んでから
- **F1 の規約化**: 上の既知課題。M1 の要件に含めるのが自然

## 実地で分かったこと

特になし(次は「M1 前の準備」から始めたい)

## 参考

- 解説レポート: `${TMPDIR}/claude-release-workflow/VoiceInk/release-0-whisper-investigation/report.html`(OS の一時領域にあるので、数日で消えうる)
- このリリースで解決した既知課題: 該当なし
- 未決事項4件の提案と、決めるための計測方法: `docs/whisper-streaming-investigation.md` の⑨
- 差し込み箇所(新規ファイル・既存ファイルの変更)の案: 同じく⑦。設計と実コードの食い違い10件は⑧
