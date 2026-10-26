import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAlerter } from '../lib/alert.mjs';

test('alert：同类一小时一次；授权提醒不会被别的类别吃掉', async () => {
  const sent = []; let t = 0;
  const a = makeAlerter({ send: async (m) => sent.push(m), log() {}, now: () => t });
  await a('x', 'inbox'); await a('y', 'inbox'); await a('token expired', 'auth');
  t = 3600_001; await a('z', 'inbox');
  assert.deepEqual(sent, ['⚠️ 回复助手异常：x', '⚠️ 回复助手异常：token expired', '⚠️ 回复助手异常：z']);
});

test('alert：发送失败不抛出，只记日志', async () => {
  const logs = [];
  const a = makeAlerter({ send: async () => { throw new Error('boom'); }, log: (...x) => logs.push(x.join(' ')) });
  await a('x');
  assert.ok(logs.some((l) => l.includes('boom')));
});

test('alert：发送失败不占这一类的限流窗口，下一轮还会再试', async () => {
  const sent = []; let fail = true;
  const a = makeAlerter({ send: async (m) => { if (fail) throw new Error('auth expired'); sent.push(m); }, log() {}, now: () => 0 });
  await a('token expired', 'auth');
  fail = false;
  await a('token expired', 'auth');
  assert.deepEqual(sent, ['⚠️ 回复助手异常：token expired']);
});
