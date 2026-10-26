import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repliedTo, shouldDraft } from '../lib/inbox.mjs';

const ME = 'ou_me';
const m = { message_id: 'om_q', chat_type: 'group', create_time: '2026-10-22 21:20', sender: { id: 'ou_u10' }, thread_id: null };
const mine = (o) => ({ message_id: 'om_r', create_time: '2026-10-22 21:25', sender: { id: ME }, ...o });

test('群里我之后回了别人（不引用、不同话题、没 @ 他）→ 不算已回复', () => {
  assert.equal(repliedTo(m, [mine({ reply_to: 'om_other' })], ME), false);
});
test('我引用了这条 → 已回复', () => {
  assert.equal(repliedTo(m, [mine({ reply_to: 'om_q' })], ME), true);
});
test('同一话题里我说了话 → 已回复', () => {
  assert.equal(repliedTo({ ...m, thread_id: 'omt_1' }, [mine({ thread_id: 'omt_1' })], ME), true);
});
test('我 @ 了发送人 → 已回复', () => {
  assert.equal(repliedTo(m, [mine({ mentions: [{ id: 'ou_u10' }] })], ME), true);
});
test('别人的消息、或比这条早的我的消息 → 不算', () => {
  assert.equal(repliedTo(m, [{ ...mine({ reply_to: 'om_q' }), sender: { id: 'ou_x' } }], ME), false);
  assert.equal(repliedTo(m, [mine({ reply_to: 'om_q', create_time: '2026-10-22 21:19' })], ME), false);
});
test('私聊里我之后说过话 → 已回复', () => {
  assert.equal(repliedTo({ ...m, chat_type: 'p2p' }, [mine({})], ME), true);
});
test('shouldDraft：已有这条消息的草稿 → 不再起草', () => {
  const state = { items: { om_card: { orig: { message_id: 'om_q' } } } };
  assert.equal(shouldDraft(m, state), false);
  assert.equal(shouldDraft({ ...m, message_id: 'om_new' }, state), true);
});

// ---- 2026-10-23 优化 ----
import { myReplies, isAck, skipAck, nextBatches, burstKey } from '../lib/inbox.mjs';

test('myReplies：返回算作回复的那几条我的消息', () => {
  const r = myReplies({ ...m, chat_type: 'p2p' }, [mine({ message_id: 'om_a' }), { ...mine({}), sender: { id: 'ou_x' } }], ME);
  assert.deepEqual(r.map((x) => x.message_id), ['om_a']);
});

test('isAck：好的 / OK / 谢谢 / 表情 是纯确认；带了新内容的不算', () => {
  for (const t of ['好的', 'OK', 'okk', '谢了', '好 谢谢', '[比心][比心][比心]', '@张三 收到', '嗯嗯 好', '辛苦了！', '👍']) assert.equal(isAck(t), true, t);
  for (const t of ['好 谢谢 我下午看看', '好的，那 kimi 呢', '可以吗', '', '好，他们给导呢，稍等一会哈']) assert.equal(isAck(t), false, t);
});

test('skipAck：纯确认且我上一句不是在问 → 跳过；我刚问了问题，对方回「好的」→ 不跳', () => {
  const ack = { message_id: 'om_k', create_time: '2026-10-23 11:56', sender: { id: 'ou_u5' }, content: 'OK' };
  const before = (content) => [{ message_id: 'om_p', create_time: '2026-10-23 11:55', sender: { id: ME }, content }, ack];
  assert.equal(skipAck([ack], before('账单对比图在这，kimi 官方的还缺'), ME), true);
  assert.equal(skipAck([ack], before('那我今晚先切过去，你看行吗？'), ME), false);
  assert.equal(skipAck([ack, { ...ack, message_id: 'om_k2', content: '另外 kimi 的呢' }], before('x'), ME), false);
});

