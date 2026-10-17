# VoiceInkフォーク改造手順:Whisperリアルタイム表示

2026-10-17 作成

## ゴールと全体像

VoiceInkをフォークし、Whisper(whisper.cpp)で話している途中の文字を録音画面に出す。本家のWhisperは録音を止めてからまとめて処理するため、途中経過が出ない。Nemotron MultilingualはNeural Engine向けの変換エラー(Code=22)で動かなかった。

方針は「短い間隔で認識し直す」疑似リアルタイム処理。録音中は1秒ごとに直近の音声を軽いモデルで認識して途中経過を表示し、録音停止後に large-v3-turbo で全体を処理して最終結果にする。

完成イメージ:

- 話し始めて約1〜2秒で録音画面に文字が出始める
- 確定した部分は書き換わらず、末尾だけが更新される
- 貼り付けられる最終結果は、今のWhisperでまとめて処理した場合と同じ精度
- 普段使いのVoiceInkとは別アプリ(VoiceInk Dev.app)で開発・検証する

全体の流れは、フォーク→開発ビルド環境→Mac miniでビルドしてMacBook Proで試す仕組み→既存コードの調査→設計→段階的な実装→計測→本家の更新取り込みの順。実装はClaude Codeに任せる前提で、各手順に依頼文を付けている。

## 手順1 フォークとリポジトリ準備

すでにビルド済みの `/opt/dev/VoiceInk`(本家のクローン)をそのまま使い、GitHub上のフォークを origin、本家を upstream にする。

1. `gh auth status` で個人アカウントでログインしていることを確認する(違う場合は `gh auth switch`)
2. GitHubでフォークし、リモートを張り替える(本家の origin は upstream に改名される)

```bash
cd /opt/dev/VoiceInk
gh repo fork --remote --remote-name origin
git remote -v   # origin=自分のフォーク、upstream=Beingpax/VoiceInk を確認
```

3. 作業ブランチを切る(main は本家と同じ状態に保つ)

```bash
git switch -c feature/whisper-streaming
```

4. フォークの変更点を記録する FORK-CHANGES.md を作る。変更した既存ファイル、追加したファイル、その理由を書いておくと、本家の更新を取り込むときの衝突解消が楽になる
5. リポジトリ直下に CLAUDE.md を置く(方針、ビルド方法、設計の要点、マイルストーン、決定事項)
6. 口述内容を含むログを誤ってpushしないよう、`logs/` を `.gitignore` に追加する

```bash
echo "logs/" >> .gitignore
```

フォークは公開リポジトリとする(決定済み)。

## 手順2 開発ビルド環境

開発中は `make dev` で「VoiceInk Dev.app」を作り、普段使いの `make local` 版と分けて動かす。本家の BUILDING.md によると、`make dev` は Dev.app をビルドして起動し、`make local` はリリース版を `~/Downloads` に出力する。

1. 前提は解消済み(XcodeのiOSプラットフォーム、Metal Toolchain)。`make check` で再確認する
2. 署名を固定する。Xcodeの Settings → Accounts でApple IDを追加し、Apple Developmentの署名を使う。ad-hoc署名だとビルドのたびにマイクとアクセシビリティの許可が外れやすい
3. 開発版を起動する

```bash
make dev   # VoiceInk Dev.app をビルドして起動
```

4. Dev.appにもマイクとアクセシビリティを許可する。普段使い版とは別アプリとして扱われる可能性が高い(設定やダウンロード済みモデルが共有されるかは初回起動時に確認)
5. 検証中は普段使いのVoiceInkを終了しておく。両方が起動していると録音ショートカットが衝突する

動作確認は、実際に口述する MacBook Pro(M1 Pro)で行う。疑似リアルタイム処理は毎秒Whisperを回すので、速度も負荷も使うマシンで測らないと意味がない。ビルドはMac miniで行い、できたアプリをMacBook Proへ配る(次の手順)。

## 手順2-2 Mac miniでビルドしてMacBook Proで試す

Mac miniで `make local` したアプリを rsync でMacBook Proにコピーし、SSH経由で再起動する。MacBook ProにXcodeは要らない。計測用なので、Debug版の Dev.app ではなくリリース版を配る。

