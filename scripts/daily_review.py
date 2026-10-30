#!/usr/bin/env python3
"""每日复盘：一天里每条要回的消息最后是怎么了结的——卡上一键发 / 按我说的办 / 我直接打字回 / 我在自己另开的会话里办完发 / 没下文，
外加草稿长度和分段、起草撞轮数上限、外部会话发送成败、我在卡上写的吩咐。输出 markdown（给每日复盘的 Claude 读，也能直接看）。
用法: daily_review.py DAY [实例目录 ...]（默认 $FRA_HOME；跑了多个实例就都列上，互相发出去的消息不会被当成「我自己回的」）"""
import collections, datetime as dt, glob, json, os, re, sys
from pathlib import Path
import fra_config

BJ = dt.timezone(dt.timedelta(hours=8))
SENT = ('sent', 'fr-sent')
UNFINISHED = re.compile(r'我再(去|看|查|拉|核|试|确认|对)|还在(查|看|核|拉)|我去(看|查|拉|核)|晚点|回头|稍后|我定一下|我理一下')
SEND_CMD = re.compile(r'messages-(send|reply)|\bfr send')

def norm(s): return re.sub(r'[\s`*"\'\\]', '', s or '')
def bj_day(ts): return dt.datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(BJ).date().isoformat()
def q(xs):
    xs = sorted(xs)
    return f'{len(xs)} 条，中位 {xs[len(xs) // 2]}，p75 {xs[3 * len(xs) // 4]}，p90 {xs[int(len(xs) * .9)]}' if xs else '无'

SECRET = re.compile(r'\b(sk|sk_live|sk_test|cpa|cpk|ak)[-_][A-Za-z0-9_-]{12,}')
def redact(s): return SECRET.sub(lambda m: m.group(0)[:6] + '…', s or '')

def manual_why(w):
    """网页发送失败原因归类：orca 报错里带着请求 id，同一种错只算一类"""
    w = re.sub(r'\s+', ' ', w or '')
    m = re.search(r'"message": "([^"]*?)(?: in browser page.*)?(?:"|$)', w)
    return f'网页脚本没跑通（{m.group(1)}）' if m else w[:60]

def load_instance(d, day):
    d = Path(d)
    ev = [e for f in sorted((d / 'events').glob('*.jsonl')) for e in fra_config.read_jsonl(f)]
    ctx = []  # 「按我说的办」的吩咐原话：办事时写在 runs/*.ctx.json
    for f in (d / 'runs').glob('*.ctx.json'):
        if dt.datetime.fromtimestamp(f.stat().st_mtime, BJ).date().isoformat() != day: continue
        try: c = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError): continue
        if c.get('authText'): ctx.append(c)
    limit = drafts = 0
    try: log = (d / 'assistant.log').read_text(errors='replace').splitlines()
    except OSError: log = []
    for l in log:
        if not re.match(r'\d{4}-\d\d-\d\dT', l) or bj_day(l.split(' ', 1)[0]) != day: continue
        limit += '到轮数上限' in l
        drafts += bool(re.search(r' claude kind=\w+ turns=', l))
    return {'dir': str(d), 'all': ev, 'day': [e for e in ev if e.get('ts') and bj_day(e['ts']) == day], 'ctx': ctx, 'limit': limit, 'drafts': drafts}

def own_session_sends(day):
    """我自己开的 Claude Code / Codex 会话里那天跑过的发消息命令（助手起草 / 办事用的 workspace 会话不算）"""
    out = []
    lo = dt.datetime.fromisoformat(day).replace(tzinfo=BJ).timestamp()
    for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')):
        proj = f.split('/')[-2]
        if proj.endswith('-workspace') or os.path.getmtime(f) < lo: continue
        for line in open(f, errors='replace'):
            if 'tool_use' not in line or not SEND_CMD.search(line): continue
            try: e = json.loads(line)
            except json.JSONDecodeError: continue
            if e.get('type') != 'assistant' or not e.get('timestamp') or bj_day(e['timestamp']) != day: continue
            for x in (e.get('message') or {}).get('content') or []:
                cmd = x.get('input', {}).get('command', '') if isinstance(x, dict) and x.get('type') == 'tool_use' else ''
                if SEND_CMD.search(cmd) and '--help' not in cmd: out.append((proj, norm(cmd)))
    for f in glob.glob(os.path.expanduser('~/.codex/sessions/*/*/*/*.jsonl')):
        if os.path.getmtime(f) < lo: continue
        for line in open(f, errors='replace'):
            if not SEND_CMD.search(line): continue
            try: e = json.loads(line)
            except json.JSONDecodeError: continue
            p = e.get('payload') or {}
            if e.get('type') == 'response_item' and e.get('timestamp') and bj_day(e['timestamp']) == day and p.get('type') in ('function_call', 'local_shell_call', 'custom_tool_call'):
                out.append(('codex', norm(str(p.get('arguments') or p.get('action') or p.get('input')))))
    return out

