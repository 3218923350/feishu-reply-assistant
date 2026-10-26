#!/bin/bash
# 对 DIR/batches/*.md 逐批抽取记忆候选 → DIR/candidates/NN.json（并发 6，已有结果跳过）。用法: extract_memories.sh DIR
set -u
DIR=$1; HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p "$DIR/candidates"
PROMPT=$(python3 "$HERE/fra_config.py" fill "$HERE/extract_prompt.md") || exit 1  # 没配好就别拿空的系统提示词去跑（照样花钱）
[ -n "$PROMPT" ] || { echo "抽取提示词是空的" >&2; exit 1; }
one() {
  b=$1; out="$DIR/candidates/$(basename "$b" .md).json"; [ -s "$out" ] && return
  "${CLAUDE_BIN:-claude}" -p "下面是一批飞书聊天记录，按系统提示抽取记忆。

$(cat "$b")" --model sonnet --output-format json --json-schema "$(cat "$HERE/extract_schema.json")" \
    --append-system-prompt "$PROMPT" --tools "" > "$out.tmp" 2> "$out.err" \
    && mv "$out.tmp" "$out" && echo "done $(basename "$b")" || echo "FAIL $(basename "$b")"
}
export -f one; export DIR HERE PROMPT
ls "$DIR"/batches/*.md | xargs -P 6 -I{} bash -c 'one {}'
# 有批次没抽出结果就算失败，不能当成「没有新记忆」
missing=$(for b in "$DIR"/batches/*.md; do [ -s "$DIR/candidates/$(basename "$b" .md).json" ] || echo "$(basename "$b")"; done)
if [ -n "$missing" ]; then echo "抽取失败的批次：$missing" >&2; exit 1; fi
