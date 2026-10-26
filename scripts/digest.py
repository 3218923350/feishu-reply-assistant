#!/usr/bin/env python3
"""每日摘要卡：记忆库过去 24h 的变化、待确认、冲突、到期事项（到期的 open 改成 overdue），用机器人发到草稿群。
待确认和到期事项带编号，我在卡下回「1 3 确认，2 删，5 结」由回复助手处理（编号表写在 $FRA_HOME/digests/<卡片 id>.json）。用法: digest.py DAY STATUS"""
import json, os, re, subprocess, sys, datetime as dt
from pathlib import Path
import fra_config

MEM = str(Path(__file__).resolve().parent.parent / 'bin' / 'mem')
MEMORY_DIRS = {'people', 'policy', 'recipes', 'facts', 'open', 'style', 'inbox'}

def meta(p):
    m = re.match(r'---\n(.*?)\n---', p.read_text(), re.S)
    out = {}
    for line in (m.group(1).split('\n') if m else []):
        k, _, v = line.partition(': ')
        out[k] = json.loads(v) if v[:1] in '["' else v
    return out

def git(wy, *a): return subprocess.run(['git', '-C', str(wy), '-c', 'core.quotePath=false', *a], capture_output=True, text=True).stdout

def summarize_changes(log, wy):
    """git log --name-status 输出 → (新增标题, 追加标题)；只看记忆目录，README 等不算"""
    changed = {}
    for line in log.splitlines():
        st, _, f = line.partition('\t')
        if f.endswith('.md') and st in ('A', 'M') and f.split('/')[0] in MEMORY_DIRS and (wy / f).exists():
            changed.setdefault(f, st)
    title = lambda f: meta(wy / f).get('title', f)
    return [title(f) for f, st in changed.items() if st == 'A'], [title(f) for f, st in changed.items() if st == 'M']

def lst(xs, n=12): return '\n'.join(f'- {x}' for x in xs[:n]) + (f'\n- …共 {len(xs)} 条' if len(xs) > n else '')

def open_commitments(log):
    """承诺账本里还没兑现 / 没说不做的 → 「对谁：答应了什么（几点）」"""
    closed = {r['id'] for r in log if r.get('op') in ('kept', 'dropped')}
    fmt = lambda ms: (dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc) + dt.timedelta(hours=8)).strftime('%m-%d %H:%M')
    return [f"对{r.get('toName', '?')}：{r.get('what', '')}（{fmt(r['at'])}）" for r in log if r.get('op') == 'add' and r['id'] not in closed]

def numbered(pending, overdue, cap=30):
    """待确认在前、到期事项在后，连续编号 → (卡片文字, 编号表)"""
    items, parts = [], []
    for kind, xs, head in [('pending', pending, f'**待你确认 {len(pending)} 条**（回这张卡：「1 3 确认，2 删」，也可以「全部确认」）'),
                           ('overdue', overdue, f'**到期没结的事 {len(overdue)} 条**（办完了回「编号 结」）')]:
        if not xs: continue
        lines = []
        for x in xs[:cap]:
            items.append({'n': len(items) + 1, 'kind': kind, 'path': x['path'], 'title': x['title']}); lines.append(f"{len(items)}. {x['title']}")
        if len(xs) > cap: lines.append(f'…还有 {len(xs) - cap} 条（Claude Code 里 mem review）')
        parts.append(head + '\n' + '\n'.join(lines))
    return '\n\n'.join(parts), items

def cost_summary(events, now_ms):
    """过去 24 小时 kind=cost 的事件 → 日报里的一行；没有就空串"""
    since = now_ms - 24 * 3600_000
    ts = lambda e: dt.datetime.fromisoformat(e['ts'].replace('Z', '+00:00')).timestamp() * 1000
    xs = [e for e in events if e.get('kind') == 'cost' and e.get('ts') and since <= ts(e) <= now_ms]
    if not xs: return ''
    usd = lambda es: sum(e.get('usd') or 0 for e in es)
    by = lambda w: [e for e in xs if e.get('what') == w]
    draft, work, learn = by('draft'), by('work'), by('learn')
    other = [e for e in xs if e.get('what') not in ('draft', 'work', 'learn')]
    parts = []
    if draft: parts.append(f"起草 {len({e.get('session') for e in draft})} 条 ${usd(draft):.2f}")
    if work:
        unknown = sum(e.get('usd') is None for e in work)
        parts.append(f"办事 {len(work)} 轮 ${usd(work):.2f}" + (f"（{unknown} 轮在 Orca 终端里，费用未知）" if unknown else ''))
    if learn: parts.append(f"抽记忆 ${usd(learn):.2f}")
    if other: parts.append(f"记忆整理 ${usd(other):.2f}")
    return f"**过去 24 小时花费** ${usd(xs):.2f}：" + '、'.join(parts)

