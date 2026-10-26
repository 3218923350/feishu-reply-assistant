#!/usr/bin/env python3
"""给 messages.jsonl 里「我在群里说过话」的每个 群×天，补拉当天整群消息作上下文，写 context.jsonl。用法: collect_context.py DIR"""
import json, subprocess, sys, datetime as dt
from pathlib import Path
import fra_config

cfg = fra_config.load_or_exit()
ME = cfg['open_id']
DRAFT_CHAT = cfg['draft_chat_id']
LARK = fra_config.bin_path('lark-cli')
d = Path(sys.argv[1])
ms = [json.loads(l) for l in open(d / 'messages.jsonl')]
days = sorted({(m['chat_id'], m['create_time'][:10]) for m in ms
               if m['chat_type'] != 'p2p' and (m.get('sender') or {}).get('id') == ME and m['chat_id'] != DRAFT_CHAT})
seen = {m['message_id'] for m in ms}
with open(d / 'context.jsonl', 'w') as f:
    for i, (chat, day) in enumerate(days):
        nxt = (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()
        r = subprocess.run([LARK, 'im', '+chat-messages-list', '--as', 'user', '--chat-id', chat, '--start', f'{day}T00:00:00+08:00',
                            '--end', f'{nxt}T00:00:00+08:00', '--order', 'asc', '--page-size', '50', '--page-all', '--page-limit', '6',
                            '--no-reactions'], capture_output=True, text=True, timeout=300)
        try: got = json.loads(r.stdout)['data'].get('messages') or []
        except Exception: print('FAIL', chat, day, (r.stderr or r.stdout)[:200], flush=True); continue
        new = [m for m in got if m['message_id'] not in seen]
        for m in new:
            seen.add(m['message_id']); f.write(json.dumps({**m, 'chat_id': chat, 'tags': ['ctx']}, ensure_ascii=False) + '\n')
        print(i + 1, len(days), chat, day, len(got), 'new', len(new), flush=True)
