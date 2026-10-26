#!/usr/bin/env python3
"""配置：$FRA_HOME/config.json + about-me.md（和 lib/config.mjs 同一套规则）。命令行：fra_config.py fill <文件> → 打印填好占位符的文本"""
import datetime as dt, json, os, re, shutil, sys
from pathlib import Path

class ConfigError(Exception):
    pass

REQUIRED = ['name', 'open_id', 'draft_chat_id']

def _home(env): return env.get('HOME') or str(Path.home())

def fra_home(env=os.environ):
    return Path(os.path.abspath(env.get('FRA_HOME') or Path(_home(env)) / '.feishu-reply-assistant'))  # 和 JS 的 path.resolve 一样：不解符号链接

def _expand(p, home):
    return home + p[1:] if isinstance(p, str) and (p == '~' or p.startswith('~/')) else p

def load(env=os.environ):
    d, home = fra_home(env), _home(env)
    f = d / 'config.json'
    def fail(why): raise ConfigError(f'配置有问题（{f}）：{why}。先跑 bin/fra setup，或照 templates/config.example.json 改。')
    try: raw = f.read_text()
    except OSError: fail('文件不存在')
    try: c = json.loads(raw)
    except json.JSONDecodeError as e: fail(f'不是合法的 JSON（{e}）')
    if not isinstance(c, dict): fail('最外层要是一个对象 { ... }')
    missing = [k for k in REQUIRED if not c.get(k)]
    if missing: fail('缺 ' + '、'.join(missing))
    for k in ('name', 'open_id', 'draft_chat_id', 'bot_open_id', 'messenger_url', 'memory_dir', 'legacy_work_dir', 'launchd_label'):
        if c.get(k) is not None and not isinstance(c[k], str): fail(f'{k} 要写成字符串')
    if c.get('launchd_label') is not None and not re.fullmatch(r'[A-Za-z0-9._-]+', c['launchd_label']): fail('launchd_label 只能用字母、数字和 . _ -')
    strs = lambda x: isinstance(x, list) and all(isinstance(v, str) for v in x)
    if c.get('leaders') is not None and not strs(c['leaders']): fail('leaders 要写成 ["姓名", ...]')
    if c.get('secret_prefixes') is not None and not strs(c['secret_prefixes']): fail('secret_prefixes 要写成 ["前缀", ...]')
    if c.get('bot_env') is not None and not (isinstance(c['bot_env'], dict) and all(isinstance(v, str) for v in c['bot_env'].values())): fail('bot_env 要写成 { "环境变量名": "值" }')
    absolute = lambda p: os.path.abspath(d / _expand(p, home)) if p else None  # 相对路径按 FRA_HOME 解析
    about = d / 'about-me.md'
    try: about_me = about.read_text()
    except OSError: about_me = ''
    return {
        'home': str(d), 'name': c['name'], 'open_id': c['open_id'], 'bot_open_id': c.get('bot_open_id') or c['open_id'],
        'draft_chat_id': c['draft_chat_id'], 'leaders': c.get('leaders') or [],
        'bot_env': {k: _expand(v, home) for k, v in (c.get('bot_env') or {}).items()},
        'messenger_url': c.get('messenger_url') or None,
        'memory_dir': absolute(c.get('memory_dir')) or str(d / 'memory'),
        'secret_prefixes': c.get('secret_prefixes') or [],
        'legacy_work_dir': absolute(c.get('legacy_work_dir')),
        'launchd_label': c.get('launchd_label') or 'com.feishu-reply-assistant',
        'about_me': about_me,
    }

def load_or_exit(env=os.environ):
    """命令行脚本用：没配好就打一行人话退出，不甩堆栈"""
    try: return load(env)
    except ConfigError as e: sys.exit(str(e))

def read_jsonl(p):
    """只追加的 jsonl：坏行跳过（写到一半崩了也不至于整条管线停掉）"""
    out = []
    try: lines = Path(p).read_text().splitlines()
    except OSError: return out
    for l in lines:
        if not l.strip(): continue
        try: out.append(json.loads(l))
        except json.JSONDecodeError: pass
    return out

def fill(text, cfg):
    about = cfg.get('about_me') or ''
    if not about.strip():
        about = f"（还没写「关于我」：在 {Path(cfg['home']) / 'about-me.md'} 里写你是谁、负责什么、常用仓库和目录）"
    return text.replace('{{name}}', cfg['name']).replace('{{about_me}}', about)

def bot_env(cfg, env=os.environ):
    return {**env, **cfg['bot_env']}

def bin_path(name):
    override = {'lark-cli': 'FRA_LARK', 'claude': 'FRA_CLAUDE'}.get(name)
    return (override and os.environ.get(override)) or shutil.which(name) or name

def record_cost(cfg, what, usd):
    now = dt.datetime.now(dt.timezone.utc)
    events = Path(cfg['home']) / 'events'; events.mkdir(parents=True, exist_ok=True)
    line = {'ts': now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z', 'kind': 'cost', 'what': what, 'usd': usd}
    with open(events / f'{now.strftime("%Y-%m")}.jsonl', 'a') as f:
        f.write(json.dumps(line, ensure_ascii=False) + '\n')

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'fill':
        try: sys.stdout.write(fill(Path(sys.argv[2]).read_text(), load()))
        except ConfigError as e: sys.exit(str(e))
    else:
        sys.exit('用法：fra_config.py fill <文件>')