1. MacBook Proで「リモートログイン」をオンにし、Mac miniから鍵でパスワードなしに入れるようにする。以前話したSSHは MacBook Pro→Mac mini の向きなので、今回は逆向きの鍵を追加する

```bash
# Mac mini で実行
ssh-copy-id mbp           # mbp = ~/.ssh/config に登録したMacBook Proの接続名
ssh mbp 'sw_vers && sysctl hw.memsize'   # 接続確認とメモリ容量の確認
```

2. Mac miniの署名をApple Developmentに固定する。署名が毎回同じなら、MacBook Pro側のマイクとアクセシビリティの許可が配り直しても外れにくい。ad-hoc署名だと、配るたびに許可し直しになる

```bash
make local
codesign -dv --verbose=2 ~/Downloads/VoiceInk.app 2>&1 | grep Authority
# Authority=Apple Development: ... と出ればOK
```

3. 配布用のスクリプトをリポジトリに置く(`scripts/deploy-mbp.sh`)。ビルド、終了、コピー、起動をまとめて行う

```bash
#!/bin/bash
set -euo pipefail
HOST=${MBP_HOST:-mbp}
APP=/Applications/VoiceInk.app
make local
ssh "$HOST" 'osascript -e "quit app \"VoiceInk\"" || true; sleep 2'
rsync -a --delete ~/Downloads/VoiceInk.app/ "$HOST:$APP/"
ssh "$HOST" "open $APP"
echo "deployed $(git rev-parse --short HEAD) to $HOST"
```

4. 初回だけMacBook Proでマイクとアクセシビリティを許可し、使うモデル(large-v3-turbo と途中経過用モデル)をMacBook Pro側でダウンロードする。モデルはアプリと一緒にはコピーされない
5. 口述で試したら、Mac miniからMacBook Proのログを取る。Claude Codeがそのまま計測結果を読める

```bash
ssh mbp "log show --last 5m --info --predicate 'subsystem == \"com.prakashjoshipax.voiceink\"'" > logs/mbp-$(date +%H%M).log
```

注意点:

- コピーには rsync を使う。AirDropやブラウザ経由だと隔離属性が付き、起動時にブロックされる。付いた場合は `xattr -dr com.apple.quarantine /Applications/VoiceInk.app`
- `make local` のアプリは本家版と同じアプリとして扱われるので、MacBook Proの普段使いのVoiceInkを置き換える形になる。設定や履歴は引き継がれる一方、開発中の不具合が普段使いにも出る。当面はこの置き換えで運用する(決定済み)。不具合が出たときは、main ブランチ(本家と同じ状態)に切り替えて deploy-mbp.sh で配り直せば元に戻せる。複雑な開発が出てきて分けたくなったら、Claude Codeに「Dev版と同じ別アプリ扱いでリリース構成のビルドを作る make ターゲット」を追加させ、スクリプトのコピー元とコピー先をそちらに切り替える
- `ssh mbp open` はMacBook Proでログイン中のユーザーの画面にアプリを起動する。ログアウト中は起動できない

## 手順3 既存コードの調査

実装に入る前に、Claude Codeに既存のリアルタイム処理の仕組みを読ませ、調査メモを作らせる。この段階ではコードを変更させない(プランモード推奨)。

調べる対象(ファイル名は未確認、ログとドキュメントから存在がわかっているもの):

- StreamingTranscriptionService:Nemotronのログに出ていた、リアルタイム処理の中心
- Nemotron と Parakeet のリアルタイム処理の実装(新しい処理のお手本)
- Whisperで録音後にまとめて処理する実装(whisper.xcframework の呼び出し方)
- モデルごとの「Real-time 対応・必須」を決めているカタログ定義
- 録音画面(MiniRecorderPanel、RecorderUIManager)と Live Text Display 設定の反映処理
- 録音の音声バッファ(サンプルレート、形式)

Claude Codeへの依頼文:

