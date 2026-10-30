import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFromStream, lastTalkAt, shq, staleWork, workLaunch, workProcs } from '../lib/work.mjs';
import { EXEC_DENY } from '../lib/tools.mjs';
import { launcherFor, orcaBin } from '../lib/orca.mjs';

const base = { repo: '/tmp/a b/repo', where: '/tmp/a b/repo', cwd: '/tmp/a b/repo/workspace', session: 's1', promptFile: '/tmp/a b/p.md',
  ctxFile: '/tmp/a b/c.json', logFile: '/tmp/a b/w.log', claude: 'claude', deny: ['Bash(lark-cli im +messages-send:*)'], title: '办·李四', prompt: '去办', env: { PATH: '/bin' } };

test('workLaunch：有 Orca → terminal create，命令里路径加了引号、带 FR_CTX、禁发消息', () => {
  const l = workLaunch({ ...base, orca: '/x/orca' });
  assert.equal(l.via, 'orca');
  assert.equal(l.cmd, '/x/orca');
  assert.deepEqual(l.args.slice(0, 4), ['terminal', 'create', '--worktree', 'path:/tmp/a b/repo']);
  const cmd = l.args[l.args.indexOf('--command') + 1];
  assert.ok(cmd.startsWith(`cd '/tmp/a b/repo/workspace' && `), cmd);
  assert.ok(cmd.includes(`'/tmp/a b/repo/bin'`) && cmd.includes(`FR_CTX='/tmp/a b/c.json'`) && cmd.includes(`'Bash(lark-cli im +messages-send:*)'`), cmd);
  assert.ok(cmd.includes(`--resume 's1'`) && cmd.includes(`"$(cat '/tmp/a b/p.md')"`), cmd);
});

test('workLaunch：没有 Orca → claude -p --resume，stream-json，env 里有 FR_CTX、PATH 前面是 repo/bin', () => {
  const l = workLaunch({ ...base, orca: null });
  assert.equal(l.via, 'spawn');
  assert.equal(l.cmd, 'claude');
  assert.equal(l.cwd, '/tmp/a b/repo/workspace');
  assert.deepEqual(l.args.slice(0, 3), ['--resume', 's1', '--dangerously-skip-permissions']);
  assert.ok(l.args.includes('stream-json') && l.args.includes('--verbose') && l.args.at(-1) === '去办' && l.args.at(-2) === '-p');
  assert.ok(l.args.includes('Bash(lark-cli im +messages-send:*)'));
  assert.equal(l.env.FR_CTX, '/tmp/a b/c.json');
  assert.ok(l.env.PATH.startsWith('/tmp/a b/repo/bin:'));
});

test('shq：单引号也能转义', () => assert.equal(shq("it's"), `'it'\\''s'`));

test('costFromStream：取最后一行 result 的 total_cost_usd；没有就 null', () => {
  assert.equal(costFromStream('{"type":"assistant"}\n{"type":"result","total_cost_usd":0.42}\n'), 0.42);
  assert.equal(costFromStream('{"type":"assistant"}\nnot json\n'), null);
  assert.equal(costFromStream(''), null);
});

test('orcaBin：FRA_ORCA 优先，其次 PATH，再其次 /Applications，都没有 null', () => {
  const APP = '/Applications/Orca.app/Contents/Resources/bin/orca';
  assert.equal(orcaBin({ FRA_ORCA: '/x/orca', PATH: '/p' }, () => true), '/x/orca');
  assert.equal(orcaBin({ PATH: '/a:/p' }, (f) => f === '/p/orca' || f === APP), '/p/orca');
  assert.equal(orcaBin({ PATH: '/a' }, (f) => f === APP), APP);
  assert.equal(orcaBin({ PATH: '/a' }, () => false), null);
});

test('launcherFor：装了 Orca 但没开（status 不 ok）→ null', async () => {
  assert.equal(await launcherFor(async () => ({ code: 0, out: '{"ok":false}' }), '/x/orca'), null);
  assert.equal(await launcherFor(async () => ({ code: 1, out: '' }), '/x/orca'), null);
  assert.equal(await launcherFor(async () => ({ code: 0, out: '{"ok":true}' }), '/x/orca'), '/x/orca');
  assert.equal(await launcherFor(async () => ({ code: 0, out: '{"ok":true}' }), null), null);
});

test('workCostOnce：进程退出后记一次费用；再调用不重复记', async () => {
  const { workCostOnce } = await import('../lib/work.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-')), 'w.log');
  fs.writeFileSync(log, '{"type":"result","total_cost_usd":0.7}\n');
  const got = [];
  workCostOnce(log, (usd) => got.push(usd));
  workCostOnce(log, (usd) => got.push(usd));
  assert.deepEqual(got, [0.7]);
});

