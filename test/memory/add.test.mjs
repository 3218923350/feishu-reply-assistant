import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry } from '../../lib/memory/store.mjs';
import { addItems, acceptEntry, listPending } from '../../lib/memory/add.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wym-add-'));
const item = (o = {}) => ({ type: 'person', title: '孙七', entities: ['孙七'], scope: 'work/svc-a', content: '负责 svc-a 发版',
  sources: ['oc_a#1'], observed: '2026-10-20', confidence: 'high', review: 'auto', ...o });
const read = (p) => parseEntry(fs.readFileSync(p, 'utf8'));

test('新建：落在 people/，frontmatter 正确，正文带日期', () => {
  const root = tmp();
  const [r] = addItems(root, [item()], { now: '2026-10-23' });
  assert.equal(r.action, 'created');
  assert.equal(path.dirname(r.path), path.join(root, 'people'));
  const { meta, body } = read(r.path);
  assert.deepEqual([meta.type, meta.title, meta.status, meta.updated, meta.review], ['person', '孙七', 'active', '2026-10-23', 'auto']);
  assert.equal(body.trim(), '2026-10-20 负责 svc-a 发版');
});

test('同标题再加：追加一行，sources 合并', () => {
  const root = tmp();
  addItems(root, [item()], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ content: '2026-10-22 也管 svc-b 合并', sources: ['oc_b#2', 'oc_a#1'] })], { now: '2026-10-24' });
  assert.equal(r.action, 'appended');
  const { meta, body } = read(r.path);
  assert.deepEqual(body.trim().split('\n'), ['2026-10-20 负责 svc-a 发版', '2026-10-22 也管 svc-b 合并']);
  assert.deepEqual(meta.sources, ['oc_a#1', 'oc_b#2']);
  assert.equal(meta.updated, '2026-10-24');
});

test('target 指定时追加到该文件', () => {
  const root = tmp();
  const [a] = addItems(root, [item()], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ title: '完全不同的标题', type: 'person', entities: ['别人'], content: '2026-10-24 新事实', target: a.path })], { now: '2026-10-24' });
  assert.deepEqual([r.action, r.path], ['appended', a.path]);
});

test('review=pending 进 inbox/policy/', () => {
  const root = tmp();
  const [r] = addItems(root, [item({ type: 'policy', title: 'opus 价格', review: 'pending' })], { now: '2026-10-23' });
  assert.equal(r.action, 'inbox');
  assert.equal(path.dirname(r.path), path.join(root, 'inbox', 'policy'));
  assert.equal(listPending(root).length, 1);
});

test('conflict_with：两边都标 conflict', () => {
  const root = tmp();
  const [a] = addItems(root, [item({ type: 'fact', title: '按量默认开通' })], { now: '2026-10-23' });
  const [b] = addItems(root, [item({ type: 'fact', title: '按量需要手动开通', conflict_with: a.path })], { now: '2026-10-23' });
  assert.equal(b.action, 'conflict');
  assert.equal(read(a.path).meta.status, 'conflict');
  assert.equal(read(b.path).meta.status, 'conflict');
});

test('key 原样落盘（张三 2026-10-23 允许记忆里放 key）', () => {
  const root = tmp();
  const [r] = addItems(root, [item({ type: 'fact', title: 'key 示例', content: '他的 key 是 abc_AbCdEf1234567890' })], { now: '2026-10-23' });
  assert.ok(fs.readFileSync(r.path, 'utf8').includes('abc_AbCdEf1234567890'));
});

test('没有 sources 的跳过', () => {
  const root = tmp();
  assert.equal(addItems(root, [item({ sources: [] })])[0].action, 'skipped');
  assert.equal(fs.existsSync(path.join(root, 'people')), false);
});

test('open 类型默认 status=open，带 due', () => {
  const root = tmp();
  const [r] = addItems(root, [item({ type: 'open', title: '给陈一充额度', due: '2026-10-25' })], { now: '2026-10-23' });
  assert.deepEqual([read(r.path).meta.status, read(r.path).meta.due], ['open', '2026-10-25']);
});

test('accept：移出 inbox，review=confirmed', () => {
  const root = tmp();
  const [r] = addItems(root, [item({ type: 'policy', title: 'opus 价格', review: 'pending' })], { now: '2026-10-23' });
  const p = acceptEntry(root, r.path);
  assert.equal(path.dirname(p), path.join(root, 'policy'));
  assert.equal(read(p).meta.review, 'confirmed');
  assert.equal(fs.existsSync(r.path), false);
});

// 2026-10-23：同一天的每日增量跑了两遍，sources 带不同后缀、同一句话追加两次
test('sources 去掉「(时间)」后缀再合并，不出现同一条消息的两种写法', () => {
  const root = tmp();
  addItems(root, [item({ sources: ['oc_a#1'] })], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ content: '2026-10-22 也管 svc-b', sources: ['oc_a#1 (2026-10-22 16:50)', 'oc_b#2（10-22 19:31）'] })], { now: '2026-10-23' });
  assert.deepEqual(read(r.path).meta.sources, ['oc_a#1', 'oc_b#2']);
});

test('要追加的事实行已经在条目里：不重复追加', () => {
  const root = tmp();
  addItems(root, [item({ content: '2026-10-22 也管 svc-b 合并' })], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ content: '2026-10-22 也管 svc-b 合并。' })], { now: '2026-10-24' });
  assert.equal(r.action, 'skipped');
  assert.equal(read(r.path).body.trim().split('\n').length, 1);
});

test('追加时合并 entities（补上 open_id）', () => {
  const root = tmp();
  addItems(root, [item()], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ content: '2026-10-23 open_id 补上', entities: ['孙七', 'ou_u7'] })], { now: '2026-10-23' });
  assert.deepEqual(read(r.path).meta.entities, ['孙七', 'ou_u7']);
});

test('新建 open 事项没给 due：默认 observed 后 3 天，能进日报的到期提醒', () => {
  const root = tmp();
  const [r] = addItems(root, [item({ type: 'open', title: '等吴九发 Kimi 账单', observed: '2026-10-23' })], { now: '2026-10-23' });
  assert.equal(read(r.path).meta.due, '2026-10-26');
  const [r2] = addItems(root, [item({ type: 'open', title: '另一件', observed: '2026-10-23', due: '2026-11-01' })], { now: '2026-10-23' });
  assert.equal(read(r2.path).meta.due, '2026-11-01');
});

test('结案的那行已经有了：不重复追加，但 status=done 照样生效', () => {
  const root = tmp();
  const [a] = addItems(root, [item({ type: 'open', title: '等吴九发账单', content: '2026-10-23 已结' })], { now: '2026-10-23' });
  const [r] = addItems(root, [item({ type: 'open', title: '等吴九发账单', content: '2026-10-23 已结', status: 'done', target: a.path })], { now: '2026-10-23' });
  assert.equal(r.action, 'appended');
  assert.equal(read(a.path).meta.status, 'done');
  assert.equal(read(a.path).body.trim().split('\n').length, 1);
});