def build(insts, day):
    # 所有实例发出去的话：别的实例发的，在这个实例看来也像「我在原会话回了」
    assistant = [norm(e['text']) for i in insts for e in i['all'] if e.get('kind') in SENT + ('ack', 'manual', 'fr-manual') and e.get('text')]
    by_assistant = lambda t: len(norm(t)) >= 8 and any(norm(t)[:30] in s or s[:30] in norm(t) for s in assistant if len(s) >= 8)
    sessions = own_session_sends(day)
    def via_session(t):
        n = norm(t)
        return next((p for p, c in sessions if len(n) >= 12 and (n[:30] in c or (len(n) > 40 and n[-25:] in c))), None)
    rows = {}
    for k, i in enumerate(insts):
        for e in i['day']:
            o = e.get('orig') or {}
            if not o.get('message_id'): continue
            r = rows.setdefault(o['message_id'], {'orig': o, 'inst': {}})
            x = r['inst'].setdefault(k, {})
            kind = e.get('kind')
            if kind == 'shadow': x.update(draft=e.get('draft') or '', cat=e.get('category'), tier=e.get('tier'))
            elif kind == 'outcome': x.setdefault('out', []).append(e.get('what'))
            elif kind == 'manual-reply': x['actual'] = e.get('actual') or []
    for r in rows.values():
        outs = [w for x in r['inst'].values() for w in x.get('out', [])]
        actual = next((x['actual'] for x in r['inst'].values() if x.get('actual')), None)
        r['draft'] = next((x['draft'] for x in reversed(list(r['inst'].values())) if x.get('draft')), '')
        r['cat'] = next((x.get('cat') for x in r['inst'].values() if x.get('cat')), None)
        r['actual'] = actual
        if 'auto' in outs: r['cls'] = '直接发（没等你）'
        elif any(w in ('send', 'send_edited') for w in outs): r['cls'] = '卡上一键发'
        elif 'work' in outs: r['cls'] = '按我说的办'
        elif 'skip' in outs: r['cls'] = '不发'
        elif actual and by_assistant(actual[0]): r['cls'] = '助手发的（另一张卡 / 另一个实例）'
        elif actual and (s := via_session(actual[0])): r['cls'], r['session'] = '我在另开的会话里办完发', s
        elif actual: r['cls'] = '我直接打字回'
        else: r['cls'] = '没下文'
    return rows

