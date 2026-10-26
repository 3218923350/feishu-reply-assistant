#!/usr/bin/env python3
"""messages.jsonl + context.jsonl → 按会话整理的对话文本，切成若干批次 batches/NN.md（每批 ≤ MAX 字）。用法: build_transcripts.py DIR [MAX]"""
import json, sys, collections
from pathlib import Path
import fra_config

cfg = fra_config.load_or_exit()
ME = cfg['open_id']
DRAFT_CHAT = cfg['draft_chat_id']
d = Path(sys.argv[1]); MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 40000
ms = [json.loads(l) for f in ('messages.jsonl', 'context.jsonl') if (d / f).exists() for l in open(d / f)]
chats = collections.defaultdict(list)
for m in ms:
    if m['chat_id'] == DRAFT_CHAT or m.get('msg_type') in ('system', 'sticker'): continue
    chats[m['chat_id']].append(m)

def title(cid, xs):
    name = next((m.get('chat_name') for m in xs if m.get('chat_name')), None)
    if name: return f'群「{name}」'
    others = sorted({(m.get('sender') or {}).get('name') for m in xs if (m.get('sender') or {}).get('id') != ME} - {None})
    return f'私聊 {"、".join(others)}' if others else '私聊（只有我自己的消息）'

blocks = []
for cid, xs in chats.items():
    xs = sorted({m['message_id']: m for m in xs}.values(), key=lambda m: m.get('create_time', ''))
    if not any((m.get('sender') or {}).get('id') == ME or set(m.get('tags', [])) & {'at_me', 'p2p'} for m in xs): continue
    lines = [f'## {title(cid, xs)}  chat_id={cid}']
    # 参与者的 open_id：人物卡按 open_id 认人（同名不同人、飞书显示名和卡上名字对不上）
    people = {(m.get('sender') or {}).get('name'): (m.get('sender') or {}).get('id') for m in xs
              if (m.get('sender') or {}).get('sender_type', 'user') == 'user' and str((m.get('sender') or {}).get('id', '')).startswith('ou_') and (m.get('sender') or {}).get('id') != ME}
    if people: lines.append('参与者：' + '、'.join(f'{n}={i}' for n, i in people.items() if n))
    for m in xs:
        s = m.get('sender') or {}
        who = f"{cfg['name']}(我)" if s.get('id') == ME else (s.get('name') or s.get('id') or '?')
        if s.get('sender_type') == 'app': who += '[bot]'
        body = (m.get('content') or '').strip().replace('\n', ' ⏎ ')
        if len(body) > 1500: body = body[:1500] + '…(截断)'
        lines.append(f'[{m.get("create_time")}] {who} ({m["message_id"]}): {body}')
    blocks.append('\n'.join(lines))

out = d / 'batches'; out.mkdir(exist_ok=True)
for p in out.glob('*.md'): p.unlink()
batch, size, n = [], 0, 0
def flush():
    global batch, size, n
    if batch:
        n += 1; (out / f'{n:02d}.md').write_text('\n\n'.join(batch)); batch, size = [], 0
for b in sorted(blocks, key=len, reverse=True):
    while len(b) > MAX:  # 超长会话按行切开
        cut = b.rfind('\n', 0, MAX); head, b = b[:cut], b.split('\n', 1)[0] + '（续）\n' + b[cut + 1:]
        flush(); batch, size = [head], len(head); flush()
    if size + len(b) > MAX: flush()
    batch.append(b); size += len(b)
flush()
print('chats', len(blocks), 'batches', n, 'chars', sum(len(b) for b in blocks))
