#!/bin/bash
# 每日复盘：统计昨天每条消息怎么了结的（daily_review.py）→ Claude 按 review_prompt.md 归因、给出明天改什么 → 草稿群发一条。
# 用法: daily_review.sh [YYYY-MM-DD] [实例目录 ...]（默认昨天、${FRA_HOME}）；NO_SEND=1 只写文件不发；REVIEW_OUT 改输出目录
set -u
HERE=$(cd "$(dirname "$0")" && pwd); export PYTHONPATH="$HERE"
DAY=${1:-$(date -v-1d +%F)}; shift $(( $# > 0 ? 1 : 0 ))
HOME_DIR=$(python3 -c 'import fra_config; print(fra_config.fra_home())' 2>/dev/null || echo "$HOME/.feishu-reply-assistant")
OUT=${REVIEW_OUT:-$HOME_DIR/corpus/daily/$DAY}; mkdir -p "$OUT"
python3 "$HERE/daily_review.py" "$DAY" "$@" > "$OUT/review-data.md" || exit 1
PROMPT=$(python3 "$HERE/fra_config.py" fill "$HERE/review_prompt.md") || exit 1
"${CLAUDE_BIN:-${FRA_CLAUDE:-claude}}" -p "下面是 $DAY 的统计和逐条对照，按系统提示复盘。

$(cat "$OUT/review-data.md")" --output-format json \
  --append-system-prompt "$PROMPT" --tools "" > "$OUT/review.json" 2> "$OUT/review.err" || { echo "复盘失败：$(tail -c 300 "$OUT/review.err")" >&2; exit 1; }
python3 - "$OUT" "$DAY" <<'EOF'
import json, os, subprocess, sys
from pathlib import Path
import fra_config
out, day = Path(sys.argv[1]), sys.argv[2]
md = json.loads((out / 'review.json').read_text()).get('result', '').strip()
if not md: sys.exit('复盘没有输出')
(out / 'review.md').write_text(md)
print(md)
if os.environ.get('NO_SEND'): sys.exit(0)
cfg = fra_config.load_or_exit()
r = subprocess.run([fra_config.bin_path('lark-cli'), 'im', '+messages-send', '--as', 'bot', '--chat-id', cfg['draft_chat_id'], '--markdown', f'**{day} 复盘**\n\n{md}'],
                   env=fra_config.bot_env(cfg), capture_output=True, text=True)
print('发送 ok' if r.returncode == 0 else f'发送失败 {r.stdout[:200]}{r.stderr[:200]}')
EOF
