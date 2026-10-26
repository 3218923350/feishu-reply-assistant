#!/usr/bin/env python3
"""未结事项（open/overdue）对照昨天的聊天：能明确看出已经办完的标 done。用法: close_open.py DIR DAY"""
import json, re, subprocess, sys
from pathlib import Path
import fra_config

MEM = str(Path(__file__).resolve().parent.parent / 'bin' / 'mem')
SCHEMA = json.dumps({'type': 'object', 'properties': {'resolved': {'type': 'array', 'items': {'type': 'object', 'properties': {
    'path': {'type': 'string'}, 'evidence': {'type': 'string'}, 'source': {'type': 'string'}}, 'required': ['path', 'evidence', 'source']}}}, 'required': ['resolved']})

def meta(p):
    m = re.match(r'---\n(.*?)\n---\n?(.*)', p.read_text(), re.S)
    out = {}
    for line in (m.group(1).split('\n') if m else []):
        k, _, v = line.partition(': ')
        out[k] = json.loads(v) if v[:1] in '["' else v
    return out, (m.group(2) if m else '')

def open_items(wy):
    items = []
    for p in sorted((wy / 'open').glob('*.md')):
        m, body = meta(p)
        if m.get('status') in ('open', 'overdue'):
            items.append({'path': str(p), 'title': m.get('title', p.stem), 'tail': '\n'.join(body.strip().split('\n')[-3:])})
    return items

def to_memories(resolved, items, day):
    """只认清单里的事项；结案 = 对原条目追加一行并标 done"""
    known = {i['path']: i for i in items}
    return [{'type': 'open', 'title': known[r['path']]['title'], 'entities': [], 'scope': '', 'content': f"{day} 已办完：{r['evidence']}",
             'sources': [r['source']] if r.get('source') else [f'每日增量#{day}'], 'observed': day, 'confidence': 'medium', 'review': 'auto',
             'status': 'done', 'target': r['path']} for r in resolved if r.get('path') in known]

def main(d, day):
    cfg = fra_config.load_or_exit()
    items = open_items(Path(cfg['memory_dir']))
    chat = '\n\n'.join(p.read_text() for p in sorted((d / 'batches').glob('*.md')))[:150_000] if (d / 'batches').exists() else ''
    if not items or not chat.strip():
        print('没有未结事项或没有聊天，跳过'); return
    listing = '\n'.join(f"- path: {i['path']}\n  事项：{i['title']}\n  最近：{i['tail']}" for i in items)
    prompt = f"""下面是{cfg['name']}记忆库里还没结的事项，和 {day} 一天的飞书聊天。挑出聊天里**能明确看出已经办完**（做完了、对方说收到/不用了、已被别的方案替代）的事项；拿不准的不要挑。
evidence 一句话写清怎么办完的（谁、什么时候、怎么说的），source 写「会话名#message_id」（聊天里括号中的完整 id）。

## 未结事项
{listing}

## {day} 的聊天
{chat}"""
    r = subprocess.run([fra_config.bin_path('claude'), '-p', prompt, '--model', 'sonnet', '--tools', '', '--output-format', 'json', '--json-schema', SCHEMA],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=1800)
    try: j = json.loads(r.stdout)
    except json.JSONDecodeError: raise RuntimeError(f'claude 输出不是 JSON（exit {r.returncode}）：{r.stdout[:200]}')
    if r.returncode != 0 or j.get('is_error') or not isinstance((j.get('structured_output') or {}).get('resolved'), list):
        raise RuntimeError(f'claude 出错（exit {r.returncode}）：{str(j.get("result"))[:200]}')
    fra_config.record_cost(cfg, 'daily-close', j.get('total_cost_usd'))
    mems = to_memories(j['structured_output']['resolved'], items, day)
    print(f'未结 {len(items)} 条 → 办完 {len(mems)} 条，cost ${j.get("total_cost_usd", 0):.2f}')
    if mems:
        (d / 'closed.json').write_text(json.dumps(mems, ensure_ascii=False, indent=1))
        subprocess.run([MEM, 'add', str(d / 'closed.json'), '--message', f'每日结案 {day}'], check=True)

if __name__ == '__main__':
    main(Path(sys.argv[1]), sys.argv[2])
