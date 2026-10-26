import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEntry } from '../../lib/memory/store.mjs';
import { DEFAULT_ROOTS, bigrams, openIndex, queryText, refresh, search } from '../../lib/memory/index.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-idx-'));
  const wy = path.join(base, 'wy'), ext = path.join(base, 'ext');
  const put = (dir, file, meta, body) => {
    fs.mkdirSync(path.join(wy, dir), { recursive: true });
    fs.writeFileSync(path.join(wy, dir, file), serializeEntry({ meta: { status: 'active', review: 'auto', updated: '2026-10-22', ...meta }, body }));
  };
  put('policy', '按量开通规则.md', { type: 'policy', title: '按量开通规则' }, '2026-10-21 按量开通需要账号码\n');
  put('facts', '模型网关地址.md', { type: 'fact', title: '模型网关地址' }, '2026-10-21 网关地址 https://gw.example.com/v1\n');
  put('people', '孙七.md', { type: 'person', title: '孙七：发版负责人', entities: ['孙七'] }, '2026-10-22 负责 svc-a 发版\n');
  fs.mkdirSync(ext, { recursive: true });
  const filler = '这是一段很长的填充说明文字。'.repeat(500);
  fs.writeFileSync(path.join(ext, 'big.md'), `# 总览\n${filler}\n## 白名单配方\n用 grant.py 给账号加紫罗兰白名单\n`);
  const roots = [{ root: 'mine', dir: wy }, { root: 'claude:proj', dir: ext, type: 'project-memory' }];
  const db = openIndex(path.join(base, 'idx.sqlite'));
  refresh(db, roots);
  return { wy, ext, roots, db };
}

test('bigrams：中文切成相邻二字，英文原样', () => {
  assert.equal(bigrams('按量开通 opus'), '按量 量开 开通 opus');
});

test('搜「开通」命中按量开通规则', () => {
  const { db } = fixture();
  assert.ok(search(db, '开通').some((h) => h.title === '按量开通规则'));
});

test('--type 只回该类型', () => {
  const { db } = fixture();
  const hits = search(db, '网关 规则 开通', { type: 'policy' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.type === 'policy'));
});

test('scope=mine 不回外部记忆', () => {
  const { db } = fixture();
  assert.equal(search(db, '紫罗兰', { scope: 'mine' }).length, 0);
});

test('超长外部文件按标题切块，命中返回 路径#块号', () => {
  const { db, ext } = fixture();
  const h = search(db, '紫罗兰')[0];
  assert.equal(h.root, 'claude:proj');
  assert.match(h.path, new RegExp(`^${path.join(ext, 'big.md')}#\\d+$`));
  assert.notEqual(h.path.split('#')[1], '1');
});

test('改 mtime 后 refresh 只算一个变化', () => {
  const { db, roots, wy } = fixture();
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(wy, 'facts', '模型网关地址.md'), t, t);
  assert.equal(refresh(db, roots).changed, 1);
});

test('删掉文件后不再命中', () => {
  const { db, roots, wy } = fixture();
  fs.unlinkSync(path.join(wy, 'policy', '按量开通规则.md'));
  refresh(db, roots);
  assert.ok(!search(db, '开通').some((h) => h.title === '按量开通规则'));
});

test('奇怪的查询不报错', () => {
  const { db } = fixture();
  for (const q of ['"', '-*', '', '按', '：', 'a"b OR']) assert.doesNotThrow(() => search(db, q), q);
  assert.deepEqual(search(db, ''), []);
});

test('who：本人的卡排在提到他的卡前面', async () => {
  const { who } = await import('../../lib/memory/index.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-who-'));
  const put = (file, meta, body) => {
    fs.mkdirSync(path.join(base, 'people'), { recursive: true });
    fs.writeFileSync(path.join(base, 'people', file), serializeEntry({ meta: { type: 'person', status: 'active', review: 'auto', updated: '2026-10-22', ...meta }, body }));
  };
  put('卫三.md', { title: '卫三：widget 开发', entities: ['卫三'] }, '常找孙七合 MR，孙七 孙七 孙七\n');
  put('孙七.md', { title: '孙七（七哥）：发版负责人', entities: ['孙七', 'u9999qqq'] }, '负责发版\n');
  const db = openIndex(path.join(base, 'idx.sqlite'));
  refresh(db, [{ root: 'mine', dir: base }]);
  assert.equal(who(db, '孙七').person[0].title, '孙七（七哥）：发版负责人');
  assert.equal(who(db, 'u9999qqq').person[0].title, '孙七（七哥）：发版负责人');
});

// 同义词由配置给（config.json 的 aliases）
const CP = [[/model\s*plan|modelplan/i, 'model-plan']];

// 2026-10-23 检索质量：口语里的连写英文、停用词、外部记忆噪音
function fixture2() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-q-'));
  const wy = path.join(base, 'wy'), ext = path.join(base, 'ext');
  const put = (dir, file, meta, body) => {
    fs.mkdirSync(path.join(wy, dir), { recursive: true });
    fs.writeFileSync(path.join(wy, dir, file), serializeEntry({ meta: { status: 'active', review: 'auto', updated: '2026-10-22', ...meta }, body }));
  };
  put('recipes', '开通.md', { type: 'recipe', title: 'model-plan 个人开通：用量计费、海外模型白名单' }, '2026-10-22 账号码开通按量\n');
  put('style', '风格.md', { type: 'style', title: '和韩八沟通：私聊随意' }, '2026-10-22 帮忙看一下这个就行，可以的\n');
  fs.mkdirSync(ext, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ext, `n${i}.md`), `# 笔记${i}\n帮钱总开个东西，可以看一下 model plan 第 ${i} 条\n`);
  const db = openIndex(path.join(base, 'idx.sqlite'));
  refresh(db, [{ root: 'mine', dir: wy }, { root: 'claude:proj', dir: ext, type: 'project-memory' }]);
  return db;
}

