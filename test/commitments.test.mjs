import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromSend, openCommitments, dueReminders } from '../lib/commitments.mjs';

const T0 = Date.parse('2026-10-24T07:13:38Z');
test('发出去的话里有承诺 → 记一条（对谁、哪句、哪张卡、哪个会话；说了「现在 / 马上」的算急）', () => {
  const r = fromSend('我现在把 B 组里的自部署节点摘掉让它只走云厂商，弄完告诉你', { card: 'c1', session: 's1', to: 'oc_x', toName: '周八', message_id: 'om_m', at: T0 });
  assert.equal(r.op, 'add');
  assert.deepEqual([r.card, r.session, r.toName, r.urgent], ['c1', 's1', '周八', true]);
  assert.ok(r.what.includes('摘'));
  assert.equal(fromSend('直接去 model-plan 建 key 就行', { card: 'c1', at: T0 }), null);
  assert.equal(fromSend('开好了跟你说', { card: 'c2', at: T0 }).urgent, false);
});

test('账本折叠：kept / dropped 的不算还开着；按会话、按卡筛', () => {
  const a = fromSend('我现在把节点摘掉，弄完告诉你', { card: 'c1', session: 's1', toName: '周八', at: T0 });
  const b = fromSend('开好了跟你说', { card: 'c2', session: 's2', toName: '郑十', at: T0 });
  const log = [a, b, { op: 'kept', id: b.id, at: T0 + 1 }];
  assert.deepEqual(openCommitments(log).map((x) => x.id), [a.id]);
  assert.deepEqual(openCommitments(log, { session: 's1' }).map((x) => x.id), [a.id]);
  assert.deepEqual(openCommitments(log, { session: 's2' }), []);
  assert.deepEqual(openCommitments([...log, { op: 'dropped', id: a.id }]), []);
});

test('提醒：急的 30 分钟还没做提醒一次；不急的不在这里提醒（日报里列）', () => {
  const a = fromSend('我现在把节点摘掉，弄完告诉你', { card: 'c1', session: 's1', toName: '周八', at: T0 });
  const b = fromSend('开好了跟你说', { card: 'c2', session: 's2', toName: '郑十', at: T0 });
  assert.deepEqual(dueReminders([a, b], T0 + 29 * 60_000), []);
  assert.deepEqual(dueReminders([a, b], T0 + 31 * 60_000).map((x) => x.id), [a.id]);
  assert.deepEqual(dueReminders([a, b, { op: 'reminded', id: a.id, at: T0 + 31 * 60_000 }], T0 + 60 * 60_000), []);
});
