"""每日复盘的统计：每条消息怎么了结的；别的实例 / 别的卡发出去的话不算「我自己回的」；我自己会话里发出去的算「另开会话」"""
import json, os, sys, tempfile, unittest
from pathlib import Path
SCRIPTS = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import daily_review

def orig(mid, who='李四', chat='oc_1'):
    return {'message_id': mid, 'chat_id': chat, 'chat_type': 'p2p', 'sender_name': who, 'create_time': '2026-10-29 10:00', 'content': '问个事'}

def inst(events, home):
    d = Path(tempfile.mkdtemp(dir=home)); (d / 'events').mkdir()
    (d / 'events' / '2026-10.jsonl').write_text(''.join(json.dumps({'ts': '2026-10-29T02:00:00Z', **e}, ensure_ascii=False) + '\n' for e in events))
    return daily_review.load_instance(d, '2026-10-29')

class Review(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old = os.environ.get('HOME'); os.environ['HOME'] = self.home  # 不读真实的 Claude Code / Codex 会话
    def tearDown(self):
        os.environ['HOME'] = self.old

    def test_classes(self):
        a = inst([
            {'kind': 'shadow', 'card': 'c1', 'orig': orig('m1'), 'draft': '好的', 'tier': 'auto'}, {'kind': 'outcome', 'card': 'c1', 'orig': orig('m1'), 'what': 'auto'},
            {'kind': 'sent', 'orig': orig('m1'), 'text': '用 1017 那个就行\n（张三的助手代回）', 'auto': True},
            {'kind': 'shadow', 'card': 'c2', 'orig': orig('m2'), 'draft': '一大段' * 50}, {'kind': 'outcome', 'card': 'c2', 'orig': orig('m2'), 'what': 'self'},
            {'kind': 'manual-reply', 'card': 'c2', 'orig': orig('m2'), 'actual': ['ok']},
            {'kind': 'shadow', 'card': 'c3', 'orig': orig('m3'), 'draft': 'x'}, {'kind': 'outcome', 'card': 'c3', 'orig': orig('m3'), 'what': 'work'},
        ], self.home)
        b = inst([{'kind': 'sent', 'orig': orig('m9'), 'text': '这条是另一个实例发的，挺长的一句话'}], self.home)
        a['day'] += [{'kind': 'manual-reply', 'orig': orig('m4'), 'actual': ['这条是另一个实例发的，挺长的一句话']}]
        rows = daily_review.build([a, b], '2026-10-29')
        cls = {k: v['cls'] for k, v in rows.items()}
        self.assertEqual(cls['m1'], '直接发（没等你）')
        self.assertEqual(cls['m2'], '我直接打字回')
        self.assertEqual(cls['m3'], '按我说的办')
        self.assertEqual(cls['m4'], '助手发的（另一张卡 / 另一个实例）')
        md = daily_review.render([a, b], rows, '2026-10-29', '张三')
        self.assertIn('直接发 1', md)
        self.assertIn('没等张三确认就发的', md)
        self.assertIn('[我直接打字回]', md)

    def test_redact(self):
        fake = 'sk_' + 'live_' + 'FAKEfakeFAKEfake0000000000abcd'  # 拼出来：别让扫描器把测试里的假 key 当真的
        self.assertNotIn('FAKEfakeFAKEfake0000', daily_review.redact(f'key {fake} 给你'))

if __name__ == '__main__':
    unittest.main()
