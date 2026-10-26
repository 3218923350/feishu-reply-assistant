#!/usr/bin/env python3
"""助手草稿 vs 我实际怎么回的（卡片被我在原会话亲自回掉）、助手替我发出又被我撤回的 → DIR/batches/zz-signals.md，交给每日抽取校正口吻和口径。用法: collect_signals.py DIR DAY"""
import datetime as dt, json, subprocess, sys
from pathlib import Path
import fra_config

SENT = ('sent', 'fr-sent')

def of_day(events, day):
    """事件时间是 UTC，按北京时间的日期筛"""
    bj = lambda ts: (dt.datetime.fromisoformat(ts.replace('Z', '+00:00')) + dt.timedelta(hours=8)).date().isoformat()
    return [e for e in events if e.get('ts') and bj(e['ts']) == day]

def render(events, recalled, name):
    parts = []
    for e in events:
        o = e.get('orig') or {}
        if e.get('kind') == 'manual-reply':
            parts.append(f"### {o.get('sender_name', '?')}（{o.get('chat_name') or '私聊'}）\n原消息：{o.get('content', '')[:500]}\n助手草稿：{e.get('draft') or '（没有草稿）'}\n{name}实际回的：{' ⏎ '.join(e.get('actual') or [])}")
        elif e.get('kind') in SENT and e.get('message_id') in recalled:
            parts.append(f"### {name}撤回了助手替他发给{e.get('toName') or o.get('sender_name', '?')}的这条\n{e.get('text', '')}")
    if not parts: return ''
    return f'## 【助手草稿 vs {name}实际回复】（{name}本人的反馈：他改写或撤回说明草稿哪里不对）\n\n' + '\n\n'.join(parts) + '\n'

def recalled_ids(ids, lark):
    out = set()
    for i in range(0, len(ids), 50):
        r = subprocess.run([lark, 'im', '+messages-mget', '--as', 'user', '--message-ids', ','.join(ids[i:i + 50]), '--no-reactions'], capture_output=True, text=True, timeout=120)
        try: out |= {m['message_id'] for m in json.loads(r.stdout)['data'].get('messages') or [] if m.get('deleted')}
        except Exception: print('查撤回失败：', (r.stderr or r.stdout)[:200])
    return out

def main(d, day):
    cfg = fra_config.load_or_exit()
    f = Path(cfg['home']) / 'events' / f'{day[:7]}.jsonl'
    events = of_day(fra_config.read_jsonl(f), day)
    md = render(events, recalled_ids([e['message_id'] for e in events if e.get('kind') in SENT and e.get('message_id')], fra_config.bin_path('lark-cli')), cfg['name'])
    if md:
        (d / 'batches').mkdir(exist_ok=True); (d / 'batches' / 'zz-signals.md').write_text(md)
    print('草稿 vs 实发', sum(e.get('kind') == 'manual-reply' for e in events), '条，有内容' if md else '，没有')

if __name__ == '__main__':
    main(Path(sys.argv[1]), sys.argv[2])
