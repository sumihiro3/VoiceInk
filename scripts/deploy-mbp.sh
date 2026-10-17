#!/bin/bash
# MacBook Pro へフォーク版 VoiceInk を配布する。
# 環境変数: MBP_HOST(既定 mbp) / DEPLOY_ALLOW_ADHOC=1(ad-hoc 署名でも続行)
set -euo pipefail

cd "$(dirname "$0")/.."

MBP_HOST="${MBP_HOST:-mbp}"
APP="$HOME/Downloads/VoiceInk.app"
DEST=/Applications/VoiceInk.app

# ビルドに時間をかける前に、配布先へ届くかを確かめる
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$MBP_HOST" true; then
  echo "error: $MBP_HOST に SSH 接続できません。~/.ssh/config の Host 設定と鍵(docs/fork-plan.md 手順2-2)を確認してください。" >&2
  exit 1
fi

make local

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
ssh "$MBP_HOST" open "$DEST"

echo "deployed $(git rev-parse --short HEAD) to $MBP_HOST"
