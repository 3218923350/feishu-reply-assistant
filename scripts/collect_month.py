#!/usr/bin/env python3
"""拉一段时间内「我发的 / @我的 / 私聊我的」飞书消息，去重后写 messages.jsonl。用法: collect_month.py START END OUTDIR"""
import json, subprocess, sys, datetime as dt
from pathlib import Path
import fra_config

cfg = fra_config.load_or_exit()
ME = cfg['open_id']
LARK = fra_config.bin_path('lark-cli')
start, end, out = dt.date.fromisoformat(sys.argv[1]), dt.date.fromisoformat(sys.argv[2]), Path(sys.argv[3])
QUERIES = {'mine': ['--sender', ME], 'at_me': ['--is-at-me'], 'p2p': ['--chat-type', 'p2p', '--exclude-sender-type', 'bot']}

def search(a, b, extra):
    args = [LARK, 'im', '+messages-search', '--as', 'user', '--query', '', '--start', f'{a}T00:00:00+08:00', '--end', f'{b}T00:00:00+08:00',
            '--page-size', '50', '--page-all', '--page-limit', '40', '--no-reactions', *extra]
    r = subprocess.run(args, capture_output=True, text=True, timeout=900)
    try: d = json.loads(r.stdout)
    except json.JSONDecodeError: raise SystemExit(f'lark-cli 非 JSON: {(r.stderr or r.stdout)[:300]}')
    if not d.get('ok'): raise SystemExit(f'lark-cli 失败: {d.get("error")}')
    return d['data'].get('messages') or [], d['data'].get('has_more')

msgs = {}
day = start
while day < end:  # 按天切，单次搜索最多 40 页
    nxt = day + dt.timedelta(days=1)
    for tag, extra in QUERIES.items():
        got, more = search(day, nxt, extra)
        for m in got:
            msgs.setdefault(m['message_id'], {**m, 'tags': []})['tags'].append(tag)
        print(day, tag, len(got), 'TRUNCATED' if more else '', flush=True)
    day = nxt

with open(out / 'messages.jsonl', 'w') as f:
    for m in sorted(msgs.values(), key=lambda m: m.get('create_time', '')):
        f.write(json.dumps(m, ensure_ascii=False) + '\n')
print('total', len(msgs))