def render(insts, rows, day, name):
    L = [f'# {day} 回复助手复盘', '']
    c = collections.Counter(r['cls'] for r in rows.values())
    helped = c['直接发（没等你）'] + c['卡上一键发'] + c['按我说的办'] + c['助手发的（另一张卡 / 另一个实例）']
    L += [f"合计：要回的消息 {len(rows)} 条（按原消息去重）；走助手了结 {helped}（直接发 {c['直接发（没等你）']}、卡上一键发 {c['卡上一键发']}、按我说的办 {c['按我说的办']}、另一张卡或另一实例发的 {c['助手发的（另一张卡 / 另一个实例）']}）；"
          f"{name}自己动手 {c['我直接打字回'] + c['我在另开的会话里办完发']}（直接打字 {c['我直接打字回']}、另开会话办完发 {c['我在另开的会话里办完发']}）；不发 {c['不发']}；没下文 {c['没下文']}", '']
    for k, i in enumerate(insts):
        oc = collections.Counter(e.get('what') for e in i['day'] if e.get('kind') == 'outcome')
        L.append(f"- 实例 {k}（{i['dir']}）：出卡 {sum(e.get('kind') == 'shadow' for e in i['day'])}，起草 {i['drafts']} 次、撞轮数上限 {i['limit']} 次；卡上结果 {dict(oc)}")
    drafts = [r['draft'] for r in rows.values() if r['draft']]
    typed = [len(r['actual'][0]) for r in rows.values() if r['cls'] == '我直接打字回']
    longd = [d for d in drafts if len(d) > 200]
    flat = sum('\n' not in d for d in longd)
    L += ['', '## 长度和分段', f'- 草稿字数：{q([len(d) for d in drafts])}', f'- 我直接打字回的字数：{q(typed)}',
          f"- 超过 200 字的草稿 {len(longd)} 条，其中一整段不换行 {flat} 条",
          f'- 草稿里留着「我再去看下 / 还在查 / 晚点」这种半成品的：{sum(bool(UNFINISHED.search(d)) for d in drafts)} 条', '']
    ext = [e for i in insts for e in i['day'] if e.get('kind') in ('fr-manual', 'manual', 'fr-unknown') or (e.get('kind') in SENT and e.get('via') == 'web')]
    if ext:
        why = collections.Counter(manual_why(e.get('why_manual')) for e in ext if e.get('kind') == 'fr-manual')
        L += ['## 外部会话发送', f"- 网页版发成 {sum(e.get('via') == 'web' and e.get('kind') in SENT for e in ext)}，没发出 {sum(e.get('kind') in ('fr-manual', 'manual') for e in ext)}，结果未知 {sum(e.get('kind') == 'fr-unknown' for e in ext)}"]
        L += [f'- 没发出的原因：{w or "（按钮发送，原因见日志）"} × {n}' for w, n in why.most_common()] + ['']
    auto = [e for i in insts for e in i['day'] if e.get('kind') == 'sent' and e.get('auto')]
    acks = [e for i in insts for e in i['day'] if e.get('kind') == 'ack']
    if auto or acks:
        L += [f'## 没等{name}确认就发的（直接发 {len(auto)}、先回一句 {len(acks)}）'] + [f"- {(e.get('orig') or {}).get('sender_name', '?')}：{e.get('text', '')[:200]}" for e in auto] + ['']
    tasks = [r for i in insts for r in fra_config.read_jsonl(Path(i['dir']) / 'tasks.jsonl') if r.get('op') == 'add' and r.get('at') and dt.datetime.fromtimestamp(r['at'] / 1000, BJ).date().isoformat() == day]
    if tasks:
        L += [f'## 加进任务清单的（{len(tasks)}）'] + [f"- {t.get('title')}（{(t.get('orig') or {}).get('sender_name', '?')}）" for t in tasks] + ['']
    asks = [c for i in insts for c in i['ctx']]
    if asks:
        L += ['## 我在卡上写的吩咐'] + [f"- {c['orig'].get('sender_name', '?')}：{c['authText'][:200]}" for c in asks] + ['']
    L += ['## 逐条：没走助手的（最值得学的）', '']
    for r in sorted(rows.values(), key=lambda r: r['orig'].get('create_time') or ''):
        if r['cls'] not in ('我直接打字回', '我在另开的会话里办完发'): continue
        o = r['orig']
        L += [f"### [{r['cls']}] {o.get('create_time', '')[5:]} {o.get('sender_name')}（{o.get('chat_name') or '私聊'}）{' · ' + r['session'] if r.get('session') else ''}",
              f"对方：{o.get('content', '')[:400]}", f"草稿（{len(r['draft'])} 字，{r['cat'] or '-'}）：{r['draft'] or '（没有草稿）'}",
              f"{name}实际回（{len(r['actual'][0])} 字）：{' ⏎ '.join(a[:600] for a in r['actual'][:3])}", '']
    return '\n'.join(L)

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    cfg = fra_config.load_or_exit()
    day = sys.argv[1]
    insts = [load_instance(d, day) for d in (sys.argv[2:] or [cfg['home']])]
    print(redact(render(insts, build(insts, day), day, cfg['name'])))
