import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serializeEntry } from '../../lib/memory/store.mjs';

const MEM = path.resolve('bin/mem'), HOOK = path.resolve('bin/mem-hook');

// FRA_HOME 下写配置，记忆目录里放一条
function fixture({ config = true, git = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-'));
  const fra = path.join(home, 'fra'), mem = path.join(home, 'mem');
  fs.mkdirSync(fra, { recursive: true });
  fs.mkdirSync(path.join(mem, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'recipes', '白名单.md'), serializeEntry({ meta: { type: 'recipe', title: '海外模型白名单开通', status: 'active', review: 'auto', updated: '2026-10-22' }, body: '2026-10-22 按账号码加白名单\n' }));
  if (config) fs.writeFileSync(path.join(fra, 'config.json'), JSON.stringify({ name: '张三', open_id: 'ou_me', draft_chat_id: 'oc_draft', memory_dir: config === 'nodir' ? path.join(home, 'nope') : mem }));
  if (git) spawnSync('git', ['init', '-q', mem]);
  const env = { ...process.env, HOME: home, FRA_HOME: fra };
  return { home, fra, mem, env, run: (bin, args, input) => spawnSync(bin, args, { env, input, encoding: 'utf8' }) }; // 直接执行，走 shebang（含 --no-warnings）
}

test('mem search 用配置里的记忆目录，索引文件是 .mem-index.sqlite', () => {
  const f = fixture();
  const r = f.run(MEM, ['search', '白名单', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).some((h) => h.title === '海外模型白名单开通'));
  assert.ok(fs.existsSync(path.join(f.mem, '.mem-index.sqlite')));
  assert.ok(!fs.existsSync(path.join(f.mem, '.index.sqlite')));
});

test('mem archive 不再有：打印用法、退出码 1', () => {
  const r = fixture().run(MEM, ['archive', '开通']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /用法/);
  assert.ok(!r.stdout.includes('archive'));
});

test('mem 没有配置：退出码非 0，stderr 含 bin/fra setup', () => {
  const r = fixture({ config: false }).run(MEM, ['search', '白名单']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bin\/fra setup/);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr); // 不是堆栈
});

