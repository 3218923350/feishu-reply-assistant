import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whyOk, inScope, dedupKey, activeFollowups, matchFollowup, sentIds, tooShortToCompose } from '../lib/fr.mjs';

const ctx = {
  card: 'om_card', authText: '可以直接发 然后找一下赵六吧 等他改好了 我们复测没问题再回复一遍',
  orig: { message_id: 'om_orig', chat_id: 'oc_proj', chat_name: '某项目群', thread_id: 'omt_1', sender_id: 'ou_u4', sender_name: '冯五', chat_type: 'group' },
};

test('why 必须是我原话里的片段（忽略空白），太短不算', () => {
  assert.equal(whyOk(ctx.authText, '可以直接发'), true);
  assert.equal(whyOk(ctx.authText, '找一下 赵六'), true);
  assert.equal(whyOk(ctx.authText, '张三已批准'), false);
  assert.equal(whyOk(ctx.authText, '发'), false);
  assert.equal(whyOk(ctx.authText, ''), false);
});

test('收件人范围：原消息/原会话/原发送人可以，点了名的人可以，没点名的不行', () => {
  assert.equal(inScope(ctx, { kind: 'orig' }), true);
  assert.equal(inScope(ctx, { kind: 'chat', id: 'oc_proj', name: '某项目群' }), true);
  assert.equal(inScope(ctx, { kind: 'user', id: 'ou_u4', name: '冯五' }), true);
  assert.equal(inScope(ctx, { kind: 'user', id: 'ou_u6', name: '赵六' }), true);
  assert.equal(inScope(ctx, { kind: 'user', id: 'ou_x', name: '王五' }), false);
  assert.equal(inScope(ctx, { kind: 'chat', id: 'oc_other', name: '别的群' }), false);
});

test('幂等键：同卡同收件人同正文相同，任一不同就不同', () => {
  assert.equal(dedupKey('c', 'ou_a', 'hi'), dedupKey('c', 'ou_a', 'hi'));
  assert.notEqual(dedupKey('c', 'ou_a', 'hi'), dedupKey('c', 'ou_b', 'hi'));
  assert.notEqual(dedupKey('c', 'ou_a', 'hi'), dedupKey('c2', 'ou_a', 'hi'));
});

test('跟进：add/fired/done 折叠出还在等的；过期的不算', () => {
  const now = Date.parse('2026-10-23T12:00:00+08:00');
  const log = [
    { op: 'add', id: 'f1', card: 'om_card', watch: { open_id: 'ou_u6' }, then: '复测后回冯五', until: now + 86400_000 },
    { op: 'add', id: 'f2', card: 'om_card', watch: { open_id: 'ou_old' }, then: 'x', until: now - 1 },
    { op: 'add', id: 'f3', card: 'om_c2', watch: { open_id: 'ou_z' }, then: 'y', until: now + 1000 },
    { op: 'done', card: 'om_c2' },
  ];
  assert.deepEqual(activeFollowups(log, now).map((f) => f.id), ['f1']);
  assert.equal(matchFollowup({ sender: { id: 'ou_u6' }, chat_id: 'oc_any', chat_type: 'p2p' }, log, now)?.id, 'f1');
  assert.equal(matchFollowup({ sender: { id: 'ou_u4' }, chat_id: 'oc_any', chat_type: 'p2p' }, log, now), null);
  assert.equal(activeFollowups([...log, { op: 'fired', id: 'f1' }], now).length, 0);
});




test('助手以我身份发出去的消息 id（fr 和「发」）：不当成我的指令，也不当成我亲自回过', () => {
  const ids = sentIds([{ kind: 'fr-sent', message_id: 'om_a' }, { kind: 'fr-manual', message_id: 'om_b' }, { kind: 'sent', message_id: 'om_c' }]);
  assert.deepEqual([...ids], ['om_a', 'om_c']);
});


// 2026-10-23 孙七那条：我只回了「bu」，Claude 自己写了一句发出去，后来撤回了
test('授权原话太短（<4 字）：只能发卡上现成的草稿，不能发新写的', () => {
  assert.equal(tooShortToCompose({ authText: 'bu', draft: '好的' }, '七哥，模型 A 那批今天不上'), true);
  assert.equal(tooShortToCompose({ authText: 'bu', draft: '好的' }, '好的'), false);
  assert.equal(tooShortToCompose({ authText: '可以直接发', draft: '' }, '新写的一句'), false);
});

// ---- v3 第 1 步（Codex 查出的漏洞）----
test('why：否定语境里的片段不算授权（「先不要发，查清楚再说」引「不要发」/「要发」都不行）', () => {
  assert.equal(whyOk('先不要发，查清楚再说', '不要发'), false);
  assert.equal(whyOk('先不要发，查清楚再说', '要发'), false);
  assert.equal(whyOk('别发了 我自己回', '发了'), false);
  assert.equal(whyOk('不用改了 直接发', '直接发'), true);
  assert.equal(whyOk('等他改好了 我们复测没问题再回复一遍', '复测没问题再回复一遍'), true);
});

test('跟进只认原来那个会话：等原发送人 → 只认原会话；等第三人 → 记了会话就只认那个，没记就只认私聊', () => {
  const now = 1_000;
  const add = (watch, orig = { chat_id: 'oc_orig', sender_id: 'ou_u3' }) => [{ op: 'add', id: 'f', card: 'c', until: now + 1, watch, orig }];
  const msg = (sender, chat_id, chat_type = 'group') => ({ sender: { id: sender }, chat_id, chat_type });
  assert.ok(matchFollowup(msg('ou_u3', 'oc_orig'), add({ open_id: 'ou_u3' }), now)); // 旧记录没有 chat_id：原发送人按原会话
  assert.equal(matchFollowup(msg('ou_u3', 'oc_other'), add({ open_id: 'ou_u3' }), now), null);
  assert.ok(matchFollowup(msg('ou_u6', 'oc_p2p', 'p2p'), add({ open_id: 'ou_u6' }), now)); // 第三人没记会话：只认私聊
  assert.equal(matchFollowup(msg('ou_u6', 'oc_g'), add({ open_id: 'ou_u6' }), now), null);
  assert.ok(matchFollowup(msg('ou_u6', 'oc_g'), add({ open_id: 'ou_u6', chat_id: 'oc_g' }), now));
});

import { followupChats } from '../lib/fr.mjs';
test('followupChats：还在等、绑在群里的跟进要单独去拉（群里不 @我 的回复搜不到）；私聊的不用', () => {
  const now = 1_000;
  const log = [
    { op: 'add', id: 'a', card: 'c1', until: now + 1, watch: { open_id: 'ou_u3', chat_id: 'oc_g' }, orig: { chat_id: 'oc_g', chat_type: 'group', thread_id: 'omt_1', sender_id: 'ou_u3' } },
    { op: 'add', id: 'b', card: 'c2', until: now + 1, watch: { open_id: 'ou_u6' }, orig: { chat_id: 'oc_x', sender_id: 'ou_u4' } },
    { op: 'add', id: 'c', card: 'c3', until: now + 1, watch: { open_id: 'ou_li' }, orig: { chat_id: 'oc_p', chat_type: 'p2p', sender_id: 'ou_li' } },
  ];
  assert.deepEqual(followupChats(log, now), [{ chat_id: 'oc_g', thread_id: 'omt_1' }]);
});
