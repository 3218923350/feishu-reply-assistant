import datetime as dt, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from digest import cost_summary, summarize_changes

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

if __name__ == '__main__':
    unittest.main()
