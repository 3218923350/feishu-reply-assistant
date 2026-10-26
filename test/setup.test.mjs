import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { MEM_MARKER, runChecks } from '../lib/setup/checks.mjs';
import { anonymize } from '../lib/setup/report.mjs';

const REPO = process.cwd();

// 一套全部配好的环境：临时 HOME / FRA_HOME / PATH，外部命令都用假的 run
function okFixture({ authOpenId = 'ou_me', aboutMe = '我负责网关', noStart = false, orcaUp = false, log = 'x start poll=90s\nx clicks ready\n' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  const fra = path.join(home, '.feishu-reply-assistant'), mem = path.join(fra, 'memory'), bin = path.join(home, 'bin');
  for (const d of [fra, mem, bin, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', launchd_label: 'com.test.fra' }));
  if (aboutMe) fs.writeFileSync(path.join(fra, 'about-me.md'), aboutMe);
  if (noStart) fs.writeFileSync(path.join(fra, '.no-start'), '');
  fs.writeFileSync(path.join(fra, 'assistant.log'), log);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `'${REPO}/bin/mem-hook' 2>/dev/null || true` }] }] } }));
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), `# x\n${MEM_MARKER}\n...\n`);
  fs.symlinkSync(path.join(REPO, 'bin', 'mem'), path.join(bin, 'mem'));
  const env = { HOME: home, FRA_HOME: fra, PATH: `${bin}:/usr/bin:/bin`, FRA_ORCA: '/x/orca' };
  const ok = (out = '') => ({ code: 0, out, err: '' });
  const run = async (cmd, args, opts = {}) => {
    const a = args.join(' ');
    if (cmd === 'lark-cli' && a.startsWith('auth status')) {
      const bot = opts.env?.FRA_TEST_BOT !== 'off';
      return ok(JSON.stringify({ identities: { user: { status: 'ready', openId: authOpenId }, bot: { available: bot } } }));
    }
    if (cmd === 'lark-cli' && a.includes('+chat-members-list')) return ok(JSON.stringify({ ok: true, data: { users: [{ open_id: 'ou_me' }], bots: [] } }));
    if (cmd === 'launchctl') return ok('state = running\n');
    if (cmd === 'git') return ok(`${mem}\n`); // 记忆目录自己就是仓库根
    if (cmd === '/x/orca') return ok(JSON.stringify({ ok: orcaUp }));
    return ok('v1');
  };
  return { home, fra, env, run, opts: { load: () => loadConfig({ env, home }), run, env, home, repo: REPO, platform: 'darwin', nodeVersion: 'v24.14.0', uid: 501 } };
}
const byName = (r, n) => r.find((c) => c.name === n);

test('runChecks：全部配好 → 都是 ✅（Orca 没开是 ⏭）；顺序和名字固定', async () => {
  const r = await runChecks(okFixture().opts);
  assert.deepEqual(r.map((c) => c.name), ['系统是 macOS', 'Node ≥ 24', 'Claude Code', 'lark-cli', '配置文件', '关于我', '飞书用户身份', '机器人身份', '草稿群',
    '卡片回调', '记忆目录', '记忆检索', 'Claude Code 记忆 hook', '全局 CLAUDE.md', 'mem 命令', '常驻服务', '每日任务', 'Orca（可选）']);
  assert.deepEqual(r.filter((c) => c.ok === false).map((c) => `${c.name}：${c.detail}`), []);
  assert.equal(byName(r, 'Orca（可选）').ok, null);
  assert.match(byName(r, 'Orca（可选）').detail, /后台跑/);
});

test('runChecks：用户身份的 open_id 和配置对不上 → ❌，fix 里两个 id 都有', async () => {
  const c = byName(await runChecks(okFixture({ authOpenId: 'ou_other' }).opts), '飞书用户身份');
  assert.equal(c.ok, false);
  assert.ok(c.fix.includes('ou_me') && c.fix.includes('ou_other'), c.fix);
});

test('runChecks：--no-start 装的 → 常驻服务和卡片回调跳过', async () => {
  const r = await runChecks(okFixture({ noStart: true, log: '' }).opts);
  assert.equal(byName(r, '常驻服务').ok, null);
  assert.equal(byName(r, '卡片回调').ok, null);
});

test('runChecks：服务启动后还没连上卡片回调 → ❌', async () => {
  const r = await runChecks(okFixture({ log: 'x start\nx clicks ready\nx start\n' }).opts);
  assert.equal(byName(r, '卡片回调').ok, false);
});

test('runChecks：没写关于我 → ❌，fix 指向 templates/about-me.md', async () => {
  const c = byName(await runChecks(okFixture({ aboutMe: '' }).opts), '关于我');
  assert.equal(c.ok, false);
  assert.match(c.fix, /templates\/about-me\.md/);
});