test('alive：自己活着，不存在的 pid 不活', async () => {
  const { alive } = await import('../lib/work.mjs');
  assert.equal(alive(process.pid), true);
  assert.equal(alive(99999999), false);
});

test('launchWork：Orca 开终端失败 → 退回后台跑，不报错；成功 → 用终端；没有 Orca → 后台', async () => {
  const { launchWork } = await import('../lib/work.mjs');
  const started = [];
  const startHeadless = (l) => { started.push(l); return 4242; };
  const fail = await launchWork({ how: base, orca: '/x/orca', run: async () => ({ code: 1, out: '', err: 'no worktree' }), startHeadless, log() {} });
  assert.deepEqual([fail.inOrca, fail.pid, started.at(-1).via], [false, 4242, 'spawn']);
  const ok = await launchWork({ how: base, orca: '/x/orca', run: async () => ({ code: 0, out: JSON.stringify({ result: { terminal: { handle: 't1' } } }) }), startHeadless, log() {} });
  assert.deepEqual([ok.inOrca, ok.terminal, ok.pid], [true, 't1', null]);
  const none = await launchWork({ how: base, orca: null, run: async () => { throw new Error('不该调 orca'); }, startHeadless, log() {} });
  assert.deepEqual([none.inOrca, none.pid], [false, 4242]);
  assert.equal(started.length, 2);
});

test('workLaunch：Orca 终端里带上 FRA_HOME（Orca 自己的环境里没有，fr / mem 会读错数据目录）', () => {
  const l = workLaunch({ ...base, orca: '/x/orca', home: '/tmp/a b/fra' });
  assert.ok(l.args[l.args.indexOf('--command') + 1].includes(`FRA_HOME='/tmp/a b/fra'`));
  assert.equal(workLaunch({ ...base, orca: null, home: '/tmp/a b/fra' }).env.FRA_HOME, '/tmp/a b/fra');
});

// 10-27：Orca 里的办事 claude 办完不退，漏了 32 个、约 8.6GB；回收只认助手自己起的进程
const S1 = '11111111-2222-3333-4444-555555555555', S2 = '66666666-7777-8888-9999-000000000000';
const argv = (sid, deny = EXEC_DENY) => `/opt/bin/claude --resume ${sid} --dangerously-skip-permissions --disallowedTools ${deny.join(' ')} -- 去办`;
test('workProcs：只认 claude --resume <会话> + 完整的 EXEC_DENY；我自己开的 claude、别家 harness 带着这串字样的都不认', () => {
  const ps = [
    ` 101 ${argv(S1)}`,
    ` 102 claude --resume ${S2} --dangerously-skip-permissions`, // 我自己 --resume 的
    ` 103 /opt/bin/claude --output-format stream-json --resume=${S2}`, // Orca 聊天
    ` 104 node /x/dsh --prompt "找带 --disallowedTools Bash(lark-cli im +messages-send:*) 的 claude --resume ${S1}"`, // 别家 harness 的题目原文
    ` 105 ${argv(S2, EXEC_DENY.slice(0, 3))}`, // 老版本的 deny 列表（短）：不是现在这版起的，不认
    ` 106 claude --dangerously-skip-permissions`,
  ].join('\n');
  assert.deepEqual(workProcs(ps, EXEC_DENY), [{ pid: 101, session: S1 }]);
});

test('lastTalkAt：只看 user / assistant 的时间；空闲进程写的记账行（没时间戳或 system）不算', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-23T13:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T13:22:00.000Z' }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-23T13:22:30.000Z' }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }),
    'not json',
  ].join('\n');
  assert.equal(lastTalkAt(jsonl), Date.parse('2026-10-23T13:22:00.000Z'));
  assert.equal(lastTalkAt(''), 0);
});

test('staleWork：会话是助手的、不在办、最后一句对话超过 30 分钟才收；拿不到对话时间不收', () => {
  const now = Date.parse('2026-10-27T12:00:00Z'), old = now - 3600_000, fresh = now - 60_000;
  const procs = [{ pid: 1, session: 'a' }, { pid: 2, session: 'b' }, { pid: 3, session: 'c' }, { pid: 4, session: 'd' }, { pid: 5, session: 'x' }];
  const talk = { a: old, b: old, c: fresh, d: 0, x: old };
  const r = staleWork(procs, { known: new Set(['a', 'b', 'c', 'd']), busy: new Set(['b']), lastTalk: (s) => talk[s], now });
  assert.deepEqual(r.map((p) => p.pid), [1]);
});