def main(day, status):
    cfg = fra_config.load_or_exit()
    WY, DIGESTS, COMMITS = Path(cfg['memory_dir']), Path(cfg['home']) / 'digests', Path(cfg['home']) / 'commitments.jsonl'
    today = dt.date.today().isoformat()
    # 到期事项：open 且 due 早于今天 → overdue
    overdue = []
    for p in (WY / 'open').glob('*.md'):
        m = meta(p)
        if m.get('status') == 'open' and m.get('due') and m['due'] < today:
            p.write_text(p.read_text().replace('\nstatus: open\n', '\nstatus: overdue\n', 1)); overdue.append(m['title'])
    if overdue:
        git(WY, 'add', '-A', '--', 'open'); git(WY, 'commit', '-q', '-m', f'到期：{len(overdue)} 条')

    added, updated = summarize_changes(git(WY, 'log', '--since=24 hours ago', '--name-status', '--format='), WY)
    pending = json.loads(subprocess.run([MEM, 'review', '--json'], capture_output=True, text=True).stdout or '[]')
    mems = [p for d in MEMORY_DIRS for p in (WY / d).rglob('*.md')]
    conflicts = [meta(p).get('title', p.name) for p in mems if meta(p).get('status') == 'conflict']
    all_overdue = [{'path': str(p), 'title': meta(p).get('title', p.name)} for p in sorted((WY / 'open').glob('*.md')) if meta(p).get('status') == 'overdue']
    review_md, items = numbered([{'path': p['path'], 'title': p['title']} for p in pending], all_overdue)

    daily_log = Path(cfg['home']) / 'daily.log'  # 别在 f-string 里套同样的引号：系统自带的 python3（3.9）不认
    parts = [f'📒 **记忆日报** {day}' + ('' if status == 'ok' else f'（⚠️ 增量任务{status}，看 {daily_log}）')]
    events_dir = Path(cfg['home']) / 'events'
    events = [e for f in sorted(events_dir.glob('*.jsonl'))[-2:] for e in fra_config.read_jsonl(f)] if events_dir.exists() else []
    spent = cost_summary(events, dt.datetime.now().timestamp() * 1000)
    if spent: parts.append(spent)
    parts.append(f'**新增 {len(added)} 条**\n{lst(added)}' if added else '昨天没有新增记忆。')
    if updated: parts.append(f'**追加 {len(updated)} 条**\n{lst(updated)}')
    if review_md: parts.append(review_md)
    if conflicts: parts.append(f'**说法冲突 {len(conflicts)} 条**（Claude Code 里看两条原文再定）\n{lst(conflicts)}')
    owed = open_commitments(fra_config.read_jsonl(COMMITS))
    if owed: parts.append(f'**以你身份答应了、还没做的 {len(owed)} 条**（去那张卡点「去做」，或在卡下说「不做了」）\n{lst(owed)}')
    md = '\n\n'.join(parts)
    r = subprocess.run([fra_config.bin_path('lark-cli'), 'im', '+messages-send', '--as', 'bot', '--chat-id', cfg['draft_chat_id'], '--markdown', md],
                       env=fra_config.bot_env(cfg), capture_output=True, text=True)
    print(md)
    try: msg_id = json.loads(r.stdout)['data']['message_id']
    except Exception: print('发送失败', r.stdout[:300] + r.stderr[:300]); return
    print('发送 ok', msg_id)
    if items:
        DIGESTS.mkdir(parents=True, exist_ok=True)
        (DIGESTS / f'{msg_id}.json').write_text(json.dumps({'day': day, 'items': items}, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
