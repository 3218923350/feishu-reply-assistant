"""2026-10-23 每日增量的修复：同一天不重跑、参与者 open_id、草稿 vs 实发、未结事项结案、日报编号、工作区清理"""
import json, os, shutil, subprocess, sys, tempfile, time, unittest
from pathlib import Path
SCRIPTS = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS))

def cfg_env(**over):
    """临时 HOME + FRA_HOME，写好配置：脚本读不到真实数据"""
    home = Path(tempfile.mkdtemp()); fra = home / 'fra'; fra.mkdir()
    (fra / 'config.json').write_text(json.dumps({'name': '张三', 'open_id': 'ou_me', 'draft_chat_id': 'oc_draft', **over}, ensure_ascii=False))
    return {**os.environ, 'HOME': str(home), 'FRA_HOME': str(fra)}

class DailyRunsOncePerDay(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='daily a ')) # 仓库路径带空格（比如放在 ~/Library/Application Support 下）也要能跑
        (self.base / 'scripts').mkdir(); shutil.copy(SCRIPTS / 'daily.sh', self.base / 'scripts')
        self.log = self.base / 'steps.log'
        for name in ['collect_month.py', 'collect_context.py', 'build_transcripts.py', 'collect_signals.py', 'daily_merge.py', 'close_open.py', 'digest.py']:
            (self.base / 'scripts' / name).write_text(f'open({str(self.log)!r}, "a").write("{name}\\n")\n')
        (self.base / 'scripts' / 'extract_memories.sh').write_text(f'echo extract_memories.sh >> "{self.log}"\n'); (self.base / 'scripts' / 'extract_memories.sh').chmod(0o755)
        ws = self.base / 'workspace'; ws.mkdir()
        for f in ['CLAUDE.md', '.gitignore', 'old.png', 'new.png']: (ws / f).write_text('x')
        old = time.time() - 10 * 86400
        for f in ['CLAUDE.md', '.gitignore', 'old.png']: os.utime(ws / f, (old, old))
    def run_daily(self, **env):
        return subprocess.run(['bash', str(self.base / 'scripts' / 'daily.sh'), '2026-10-22'], env={**os.environ, 'HOME': str(self.base), 'FRA_HOME': str(self.base / '.fra'), **env}, capture_output=True, text=True)
    def steps(self): return self.log.read_text().split()

    def test_second_run_same_day_does_nothing(self):
        self.run_daily()
        first = self.steps()
        self.assertIn('daily_merge.py', first); self.assertIn('close_open.py', first); self.assertIn('digest.py', first)
        r = self.run_daily()
        self.assertEqual(self.steps(), first, r.stdout)
        self.assertIn('已经处理过', r.stdout)
    def test_force_reruns(self):
        self.run_daily(); self.run_daily(FORCE='1')
        self.assertEqual(self.steps().count('daily_merge.py'), 2)
    def test_signals_come_after_transcripts(self):
        self.run_daily()
        s = self.steps(); self.assertLess(s.index('build_transcripts.py'), s.index('collect_signals.py')); self.assertLess(s.index('collect_signals.py'), s.index('extract_memories.sh'))
    def test_workspace_cleanup_keeps_config(self):
        self.run_daily()
        self.assertEqual(sorted(p.name for p in (self.base / 'workspace').iterdir()), ['.gitignore', 'CLAUDE.md', 'new.png'])

class TranscriptRoster(unittest.TestCase):
    def test_participants_with_open_id(self):
        d = Path(tempfile.mkdtemp())
        ms = [{'message_id': 'om_1', 'chat_id': 'oc_1', 'chat_type': 'p2p', 'create_time': '2026-10-22 21:20', 'sender': {'id': 'ou_u9', 'name': '杨九', 'sender_type': 'user'}, 'content': '好', 'tags': ['p2p']},
              {'message_id': 'om_2', 'chat_id': 'oc_1', 'chat_type': 'p2p', 'create_time': '2026-10-22 21:21', 'sender': {'id': 'ou_me', 'name': '张三'}, 'content': '嗯', 'tags': ['mine']}]
        (d / 'messages.jsonl').write_text(''.join(json.dumps(m, ensure_ascii=False) + '\n' for m in ms))
        subprocess.run([sys.executable, str(SCRIPTS / 'build_transcripts.py'), str(d)], check=True, capture_output=True, env=cfg_env())
        text = (d / 'batches' / '01.md').read_text()
        self.assertIn('杨九=ou_u9', text)
        self.assertNotIn('张三=ou_', text)
        self.assertIn('张三(我)', text)

