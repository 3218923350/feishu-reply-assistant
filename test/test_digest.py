import datetime as dt, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import json
from digest import cost_summary, self_handled, summarize_changes

class SummarizeChanges(unittest.TestCase):
    def test_only_memory_dirs_and_chinese_paths(self):
        wy = Path(tempfile.mkdtemp())
        for f, title in [('facts/中文.md', '中文标题'), ('people/x.md', 'x 的卡'), ('README.md', None)]:
            (wy / f).parent.mkdir(parents=True, exist_ok=True)
            (wy / f).write_text(f'---\ntitle: {title}\n---\nbody\n' if title else '# readme\n')
        log = 'A\tfacts/中文.md\nM\tREADME.md\nM\tpeople/x.md\nD\tpolicy/gone.md\n'
        added, updated = summarize_changes(log, wy)
        self.assertEqual(added, ['中文标题'])
        self.assertEqual(updated, ['x 的卡'])

class CostSummary(unittest.TestCase):
    def test_cost_summary(self):
        now = 1_800_000_000_000
        ev = lambda what, usd, s=None, ago_h=1: {'kind': 'cost', 'what': what, 'usd': usd, 'session': s,
            'ts': dt.datetime.fromtimestamp((now - ago_h * 3600_000) / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')}
        events = [ev('draft', 0.5, 's1'), ev('draft', 0.1, 's1'), ev('draft', 0.4, 's2'), ev('work', 1.0), ev('work', None),
                  ev('learn', 0.05), ev('daily-extract', 0.3), ev('daily-merge', 0.2), ev('draft', 9.9, 's9', ago_h=26), {'kind': 'sent'}]
        self.assertEqual(cost_summary(events, now),
            '**过去 24 小时花费** $2.55：起草 2 条 $1.00、办事 2 轮 $1.00（1 轮在 Orca 终端里，费用未知）、抽记忆 $0.05、记忆整理 $0.50')
        self.assertEqual(cost_summary([], now), '')
        self.assertEqual(cost_summary([ev('draft', 0.3, 's1')], now), '**过去 24 小时花费** $0.30：起草 1 条 $0.30')

class OpenTasks(unittest.TestCase):
    def test_open_tasks(self):
        from digest import open_tasks
        log = [{'op': 'add', 'id': 'a', 'title': '修 A'}, {'op': 'add', 'id': 'b', 'title': '修 B'}, {'op': 'start', 'id': 'a'}, {'op': 'done', 'id': 'b'}, {'op': 'done', 'id': 'zz'}]
        self.assertEqual([(t['title'], t['status']) for t in open_tasks(log)], [('修 A', 'started')])

class SelfHandled(unittest.TestCase):
    """我没用草稿、自己回掉的卡：按抽取时归的类计数，「查错或跑偏」的逐条列出"""
    def day(self, items, reviews=None, **extra):
        d = Path(tempfile.mkdtemp())
        (d / 'signals.json').write_text(json.dumps({'day': '2026-10-27', 'items': items, 'no_draft': 0, 'unpaired': 0, **extra}, ensure_ascii=False))
        if reviews is not None:
            (d / 'candidates').mkdir()
            (d / 'candidates' / 'zz-signals.json').write_text(json.dumps({'structured_output': {'memories': [], 'reviews': reviews}}, ensure_ascii=False))
        return d

    def test_counts_and_lists_wrong_ones(self):
        it = lambda n, who, draft, actual: {'n': n, 'card': f'om_{n}', 'sender': who, 'chat': '私聊', 'draft': draft, 'actual': [actual]}
        d = self.day([it(1, '钱二', '先帮我们恢复到 500w TPM 吧', '我看我这里没有模型 B 这个'), it(2, '孙七', '还没加，刚在弄', '加好了'), it(3, '赵六', '可以的', '可以的～')],
                     [{'n': 1, 'reason': '查错或跑偏', 'note': '网关根本没用这个模型'}, {'n': 2, 'reason': '他自己办了', 'note': ''}, {'n': 3, 'reason': '只是改短', 'note': ''}],
                     no_draft=4, unpaired=2)
        md = self_handled(d)
        self.assertIn('**你自己回掉的卡 3 张**（有草稿你没用）：查错或跑偏 1、他自己办了 1、只是改短 1（另有没草稿的 4 张，回的是同一个人后来那张卡的 2 张不算）', md)
        self.assertIn('- 钱二：网关根本没用这个模型\n  草稿：先帮我们恢复到 500w TPM 吧\n  你回：我看我这里没有模型 B 这个', md)
        self.assertNotIn('孙七', md)

    def test_skipped_listed_with_wrong_ones(self):
        items = [{'n': 1, 'card': None, 'sender': '李四', 'chat': '对接群', 'draft': '（判了不用回：李四说加完了）', 'actual': ['看了，到账了'], 'skipped': True},
                 {'n': 2, 'card': 'c', 'sender': '王五', 'chat': '私聊', 'draft': 'a', 'actual': ['b']}]
        md = self_handled(self.day(items, [{'n': 1, 'reason': '判了不用回', 'note': '对方让你看一下，该回'}, {'n': 2, 'reason': '只是改短', 'note': ''}]))
        self.assertIn('**你自己回掉的卡 2 张**（有草稿你没用，或助手判了不用回你却回了 1 张）：判了不用回 1、只是改短 1', md)
        self.assertIn('**查错或跑偏 / 判了不用回的**\n- 李四：对方让你看一下，该回', md)

    def test_unclassified_and_empty(self):
        d = self.day([{'n': 1, 'card': 'c', 'sender': 'x', 'chat': '私聊', 'draft': 'a', 'actual': ['b']}])  # 抽取失败、没有 reviews
        self.assertEqual(self_handled(d), '**你自己回掉的卡 1 张**（有草稿你没用）：没归类 1')
        self.assertEqual(self_handled(self.day([])), '')
        self.assertEqual(self_handled(Path(tempfile.mkdtemp())), '')
        bad = self.day([{'n': 1, 'card': 'c', 'sender': 'x', 'chat': '私聊', 'draft': 'a', 'actual': ['b']}], [{'n': 1, 'reason': '瞎编的类', 'note': ''}])
        self.assertIn('没归类 1', self_handled(bad))

if __name__ == '__main__':
    unittest.main()