test('nextBatches：同一会话同一人的连发合成一批；在处理的会话、等重试的批次先不动', () => {
  const q = (id, chat, sender, t, extra = {}) => ({ message_id: id, chat_id: chat, sender: { id: sender }, create_time: t, thread_id: null, ...extra });
  const queue = [q('a1', 'oc_a', 'ou_1', '2026-10-23 12:09'), q('b1', 'oc_b', 'ou_2', '2026-10-23 12:09'), q('a2', 'oc_a', 'ou_1', '2026-10-23 12:09'),
    q('a3', 'oc_a', 'ou_9', '2026-10-23 12:10'), q('c1', 'oc_c', 'ou_3', '2026-10-23 12:10', { retryAt: 2e12 })];
  const batches = nextBatches(queue, new Set([burstKey(queue[1])]), 1e12);
  assert.deepEqual(batches.map((b) => b.map((x) => x.message_id)), [['a1', 'a2'], ['a3']]);
});

test('shouldDraft：连发合并起草过的消息（burst 里的）也不再起草', () => {
  const state = { items: { om_card: { orig: { message_id: 'om_last', burst: ['om_q', 'om_last'] } } } };
  assert.equal(shouldDraft(m, state), false);
});

import { handledBy } from '../lib/inbox.mjs';
test('handledBy：卡片发出后我在原会话亲自回的才算；助手替我发的、卡片之前的不算', () => {
  const orig = { message_id: 'om_q', chat_type: 'p2p', create_time: '2026-10-23 11:34', sender_id: 'ou_u1' };
  const msgs = [mine({ message_id: 'om_old', create_time: '2026-10-23 11:35' }), mine({ message_id: 'om_fr', create_time: '2026-10-23 11:56' }),
    mine({ message_id: 'om_me', create_time: '2026-10-23 11:58', content: '收到' })];
  assert.deepEqual(handledBy(orig, msgs, ME, new Set(['om_fr']), '2026-10-23 11:37').map((x) => x.message_id), ['om_me']);
  // lark-cli 按时间倒序给；返回按时间正序（先回的在前），记「我实际怎么回的」取前几条
  const desc = [mine({ message_id: 'om_2', create_time: '2026-10-23 12:00' }), mine({ message_id: 'om_1', create_time: '2026-10-23 11:58' })];
  assert.deepEqual(handledBy(orig, desc, ME, new Set(), '2026-10-23 11:37').map((x) => x.message_id), ['om_1', 'om_2']);
  // 群里：orig 只有 sender_id，也能按「@ 了发送人」认
  const g = { ...orig, chat_type: 'group' };
  assert.deepEqual(handledBy(g, [mine({ message_id: 'om_at', create_time: '2026-10-23 11:58', mentions: [{ id: 'ou_u1' }] })], ME, new Set(), '2026-10-23 11:37').map((x) => x.message_id), ['om_at']);
});

// 2026-10-23 18:41 秦十在部署卡话题里先「@孙七 帮忙点一下谢谢」再单独「@张三」：只 @ 我是在叫我，不是「好的」
test('isAck：只有 @ 没有别的字是在叫我，不算纯确认', () => {
  assert.equal(isAck('@张三'), false);
  assert.equal(isAck('@张三 @孙七'), false);
  assert.equal(isAck('@张三 好的'), true);
});

// 对方报错，我先回了句「我看看」：助手查完不能因为「已回复」就把草稿扔了
test('myReplies：「我看看 / 稍等 / 我查一下」这种占位不算回过；带了实际内容的算', () => {
  const p2p = { ...m, chat_type: 'p2p' };
  for (const t of ['我看看', '我看一下哈', '稍等', '好 我查下', '收到 我看看', '马上']) assert.deepEqual(myReplies(p2p, [mine({ content: t })], ME), [], t);
  assert.equal(myReplies(p2p, [mine({ content: '我看看 怀疑是模型自己的内容审核' })], ME).length, 1);
  assert.equal(myReplies(p2p, [mine({ content: '我看看' }), mine({ message_id: 'om_r2', content: '查清楚了，是 WebSearch 发的 thinking=disabled' })], ME).length, 1);
});
