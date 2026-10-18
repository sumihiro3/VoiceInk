#!/bin/bash
# MacBook Pro へフォーク版 VoiceInk を配布する。
# make local の成果物(.local-build/Build/Products/Release/VoiceInk.app)を直接配る。
# ~/Downloads は使わない(古いビルドを配る事故を防ぐため)。
# 配る前に、バイナリがこの実行中に作り直されたこと(更新時刻 >= 開始時刻)を確かめ、
# 配ったあとに、手元と MacBook Pro のバイナリの SHA-256 が一致することを確かめる。
# 環境変数: MBP_HOST(既定 mbp) / DEPLOY_ALLOW_ADHOC=1(ad-hoc 署名でも続行)
set -euo pipefail

START_EPOCH=$(date +%s)

cd "$(dirname "$0")/.."

MBP_HOST="${MBP_HOST:-mbp}"
APP="$PWD/.local-build/Build/Products/Release/VoiceInk.app"
BIN="$APP/Contents/MacOS/VoiceInk"
DEST=/Applications/VoiceInk.app

# ビルドに時間をかける前に、配布先へ届くかを確かめる
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$MBP_HOST" true; then
  echo "error: $MBP_HOST に SSH 接続できません。~/.ssh/config の Host 設定と鍵(docs/fork-plan.md 手順2-2)を確認してください。" >&2
  exit 1
fi

make local

# make local が成功しても、成果物が古いままなら配らない
if [ ! -f "$BIN" ]; then
  echo "error: ビルド成果物が見つかりません: $BIN" >&2
  exit 1
fi
BIN_MTIME=$(stat -f %m "$BIN")
if [ "$BIN_MTIME" -lt "$START_EPOCH" ]; then
  echo "error: $BIN がこの実行中に更新されていません(古いビルドの可能性)。配布を中止します。" >&2
  exit 1
fi

# codesign は stderr に出力する。pipefail + grep -q の SIGPIPE を避けるため変数に取る
SIGN_INFO=$(codesign -dv --verbose=2 "$APP" 2>&1 || true)
if ! grep -q "Authority=Apple Development" <<<"$SIGN_INFO"; then
  if [ "${DEPLOY_ALLOW_ADHOC:-0}" = "1" ]; then
    echo "warning: Apple Development 署名ではありません(DEPLOY_ALLOW_ADHOC=1 のため続行)。" >&2
  else
    echo "error: ad-hoc 署名では MacBook Pro 側のマイクとアクセシビリティの許可が外れます。Apple Development 署名でビルドしてください。" >&2
    exit 1
  fi
fi

ssh "$MBP_HOST" "osascript -e 'quit app \"VoiceInk\"'" || true
sleep 2

rsync -a --delete "$APP/" "$MBP_HOST:$DEST/"

LOCAL_HASH=$(shasum -a 256 "$BIN" | awk '{print $1}')
REMOTE_HASH=$(ssh "$MBP_HOST" shasum -a 256 "$DEST/Contents/MacOS/VoiceInk" | awk '{print $1}')
if [ -z "$REMOTE_HASH" ] || [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "error: 配布後のバイナリのハッシュが一致しません(local=$LOCAL_HASH remote=${REMOTE_HASH:-none})。" >&2
  exit 1
fi

ssh "$MBP_HOST" open "$DEST"

echo "deployed $(git rev-parse --short HEAD) to $MBP_HOST"
