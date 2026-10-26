#!/usr/bin/env python3
"""汇总 DIR/candidates/*.json → DIR/candidates.jsonl，打印各类数量、同名人物分组、疑似密钥，费用记成事件。用法: aggregate_candidates.py DIR [WHAT=extract]"""
import json, re, sys, collections
from pathlib import Path
import fra_config

cfg = fra_config.load_or_exit()
d = Path(sys.argv[1]); WHAT = sys.argv[2] if len(sys.argv) > 2 else 'extract'
PREFIXES = ''.join(f'|{re.escape(p.rstrip("-_"))}[-_][A-Za-z0-9_-]{{8,}}' for p in cfg['secret_prefixes'] if p.rstrip('-_'))  # 公司专有的 key 前缀来自配置
SECRET = re.compile(r'(password|passwd|密码|口令|sk-[A-Za-z0-9]{8,}|[A-Za-z0-9]{32,}|Bearer\s+\S{12,}' + PREFIXES + ')', re.I)
out, cost = [], 0.0
for p in sorted((d / 'candidates').glob('*.json')):
    j = json.loads(p.read_text()); cost += j.get('total_cost_usd') or 0
    for m in (j.get('structured_output') or {}).get('memories', []):
        out.append({**m, 'batch': p.stem})
with open(d / 'candidates.jsonl', 'w') as f:
    for m in out: f.write(json.dumps(m, ensure_ascii=False) + '\n')
mark = d / f'.cost-{WHAT}'  # 半路失败后重跑：费用只记一次
if not mark.exists(): fra_config.record_cost(cfg, WHAT, cost); mark.write_text(str(cost))
print('candidates', len(out), 'cost $%.2f' % cost)
print('by type', dict(collections.Counter(m['type'] for m in out)))
print('by confidence', dict(collections.Counter(m['confidence'] for m in out)))
people = collections.defaultdict(list)
for m in out:
    if m['type'] == 'person': people[(m['people'] or [m['title']])[0]].append(m)
print('person cards', sum(map(len, people.values())), 'distinct names', len(people), 'multi', sum(len(v) > 1 for v in people.values()))
hits = [(m['batch'], m['title'], s.group(0)[:12]) for m in out for s in [SECRET.search(m['content'])] if s]
print('secret-like hits', len(hits)); [print('  ', h) for h in hits[:15]]
