import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_PERMS, EXEC_DENY, allows } from '../lib/tools.mjs';
import { route, claim, isVerified } from '../lib/commands.mjs';
import { run } from '../lib/run.mjs';
import { settle } from '../lib/inbox.mjs';

// C1 起草完全放行（张三 2026-10-23 定），只禁发飞书消息
test('C1 起草：跳过权限确认，但发消息的命令都被禁', () => {
  assert.equal(DRAFT_PERMS[0], '--dangerously-skip-permissions');
  assert.deepEqual(DRAFT_PERMS.slice(DRAFT_PERMS.indexOf('--disallowedTools') + 1), EXEC_DENY);
});
test('C1 执行阶段禁止发飞书消息', () => {
  for (const c of ['lark-cli im +messages-send --text hi', 'lark-cli im +messages-reply --message-id x --text hi', 'lark-cli im +messages-forward x',
    'lark-cli api POST /open-apis/im/v1/messages --data x', 'lark-cli api POST /open-apis/im/v1/messages/om_x/reply --data x'])
    assert.equal(allows(EXEC_DENY, c), true, c);
});

// C4 待执行卡上的「可以 / 发」不能直接把「做完后」的话发出去：交给 Claude 结合上下文理解
test('C4 action 卡上的「可以」不走直接发送，交给 Claude', () => {
  assert.equal(route({ kind: 'action', status: 'pending', draft: '已为你开通' }, '@codex 可以').do, 'work');
  assert.equal(route({ kind: 'action', status: 'pending', draft: '已为你开通' }, '发').do, 'work');
});
test('C4 草稿卡上整句「发」直接发（带 @ 也认），「不」跳过，其余交给 Claude', () => {
  assert.equal(route({ kind: 'answer', status: 'pending', draft: 'x' }, '@codex 发').do, 'send');
  assert.equal(route({ kind: 'answer', status: 'pending', draft: 'x' }, '不').do, 'dismiss');
  assert.deepEqual(route({ kind: 'answer', status: 'pending', draft: 'x' }, '可以直接发 然后找一下赵六吧'), { do: 'work', text: '可以直接发 然后找一下赵六吧' });
  assert.equal(route({ kind: 'action', status: 'pending' }, '执行').do, 'work');
  assert.equal(route({ kind: 'answer', status: 'pending', draft: '' }, '发').do, 'work'); // 没草稿可发就让 Claude 看
});

// C5 先占住状态再做异步操作
test('C5 同一张卡只能被占用一次', () => {
  const item = { status: 'pending' };
  assert.equal(claim(item, 'sending'), true);
  assert.equal(claim(item, 'sending'), false);
  assert.equal(item.status, 'sending');
});

// C6 只有 ok===true 且有像样的验证记录才算验证过
test('C6 isVerified 严格判断', () => {
  assert.equal(isVerified({ ok: true, verification: 'cat /tmp/x → 2026-10-23 00:49' }), true);
  for (const r of [{ ok: true, verification: {} }, { ok: 'false', verification: '没有验证但写了字' }, { ok: true, verification: '  ' }, { ok: true }, { ok: false, verification: 'ls → ok ok ok' }])
    assert.equal(isVerified(r), false, JSON.stringify(r));
});

// I4 子进程起不来不能把助手弄挂
test('I4 run 遇到不存在的程序返回失败结果而不是抛出', async () => {
  const r = await run('/no/such/binary', ['x'], { timeout: 2000 });
  assert.equal(r.code, null);
  assert.match(r.err, /ENOENT/);
});
test('I4 run 超时会结束', async () => {
  const t = Date.now();
  const r = await run('/bin/sleep', ['5'], { timeout: 300 });
  assert.equal(r.code, null);
  assert.ok(Date.now() - t < 3000);
});

// I3 处理失败的消息留在队列里重试，失败太多次才放弃
test('I3 settle：成功出队，失败重试 3 次后放弃', () => {
  const state = { queue: [{ message_id: 'a' }, { message_id: 'b' }] };
  assert.equal(settle(state, 'a', true), 'done');
  assert.deepEqual(state.queue.map((m) => m.message_id), ['b']);
  assert.equal(settle(state, 'b', false), 'retry');
  assert.equal(settle(state, 'b', false), 'retry');
  assert.equal(settle(state, 'b', false), 'drop');
  assert.deepEqual(state.queue, []);
});

test('C1 原生资源风格的转发也禁掉（im messages forward / merge_forward、im threads forward、原生接口转发话题）；读和改卡片不受影响', () => {
  for (const c of ['lark-cli im messages forward --params {} --data {}', 'lark-cli im messages merge_forward --data {}', 'lark-cli im threads forward --params {}',
    'lark-cli api POST /open-apis/im/v1/threads/omt_1/forward --data x'])
    assert.equal(allows(EXEC_DENY, c), true, c);
  for (const c of ['lark-cli im +messages-search --query x', 'lark-cli im messages read_status --data {}', 'lark-cli im +chat-messages-list --chat-id oc_1'])
    assert.equal(allows(EXEC_DENY, c), false, c);
});

test('C1 包一层也禁：env / sh -c / bash -c / 绝对路径 / 引号里的接口路径 / 改消息、撤回、批量发；读消息的 GET 不禁', () => {
  for (const c of ['X=1 lark-cli im +messages-send --text hi', 'env X=1 lark-cli im +messages-send --text hi', 'sh -c "lark-cli im +messages-send --text hi"',
    "bash -c 'lark-cli im +messages-reply --message-id x --text hi'", '/opt/homebrew/bin/lark-cli im +messages-send --text hi',
    "lark-cli api POST '/open-apis/im/v1/messages' --data x", 'lark-cli api POST https://open.feishu.cn/open-apis/im/v1/messages --data x',
    'lark-cli api PATCH /open-apis/im/v1/messages/om_1 --data x', 'lark-cli api DELETE /open-apis/im/v1/messages/om_1', 'lark-cli api POST /open-apis/im/v1/batch_messages',
    'lark-cli im messages patch --as user --data x', 'lark-cli im messages delete --params x', 'lark-cli api POST /open-apis/interactive/v1/card/update'])
    assert.equal(allows(EXEC_DENY, c), true, c);
  for (const c of ['lark-cli api GET /open-apis/im/v1/messages --params x', 'lark-cli im +messages-mget --message-ids om_1', 'fr send --to orig --text hi --why 发吧'])
    assert.equal(allows(EXEC_DENY, c), false, c);
});

test('C1 加急（以本人身份提醒别人）也禁', () => {
  for (const c of ['lark-cli im messages urgent_app --params x', 'lark-cli im messages urgent_sms --params x', 'lark-cli im messages urgent_phone --params x'])
    assert.equal(allows(EXEC_DENY, c), true, c);
});