test('mem-hook 没有配置：退出码 0、没有输出', () => {
  const r = fixture({ config: false }).run(HOOK, [], JSON.stringify({ prompt: '海外模型白名单怎么开通呢' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('mem-hook 有配置：命中就注入线索', () => {
  const r = fixture().run(HOOK, [], JSON.stringify({ prompt: '海外模型白名单怎么开通呢' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /海外模型白名单开通/);
});

test('记忆目录不存在：mem 打一行人话退出非 0；mem-hook 静默退出 0', () => {
  const f = fixture({ config: 'nodir' });
  const r = f.run(MEM, ['search', '白名单']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /记忆目录/);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
  const h = f.run(HOOK, [], JSON.stringify({ prompt: '海外模型白名单怎么开通呢' }));
  assert.equal(h.status, 0, h.stderr);
  assert.equal(h.stdout + h.stderr, '');
});

test('mem-hook：stdin 不是 JSON 也静默退出 0', () => {
  const h = fixture().run(HOOK, [], 'oops');
  assert.equal(h.status, 0, h.stderr);
  assert.equal(h.stdout, '');
});

test('记忆目录不是 git 仓库：mem add 照样写进去，退出码 0', () => {
  const f = fixture();
  const item = { type: 'fact', title: '网关地址', entities: [], scope: '', content: '2026-10-22 gw.example.com', sources: ['s#1'], observed: '2026-10-22', confidence: 'high', review: 'auto' };
  const r = f.run(MEM, ['add', '-'], JSON.stringify([item]));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.mem, 'facts', '网关地址.md')));
});

test('记忆目录是 git 仓库：mem add 提交一次', () => {
  const f = fixture({ git: true });
  const item = { type: 'fact', title: '网关地址', entities: [], scope: '', content: '2026-10-22 gw.example.com', sources: ['s#1'], observed: '2026-10-22', confidence: 'high', review: 'auto' };
  const r = f.run(MEM, ['add', '-', '--message', '测试'], JSON.stringify([item]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(spawnSync('git', ['-C', f.mem, 'log', '--format=%s'], { encoding: 'utf8' }).stdout, /测试/);
});

// 后台跑一个命令，返回退出码、输出和耗时
const spawnMem = async (f, args) => {
  const { spawn } = await import('node:child_process');
  const t0 = Date.now(), c = spawn(MEM, args, { env: f.env });
  let out = '', err = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => c.on('close', r));
  return { code, out, err, ms: Date.now() - t0 };
};
const hasHit = (r) => (r.code ?? r.status) === 0 && JSON.parse(r.out ?? r.stdout).some((h) => h.title === '海外模型白名单开通'); // spawn 和 spawnSync 的结果都认

test('索引过期、又正好有人拿着写锁：读不等它，马上用现有的索引返回结果', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture();
  assert.equal(f.run(MEM, ['search', '白名单', '--json']).status, 0); // 先建好索引
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(f.mem, 'recipes', '白名单.md'), t, t); // 让索引过期
  const holder = new DatabaseSync(path.join(f.mem, '.mem-index.sqlite'));
  holder.exec('BEGIN IMMEDIATE'); // 别的进程正拿着写锁，3 秒后才放
  const done = new Promise((r) => setTimeout(() => { holder.exec('COMMIT'); holder.close(); r(); }, 3000));
  const r = await spawnMem(f, ['search', '白名单', '--json']);
  await done;
  assert.ok(hasHit(r), r.err);
  assert.ok(r.ms < 2000, `等了 ${r.ms}ms`);
});

test('mem add 返回时新记忆就能搜到', () => {
  const f = fixture();
  f.run(MEM, ['search', '白名单']);
  const item = { type: 'fact', title: '网关地址', entities: [], scope: '', content: '2026-10-22 网关在 gw.example.com', sources: ['s#1'], observed: '2026-10-22', confidence: 'high', review: 'auto' };
  assert.equal(f.run(MEM, ['add', '-'], JSON.stringify([item])).status, 0);
  assert.ok(JSON.parse(f.run(MEM, ['search', '网关地址', '--json']).stdout).some((h) => h.title === '网关地址'));
});

test('不经过 mem add 直接写进目录的记忆（Claude Code 自动记忆）：下一次查就能搜到', () => {
  const f = fixture();
  f.run(MEM, ['search', '白名单']);
  fs.writeFileSync(path.join(f.mem, 'recipes', '额度.md'), serializeEntry({ meta: { type: 'recipe', title: '调整按量额度', status: 'active', review: 'auto', updated: '2026-10-22' }, body: '2026-10-22 额度在后台改\n' }));
  assert.ok(JSON.parse(f.run(MEM, ['search', '额度', '--json']).stdout).some((h) => h.title === '调整按量额度'));
});

test('索引版本旧了（升级后）：重建好再读，结果照常', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture();
  f.run(MEM, ['search', '白名单']);
  const db = new DatabaseSync(path.join(f.mem, '.mem-index.sqlite'));
  db.exec('PRAGMA user_version = 1'); db.close();
  assert.ok(hasHit(f.run(MEM, ['search', '白名单', '--json'])));
});

test('几十个读同时跑，同时有人 mem reindex、有人改记忆：读全部成功、都有结果', async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(f.mem, 'recipes', `r${i}.md`), serializeEntry({ meta: { type: 'recipe', title: `配方${i}`, status: 'active', review: 'auto', updated: '2026-10-22' }, body: `2026-10-22 第 ${i} 条\n` }));
  f.run(MEM, ['search', '白名单']);
  let writing = true;
  const writer = (async () => { for (let i = 0; writing; i++) { fs.appendFileSync(path.join(f.mem, 'recipes', `r${i % 200}.md`), `追加 ${i}\n`); await new Promise((r) => setTimeout(r, 30)); } })();
  const reads = Array.from({ length: 30 }, () => spawnMem(f, ['search', '白名单', '--json']));
  const reindex = spawnMem(f, ['reindex']);
  const rs = await Promise.all(reads);
  writing = false; await writer;
  assert.equal((await reindex).code, 0);
  const bad = rs.filter((r) => !hasHit(r));
  assert.deepEqual(bad.map((r) => r.err || r.out.slice(0, 80)), []);
});

test('好几个 mem 同时刷新过期的索引：都成功，同一个文件不会进索引两次', async () => {
  const { spawn } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture();
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(f.mem, 'recipes', `r${i}.md`), serializeEntry({ meta: { type: 'recipe', title: `配方${i}`, status: 'active', review: 'auto', updated: '2026-10-22' }, body: `2026-10-22 第 ${i} 条白名单\n` }));
  const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise((r) => spawn(MEM, ['search', '白名单', '--json'], { env: f.env }).on('close', r))));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  const db = new DatabaseSync(path.join(f.mem, '.mem-index.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM docs').get().n, db.prepare('SELECT COUNT(DISTINCT path) n FROM docs').get().n);
});

test('mem add：缺必填字段（比如把正文写成 body）→ 拒收，说清是第几条缺了什么，什么都不写', () => {
  const f = fixture();
  const r = f.run(MEM, ['add', '-'], JSON.stringify([{ type: 'fact', title: '网关地址', entities: [], scope: '', body: 'x', sources: ['s#1'], observed: '2026-10-22', confidence: 'high', review: 'auto' }]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /第 1 条.*content/);
  assert.ok(!fs.existsSync(path.join(f.mem, 'facts')));
});

test('mem：输入不是 JSON、reject 不在待确认里的条目 → 一行人话，不甩堆栈', () => {
  const f = fixture();
  for (const [args, input] of [[['add', '-'], 'not json'], [['reject', path.join(f.mem, 'recipes', '白名单.md')], '']]) {
    const r = f.run(MEM, args, input);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.ok(r.stderr.trim() && !/\n\s+at /.test(r.stderr), r.stderr);
  }
});
