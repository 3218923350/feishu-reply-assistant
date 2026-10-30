#!/usr/bin/env python3
"""助手草稿 vs 我实际怎么回的（卡片被我在原会话亲自回掉）、助手替我发出又被我撤回的 → DIR/batches/zz-signals.md，交给每日抽取校正口吻和口径。
有草稿的每条带 #编号，抽取时顺带归一类（为什么没用助手的稿），编号对应哪张卡写在 DIR/signals.json，日报据此出「你自己回掉的卡」。用法: collect_signals.py DIR DAY"""
import datetime as dt, json, subprocess, sys
from pathlib import Path
import fra_config

SENT = ('sent', 'fr-sent')

def of_day(events, day):
    """事件时间是 UTC，按北京时间的日期筛"""
    bj = lambda ts: (dt.datetime.fromisoformat(ts.replace('Z', '+00:00')) + dt.timedelta(hours=8)).date().isoformat()
    return [e for e in events if e.get('ts') and bj(e['ts']) == day]

def render(events, recalled, name):
    """→ (md, 要归类的条目)。actual 为空的（他回的是同一个人后来那张卡）不算：配不上"""
    parts, items = [], []
    for e in events:
        o = e.get('orig') or {}
        if e.get('kind') == 'manual-reply' and e.get('actual'):
            # skipped：助手判了「不用回」（没出卡），{name}却回了。也要归类：多半是判错了
            draft, skipped = e.get('draft') or '', e.get('skipped')
            ask = bool(draft) or skipped is not None
            if ask: items.append({'n': len(items) + 1, 'card': e.get('card'), 'sender': o.get('sender_name', '?'), 'chat': o.get('chat_name') or '私聊', 'draft': draft or f'（判了不用回：{skipped}）', 'actual': e['actual'], **({'skipped': True} if skipped is not None else {})})
            got = f'（判了不用回，没出卡：{skipped}）' if skipped is not None else draft or '（没有草稿）'
            parts.append(f"### {f'#{len(items)} ' if ask else ''}{o.get('sender_name', '?')}（{o.get('chat_name') or '私聊'}）\n原消息：{o.get('content', '')[:500]}\n助手草稿：{got}\n{name}实际回的：{' ⏎ '.join(e['actual'])}")
        elif e.get('kind') in SENT and e.get('message_id') in recalled:
            parts.append(f"### {name}撤回了助手替他发给{e.get('toName') or o.get('sender_name', '?')}的这条\n{e.get('text', '')}")
    if not parts: return '', items
    return (f'## 【助手草稿 vs {name}实际回复】（{name}本人的反馈：他改写或撤回说明草稿哪里不对）\n'
            + (f'带 #编号 的每条都在 reviews 里归一类。\n' if items else '') + '\n' + '\n\n'.join(parts) + '\n'), items

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
    md, items = render(events, recalled_ids([e['message_id'] for e in events if e.get('kind') in SENT and e.get('message_id')], fra_config.bin_path('lark-cli')), cfg['name'])
    if md:
        (d / 'batches').mkdir(exist_ok=True); (d / 'batches' / 'zz-signals.md').write_text(md)
    mr = [e for e in events if e.get('kind') == 'manual-reply']
    (d / 'signals.json').write_text(json.dumps({'day': day, 'items': items, 'no_draft': sum(bool(e.get('actual')) and not e.get('draft') and e.get('skipped') is None for e in mr),
                                                'unpaired': sum(not e.get('actual') for e in mr)}, ensure_ascii=False, indent=1))
    print('草稿 vs 实发', len(mr), '条，有内容' if md else '，没有')

if __name__ == '__main__':
    main(Path(sys.argv[1]), sys.argv[2])