test('runChecks：配置读不到 → 配置文件 ❌，依赖配置的项跳过，不抛错', async () => {
  const f = okFixture();
  fs.rmSync(path.join(f.fra, 'config.json'));
  const r = await runChecks(f.opts);
  assert.equal(byName(r, '配置文件').ok, false);
  assert.match(byName(r, '配置文件').fix, /bin\/fra setup/);
  assert.equal(byName(r, '草稿群').ok, null);
});

test('runChecks：Orca 开着 → ✅', async () => {
  assert.equal(byName(await runChecks(okFixture({ orcaUp: true }).opts), 'Orca（可选）').ok, true);
});

test('anonymize：同一个 id 同一个占位符，名字按出现顺序编号，正文去掉，key 脱敏', () => {
  const t = anonymize('2026-10-26T01:00:00Z process 张三丰 @ 群A: 帮我开 abc_AbCdEf1234567890\n2026-10-26T01:00:01Z ERR ou_x1 ou_x2 ou_x1 张三', { names: ['张三', '张三丰', '群A'], prefixes: ['abc'] });
  assert.equal(t, '2026-10-26T01:00:00Z process 人#1 @ 人#2: …\n2026-10-26T01:00:01Z ERR ou#1 ou#2 ou#1 人#3');
});

test('anonymize：带时间戳的日志行也去掉正文；不同前缀的 id 分开编号', () => {
  const t = anonymize('2026-10-26T07:39:02.750Z draft answer 李四 → om_9: x\n2026-10-26T07:39:03Z sent oc_a om_9', { names: ['李四'] });
  assert.equal(t, '2026-10-26T07:39:02.750Z draft answer 人#1 → om#1: …\n2026-10-26T07:39:03Z sent oc#1 om#1');
});

// ---------- setup ----------
import { MEM_SNIPPET, addSnippet, hookCommand, mergeHook } from '../lib/setup/claude.mjs';
import { initMemoryDir } from '../lib/setup/memdir.mjs';
import { run as runProc } from '../lib/run.mjs';

test('mergeHook：空设置里加上；再跑一次不变；别的 hook 不动；路径带空格加了引号', () => {
  const cmd = hookCommand('/tmp/x/My Repo');
  assert.equal(cmd, `'/tmp/x/My Repo/bin/mem-hook' 2>/dev/null || true`);
  const a = mergeHook('', cmd);
  assert.equal(a.changed, true);
  assert.equal(JSON.parse(a.text).hooks.UserPromptSubmit[0].hooks[0].command, cmd);
  assert.equal(mergeHook(a.text, cmd).changed, false);
  const other = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other' }] }] }, model: 'x' });
  const b = JSON.parse(mergeHook(other, cmd).text);
  assert.equal(b.model, 'x');
  assert.ok(JSON.stringify(b).includes('"other"') && JSON.stringify(b).includes('mem-hook'));
});

test('mergeHook：旧路径的 mem-hook 换成新的，不重复加', () => {
  const old = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/old/bin/mem-hook 2>/dev/null || true' }] }] } });
  const r = mergeHook(old, hookCommand('/new'));
  assert.equal(r.changed, true);
  assert.equal((r.text.match(/mem-hook/g) || []).length, 1);
  assert.ok(r.text.includes('/new/bin/mem-hook'));
});

test('addSnippet：没有就追加，有就替换标记之间的内容，再跑一次不变', () => {
  const a = addSnippet('# 我的规则\n', MEM_SNIPPET);
  assert.ok(a.changed && a.text.startsWith('# 我的规则\n') && a.text.includes(MEM_MARKER) && a.text.includes('mem search'));
  assert.equal(addSnippet(a.text, MEM_SNIPPET).changed, false);
  const stale = a.text.replace('mem search', 'OLD TEXT');
  const b = addSnippet(stale + '\n# 后面的规则\n', MEM_SNIPPET);
  assert.ok(b.changed && !b.text.includes('OLD TEXT') && b.text.includes('# 后面的规则') && (b.text.match(new RegExp(MEM_MARKER, 'g')) || []).length === 1);
  assert.equal(addSnippet('', MEM_SNIPPET).text.trim().startsWith(MEM_MARKER), true);
});

