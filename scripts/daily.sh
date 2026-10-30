#!/bin/bash
# 每日增量：前一天的飞书（我发的 / @我 / 私聊 + 群上下文）+ 助手草稿 vs 我实际怎么回的 → 抽记忆 → 和已有记忆合并入库 → 结掉已办完的事项 → 草稿群发摘要卡 → 复盘卡。launchd 每天 06:30 跑。
# 用法: daily.sh [YYYY-MM-DD]（默认昨天）；同一天只入库一次，要重跑：FORCE=1 daily.sh DAY
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
DAY=${1:-$(date -v-1d +%F)}
NEXT=$(date -j -v+1d -f %F "$DAY" +%F)
FRA_HOME=${FRA_HOME:-$HOME/.feishu-reply-assistant}; export FRA_HOME
CLAUDE_BIN=${CLAUDE_BIN:-${FRA_CLAUDE:-claude}}; export CLAUDE_BIN  # 换模型（比如 FRA_CLAUDE 指向带 --settings 的包装脚本）时抽记忆也跟着换
OUT="$FRA_HOME/corpus/daily/$DAY"
mkdir -p "$OUT"
echo "== $(date '+%F %T') 每日增量 $DAY"
# 同一天跑两遍会把同样的事实行重复追加进记忆（还可能互相矛盾）：入库成功后记个标记
if [ -f "$OUT/.done" ] && [ -z "${FORCE:-}" ]; then echo "$DAY 已经处理过（$OUT/.done），跳过；要重跑用 FORCE=1"; exit 0; fi
status="ok"
# 每一步：名字 + 参数，参数都加引号（仓库路径可能带空格，比如放在 ~/Library/Application Support 下）
steps=(
  "collect_month.py|$DAY|$NEXT|$OUT" "collect_context.py|$OUT" "build_transcripts.py|$OUT|40000" "collect_signals.py|$OUT|$DAY"
  "extract_memories.sh|$OUT" "daily_merge.py|$OUT|$DAY" "close_open.py|$OUT|$DAY"
)
for step in "${steps[@]}"; do
  IFS='|' read -r -a a <<< "$step"
  name=${a[0]}; args=("${a[@]:1}")
  echo "-- $name ${args[*]}"
  case "$name" in *.py) cmd=(python3 "$HERE/$name") ;; *) cmd=("$HERE/$name") ;; esac
  if ! "${cmd[@]}" "${args[@]}"; then status="失败：$name"; break; fi
  [ "$name" = daily_merge.py ] && touch "$OUT/.done"  # 入库成功就记下，之后的步骤失败也不再重复入库
done
# 起草工作区里下载的截图、账单、附件：留 7 天
find "$HERE/../workspace" -mindepth 1 -maxdepth 1 ! -name CLAUDE.md ! -name .gitignore -mtime +7 -exec rm -rf {} + 2>/dev/null
python3 "$HERE/digest.py" "$DAY" "$status"
# 复盘：昨天每条消息怎么了结的、没走助手的原因、明天改什么（失败不影响记忆日报）
"$HERE/daily_review.sh" "$DAY" || echo "复盘没跑成"

