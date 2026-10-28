import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(HERE))

def cfg_env(**over):
    home = Path(tempfile.mkdtemp()); fra = home / 'fra'; fra.mkdir()
    (fra / 'config.json').write_text(json.dumps({'name': '张三', 'open_id': 'ou_me', 'draft_chat_id': 'oc_draft', **over}, ensure_ascii=False))
    return {**os.environ, 'HOME': str(home), 'FRA_HOME': str(fra)}
from daily_merge import parse_claude

class DailyMergeFailures(unittest.TestCase):  # I5
    def test_failed_or_malformed_runs_raise(self):
        for code, out in [(1, ''), (0, '{"is_error": true, "result": "boom"}'), (0, '{"result": "no structured"}'), (0, 'not json')]:
            with self.assertRaises(RuntimeError, msg=out):
                parse_claude(code, out)
    def test_ok_run_returns_memories(self):
        self.assertEqual(parse_claude(0, json.dumps({'structured_output': {'memories': [{'title': 'x'}]}})), [{'title': 'x'}])

class ExtractFailurePropagates(unittest.TestCase):  # I5
    def test_failed_batch_makes_script_exit_nonzero(self):
        d = Path(tempfile.mkdtemp()); (d / 'batches').mkdir(); (d / 'batches' / '01.md').write_text('聊天')
        r = subprocess.run(['bash', str(HERE / 'extract_memories.sh'), str(d)], env={**cfg_env(), 'CLAUDE_BIN': '/usr/bin/false'}, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)

class TranscriptsKeepFullIds(unittest.TestCase):  # I8
    def test_full_message_id_in_batches(self):
        d = Path(tempfile.mkdtemp())
        m = {'message_id': 'om_x100b6294960f2ca4dd20856b946ed30', 'chat_id': 'oc_1', 'chat_type': 'p2p', 'create_time': '2026-10-22 21:20',
             'sender': {'id': 'ou_other', 'name': '郑十'}, 'content': 'u5678xyz', 'tags': ['p2p']}
        (d / 'messages.jsonl').write_text(json.dumps(m, ensure_ascii=False) + '\n')
        subprocess.run([sys.executable, str(HERE / 'build_transcripts.py'), str(d)], check=True, capture_output=True, env=cfg_env())
        self.assertIn('om_x100b6294960f2ca4dd20856b946ed30', (d / 'batches' / '01.md').read_text())

class BuildTranscriptsUsesConfigName(unittest.TestCase):
    def test_owner_name_from_config(self):
        d = Path(tempfile.mkdtemp())
        m = {'message_id': 'om_1', 'chat_id': 'oc_1', 'chat_type': 'p2p', 'create_time': '2026-10-22 21:20', 'sender': {'id': 'ou_me', 'name': '张三'}, 'content': '在的', 'tags': ['mine']}
        (d / 'messages.jsonl').write_text(json.dumps(m, ensure_ascii=False) + '\n')
        r = subprocess.run([sys.executable, str(HERE / 'build_transcripts.py'), str(d)], capture_output=True, text=True, env=cfg_env())
        self.assertEqual(r.returncode, 0, r.stderr)
        t = (d / 'batches' / '01.md').read_text()
        self.assertIn('张三(我)', t)