test('initMemoryDir：建好目录、.gitignore、git 仓库；再跑一次 created=false', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memdir-')), 'memory');
  const run = (cmd, args, o = {}) => runProc(cmd, args, { ...o, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.deepEqual(await initMemoryDir(dir, run), { created: true });
  for (const d of ['people', 'policy', 'recipes', 'facts', 'open', 'style', 'inbox/people', 'inbox/recipes']) assert.ok(fs.existsSync(path.join(dir, d)), d);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.mem-index\.sqlite\*\n\.mem\.lock\//);
  assert.equal((await run('git', ['-C', dir, 'log', '--format=%s'])).out.trim(), '初始化记忆库');
  assert.deepEqual(await initMemoryDir(dir, run), { created: false });
});

test('install.sh：服务名取自配置；路径带空格 / & 也能写进 plist；launchctl 用假的', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inst a&b '));
  const fra = path.join(home, 'fra'), fake = path.join(home, 'fakebin');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(fra); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', launchd_label: 'com.test.fra-never-real' }));
  fs.writeFileSync(path.join(fake, 'launchctl'), `#!/bin/bash\necho "$@" >> '${path.join(home, 'launchctl.log')}'\necho "state = running"\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['install.sh'], { env: { ...process.env, HOME: home, FRA_HOME: fra, PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.readFileSync(path.join(home, 'launchctl.log'), 'utf8');
  assert.match(calls, /bootstrap gui\/\d+ .*com\.test\.fra-never-real\.plist/);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.test.fra-never-real.plist'), 'utf8');
  assert.ok(plist.includes('<string>com.test.fra-never-real</string>'));
  assert.ok(plist.includes(fra.replace('&', '&amp;')) && !plist.includes(`${fra}/`.replace(/&amp;/, '&')), plist);
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.test.fra-never-real.daily.plist')));
});

test('bin/fra setup 不在交互终端里就不跑（不给默认答案替人点头），什么文件都不碰', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-notty-'));
  const r = spawnSync(path.resolve('bin/fra'), ['setup'], { env: { ...process.env, HOME: home, FRA_HOME: path.join(home, 'fra') }, input: 'y\ny\ny\n', encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /终端/);
  assert.deepEqual(fs.readdirSync(home), []);
});

// ---------- 审查第 3、4 轮 ----------
test('runChecks：两个应用时草稿群按机器人应用下的 open_id 比', async () => {
  const f = okFixture();
  fs.writeFileSync(path.join(f.fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', bot_open_id: 'ou_mebot', draft_chat_id: 'oc_draft', launchd_label: 'com.test.fra' }));
  const run = async (cmd, args, opts) => (args.join(' ').includes('+chat-members-list') ? { code: 0, out: JSON.stringify({ data: { users: [{ member_id: 'ou_mebot' }] } }), err: '' } : f.run(cmd, args, opts));
  assert.equal(byName(await runChecks({ ...f.opts, run }), '草稿群').ok, true);
});

test('runChecks：记忆目录在别的 git 仓库里面 → ❌（提交会进那个仓库）', async () => {
  const f = okFixture();
  const run = async (cmd, args, opts) => (cmd === 'git' ? { code: 0, out: '/somewhere/else\n', err: '' } : f.run(cmd, args, opts));
  const c = byName(await runChecks({ ...f.opts, run }), '记忆目录');
  assert.equal(c.ok, false);
  assert.match(c.fix, /别的 git 仓库/);
});

test('runChecks：limit 只跑前几项（setup 第一步用），不碰飞书、不碰 launchd', async () => {
  const calls = [];
  const f = okFixture();
  const r = await runChecks({ ...f.opts, limit: 4, run: async (c, a, o) => { calls.push(c); return f.run(c, a, o); } });
  assert.equal(r.length, 4);
  assert.ok(!calls.includes('launchctl') && !calls.includes('git'));
});

test('anonymize：多行正文的后续行也去掉，直到下一条带时间戳的日志；错误的续行保留', () => {
  const t = anonymize('2026-10-26T07:39:02.750Z process 李四 @ 群A: 第一行\n账号是 a@example.com\n2026-10-26T07:39:03Z ERR x {\n  "code": 230001\n}', { names: ['李四', '群A'] });
  assert.equal(t, '2026-10-26T07:39:02.750Z process 人#1 @ 人#2: …\n…\n2026-10-26T07:39:03Z ERR x {\n  "code": 230001\n}');
});

test('anonymize：本机 home 换成 ~；网址的主机名隐藏', () => {
  const t = anonymize('memory_dir /home/alice/work/mem; url https://corp.feishu.cn/next/messenger/', { home: '/home/alice' });
  assert.equal(t, 'memory_dir ~/work/mem; url https://<主机>/next/messenger/');
});

test('reportNames：配置读不到时从坏配置、日志、事件、跟进里也能收名字', async () => {
  const { reportNames } = await import('../lib/setup/report.mjs');
  const fra = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-'));
  fs.writeFileSync(path.join(fra, 'config.json'), '{"name":"张三","leaders":["王五"],"secret_prefixes":["abc"],');
  fs.writeFileSync(path.join(fra, 'assistant.log'), '2026-10-26T07:39:02Z process 李四 @ 项目群: x\n2026-10-26T07:40:00Z draft answer 赵六 → om_1\n');
  fs.mkdirSync(path.join(fra, 'events'));
  fs.writeFileSync(path.join(fra, 'events', '2026-10.jsonl'), JSON.stringify({ kind: 'fr-sent', toName: '孙七', orig: { sender_name: '周八', chat_name: '另一个群' } }) + '\n');
  fs.writeFileSync(path.join(fra, 'followups.jsonl'), JSON.stringify({ op: 'add', watch: { name: '吴九' } }) + '\n');
  const r = reportNames(fra, null);
  for (const n of ['张三', '王五', '李四', '项目群', '赵六', '孙七', '周八', '另一个群', '吴九']) assert.ok(r.names.includes(n), n);
  assert.deepEqual(r.prefixes, ['abc']);
});

test('mergeHook：settings.json 写坏了 / UserPromptSubmit 不是数组 → 人话错误', () => {
  assert.throws(() => mergeHook('{"a":1,}', hookCommand('/r')), /settings\.json.*JSON/);
  assert.throws(() => mergeHook('{"hooks":{"UserPromptSubmit":{}}}', hookCommand('/r')), /UserPromptSubmit/);
  assert.throws(() => mergeHook('null', hookCommand('/r')), /settings\.json/);
});

test('addSnippet：标记不成对 → 报错让人工处理，不重复追加、不吞内容', () => {
  const END = '<!-- /feishu-reply-assistant:mem -->';
  assert.throws(() => addSnippet(`a\n${MEM_MARKER}\n旧的\n# 我的规则\n`, MEM_SNIPPET), /标记不成对/);
  assert.throws(() => addSnippet(`a\n${END}\n`, MEM_SNIPPET), /标记不成对/);
});

test('install.sh：仓库路径带单引号也能装', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-q-'));
  const repo = path.join(home, "it's repo");
  for (const d of ['lib', 'scripts', 'bin']) fs.cpSync(path.resolve(d), path.join(repo, d), { recursive: true });
  fs.copyFileSync('install.sh', path.join(repo, 'install.sh')); fs.copyFileSync('assistant.mjs', path.join(repo, 'assistant.mjs'));
  const fra = path.join(home, 'fra'), fake = path.join(home, 'fakebin');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true }); fs.mkdirSync(fra); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', launchd_label: 'com.test.fra-never-real-q' }));
  fs.writeFileSync(path.join(fake, 'launchctl'), '#!/bin/bash\necho "state = running"\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(repo, 'install.sh')], { env: { ...process.env, HOME: home, FRA_HOME: fra, PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.test.fra-never-real-q.plist')));
});