test('连写的 modelplan 也能命中 model-plan 的配方（进前 3）', () => {
  const hits = search(fixture2(), '帮钱总开个modelplan哈', { aliases: CP });
  assert.ok(hits.slice(0, 3).some((h) => h.title === 'model-plan 个人开通：用量计费、海外模型白名单'), JSON.stringify(hits.map((h) => h.title)));
});

test('外部项目记忆最多占 2 条', () => {
  const hits = search(fixture2(), 'model plan 钱总', { limit: 8 });
  assert.ok(hits.filter((h) => h.root !== 'mine').length <= 2, JSON.stringify(hits.map((h) => h.root)));
});

test('只命中停用词（看一下 / 可以 / 帮忙）的不算命中', () => {
  assert.deepEqual(search(fixture2(), '帮忙看一下可以吗').map((h) => h.title), []);
});

test('who 带 open_id：精确找到本人的卡，哪怕卡上的名字不同', async () => {
  const { who } = await import('../../lib/memory/index.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-who2-'));
  fs.mkdirSync(path.join(base, 'people'), { recursive: true });
  const put = (file, meta) => fs.writeFileSync(path.join(base, 'people', file), serializeEntry({ meta: { type: 'person', status: 'active', review: 'auto', updated: '2026-10-22', ...meta }, body: '2026-10-22 x\n' }));
  put('a.md', { title: '钱二、沈七、赵六', entities: ['钱二', '沈七', '赵六'] });
  put('b.md', { title: '赵六（安全）', entities: ['赵六', 'ou_u6'] });
  const db = openIndex(path.join(base, 'idx.sqlite'));
  refresh(db, [{ root: 'mine', dir: base }]);
  assert.equal(who(db, '六哥', { id: 'ou_u6' }).person[0].title, '赵六（安全）'); // 飞书显示名和卡上名字对不上，也按 open_id 找到
  assert.equal(who(db, 'ou_u6').person[0].title, '赵六（安全）');
  assert.equal(who(db, '六哥', { id: 'ou_u6' }).person.length, 1);
});

test('Codex 记忆：索引 rollout_summaries，不索引 phase2_workspace_diff', async () => {
  const { DEFAULT_ROOTS, refresh: rf } = await import('../../lib/memory/index.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-home-'));
  const mem = path.join(home, '.codex', 'memories');
  fs.mkdirSync(path.join(mem, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'memory_summary.md'), '# 摘要\n玄武岩\n');
  fs.writeFileSync(path.join(mem, 'phase2_workspace_diff.md'), '# diff\n玄武岩\n');
  fs.writeFileSync(path.join(mem, 'rollout_summaries', 'r1.md'), '# 任务\n玄武岩\n');
  const wy = path.join(home, 'wy'); fs.mkdirSync(wy);
  const db = openIndex(path.join(home, 'idx.sqlite'));
  rf(db, DEFAULT_ROOTS(home, wy));
  const files = search(db, '玄武岩').map((h) => path.basename(h.path.split('#')[0])).sort();
  assert.deepEqual(files, ['memory_summary.md', 'r1.md']);
});

test('queryText：按字面量去掉 ignore 里的名字，含正则特殊字符也不出错', () => {
  assert.ok(!queryText('张三 帮我开通', { ignore: ['张三'] }).includes('张三'));
  assert.doesNotThrow(() => queryText('A.B (x) 开通', { ignore: ['A.B (x)'] }));
  assert.ok(!queryText('A.B (x) 开通', { ignore: ['A.B (x)'] }).includes('A.B'));
});

test('aliases：没给同义词时连写的 modelplan 不会自动变成 model-plan', () => {
  assert.ok(!queryText('开个modelplan').includes('model-plan'));
  assert.ok(queryText('开个modelplan', { aliases: CP }).includes('model-plan'));
});

test('DEFAULT_ROOTS：记忆库的 root 叫 mine；--scope mine 只搜记忆库', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-roots-'));
  assert.equal(DEFAULT_ROOTS(home, path.join(home, 'mem'))[0].root, 'mine');
  const { db } = fixture();
  const hits = search(db, '开通 白名单', { scope: 'mine' });
  assert.ok(hits.length > 0 && hits.every((h) => h.root === 'mine'), JSON.stringify(hits.map((h) => h.root)));
});

test('who 查我自己：相关口径不会因为去掉了我的名字而变空', async () => {
  const { who } = await import('../../lib/memory/index.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-self-'));
  fs.mkdirSync(path.join(base, 'policy'), { recursive: true });
  fs.writeFileSync(path.join(base, 'policy', 'a.md'), serializeEntry({ meta: { type: 'policy', title: '张三负责的网关口径', status: 'active', review: 'auto', updated: '2026-10-22' }, body: '2026-10-22 张三说 key 统一走门户\n' }));
  const db = openIndex(path.join(base, 'idx.sqlite'));
  refresh(db, [{ root: 'mine', dir: base }]);
  assert.equal(who(db, '张三', { ignore: ['张三'] }).related[0]?.title, '张三负责的网关口径');
});
