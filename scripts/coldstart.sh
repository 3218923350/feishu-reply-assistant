#!/bin/bash
# 冷启动：从最近 DAYS 天的飞书（我发的 / @我 / 私聊 + 群上下文）抽记忆入库。先拉消息、整理成批次（不花钱），报一下批次数再问要不要继续。
# 用法: coldstart.sh [DAYS=30]；YES=1 不问直接跑
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DAYS=${1:-30}
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "用法：coldstart.sh [天数，默认 30]"; exit 2; }
FRA_HOME=${FRA_HOME:-$HOME/.feishu-reply-assistant}; export FRA_HOME
TODAY=$(date +%F)
START=$(date -v-"${DAYS}"d +%F)
OUT="$FRA_HOME/corpus/coldstart-$TODAY"
mkdir -p "$OUT"
echo "== 冷启动 $START ~ $TODAY → $OUT"
python3 "$HERE/collect_month.py" "$START" "$(date -v+1d +%F)" "$OUT"
if [ ! -s "$OUT/messages.jsonl" ]; then echo "这段时间没有消息，跳过冷启动"; exit 0; fi
python3 "$HERE/collect_context.py" "$OUT"
python3 "$HERE/build_transcripts.py" "$OUT" 40000
N=$(find "$OUT/batches" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')  # 没有批次时 ls 会失败，pipefail 下整个脚本就退了
if [ "$N" = 0 ]; then echo "没有可用的聊天记录（可能都在草稿群里），跳过冷启动"; exit 0; fi
echo "共 $N 批聊天，每批调用一次 Claude（sonnet）抽记忆，再按类型合并（6 次）。"
if [ "${YES:-}" != 1 ]; then  # 只有 YES=1 才不问（YES=0 / no 都还是要问）
  read -r -p "继续？[y/N] " ans || ans=""  # 从标准输入读：setup 里是继承的终端；不是终端（比如重定向自 /dev/null）就当没同意
  case "$ans" in y|Y|yes) ;; *) echo "没继续。消息和批次留在 ${OUT}，之后 YES=1 重跑会接着用"; exit 0 ;; esac
fi
"$HERE/extract_memories.sh" "$OUT"
python3 "$HERE/aggregate_candidates.py" "$OUT" coldstart-extract
"$HERE/consolidate.sh" "$OUT"
python3 "$HERE/import_coldstart.py" "$OUT"
"$HERE/../bin/mem" add "$OUT/coldstart.jsonl" --message "冷启动 $START ~ $TODAY"
echo "== 冷启动完成：mem review 看待确认的条目"
