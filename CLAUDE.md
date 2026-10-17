# VoiceInk フォーク(Whisper 途中経過表示)

## このリポジトリ

- Beingpax/VoiceInk の公開フォーク。origin = 自分のフォーク、upstream = 本家
- 目的:Whisper(whisper.cpp)で、録音中に途中経過を表示する「疑似リアルタイム処理」を追加する
- 作業ブランチ:`feature/whisper-streaming`。main は本家と同じ状態に保つ
- 手順の詳細(フォーク、配布スクリプト、調査と実装の依頼文、テストケース)は docs/fork-plan.md を参照する
- 開発は claude-release-workflow で進める(リリースサイクルと運用は docs/development-workflow.md を参照する)

## 作業の進め方

- マイルストーン(下記)を1つずつ進める。1つ終わったらコミットし、次へ進む前に人間の確認を待つ
- 新しい処理は新しいファイルにまとめる。既存ファイルへの変更は差し込みに必要な最小限にする
- 既存ファイルを変更・ファイルを追加したら、FORK-CHANGES.md に「ファイル・変更内容・理由」を追記する
- 前のマイルストーンまでの動作を壊さない
- 途中経過の処理でエラーが出ても、録音後の最終処理は従来どおり動くようにする
- `logs/` には口述内容が含まれる。`.gitignore` 済みで、コミットしない

## ビルドと動作確認

- 開発は Mac mini、動作確認は MacBook Pro(M1 Pro)で行う
- `make check`:ビルド環境の確認
- `make dev`:Mac mini 上での簡易確認(VoiceInk Dev.app)
- `scripts/deploy-mbp.sh`:`make local` でビルドし、MacBook Pro の /Applications/VoiceInk.app を置き換えて再起動する
- 署名は Apple Development を使う(`codesign -dv --verbose=2 ~/Downloads/VoiceInk.app` で確認)。ad-hoc 署名だと MacBook Pro 側の権限が配るたびに外れる
- 計測ログの取得(Mac mini から実行):

```bash
ssh mbp "log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\"'" > logs/mbp-$(date +%H%M).log
```

## 設計の要点

- 録音中は一定間隔(初期値1秒)で、直近の音声(上限25秒)を途中経過用モデルで認識し、録音画面に表示する
- 前の回の認識が終わっていなければ、その回は飛ばす(処理を重ねない)
- 連続した2回の結果で先頭から一致した部分を「確定」とする(LocalAgreement)。確定部分は以後書き換えない
- 表示は「確定(通常の文字)+未確定(薄い文字)」
- 認識対象が上限を超えたら、確定済み区間の終わり(Whisper の区間の時刻)で音声バッファを切る。確定済みの末尾を初期プロンプトに渡して文脈をつなぐ
- 発話区間の検出(VAD)で、発話がなければ認識しない
- 録音停止後は、全音声を Mode で選んだ Whisper モデル(large-v3-turbo)で処理し直し、既存の整形・置換・AI整形に流す。貼り付けるのはこの結果だけ
- 1回の認識時間と、そのときの音声の長さを os_log に出す

## マイルストーン

- [x] M0 調査:既存のリアルタイム処理を読み、[`docs/whisper-streaming-investigation.md`](docs/whisper-streaming-investigation.md) にまとめる(コードは変更しない)
- [ ] M1 表示だけの試作:1秒ごとに録音開始からの全音声を認識し、そのまま表示する
- [ ] M2 確定処理:LocalAgreement で確定・未確定を分けて表示する
- [ ] M3 窓の切り詰め:25秒超で確定済み区間をバッファから外す
- [ ] M4 無音対策:VAD で無音時の認識を飛ばす
- [ ] M5 設定画面:途中経過の有効・無効、途中経過用モデル、処理間隔を Mode の設定に追加する
- [ ] M6 仕上げ:計測ログの整理、エラー時の安全策、FORK-CHANGES.md の最終化

## 合格基準(暫定)

- 話し始めて2秒以内に文字が出る
- 60秒以上話し続けても、1回の認識時間が処理間隔を超え続けない
- 10秒の無音で文字が出ない
- 最終結果が、従来の録音後処理と同等の表記になる

## 決定事項

- フォークは公開、個人の GitHub アカウント
- MacBook Pro の普段使いの VoiceInk は、当面フォーク版で置き換える。複雑な開発が出てきたら別アプリに分ける
- 録音停止後は Mode で選んだ Whisper モデル(large-v3-turbo)で全音声を処理し直す(provider の `stopDisposition = .useBatchFallback`。release-1 で決定)

## 未決事項(M0 の調査結果を見て決める)

- 途中経過用モデル(base / small / large-v3-turbo の量子化版)
- 処理間隔と認識対象の上限の初期値
- VAD を whisper.cpp 内蔵のものにするか、音量のしきい値で済ませるか