class ImportColdstartIsGeneric(unittest.TestCase):
    def test_imports_everything_without_special_cases(self):
        d = Path(tempfile.mkdtemp()); (d / 'consolidated').mkdir()
        mem = lambda t, title: {'type': t, 'title': title, 'entities': [], 'scope': '', 'content': '2026-10-01 x', 'sources': ['s#1'], 'observed': '', 'confidence': 'high', 'review': 'auto'}
        for g in ('person', 'policy', 'recipe', 'fact', 'open', 'style'):
            ms = {'recipe': [mem('recipe', '开通配方')], 'fact': [mem('fact', '网关地址')]}.get(g, [])
            (d / 'consolidated' / f'{g}.json').write_text(json.dumps({'total_cost_usd': 0.1, 'structured_output': {'memories': ms}}, ensure_ascii=False))
        env = cfg_env()
        r = subprocess.run([sys.executable, str(HERE / 'import_coldstart.py'), str(d)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = [json.loads(l) for l in (d / 'coldstart.jsonl').read_text().splitlines()]
        self.assertEqual([m['title'] for m in out], ['开通配方', '网关地址'])
        self.assertTrue(all(m['observed'] for m in out))  # 没写日期的默认今天
        self.assertNotIn('R17', (HERE / 'import_coldstart.py').read_text())
        ev = [json.loads(l) for f in (Path(env['FRA_HOME']) / 'events').glob('*.jsonl') for l in f.read_text().splitlines()]
        self.assertEqual([(e['kind'], e['what'], round(e['usd'], 2)) for e in ev], [('cost', 'coldstart-consolidate', 0.6)])

class ColdstartNoMessages(unittest.TestCase):
    def test_empty_range_exits_cleanly(self):
        env = cfg_env()
        lark = Path(env['FRA_HOME']) / 'lark'
        lark.write_text('#!/bin/bash\necho \'{"ok":true,"data":{"messages":[],"has_more":false}}\'\n'); lark.chmod(0o755)
        r = subprocess.run(['bash', str(HERE / 'coldstart.sh'), '2'], capture_output=True, text=True, env={**env, 'FRA_LARK': str(lark)}, stdin=subprocess.DEVNULL, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('这段时间没有消息', r.stdout)

class AggregateUsesConfigPrefixes(unittest.TestCase):
    def run_agg(self, **over):
        d = Path(tempfile.mkdtemp()); (d / 'candidates').mkdir()
        m = {'type': 'fact', 'title': 'key', 'content': '他的 key abc_AbCdEf1234567890', 'confidence': 'high', 'people': [], 'projects': [], 'evidence': [], 'valid_from': '', 'volatility': 'low'}
        (d / 'candidates' / '01.json').write_text(json.dumps({'total_cost_usd': 0.25, 'structured_output': {'memories': [m]}}))
        env = cfg_env(**over)
        r = subprocess.run([sys.executable, str(HERE / 'aggregate_candidates.py'), str(d), 'daily-extract'], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout, env
    def test_prefix_only_when_configured(self):
        out, env = self.run_agg(secret_prefixes=['abc'])
        self.assertIn('secret-like hits 1', out)
        ev = [json.loads(l) for f in (Path(env['FRA_HOME']) / 'events').glob('*.jsonl') for l in f.read_text().splitlines()]
        self.assertEqual([(e['what'], e['usd']) for e in ev], [('daily-extract', 0.25)])
        self.assertIn('secret-like hits 0', self.run_agg()[0])

class Python39Compatible(unittest.TestCase):
    def test_scripts_compile_on_system_python(self):
        """同事的 Mac 上 python3 多半是系统自带的 3.9：脚本不能用 3.12 才有的语法"""
        py = '/usr/bin/python3'
        if not os.path.exists(py): self.skipTest('没有系统 python3')
        for f in sorted(HERE.glob('*.py')):
            r = subprocess.run([py, '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', str(f)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f'{f.name}: {r.stderr[-300:]}')

class ScriptsWithoutConfig(unittest.TestCase):
    def test_one_line_error(self):
        home = Path(tempfile.mkdtemp())
        r = subprocess.run([sys.executable, str(HERE / 'collect_month.py'), '2026-10-01', '2026-10-02', str(home)], capture_output=True, text=True,
                           env={**os.environ, 'HOME': str(home), 'FRA_HOME': str(home / 'fra')})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('bin/fra setup', r.stderr); self.assertNotIn('Traceback', r.stderr)

class ColdstartNoBatches(unittest.TestCase):
    def test_messages_but_no_batches(self):
        env = cfg_env()
        lark = Path(env['FRA_HOME']) / 'lark'
        msg = {'message_id': 'om_1', 'chat_id': 'oc_draft', 'chat_type': 'group', 'create_time': '2026-10-22 10:00', 'sender': {'id': 'ou_me', 'name': '张三'}, 'content': '发'}
        lark.write_text('#!/bin/bash\ncase "$*" in *"+messages-search"*) echo \'' + json.dumps({'ok': True, 'data': {'messages': [msg], 'has_more': False}}) + '\' ;; *) echo \'{"ok":true,"data":{"messages":[]}}\' ;; esac\n')
        lark.chmod(0o755)
        r = subprocess.run(['bash', str(HERE / 'coldstart.sh'), '2'], capture_output=True, text=True, env={**env, 'FRA_LARK': str(lark), 'YES': '1', 'CLAUDE_BIN': '/usr/bin/false'}, stdin=subprocess.DEVNULL, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('没有可用的聊天记录', r.stdout)

class ExtractNeedsPrompt(unittest.TestCase):
    def test_refuses_empty_system_prompt(self):
        d = Path(tempfile.mkdtemp()); (d / 'batches').mkdir(); (d / 'batches' / '01.md').write_text('聊天')
        home = Path(tempfile.mkdtemp())
        r = subprocess.run(['bash', str(HERE / 'extract_memories.sh'), str(d)], capture_output=True, text=True,
                           env={**os.environ, 'HOME': str(home), 'FRA_HOME': str(home / 'nope'), 'CLAUDE_BIN': '/usr/bin/true'})
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((d / 'candidates' / '01.json').exists())

class CostRecordedOnce(unittest.TestCase):
    def test_rerun_does_not_double_count(self):
        d = Path(tempfile.mkdtemp()); (d / 'candidates').mkdir()
        (d / 'candidates' / '01.json').write_text(json.dumps({'total_cost_usd': 0.25, 'structured_output': {'memories': []}}))
        env = cfg_env()
        for _ in range(2):
            subprocess.run([sys.executable, str(HERE / 'aggregate_candidates.py'), str(d), 'coldstart-extract'], check=True, capture_output=True, env=env)
        ev = [l for f in (Path(env['FRA_HOME']) / 'events').glob('*.jsonl') for l in f.read_text().splitlines()]
        self.assertEqual(len(ev), 1)

class SignalsSkipBadLines(unittest.TestCase):
    def test_bad_event_line(self):
        env = cfg_env()
        ev = Path(env['FRA_HOME']) / 'events'; ev.mkdir()
        good = json.dumps({'ts': '2026-10-22T04:00:00Z', 'kind': 'manual-reply', 'orig': {'sender_name': '李四'}, 'draft': 'a', 'actual': ['b']}, ensure_ascii=False)
        (ev / '2026-10.jsonl').write_text(good + '\n{"ts": \n')
        d = Path(tempfile.mkdtemp())
        r = subprocess.run([sys.executable, str(HERE / 'collect_signals.py'), str(d), '2026-10-22'], capture_output=True, text=True, env={**env, 'FRA_LARK': '/usr/bin/false'})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('李四', (d / 'batches' / 'zz-signals.md').read_text())

    def test_numbered_items_and_unpaired(self):
        """有草稿的编号（抽取时据此归类）；actual 空的（回的是同一个人后来那张卡）不进 md、只计数；没草稿的不编号"""
        env = cfg_env()
        ev = Path(env['FRA_HOME']) / 'events'; ev.mkdir()
        e = lambda who, draft, actual: json.dumps({'ts': '2026-10-22T04:00:00Z', 'kind': 'manual-reply', 'card': f'om_{who}', 'orig': {'sender_name': who}, 'draft': draft, 'actual': actual}, ensure_ascii=False)
        (ev / '2026-10.jsonl').write_text('\n'.join([e('李四', '稿一', ['回一']), e('王五', '', ['回二']), e('赵六', '稿三', []), e('孙七', '稿四', ['回四'])]) + '\n')
        d = Path(tempfile.mkdtemp())
        r = subprocess.run([sys.executable, str(HERE / 'collect_signals.py'), str(d), '2026-10-22'], capture_output=True, text=True, env={**env, 'FRA_LARK': '/usr/bin/false'})
        self.assertEqual(r.returncode, 0, r.stderr)
        md = (d / 'batches' / 'zz-signals.md').read_text()
        self.assertIn('### #1 李四', md); self.assertIn('### 王五', md); self.assertIn('### #2 孙七', md); self.assertNotIn('赵六', md)
        sig = json.loads((d / 'signals.json').read_text())
        self.assertEqual([(x['n'], x['sender'], x['card']) for x in sig['items']], [(1, '李四', 'om_李四'), (2, '孙七', 'om_孙七')])
        self.assertEqual((sig['no_draft'], sig['unpaired']), (1, 1))

    def test_skipped_but_replied_is_numbered(self):
        """助手判了不用回（没出卡）、他却回了：也编号归类，草稿写明判了不用回；不算「没草稿」"""
        env = cfg_env()
        ev = Path(env['FRA_HOME']) / 'events'; ev.mkdir()
        e = {'ts': '2026-10-22T04:00:00Z', 'kind': 'manual-reply', 'orig': {'sender_name': '李四', 'chat_name': '对接群', 'content': '加完了 您这边看一下'}, 'draft': '', 'skipped': '李四说加完了，不用回', 'actual': ['看了，到账了']}
        (ev / '2026-10.jsonl').write_text(json.dumps(e, ensure_ascii=False) + '\n')
        d = Path(tempfile.mkdtemp())
        subprocess.run([sys.executable, str(HERE / 'collect_signals.py'), str(d), '2026-10-22'], check=True, capture_output=True, env={**env, 'FRA_LARK': '/usr/bin/false'})
        self.assertIn('### #1 李四（对接群）\n原消息：加完了 您这边看一下\n助手草稿：（判了不用回，没出卡：李四说加完了，不用回）', (d / 'batches' / 'zz-signals.md').read_text())
        sig = json.loads((d / 'signals.json').read_text())
        self.assertEqual([(x['n'], x.get('skipped')) for x in sig['items']], [(1, True)])
        self.assertEqual(sig['no_draft'], 0)

class ColdstartAsksUnlessYes1(unittest.TestCase):
    def test_yes0_still_asks_and_bad_days_rejected(self):
        env = cfg_env()
        lark = Path(env['FRA_HOME']) / 'lark'
        msg = {'message_id': 'om_1', 'chat_id': 'oc_1', 'chat_type': 'p2p', 'create_time': '2026-10-22 10:00', 'sender': {'id': 'ou_li', 'name': '李四', 'sender_type': 'user'}, 'content': '在吗', 'tags': ['p2p']}
        lark.write_text('#!/bin/bash\ncase "$*" in *"+messages-search"*) echo \'' + json.dumps({'ok': True, 'data': {'messages': [msg], 'has_more': False}}) + '\' ;; *) echo \'{"ok":true,"data":{"messages":[]}}\' ;; esac\n')
        lark.chmod(0o755)
        r = subprocess.run(['bash', str(HERE / 'coldstart.sh'), '2'], capture_output=True, text=True, env={**env, 'FRA_LARK': str(lark), 'YES': '0', 'CLAUDE_BIN': '/usr/bin/false'}, stdin=subprocess.DEVNULL, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('没继续', r.stdout)
        bad = subprocess.run(['bash', str(HERE / 'coldstart.sh'), 'abc'], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30)
        self.assertEqual(bad.returncode, 2); self.assertIn('用法', bad.stdout + bad.stderr)

class ShellVarsBraced(unittest.TestCase):
    def test_no_bare_var_before_cjk(self):
        """bash 在某些 locale 下会把 $OUT， 里「，」的第一个字节当成变量名的一部分（set -u 下直接报 unbound）：变量后面紧跟中文要写成 ${OUT}"""
        import re
        root = HERE.parent
        for f in [*sorted(HERE.glob('*.sh')), root / 'install.sh']:
            for i, l in enumerate(f.read_text().splitlines(), 1):
                self.assertIsNone(re.search(r'\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]', l), f'{f.name}:{i}: {l.strip()}')

if __name__ == '__main__':
    unittest.main()