```text
このリポジトリはVoiceInkのフォークです。Whisperで途中経過を表示する「疑似リアルタイム処理」を追加したいので、まず調査だけしてください。コードは変更しないでください。

調べて docs/whisper-streaming-investigation.md にまとめてほしいこと:
1. StreamingTranscriptionService の役割と、プロバイダ(Nemotron/Parakeet/クラウド)ごとの差し替え方
2. 途中経過テキストが録音画面に届くまでの流れ(型、プロトコル、呼び出し順)
3. 録音停止後に最終テキストを作る流れと、整形・置換・AI整形への接続点
4. Whisper(whisper.xcframework)の呼び出し方、モデルの読み込みと保持の仕方、スレッド
5. モデルごとの Real-time 可否を定義している箇所
6. 録音中の音声バッファの形式と、途中で取り出せるか
7. 「Whisperのリアルタイムプロバイダ」を追加する場合に触る必要がある既存ファイルの一覧と、変更を最小にする差し込み方の案
```

調査メモを読んだら、手順4の設計と食い違う点がないか確認してから実装に進む。

## 手順4 設計

録音中は1秒ごとに直近の音声を軽いモデルで認識して途中経過を出し、録音停止後に全音声を large-v3-turbo で処理し直して最終結果にする。途中経過と最終結果を切り離すので、貼り付けられる文の精度は今と変わらない。

処理の流れ:

```text
[録音中:1秒ごとに途中経過を更新]
マイク音声 → 音声バッファ(認識対象は直近25〜30秒) → 発話あり?(VAD)
    なし → この回は飛ばす
    あり → 途中経過用モデルで認識(base / small など軽いモデル)
         → 一致部分を確定(連続2回で同じなら確定)
         → 録音画面に表示(確定+未確定は薄字)
         → 1秒後に次の回
    確定区間が25秒を超えたら、音声バッファから確定区間を削る

[録音停止後:録音全体で最終処理]
全音声を large-v3-turbo で再処理 → 整形・置換・AI整形(既存の処理をそのまま) → 貼り付け(最終結果)
```

途中経過のループは表示専用で、貼り付けられるのは録音停止後の最終処理の結果だけ。

設計の要点:

- 処理を重ねない:前の回の認識が終わっていなければ、その回は飛ばす
- 認識対象は直近25〜30秒:Whisperが一度に扱う長さが30秒のため。超えたら、確定済み区間の終わり(Whisperの区間の時刻)で音声バッファを切る
- 確定の決め方:連続した2回の結果で、先頭から一致した部分を確定する(whisper_streaming の LocalAgreement と同じ考え方)。確定部分は以後書き換えない
- 文脈をつなぐ:バッファを切った後は、確定済みの末尾をWhisperの初期プロンプトに渡して、切れ目の誤認識を減らす
- 無音対策:発話区間の検出(VAD)で発話がなければ認識しない
- 安全策:途中経過の処理でエラーが出ても、録音後の最終処理は従来どおり動かす

追加する設定項目(初期値は計測して見直す):

| 項目 | 初期値 | 説明 |
| --- | --- | --- |
| 途中経過を表示 | オン | Whisperを使うModeで、録音中に途中経過を出す |
| 途中経過用モデル | base | 軽さ優先。small や large-v3-turbo の量子化版も選べるようにする |
| 処理間隔 | 1秒 | 認識が間に合わない場合は延ばす |
| 認識対象の上限 | 25秒 | 超えたら確定済み区間を切る |
| 最終処理のモデル | Modeで選んだWhisper | 既存の設定をそのまま使う |

## 手順5 実装マイルストーン

小さく動くものから順に作り、各段階で `scripts/deploy-mbp.sh` でMacBook Proに配って口述で確かめてから次へ進む。各段階の終わりにコミットし、FORK-CHANGES.md を更新する。

1. M1 表示だけの試作:録音中に1秒ごと、録音開始からの音声全体を途中経過用モデルで認識し、結果をそのまま録音画面に出す。停止後は今までどおりの処理
2. M2 確定処理:連続2回で一致した先頭部分を確定とし、表示を「確定(通常の文字)+未確定(薄い文字)」に分ける
3. M3 窓の切り詰め:認識対象が25秒を超えたら、確定済みの区間を音声バッファから外す。長い口述でも処理時間が伸びないようにする
4. M4 無音対策:発話区間の検出(VAD)で無音のときは認識を飛ばし、Whisperが無音から文字を作る現象を防ぐ
5. M5 設定画面:途中経過用モデル、処理間隔、有効・無効をModeの設定に追加する
6. M6 仕上げ:計測ログの整理、エラー時に録音後の処理へ戻る安全策、FORK-CHANGES.md の最終化

M1でClaude Codeに渡す依頼文:

