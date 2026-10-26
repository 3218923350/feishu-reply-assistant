#!/bin/bash
# 按类型分组合并 DIR/candidates.jsonl → DIR/consolidated/<group>.json（并发）。用法: consolidate.sh DIR
set -u
DIR=$1; HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p "$DIR/consolidated"
python3 - "$DIR" <<'PY'
import json, sys
from pathlib import Path
d = Path(sys.argv[1]); groups = {'person': ['person'], 'policy': ['decision', 'faq'], 'recipe': ['procedure'], 'fact': ['fact'], 'open': ['commitment'], 'style': ['style']}
ms = [json.loads(l) for l in open(d / 'candidates.jsonl')]
for g, types in groups.items():
    xs = [m for m in ms if m['type'] in types]
    (d / 'consolidated' / f'{g}.in.jsonl').write_text(''.join(json.dumps({k: m[k] for k in ('type', 'title', 'content', 'people', 'projects', 'evidence', 'valid_from', 'volatility', 'confidence', 'batch')}, ensure_ascii=False) + '\n' for m in xs))
    print(g, len(xs))
PY
PROMPT=$(python3 "$HERE/fra_config.py" fill "$HERE/consolidate_prompt.md") || exit 1
[ -n "$PROMPT" ] || { echo "合并提示词是空的" >&2; exit 1; }
one() {
  g=$1; out="$DIR/consolidated/$g.json"; [ -s "$out" ] && return
  "${CLAUDE_BIN:-claude}" -p "下面是同一类型（${g}）的记忆候选，按系统提示整理。

$(cat "$DIR/consolidated/$g.in.jsonl")" --model sonnet --output-format json --json-schema "$(cat "$HERE/consolidate_schema.json")" \
    --append-system-prompt "$PROMPT" --tools "" > "$out.tmp" 2> "$out.err" \
    && mv "$out.tmp" "$out" && echo "done $g" || echo "FAIL $g"
}
export -f one; export DIR HERE PROMPT
printf '%s\n' person policy recipe fact open style | xargs -P 6 -I{} bash -c 'one {}'
