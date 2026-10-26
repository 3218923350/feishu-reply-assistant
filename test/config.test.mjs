import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, botEnv, fill, loadConfig } from '../lib/config.mjs';

// home/fra/config.json（cfg=null 就不写；字符串原样写进去，用来测坏 JSON）
function fixture(cfg, { fra = 'fra', aboutMe } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const dir = path.join(home, fra);
  fs.mkdirSync(dir, { recursive: true });
  if (cfg !== null) fs.writeFileSync(path.join(dir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  if (aboutMe != null) fs.writeFileSync(path.join(dir, 'about-me.md'), aboutMe);
  return { home, fra: dir };
}
const MIN = { name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' };

test('loadConfig：读 FRA_HOME/config.json，展开 ~，补默认值', () => {
  const { home, fra } = fixture({ ...MIN, memory_dir: '~/mem' });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.equal(c.home, fra);
  assert.equal(c.name, '张三');
  assert.equal(c.openId, 'ou_me');
  assert.equal(c.draftChatId, 'oc_draft');
  assert.equal(c.botOpenId, 'ou_me'); // 单应用：不写 bot_open_id 就等于 open_id
  assert.equal(c.memoryDir, path.join(home, 'mem'));
  assert.deepEqual([c.leaders, c.botEnv, c.secretPrefixes, c.aliases, c.aboutMe], [[], {}, [], [], '']);
  assert.equal(c.launchdLabel, 'com.feishu-reply-assistant');
  assert.equal(c.legacyWorkDir, null);
  assert.equal(c.messengerUrl, null);
});

test('loadConfig：不设 FRA_HOME 用 ~/.feishu-reply-assistant；memory_dir 默认在它下面', () => {
  const { home } = fixture(MIN, { fra: '.feishu-reply-assistant' });
  const c = loadConfig({ env: {}, home });
  assert.equal(c.home, path.join(home, '.feishu-reply-assistant'));
  assert.equal(c.memoryDir, path.join(home, '.feishu-reply-assistant', 'memory'));
});

test('loadConfig：读 about-me.md、legacy_work_dir 展开 ~、// 开头的说明键忽略', () => {
  const { home, fra } = fixture({ ...MIN, legacy_work_dir: '~/old', '//name': '说明', bot_open_id: 'ou_bot' }, { aboutMe: '我负责网关\n' });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.equal(c.aboutMe, '我负责网关\n');
  assert.equal(c.legacyWorkDir, path.join(home, 'old'));
  assert.equal(c.botOpenId, 'ou_bot');
});

test('loadConfig：没有文件 / JSON 坏 / 缺必填 → ConfigError，指向 bin/fra setup', () => {
  for (const bad of [null, '{oops', JSON.stringify({ name: '张三', open_id: 'ou_me' })]) {
    const { home, fra } = fixture(bad);
    assert.throws(() => loadConfig({ env: { FRA_HOME: fra }, home }), (e) => e instanceof ConfigError
      && e.message.includes(path.join(fra, 'config.json')) && e.message.includes('bin/fra setup'), String(bad));
  }
  const { home, fra } = fixture({ name: '张三', open_id: 'ou_me' });
  assert.throws(() => loadConfig({ env: { FRA_HOME: fra }, home }), /draft_chat_id/);
});

test('aliases 编成不区分大小写的正则', () => {
  const { home, fra } = fixture({ ...MIN, aliases: [['model\\s*plan|modelplan', 'model-plan']] });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.equal(c.aliases[0][0].test('Model Plan'), true);
  assert.equal(c.aliases[0][1], 'model-plan');
});

test('fill：换姓名和关于我；没写关于我时给出提示，不留 {{', () => {
  assert.equal(fill('替{{name}}起草，{{name}}说了算\n{{about_me}}', { name: '张三', aboutMe: '我负责网关', home: '/x' }), '替张三起草，张三说了算\n我负责网关');
  const t = fill('{{about_me}}', { name: '张三', aboutMe: '', home: '/x' });
  assert.ok(t.includes('还没写「关于我」') && t.includes('/x/about-me.md') && !t.includes('{{'), t);
});

test('botEnv：bot_env 合进环境变量，~ 已展开', () => {
  const { home, fra } = fixture({ ...MIN, bot_env: { LARKSUITE_CLI_CONFIG_DIR: '~/.lark-bot' } });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.deepEqual(botEnv(c, { PATH: '/bin' }), { PATH: '/bin', LARKSUITE_CLI_CONFIG_DIR: path.join(home, '.lark-bot') });
});

test('loadConfig：字段形状不对也给人话 ConfigError，不甩 TypeError / SyntaxError', () => {
  const cases = [['null', /对象/], ['[]', /对象/], [JSON.stringify({ ...MIN, aliases: [['(', 'x']] }), /aliases/], [JSON.stringify({ ...MIN, aliases: ['modelplan'] }), /aliases/],
    [JSON.stringify({ ...MIN, bot_env: '~/.lark-bot' }), /bot_env/], [JSON.stringify({ ...MIN, memory_dir: 5 }), /memory_dir/], [JSON.stringify({ ...MIN, leaders: '李四' }), /leaders/]];
  for (const [raw, re] of cases) {
    const { home, fra } = fixture(raw);
    assert.throws(() => loadConfig({ env: { FRA_HOME: fra }, home }), (e) => e instanceof ConfigError && re.test(e.message) && e.message.includes('bin/fra setup'), raw);
  }
});

test('loadConfig：相对路径（FRA_HOME、memory_dir）都变成绝对路径', () => {
  const { home, fra } = fixture({ ...MIN, memory_dir: 'mem' });
  const c = loadConfig({ env: { FRA_HOME: path.relative(process.cwd(), fra) }, home });
  assert.equal(c.home, fra);
  assert.equal(c.memoryDir, path.join(fra, 'mem')); // 相对 memory_dir 按 FRA_HOME 解析，不随 cwd 变
});

test('照模板只填必填项：单应用、不走网页替发，不会静默坏掉', () => {
  const t = JSON.parse(fs.readFileSync('templates/config.example.json', 'utf8'));
  const { home, fra } = fixture({ ...t, name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.equal(c.botOpenId, 'ou_me');
  assert.deepEqual(c.botEnv, {});
  assert.equal(c.messengerUrl, null);
});

test('fill：关于我里的 $& / $` 原样保留，不当替换模式', () => {
  const t = fill('X {{about_me}} Y {{name}}', { name: 'a$&b', aboutMe: "git log --pretty=$'%h' $` $&", home: '/x' });
  assert.equal(t, "X git log --pretty=$'%h' $` $& Y a$&b");
});

test('loadConfig：launchd_label 只能是字母数字和 . _ -（它会拼进文件名和 plist）', () => {
  const { home, fra } = fixture({ ...MIN, launchd_label: 'com.foo/bar' });
  assert.throws(() => loadConfig({ env: { FRA_HOME: fra }, home }), /launchd_label/);
});

test('expandBotEnv：setup 还没写配置时，机器人环境变量里的 ~ 也要展开', async () => {
  const { expandBotEnv } = await import('../lib/config.mjs');
  assert.deepEqual(expandBotEnv({ LARKSUITE_CLI_CONFIG_DIR: '~/.lark-bot' }, '/home/u'), { LARKSUITE_CLI_CONFIG_DIR: '/home/u/.lark-bot' });
  assert.deepEqual(expandBotEnv(undefined, '/home/u'), {});
});

test('照模板原样复制：记忆目录在 FRA_HOME 下，没有示例上级', () => {
  const t = JSON.parse(fs.readFileSync('templates/config.example.json', 'utf8'));
  const { home, fra } = fixture({ ...t, name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft' });
  const c = loadConfig({ env: { FRA_HOME: fra }, home });
  assert.equal(c.memoryDir, path.join(fra, 'memory'));
  assert.deepEqual(c.leaders, []);
});