```text
docs/whisper-streaming-investigation.md の調査結果をもとに、Whisperの疑似リアルタイム処理の最初の試作(M1)を実装してください。

- 新しい処理は新しいファイル(例:WhisperStreamingTranscriptionService.swift)にまとめ、既存ファイルへの変更は差し込みに必要な最小限にする
- 録音中は1秒ごとに、それまでの音声を途中経過用モデルで認識し、結果を既存の途中経過表示に渡す
- 前の認識が終わっていなければ、その回は飛ばす(処理を重ねない)
- 言語は日本語固定、途中経過用モデルはまず固定値でよい
- 録音停止後は既存のWhisperの処理をそのまま使う
- 1回の認識にかかった時間と音声の長さを os_log に出す
- 変更したファイルと理由を FORK-CHANGES.md に追記する
```

M2以降も同じ形で、「前の段階までの動作を壊さないこと」を毎回依頼文に入れる。自作の claude-release-workflow をこのリポジトリにも適用するなら、各マイルストーンを1つの作業単位にする。

## 手順6 テストと計測

各マイルストーンの後に、MacBook Pro(M1 Pro)で次のケースを口述して確かめる。合格基準はたたき台で、最初の計測結果を見て見直す。

| ケース | 話す内容 | 合格基準(案) |
| --- | --- | --- |
| 短い発話 | 5秒程度の一文 | 話し始めて2秒以内に文字が出る |
| 長い口述 | 60秒以上話し続ける | 1回の認識時間が処理間隔(1秒)を超え続けない |
| 英語混じり | 「Claude CodeでGitHubのPRを確認」など | 最終結果が録音後処理と同等の表記になる |
| 無音 | 10秒黙る | 文字が出ない |
| 言い直し | 途中で言い直す | 確定部分が書き換わらない |
| 途中で中止 | Escで録音をやめる | 処理が残らず、次の録音がすぐ始められる |

計測するもの:

- 1回の認識時間と、そのときの音声の長さ(os_log から取る)
- 話し始めてから最初の文字が出るまでの時間
- 録音停止から貼り付けまでの時間(今のWhisperと比べて遅くなっていないか)
- 録音中のCPUとGPUの使用率(アクティビティモニタ)

ログは手順2-2のコマンドでMac miniから回収する。サブシステム名は本家と同じ想定(違う場合は調査メモの値に合わせる)。

## 手順7 本家の更新取り込みとライセンス

本家は更新が活発なので、月に1回程度、main を本家に合わせてから作業ブランチを乗せ替える。

```bash
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch feature/whisper-streaming && git rebase main
scripts/deploy-mbp.sh   # 動作確認
```

- 衝突したら FORK-CHANGES.md を見ながら解消する。Claude Codeに「FORK-CHANGES.md の意図を保って衝突を解消して」と頼むのが早い
- 本家側でWhisperのリアルタイム対応やNemotronの修正が入ったら、自分の改造を続けるか見直す
- 本家は現在プルリクエストを受け付けていないので、改造は自分のフォークで完結させる

ライセンスはGPLv3。自分で使うだけなら義務は生じない。ビルドしたアプリを他人に配るときや、動画で配布するときは、ソースコードをGPLv3で公開し、元のVoiceInkの著作権表示を残す。気に入って普段使いにするなら、本家のライセンス購入で開発を支える。

## 確認事項

決定済み:

- フォークは公開でよい(通常の gh repo fork を使う)
- フォーク先は個人のGitHubアカウント
- 開発はMac mini、動作確認はMacBook Pro。MacBook Proの普段使いのVoiceInkは当面フォーク版で置き換える。複雑な開発が出てきたら別アプリに分ける

未決(手順3の調査メモを見て決める):

- [ ] 途中経過用モデル:base / small / large-v3-turbo(量子化版)のどれから試すか
- [ ] 処理間隔1秒、認識対象の上限25〜30秒という初期値でよいか
- [ ] 録音停止後の最終処理を large-v3-turbo でやり直すか、確定済みの途中経過をそのまま使うか
- [ ] 無音対策は whisper.cpp 内蔵のVADを使うか、音量のしきい値で簡易的に済ませるか
- [ ] 手順6の合格基準の数字(2秒、1秒)でよいか
- [ ] claude-release-workflow をこのリポジトリにも適用するか
