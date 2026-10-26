#!/usr/bin/env python3
"""每日增量合并：DIR/candidates/*.json → 对照已有记忆（mem search）让 Claude 决定新建 / 追加(target) / 冲突(conflict_with) / 丢弃 → mem add。用法: daily_merge.py DIR DAY"""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEM = str(HERE.parent / 'bin' / 'mem')
import fra_config

def parse_claude(returncode, stdout):
    """claude -p 的结果 → memories；失败、报错、没有结构化输出都抛错（不能当成「没有新记忆」）"""
    try: j = json.loads(stdout)
    except json.JSONDecodeError: raise RuntimeError(f'claude 输出不是 JSON（exit {returncode}）：{stdout[:200]}')
    if returncode != 0 or j.get('is_error'): raise RuntimeError(f'claude 出错（exit {returncode}）：{str(j.get("result"))[:200]}')
    so = j.get('structured_output')
    if not isinstance(so, dict) or not isinstance(so.get('memories'), list): raise RuntimeError('claude 没有给出结构化的 memories')
    return so['memories']

def main(d, day):
    cfg = fra_config.load_or_exit()
    item = json.loads((HERE.parent / 'schema' / 'memory.json').read_text())
    subprocess.run([sys.executable, str(HERE / 'aggregate_candidates.py'), str(d), 'daily-extract'], check=True, stdout=subprocess.DEVNULL)
    cands = [json.loads(l) for l in open(d / 'candidates.jsonl')] if (d / 'candidates.jsonl').exists() else []
    if not cands:
        print('没有候选'); return
    lines = []
    for c in cands:
        r = subprocess.run([MEM, 'search', c['title'], '--json', '--limit', '3', '--scope', 'mine'], capture_output=True, text=True)
        related = [{k: h[k] for k in ('path', 'type', 'title', 'snippet')} for h in (json.loads(r.stdout) if r.returncode == 0 else [])]
        lines.append(json.dumps({'candidate': {k: c[k] for k in ('type', 'title', 'content', 'people', 'projects', 'evidence', 'valid_from', 'confidence')},
                                 'existing': related}, ensure_ascii=False))
    extra = f"""
这次输入是 {day} 一天的候选，类型混在一起，每行带 existing（记忆库里最相关的已有条目）。在上面规则之外：
- 和某条 existing 是同一件事、有新信息 → 输出该条，target 填那条的 path，content 只写新增的事实行；事项已办完就带 status=done；
- 和 existing 说法矛盾 → 输出新条目，conflict_with 填那条的 path；
- existing 已经覆盖、没有新信息 → 不输出；
- observed 用 {day}；sources 用候选 evidence 里的「会话#message_id」（完整 id），不要再加时间后缀；
- person 一人一条，entities 写 ["姓名", "ou_xxx"]（open_id 在候选 people 里）；existing 里是几个人合写的卡，就给这个人新建单人卡，不要往合写卡里追加。"""
    schema = json.dumps({'type': 'object', 'properties': {'memories': {'type': 'array', 'items': item}}, 'required': ['memories']})
    r = subprocess.run([fra_config.bin_path('claude'), '-p', '下面是记忆候选（JSON 行），按系统提示整理：\n\n' + '\n'.join(lines), '--model', 'sonnet', '--tools', '',
                        '--output-format', 'json', '--json-schema', schema,
                        '--append-system-prompt', fra_config.fill((HERE / 'consolidate_prompt.md').read_text(), cfg) + extra],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=1800)
    mems = parse_claude(r.returncode, r.stdout)
    fra_config.record_cost(cfg, 'daily-merge', json.loads(r.stdout).get('total_cost_usd'))
    (d / 'merged.json').write_text(json.dumps(mems, ensure_ascii=False, indent=1))
    print(f'候选 {len(cands)} → 入库 {len(mems)}，cost ${json.loads(r.stdout).get("total_cost_usd", 0):.2f}')
    if mems:
        subprocess.run([MEM, 'add', str(d / 'merged.json'), '--message', f'每日增量 {day}'], check=True)

if __name__ == '__main__':
    main(Path(sys.argv[1]), sys.argv[2])
