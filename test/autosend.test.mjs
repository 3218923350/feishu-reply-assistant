import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackAllowed, autoSendable, msgArgs, signed, unfinished } from '../lib/autosend.mjs';

const res = (o = {}) => ({ kind: 'answer', draft: '用 deepseek-v4.1-flash-1017 就行', options: [], draft_after: '', ...o });

test('直接发：只发判定为 auto、现成的回复', () => {
  assert.equal(autoSendable(res(), { tier: 'auto' }), true);
  assert.equal(autoSendable(res(), { tier: 'countdown' }), false);
  assert.equal(autoSendable(res(), { tier: 'hold' }), false);
  assert.equal(autoSendable(res(), null), false);
  assert.equal(autoSendable(res({ kind: 'action' }), { tier: 'auto' }), false);
  assert.equal(autoSendable(res({ draft: '  ' }), { tier: 'auto' }), false);
  assert.equal(autoSendable(res({ options: [{ id: 'a', label: '开白名单' }] }), { tier: 'auto' }), false);
  assert.equal(autoSendable(res({ draft_after: '开好了' }), { tier: 'auto' }), false);
});

test('直接发：答应了还没做的、没验证就说好了的，不发', () => {
  assert.equal(autoSendable(res({ draft: '我这边马上给你开一下' }), { tier: 'auto' }), false);
  assert.equal(autoSendable(res({ draft: '已经给你加好了' }), { tier: 'auto' }), false);
});

test('署名：另起一行加在结尾；没配署名就原样', () => {
  assert.equal(signed('好的  \n', '（张三的助手代回）'), '好的\n（张三的助手代回）');
  assert.equal(signed('好的', ''), '好的');
});

test('发消息：用了 markdown 按富文本发，没用就发纯文本', () => {
  assert.deepEqual(msgArgs('好，先 60s'), ['--text', '好，先 60s']);
  for (const t of ['查到了：\n- 一\n- 二', '1. 先这样\n2. 再那样', '模型写 `deepseek-v4.1-flash-1017`', '**结论**：没问题', '见 [文档](https://x.cn)'])
    assert.equal(msgArgs(t)[0], '--markdown', t);
  assert.equal(msgArgs('价格 2*3 元，减-1')[0], '--text');
});

test('没查完：草稿里留着「我再去看下 / 还在查」', () => {
  assert.equal(unfinished('首字节我还在捞，捞完补'), '还在捞');
  assert.equal(unfinished('我再去看下终端节点组'), '我再去看下');
  assert.equal(unfinished('核完再发你'), '核完再发');
  assert.equal(unfinished('查到了，是入口 60 秒超时'), null);
  assert.equal(unfinished(''), null);
});

test('先回一句：只在私聊；同一个会话 2 小时内回过就不再回；上级、外部不回', () => {
  const now = Date.parse('2026-10-30T10:00:00Z');
  const ago = (m) => new Date(now - m * 60_000).toISOString();
  const base = { chatId: 'oc_1', chatType: 'p2p', now, leader: false, external: false };
  assert.equal(ackAllowed({ ...base, events: [] }), true);
  assert.equal(ackAllowed({ ...base, events: [{ kind: 'ack', chat_id: 'oc_1', ts: ago(30) }] }), false);
  assert.equal(ackAllowed({ ...base, events: [{ kind: 'sent', orig: { chat_id: 'oc_1' }, ts: ago(90) }] }), false);
  assert.equal(ackAllowed({ ...base, events: [{ kind: 'ack', chat_id: 'oc_1', ts: ago(150) }] }), true);
  assert.equal(ackAllowed({ ...base, events: [{ kind: 'ack', chat_id: 'oc_2', ts: ago(5) }] }), true);
  assert.equal(ackAllowed({ ...base, leader: true, events: [] }), false);
  assert.equal(ackAllowed({ ...base, external: true, events: [] }), false);
  assert.equal(ackAllowed({ ...base, chatType: 'group', events: [] }), false); // 群里一律不先回
});
