import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry } from '../../lib/memory/store.mjs';
import { addItems, acceptEntry, rejectEntry } from '../../lib/memory/add.mjs';
import { redact } from '../../lib/memory/secrets.mjs';
import { withLock } from '../../lib/memory/lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wym-safe-'));
const item = (o = {}) => ({ type: 'fact', title: '网关地址', entities: ['网关'], scope: 'model-plan prod', content: '地址 x',
  sources: ['oc_a#1'], observed: '2026-10-22', confidence: 'high', review: 'auto', ...o });
const read = (p) => parseEntry(fs.readFileSync(p, 'utf8'));

// C2 识别常见写法的凭证（fr 外发前靠它拦 key；记忆库本身允许放 key）
test('C2 JSON / 环境变量 / URL 参数里的凭证', () => {
  for (const s of ['{"password": "hunter2xyz"}', 'OPENAI_API_KEY=abcd1234efgh5678', 'FOO_SECRET=s3cr3tvalue1', 'https://x?access_token=abcdefgh12345678']) {
    const r = redact(s);
    assert.ok(r.hits >= 1, s);
    assert.ok(!/hunter2xyz|abcd1234efgh5678|s3cr3tvalue1|abcdefgh12345678/.test(r.text), r.text);
  }
});

// C3 路径必须在记忆库里
test('C3 target 指向库外文件：不写库外，按普通条目处理', () => {
  const root = tmp(), outside = path.join(tmp(), 'outside.md');
  fs.writeFileSync(outside, 'keep');
  const [r] = addItems(root, [item({ target: outside })]);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.ok(r.path.startsWith(root + path.sep));
});
test('C3 ../ 穿越和 conflict_with 库外路径都被忽略', () => {
  const root = tmp(), dir = tmp(), outside = path.join(dir, 'o.md');
  fs.writeFileSync(outside, '---\nstatus: active\n---\n');
  addItems(root, [item({ target: path.relative(root, outside) }), item({ title: '另一条', conflict_with: outside })]);
  assert.equal(fs.readFileSync(outside, 'utf8'), '---\nstatus: active\n---\n');
});
test('C3 accept / reject 只接受 inbox 里的条目', () => {
  const root = tmp();
  const [r] = addItems(root, [item()]);
  assert.throws(() => acceptEntry(root, r.path));
  assert.throws(() => rejectEntry(root, r.path));
  assert.ok(fs.existsSync(r.path));
});

// I1 pending 内容不能直接追加进已确认条目
test('I1 pending 追加到已有条目：先进 inbox，accept 后才并进原条目', () => {
  const root = tmp();
  const [a] = addItems(root, [item({ type: 'policy', title: 'opus 价格' })]);
  const before = fs.readFileSync(a.path, 'utf8');
  const [b] = addItems(root, [item({ type: 'policy', title: 'opus 价格', content: '2026-10-23 涨价到 30', review: 'pending' })]);
  assert.equal(b.action, 'inbox');
  assert.equal(fs.readFileSync(a.path, 'utf8'), before);
  const p = acceptEntry(root, b.path);
  assert.equal(p, a.path);
  assert.match(read(a.path).body, /涨价到 30/);
  assert.equal(fs.existsSync(b.path), false);
});

// I2 查重要看 scope 和人物身份
test('I2 同标题不同环境不合并', () => {
  const root = tmp();
  addItems(root, [item({ scope: 'model-plan prod' })]);
  const [r] = addItems(root, [item({ scope: 'model-plan test' })]);
  assert.equal(r.action, 'created');
});
test('I2 同名不同 open_id 的人不合并', () => {
  const root = tmp();
  const p = (id) => item({ type: 'person', title: '张伟', entities: ['张伟', id], scope: 'work' });
  addItems(root, [p('ou_aaaaaaaa')]);
  assert.equal(addItems(root, [p('ou_bbbbbbbb')])[0].action, 'created');
  assert.equal(addItems(root, [{ ...p('ou_aaaaaaaa'), content: '2026-10-23 又一条新事实' }])[0].action, 'appended');
});

// I6 写入串行
test('I6 锁被占用时等待超时报错，用完释放', async () => {
  const root = tmp();
  let inner;
  await withLock(root, async () => {
    inner = await withLock(root, () => 'x', { timeoutMs: 300 }).catch((e) => e);
  });
  assert.ok(inner instanceof Error);
  assert.equal(await withLock(root, () => 'ok', { timeoutMs: 300 }), 'ok');
});

// I7 事项能通过 add 结案
test('I7 追加时带 status=done 会更新状态', () => {
  const root = tmp();
  const [a] = addItems(root, [item({ type: 'open', title: '给陈一充额度', due: '2026-10-25' })]);
  addItems(root, [item({ type: 'open', title: '给陈一充额度', content: '2026-10-24 已充', status: 'done' })]);
  assert.equal(read(a.path).meta.status, 'done');
});