class Signals(unittest.TestCase):
    def test_render_pairs_and_recalls(self):
        from collect_signals import render, of_day
        evs = [{'ts': '2026-10-22T04:00:00Z', 'kind': 'manual-reply', 'orig': {'sender_name': '吴九', 'chat_name': None, 'content': 'kimi'}, 'draft': '收到，谢谢！', 'actual': ['那我合到账单里']},
               {'ts': '2026-10-22T04:04:00Z', 'kind': 'fr-sent', 'toName': '孙七', 'text': '模型 A 那批今天不上', 'message_id': 'om_r'},
               {'ts': '2026-10-22T04:05:00Z', 'kind': 'fr-sent', 'toName': '蒋四', 'text': '我们加一下', 'message_id': 'om_ok'},
               {'ts': '2026-10-21T15:00:00Z', 'kind': 'manual-reply', 'orig': {'sender_name': '前一天'}, 'draft': 'x', 'actual': ['y']}]
        day = of_day(evs, '2026-10-22')  # 北京时间：10-21T15:00Z 是 10-21 23:00，不算
        self.assertEqual(len(day), 3)
        md, items = render(day, {'om_r'}, '张三')
        self.assertIn('吴九', md); self.assertIn('收到，谢谢！', md); self.assertIn('那我合到账单里', md)
        self.assertIn('撤回', md); self.assertIn('模型 A 那批今天不上', md); self.assertNotIn('我们加一下', md)
        self.assertIn('张三实际回的', md)
        self.assertEqual([x['sender'] for x in items], ['吴九'])
        self.assertEqual(render([], set(), '张三'), ('', []))

class CloseOpen(unittest.TestCase):
    def test_only_known_open_items_become_done(self):
        from close_open import to_memories
        items = [{'path': '/mem/open/a.md', 'title': '等吴九发 Kimi 账单'}]
        mems = to_memories([{'path': '/mem/open/a.md', 'evidence': '吴九 12:09 发了 Kimi 账单', 'source': '私聊 吴九#om_k'}, {'path': '/etc/passwd', 'evidence': 'x', 'source': 'y'}], items, '2026-10-23')
        self.assertEqual(len(mems), 1)
        m = mems[0]
        self.assertEqual([m['target'], m['status'], m['type'], m['title']], ['/mem/open/a.md', 'done', 'open', '等吴九发 Kimi 账单'])
        self.assertTrue(m['content'].startswith('2026-10-23 已办完：'))
        self.assertEqual(m['sources'], ['私聊 吴九#om_k'])

class DigestNumbers(unittest.TestCase):
    def test_pending_then_overdue_numbered(self):
        from digest import numbered
        md, items = numbered([{'path': '/p1', 'title': 'A'}, {'path': '/p2', 'title': 'B'}], [{'path': '/o1', 'title': 'C'}])
        self.assertEqual([(i['n'], i['kind'], i['title']) for i in items], [(1, 'pending', 'A'), (2, 'pending', 'B'), (3, 'overdue', 'C')])
        self.assertIn('1. A', md); self.assertIn('3. C', md); self.assertIn('确认', md); self.assertIn('结', md)


class DigestCommitments(unittest.TestCase):
    def test_open_commitments_listed(self):
        from digest import open_commitments
        log = [{'op': 'add', 'id': 'a', 'toName': '周八', 'what': '我现在把节点摘', 'at': 1792826018000},
               {'op': 'add', 'id': 'b', 'toName': '郑十', 'what': '开好了跟你说', 'at': 1792826018000},
               {'op': 'kept', 'id': 'b'}]
        self.assertEqual(open_commitments(log), ['对周八：我现在把节点摘（10-24 15:13）'])

if __name__ == '__main__':
    unittest.main()
