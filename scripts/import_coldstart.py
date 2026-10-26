#!/usr/bin/env python3
"""冷启动：DIR/consolidated/*.json → DIR/coldstart.jsonl（应用审阅决定），--dry 只看统计。用法: import_coldstart.py DIR [--dry]"""
import json, re, sys, collections, datetime as dt
from pathlib import Path
import fra_config

d = Path(sys.argv[1]); dry = '--dry' in sys.argv
cfg = fra_config.load_or_exit()
today = dt.date.today().isoformat()
def norm(s): return re.sub(r'[\s\W_]+', '', str(s)).lower()

items, dropped, cost = [], [], 0.0
for g in ('person', 'policy', 'recipe', 'fact', 'open', 'style'):
    j = json.loads((d / 'consolidated' / f'{g}.json').read_text()); cost += j.get('total_cost_usd') or 0
    for m in j['structured_output']['memories']:
        if m['type'] == 'fact' and '杂项' in m['title']: dropped.append(m['title']); continue  # 大杂烩，检索价值低
        if m['type'] == 'person': m['review'] = 'auto'  # 人物卡不属于必须确认的四类
        dates = re.findall(r'\d{4}-\d{2}-\d{2}', m.get('observed') or '')
        m['observed'] = dates[-1] if dates else today
        items.append(m)

print('总数', len(items), '按类型', dict(collections.Counter(m['type'] for m in items)))
print('待确认', sum(m['review'] == 'pending' for m in items), '丢弃', dropped)
keys = collections.Counter((m['type'], norm(m['title'])) for m in items)
ent = collections.Counter(m['entities'][0] for m in items if m['type'] == 'person' and m['entities'])
print('同标题会合并', [k for k, v in keys.items() if v > 1], '同人会合并', [k for k, v in ent.items() if v > 1])
if not dry:
    mark = d / '.cost-coldstart-consolidate'  # 重跑不重复记费用
    if not mark.exists(): fra_config.record_cost(cfg, 'coldstart-consolidate', cost); mark.write_text(str(cost))
    (d / 'coldstart.jsonl').write_text(''.join(json.dumps(m, ensure_ascii=False) + '\n' for m in items))
    print('写出', d / 'coldstart.jsonl')