test('setup 的几个判断：草稿群查失败不重建；open_id 不静默覆盖；bot_open_id 要像 ou_xxx', async () => {
  const { draftGroupStep, ownerIdStep, isOpenId } = await import('../lib/setup/steps.mjs');
  assert.equal(draftGroupStep({ id: null }), 'create');
  assert.equal(draftGroupStep({ id: 'oc_1', list: { ok: true, data: { users: [{ member_id: 'ou_me' }] } }, me: 'ou_me' }), 'keep');
  assert.equal(draftGroupStep({ id: 'oc_1', list: { ok: true, data: { users: [] } }, me: 'ou_me' }), 'ask'); // 我不在群里：问要不要另建
  assert.equal(draftGroupStep({ id: 'oc_1', list: { ok: false, error: { message: 'rate limit' } }, me: 'ou_me' }), 'error'); // 查失败：别建第二个群
  assert.deepEqual(ownerIdStep(undefined, 'ou_a'), { id: 'ou_a', conflict: false });
  assert.deepEqual(ownerIdStep('ou_a', 'ou_a'), { id: 'ou_a', conflict: false });
  assert.deepEqual(ownerIdStep('ou_a', 'ou_b'), { id: 'ou_a', conflict: true });
  assert.equal(isOpenId('ou_abc123'), true);
  assert.equal(isOpenId(''), false);
  assert.equal(isOpenId('abc'), false);
});

test('runChecks：关于我还是模板原样（setup 复制过去没改）→ ❌', async () => {
  const f = okFixture({ aboutMe: fs.readFileSync('templates/about-me.md', 'utf8') });
  const c = byName(await runChecks(f.opts), '关于我');
  assert.equal(c.ok, false);
  assert.match(c.fix, /示例/);
});

test('anonymize：ALERT 和 ERR jsonl 行里带的消息正文也去掉', () => {
  const t = anonymize('2026-10-26T01:00:00Z ALERT drop 这条连续 3 次没处理成功，放弃了：李四「帮我开个号」\n2026-10-26T01:00:01Z ERR jsonl /x/events.jsonl {"text":"key 给你"', { names: ['李四'] });
  assert.equal(t, '2026-10-26T01:00:00Z ALERT drop: …\n2026-10-26T01:00:01Z ERR jsonl: …');
});
