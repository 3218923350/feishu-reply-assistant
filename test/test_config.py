import datetime as dt, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
SCRIPTS = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import fra_config

MIN = {'name': '张三', 'open_id': 'ou_me', 'draft_chat_id': 'oc_draft'}

def fixture(cfg, about=None, sub='fra'):
    home = Path(tempfile.mkdtemp()); d = home / sub; d.mkdir()
    if cfg is not None: (d / 'config.json').write_text(cfg if isinstance(cfg, str) else json.dumps(cfg, ensure_ascii=False))
    if about is not None: (d / 'about-me.md').write_text(about)
    return home, d

class Load(unittest.TestCase):
    def test_defaults(self):
        home, d = fixture({**MIN, 'memory_dir': '~/mem', 'bot_env': {'LARKSUITE_CLI_CONFIG_DIR': '~/.lark-bot'}})
        c = fra_config.load({'FRA_HOME': str(d), 'HOME': str(home)})
        self.assertEqual(c['home'], str(d))
        self.assertEqual(c['bot_open_id'], 'ou_me')
        self.assertEqual(c['memory_dir'], str(home / 'mem'))
        self.assertEqual([c['leaders'], c['secret_prefixes'], c['legacy_work_dir'], c['messenger_url']], [[], [], None, None])
        self.assertEqual(c['launchd_label'], 'com.feishu-reply-assistant')
        self.assertEqual(fra_config.bot_env(c, {'PATH': '/bin'}), {'PATH': '/bin', 'LARKSUITE_CLI_CONFIG_DIR': str(home / '.lark-bot')})

    def test_default_home(self):
        home, d = fixture(MIN, sub='.feishu-reply-assistant')
        c = fra_config.load({'HOME': str(home)})
        self.assertEqual(c['home'], str(d))
        self.assertEqual(c['memory_dir'], str(d / 'memory'))

    def test_missing_or_bad(self):
        for bad in [None, '{oops', json.dumps({'name': '张三', 'open_id': 'ou_me'})]:
            home, d = fixture(bad)
            with self.assertRaises(fra_config.ConfigError) as e:
                fra_config.load({'FRA_HOME': str(d), 'HOME': str(home)})
            self.assertIn('bin/fra setup', str(e.exception)); self.assertIn(str(d / 'config.json'), str(e.exception))

    def test_bad_shape(self):
        for raw in ['null', '[]', json.dumps({**MIN, 'bot_env': '~/.x'}), json.dumps({**MIN, 'memory_dir': 5})]:
            home, d = fixture(raw)
            with self.assertRaises(fra_config.ConfigError, msg=raw):
                fra_config.load({'FRA_HOME': str(d), 'HOME': str(home)})

    def test_relative_paths_absolute(self):
        home, d = fixture({**MIN, 'memory_dir': 'mem'})
        rel = os.path.relpath(d)
        c = fra_config.load({'FRA_HOME': rel, 'HOME': str(home)})
        self.assertEqual(c['home'], str(d)); self.assertEqual(c['memory_dir'], str(d / 'mem'))

    def test_about_me_unreadable(self):
        home, d = fixture(MIN); (d / 'about-me.md').mkdir()
        self.assertEqual(fra_config.load({'FRA_HOME': str(d), 'HOME': str(home)})['about_me'], '')

class Fill(unittest.TestCase):
    def test_fill(self):
        self.assertEqual(fra_config.fill('替{{name}}\n{{about_me}}', {'name': '张三', 'about_me': '我负责网关', 'home': '/x'}), '替张三\n我负责网关')
        t = fra_config.fill('{{about_me}}', {'name': '张三', 'about_me': '', 'home': '/x'})
        self.assertIn('还没写「关于我」', t); self.assertIn('/x/about-me.md', t); self.assertNotIn('{{', t)

    def test_fill_cli(self):
        home, d = fixture(MIN, about='关于我')
        f = d / 'p.md'; f.write_text('替{{name}}起草')
        r = subprocess.run([sys.executable, str(SCRIPTS / 'fra_config.py'), 'fill', str(f)], capture_output=True, text=True,
                           env={**os.environ, 'FRA_HOME': str(d), 'HOME': str(home)})
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(r.stdout, '替张三起草')

class Cost(unittest.TestCase):
    def test_record_cost(self):
        home, d = fixture(MIN)
        c = fra_config.load({'FRA_HOME': str(d), 'HOME': str(home)})
        fra_config.record_cost(c, 'daily-merge', 0.2)
        f = d / 'events' / f'{dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")}.jsonl'
        e = json.loads(f.read_text().splitlines()[-1])
        self.assertEqual((e['kind'], e['what'], e['usd']), ('cost', 'daily-merge', 0.2))
        self.assertTrue(e['ts'].endswith('Z'))

if __name__ == '__main__':
    unittest.main()
